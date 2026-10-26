"""Authenticated opaque transport, one-use packages and serialized MLS mutations."""

import base64
import hashlib
import json
import os
import secrets
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import HTTPException, UploadFile
from sqlalchemy import delete, func, or_, select, text

from coherent_api.models.conversation import Conversation
from coherent_api.models.e2ee import AccountRoster, E2eeAccount, E2eeDevice
from coherent_api.models.message import Message
from coherent_api.models.message_attachment import MessageAttachment
from coherent_api.models.mls import MlsEvent, MlsPackage, MlsState, MlsStorage
from coherent_api.schemas.e2ee import RosterPayload
from coherent_api.schemas.mls import LeaseRequest, TransportPayload
from coherent_api.services.attachments import attachment_storage_bytes
from coherent_api.services.conversation_access import (
    conversation_member_ids,
    get_conversation,
    get_server_channel,
)


def digest(data: bytes) -> str:
    return base64.b64encode(hashlib.sha256(data).digest()).decode()


def action_signature(device: E2eeDevice, nonce: str, payload: str, proof: str) -> None:
    try:
        public = base64.b64decode(device.signature_key, validate=True)
        data = (
            b"coherent/device-proof/v1\0action\0"
            + device.user_id.bytes
            + device.id.bytes
            + public
            + base64.b64decode(nonce, validate=True)
            + hashlib.sha256(payload.encode()).digest()
        )
        Ed25519PublicKey.from_public_bytes(public).verify(
            base64.b64decode(proof, validate=True), data
        )
    except (ValueError, InvalidSignature) as error:
        raise HTTPException(
            status_code=403, detail="Подпись устройства не прошла проверку"
        ) from error


async def active_device(session, user, device_id: UUID) -> E2eeDevice:
    device = await session.get(E2eeDevice, device_id)
    account = await session.get(E2eeAccount, user.id)
    if (
        device is None
        or device.user_id != user.id
        or device.revoked_at is not None
        or account is None
        or not account.roster_revision
    ):
        raise HTTPException(
            status_code=403, detail="Подтверди это устройство ключом восстановления"
        )
    roster = await session.get(AccountRoster, (user.id, account.roster_revision))
    if roster is None or not any(
        d.device_id == device.id and d.signature_key == device.signature_key
        for d in RosterPayload.model_validate_json(roster.payload).devices
    ):
        raise HTTPException(status_code=403, detail="Устройство отсутствует в подписанном списке")
    return device


async def secure_conversation(session, user, conversation_id: UUID, lock: bool = False):
    conversation = await get_conversation(session, user, conversation_id)
    if await get_server_channel(session, conversation_id) is not None:
        raise HTTPException(
            status_code=409, detail="Каналы серверов используют облачное шифрование"
        )
    if lock:
        conversation = await session.scalar(
            select(Conversation)
            .where(Conversation.id == conversation_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    return conversation


async def allocate_storage(session, settings, amount: int) -> None:
    if session.get_bind().dialect.name == "postgresql":
        await session.execute(text("SELECT pg_advisory_xact_lock(720184291)"))
    counter = await session.get(MlsStorage, 1, with_for_update=True)
    if counter is None:
        counter = MlsStorage(id=1, allocated_bytes=0)
        session.add(counter)
        await session.flush()
    if counter.allocated_bytes + amount > settings.e2ee_storage_limit_mb * 1024 * 1024:
        raise HTTPException(status_code=507, detail="Хранилище защищённых сообщений заполнено")
    counter.allocated_bytes += amount


async def directory(session, user, conversation_id: UUID) -> dict:
    conversation = await secure_conversation(session, user, conversation_id)
    accounts = []
    for uid in await conversation_member_ids(session, conversation):
        account = await session.get(E2eeAccount, uid)
        rosters = (
            list(
                await session.scalars(
                    select(AccountRoster)
                    .where(AccountRoster.user_id == uid)
                    .order_by(AccountRoster.revision)
                )
            )
            if account
            else []
        )
        accounts.append(
            {
                "account_id": str(uid),
                "public_key": account.recovery_public_key if account else None,
                "rosters": [{"payload": r.payload, "signature": r.signature} for r in rosters],
                "ready": bool(rosters and account and account.recovery_confirmed_at),
            }
        )
    state = await session.get(MlsState, conversation_id)
    return {"accounts": accounts, "state": state_view(state)}


def state_view(state: MlsState | None) -> dict:
    return {
        "group_id": str(state.group_id) if state and state.group_id else None,
        "sequence": state.sequence if state else 0,
        "epoch": state.epoch if state else 0,
        "generation": state.generation if state else 0,
        "roster": json.loads(state.roster) if state else [],
    }


async def desired_devices(session, conversation) -> list[UUID]:
    result = []
    for uid in await conversation_member_ids(session, conversation):
        account = await session.get(E2eeAccount, uid)
        roster = (
            await session.get(AccountRoster, (uid, account.roster_revision))
            if account and account.roster_revision
            else None
        )
        if roster is None or not account.recovery_confirmed_at:
            raise HTTPException(
                status_code=409, detail="Не все участники настроили защищённую переписку"
            )
        result.extend(
            d.device_id for d in RosterPayload.model_validate_json(roster.payload).devices
        )
    if len(result) > 100 or len(set(result)) != len(result):
        raise HTTPException(status_code=409, detail="В беседе слишком много устройств")
    return sorted(result)


async def lease(session, user, conversation_id: UUID, body: LeaseRequest) -> dict:
    await active_device(session, user, body.device_id)
    conversation = await secure_conversation(session, user, conversation_id, lock=True)
    accepted = await session.get(MlsEvent, body.request_id)
    if accepted:
        if accepted.conversation_id != conversation_id or accepted.device_id != body.device_id:
            raise HTTPException(status_code=409, detail="Идентификатор запроса уже использован")
        return {"accepted": True, "event": await event_view(session, accepted)}
    state = await session.get(MlsState, conversation_id)
    if state is None:
        state = MlsState(
            conversation_id=conversation_id, sequence=0, epoch=0, generation=0, roster="[]"
        )
        session.add(state)
        await session.flush()
    now = datetime.now(UTC)
    if state.lease_expires_at and state.lease_expires_at.replace(tzinfo=UTC) > now:
        if state.lease_device_id == body.device_id and state.lease_request_id == body.request_id:
            return json.loads(state.lease_payload)
        raise HTTPException(
            status_code=409,
            detail="Другая отправка ещё выполняется. Повтори через секунду",
            headers={"Retry-After": "1"},
        )
    desired = await desired_devices(session, conversation)
    if body.device_id not in desired:
        raise HTTPException(status_code=403, detail="Устройство не входит в беседу")
    current = [UUID(x) for x in json.loads(state.roster)]
    if body.operation == "reset" and body.device_id in current:
        raise HTTPException(
            status_code=409, detail="Это устройство уже участвует в защищённой сессии"
        )
    if body.operation in ("init", "reset", "add"):
        recent = await session.scalar(
            select(func.count())
            .select_from(MlsEvent)
            .where(
                MlsEvent.device_id == body.device_id,
                MlsEvent.created_at > now - timedelta(hours=1),
                MlsEvent.message_id.is_(None),
            )
        )
        if (recent or 0) >= 20:
            raise HTTPException(
                status_code=429, detail="Слишком много изменений защищённых сессий. Повтори позже"
            )
    if body.operation == "init" and state.group_id is not None:
        raise HTTPException(status_code=409, detail="Защищённая сессия уже создана")
    if body.operation in ("add", "message") and (
        state.group_id is None or body.device_id not in current
    ):
        raise HTTPException(
            status_code=409, detail="Для этого устройства нужна новая защищённая сессия"
        )
    if body.operation == "message" and set(current) != set(desired):
        raise HTTPException(status_code=409, detail="Сначала синхронизируй новые устройства")
    targets = (
        [d for d in desired if d != body.device_id]
        if body.operation in ("init", "reset")
        else [d for d in desired if d not in current]
        if body.operation == "add"
        else []
    )
    if body.operation == "add" and (not targets or not set(current) <= set(desired)):
        raise HTTPException(status_code=409, detail="Состав защищённой сессии изменился")
    lease_id = uuid4()
    expires = now + timedelta(minutes=2)
    packages = []
    for target in targets:
        package = await session.scalar(
            select(MlsPackage)
            .where(
                MlsPackage.device_id == target,
                MlsPackage.consumed_at.is_(None),
                MlsPackage.expires_at > now,
                or_(MlsPackage.reserved_until.is_(None), MlsPackage.reserved_until < now),
            )
            .order_by(MlsPackage.created_at, MlsPackage.id)
            .with_for_update(skip_locked=True)
            .limit(1)
        )
        if package is None:
            raise HTTPException(
                status_code=409,
                detail="Откройте Когерент на устройствах участников, чтобы подготовить ключи",
            )
        package.consumed_at = now  # Burn even abandoned candidates.
        package.reserved_id = lease_id
        package.reserved_until = expires
        packages.append({"id": package.id, "device_id": str(target), "wire": package.wire})
    group_id = uuid4() if body.operation in ("init", "reset") else state.group_id
    response = {
        "accepted": False,
        "lease_id": str(lease_id),
        "nonce": base64.b64encode(secrets.token_bytes(32)).decode(),
        "request_id": str(body.request_id),
        "operation": body.operation,
        "group_id": str(group_id),
        "expected_sequence": state.sequence,
        "previous_epoch": 0 if body.operation in ("init", "reset") else state.epoch,
        "roster": [str(d) for d in desired],
        "targets": [str(d) for d in targets],
        "packages": packages,
        "expires_at": expires.isoformat(),
    }
    state.lease_id = lease_id
    state.lease_device_id = body.device_id
    state.lease_request_id = body.request_id
    state.lease_nonce = response["nonce"]
    state.lease_expires_at = expires
    state.lease_payload = json.dumps(response, separators=(",", ":"))
    await session.commit()
    return response


async def event_view(session, event: MlsEvent) -> dict:
    device = await session.get(E2eeDevice, event.device_id)
    assert device is not None
    return {
        "id": str(event.id),
        "sequence": event.sequence,
        "payload": event.payload,
        "nonce": event.nonce,
        "proof": event.proof,
        "sender": {
            "version": 1,
            "account_id": str(device.user_id),
            "device_id": str(device.id),
            "signature_key": device.signature_key,
        },
        "created_at": event.created_at.isoformat(),
    }


async def events(session, user, conversation_id: UUID, device_id: UUID, after: int) -> dict:
    await active_device(session, user, device_id)
    await secure_conversation(session, user, conversation_id)
    page = list(
        await session.scalars(
            select(MlsEvent)
            .where(MlsEvent.conversation_id == conversation_id, MlsEvent.sequence > after)
            .order_by(MlsEvent.sequence)
            .limit(101)
        )
    )
    return {
        "events": [await event_view(session, e) for e in page[:100]],
        "has_more": len(page) > 100,
    }


async def save_cipher_files(
    session, settings, files: list[UploadFile], descriptors, message: Message
) -> list[Path]:
    if (
        len(files) != len(descriptors)
        or sum(d.byte_size for d in descriptors) > 50 * 1024 * 1024 + 16384
        or len({d.id for d in descriptors}) != len(descriptors)
    ):
        raise HTTPException(status_code=400, detail="Неверный набор зашифрованных файлов")
    if not files:
        return []
    directory = Path(settings.attachment_dir)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if session.get_bind().dialect.name == "postgresql":
        await session.execute(text("SELECT pg_advisory_xact_lock(77814021)"))
    required = sum(d.byte_size for d in descriptors)
    if (
        attachment_storage_bytes(directory) + required
        > settings.attachment_storage_limit_mb * 1024 * 1024
        or shutil.disk_usage(directory).free - required
        < settings.attachment_min_free_mb * 1024 * 1024
    ):
        raise HTTPException(status_code=507, detail="Хранилище файлов заполнено. Попробуй позже")
    stored = []
    try:
        for upload, descriptor in zip(files, descriptors, strict=True):
            if upload.filename != str(descriptor.id):
                raise HTTPException(status_code=400, detail="Идентификатор файла не совпадает")
            path = directory / str(descriptor.id)
            size = 0
            hasher = hashlib.sha256()
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError as e:
                raise HTTPException(
                    status_code=409, detail="Идентификатор файла уже использован"
                ) from e
            stored.append(path)
            with os.fdopen(fd, "wb") as target:
                while chunk := await upload.read(1024 * 1024):
                    size += len(chunk)
                    if size > descriptor.byte_size:
                        raise HTTPException(status_code=400, detail="Размер файла не совпадает")
                    hasher.update(chunk)
                    target.write(chunk)
                target.flush()
                os.fsync(target.fileno())
            if (
                size != descriptor.byte_size
                or base64.b64encode(hasher.digest()).decode() != descriptor.digest
            ):
                raise HTTPException(status_code=400, detail="Повреждён зашифрованный файл")
            session.add(
                MessageAttachment(
                    id=descriptor.id,
                    message_id=message.id,
                    filename="encrypted-file",
                    media_type="application/octet-stream",
                    byte_size=size,
                    encrypted=False,
                    client_encrypted=True,
                )
            )
        return stored
    except BaseException:
        for path in stored:
            path.unlink(missing_ok=True)
        raise


async def publish(
    session,
    user,
    settings,
    conversation_id: UUID,
    device_id: UUID,
    payload: str,
    proof: str,
    files: list[UploadFile],
) -> dict:
    body = TransportPayload.model_validate_json(payload)
    if body.conversation_id != conversation_id:
        raise HTTPException(status_code=400, detail="Беседа не совпадает")
    device = await active_device(session, user, device_id)
    conversation = await secure_conversation(session, user, conversation_id, lock=True)
    existing = await session.get(MlsEvent, body.request_id)
    request_hash = digest(payload.encode() + proof.encode())
    if existing:
        if (
            existing.device_id != device_id
            or existing.request_hash != request_hash
            or existing.conversation_id != conversation_id
        ):
            raise HTTPException(status_code=409, detail="Повторный запрос отличается от принятого")
        return {**await event_view(session, existing), "duplicate": True}
    state = await session.get(MlsState, conversation_id)
    now = datetime.now(UTC)
    if (
        state is None
        or state.lease_id != body.lease_id
        or state.lease_device_id != device_id
        or state.lease_request_id != body.request_id
        or not state.lease_expires_at
        or state.lease_expires_at.replace(tzinfo=UTC) <= now
    ):
        raise HTTPException(
            status_code=409, detail="Разрешение на отправку истекло. Синхронизируй беседу"
        )
    assert state.lease_nonce and state.lease_payload
    action_signature(device, state.lease_nonce, payload, proof)
    lease_data = json.loads(state.lease_payload)
    desired = await desired_devices(session, conversation)
    if (
        body.expected_sequence != state.sequence
        or body.expected_sequence != lease_data["expected_sequence"]
        or str(body.group_id) != lease_data["group_id"]
        or body.previous_epoch != lease_data["previous_epoch"]
        or ("message" if body.operation == "migrate" else body.operation) != lease_data["operation"]
        or [str(d) for d in body.roster] != lease_data["roster"]
        or set(body.roster) != set(desired)
        or [str(d) for d in body.targets] != lease_data["targets"]
        or body.package_ids != [p["id"] for p in lease_data["packages"]]
    ):
        raise HTTPException(status_code=409, detail="Состав или версия беседы изменились")
    message = None
    old_paths = []
    migrating = body.operation == "migrate"
    if body.operation in ("message", "migrate"):
        packet = body.message
        if (
            packet is None
            or body.commit is not None
            or body.welcome is not None
            or packet.epoch != state.epoch
            or packet.context.conversation_id != body.group_id
            or packet.context.sender_account_id != user.id
            or packet.context.sender_device_id != device_id
            or set(packet.backups) != set(await conversation_member_ids(session, conversation))
            or any(k != v.recipient for k, v in packet.backups.items())
        ):
            raise HTTPException(status_code=400, detail="Неверный защищённый пакет сообщения")
        original = await session.get(Message, packet.context.message_id, with_for_update=True)
        if migrating:
            if (
                original is None
                or original.conversation_id != conversation_id
                or original.sender_id != user.id
                or original.mls_payload is not None
            ):
                raise HTTPException(status_code=409, detail="Облачное сообщение уже изменилось")
            from coherent_api.services.attachment_cleanup import is_expired

            source = list(
                await session.scalars(
                    select(MessageAttachment).where(MessageAttachment.message_id == original.id)
                )
            )
            expired = original.attachments_expired or is_expired(original.created_at)
            expected = set() if expired else {a.id for a in source}
            if (
                body.source_files is None
                or set(body.source_files) != expected
                or len(body.source_files) != len(expected)
            ):
                raise HTTPException(
                    status_code=409, detail="Вложения облачного сообщения изменились"
                )
            old_paths = [Path(settings.attachment_dir) / str(a.id) for a in source]
            await session.execute(
                delete(MessageAttachment).where(MessageAttachment.message_id == original.id)
            )
        elif original is not None or body.source_files is not None:
            raise HTTPException(status_code=409, detail="Идентификатор сообщения уже использован")
        message = Message(
            id=packet.context.message_id,
            conversation_id=conversation_id,
            sender_id=user.id,
            body="Зашифрованное сообщение",
            body_ciphertext=None,
            attachment_count=len(body.files),
            mls_payload=json.dumps(
                {
                    "payload": payload,
                    "nonce": state.lease_nonce,
                    "proof": proof,
                    "sender": {
                        "version": 1,
                        "account_id": str(user.id),
                        "device_id": str(device_id),
                        "signature_key": device.signature_key,
                    },
                },
                separators=(",", ":"),
            ),
        )
        if migrating:
            original.body = message.body
            original.body_ciphertext = None
            original.mls_payload = message.mls_payload
            original.attachment_count = message.attachment_count
            original.attachments_expired = expired
            message = original
        else:
            session.add(message)
        await session.flush()
    else:
        if (
            not body.commit
            or not body.welcome
            or body.message is not None
            or body.files
            or files
            or body.source_files is not None
        ):
            raise HTTPException(status_code=400, detail="Неверный пакет изменения MLS")
        for value in (body.commit, body.welcome):
            try:
                base64.b64decode(value, validate=True)
            except ValueError as error:
                raise HTTPException(status_code=400, detail="Неверное кодирование MLS") from error
        for package_id in body.package_ids:
            package = await session.get(MlsPackage, package_id, with_for_update=True)
            if (
                package is None
                or package.reserved_id != state.lease_id
                or package.consumed_at is None
            ):
                raise HTTPException(status_code=409, detail="Одноразовый пакет уже использован")
            package.consumed_at = now
            package.wire = ""
            package.reserved_id = None
            package.reserved_until = None
        if body.operation in ("init", "reset"):
            state.generation += 1
        state.group_id = body.group_id
        state.epoch = body.previous_epoch + 1
        state.roster = json.dumps([str(x) for x in body.roster])
    await allocate_storage(session, settings, len(payload.encode()) * (2 if message else 1) + 4096)
    stored = []
    try:
        if message:
            stored = await save_cipher_files(session, settings, files, body.files, message)
        state.sequence += 1
        event = MlsEvent(
            id=body.request_id,
            conversation_id=conversation_id,
            sequence=state.sequence,
            group_id=body.group_id,
            device_id=device_id,
            payload=payload,
            nonce=state.lease_nonce,
            proof=proof,
            request_hash=request_hash,
            created_at=now,
            message_id=message.id if message else None,
        )
        session.add(event)
        state.lease_id = None
        state.lease_device_id = None
        state.lease_request_id = None
        state.lease_nonce = None
        state.lease_expires_at = None
        state.lease_payload = None
        if not migrating:
            conversation.updated_at = now
        await session.commit()
    except BaseException:
        await session.rollback()
        for path in stored:
            path.unlink(missing_ok=True)
        raise
    for path in old_paths:
        path.unlink(missing_ok=True)
    return await event_view(session, event)
