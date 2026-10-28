"""Recovery enrollment and root-authenticated device rosters; no private keys."""

import base64
import hashlib
import json
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from pydantic import ValidationError
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from coherent_api.api.dependencies import CurrentUser, SessionDep
from coherent_api.core.security import verify_password_async
from coherent_api.models.e2ee import AccountRoster, DeviceChallenge, E2eeAccount, E2eeDevice
from coherent_api.models.user import User
from coherent_api.schemas.e2ee import (
    BootstrapRequest,
    ChallengeRequest,
    ContactPinsRequest,
    DeviceProofRequest,
    EnrollPayload,
    EnrollRequest,
    RosterPayload,
)
from coherent_api.services.auth_security import throttle
from coherent_api.services.email_verification import send_recovery_notice


async def legacy_security_gate(request: Request, user: CurrentUser, session: SessionDep):
    from coherent_api.services.crypto_policy import cloud_chats

    if request.url.path.endswith(("/security/status", "/security/challenges")):
        return
    if await cloud_chats(session):
        raise HTTPException(
            409, "Обнови клиент: ключ восстановления для облачной переписки не требуется"
        )


router = APIRouter(
    prefix="/security",
    tags=["Устройства и восстановление"],
    dependencies=[Depends(legacy_security_gate)],
)


def require_available(request: Request) -> None:
    if not request.app.state.settings.e2ee_setup_enabled:
        raise HTTPException(
            status_code=409, detail="Настройка новой защищённой переписки ещё не включена"
        )


@router.get("/status")
async def security_status(request: Request, user: CurrentUser, session: SessionDep) -> dict:
    from coherent_api.services.crypto_policy import chat_policy, cloud_chats

    cloud = await cloud_chats(session)
    policy = await chat_policy(session)
    account = await session.get(E2eeAccount, user.id)
    devices = list(
        await session.scalars(
            select(E2eeDevice).where(
                E2eeDevice.user_id == user.id,
                E2eeDevice.revoked_at.is_(None),
                E2eeDevice.call_id.is_(None),
            )
        )
    )
    return {
        "setup_available": request.app.state.settings.e2ee_setup_enabled and not cloud,
        "history_revision": str(policy.history_revision) if policy else None,
        "call_encryption": "ephemeral_mls_v1" if cloud else "account_mls_v1",
        "configured": account is not None,
        "recovery_confirmed": bool(account and account.recovery_confirmed_at),
        "chat_encryption": "mls"
        if request.app.state.settings.e2ee_messaging_enabled and not cloud
        else "cloud_v1",
        "roster_revision": account.roster_revision if account else 0,
        "devices": [
            {
                "id": str(d.id),
                "label": d.label,
                "platform": d.platform,
                "approved_at": d.approved_at.isoformat(),
            }
            for d in devices
        ],
    }


@router.post("/challenges")
async def device_challenge(
    body: ChallengeRequest, request: Request, user: CurrentUser, session: SessionDep
) -> dict:
    from coherent_api.services.crypto_policy import cloud_chats

    if body.call_id:
        from coherent_api.services.call_devices import joined_call

        if body.purpose != "action":
            raise HTTPException(400, "Ключ звонка разрешает только действия звонка")
        await joined_call(session, user, body.call_id)
    elif await cloud_chats(session):
        raise HTTPException(409, "Переписка использует облачное шифрование; обнови клиент")
    else:
        require_available(request)
    await session.scalar(select(User).where(User.id == user.id).with_for_update(key_share=True))
    await throttle(session, "device-challenges", str(user.id), 240, 60)
    now = datetime.now(UTC)
    await session.execute(delete(DeviceChallenge).where(DeviceChallenge.expires_at < now))
    challenge = DeviceChallenge(
        id=uuid4(),
        user_id=user.id,
        purpose=body.purpose,
        nonce=base64.b64encode(secrets.token_bytes(32)).decode(),
        session_version=user.session_version,
        attempts=0,
        created_at=now,
        expires_at=now + timedelta(minutes=5),
        call_id=body.call_id,
    )
    session.add(challenge)
    await session.commit()
    return {"challenge_id": str(challenge.id), "nonce": challenge.nonce}


async def verify_device_request(
    session,
    user,
    identity: UUID,
    device_id: UUID,
    public: str,
    proof: str,
    password: str,
    purpose: str,
    payload_hash: bytes = bytes(32),
    require_password: bool = True,
    call_id: UUID | None = None,
) -> None:
    await session.scalar(
        select(User)
        .where(User.id == user.id)
        .with_for_update(key_share=True)
        .execution_options(populate_existing=True)
    )
    challenge = await session.scalar(
        select(DeviceChallenge)
        .where(
            DeviceChallenge.id == identity,
            DeviceChallenge.user_id == user.id,
            DeviceChallenge.purpose == purpose,
        )
        .with_for_update()
    )
    now = datetime.now(UTC)
    if (
        challenge is None
        or challenge.consumed_at is not None
        or challenge.expires_at.replace(tzinfo=UTC) <= now
        or challenge.session_version != user.session_version
        or challenge.attempts >= 5
        or challenge.call_id != call_id
    ):
        raise HTTPException(
            status_code=403, detail="Подтверждение устройства истекло. Повтори действие"
        )
    challenge.attempts += 1
    valid = False
    try:
        public_bytes = base64.b64decode(public, validate=True)
        signed = (
            b"coherent/device-proof/v1\0"
            + purpose.encode()
            + b"\0"
            + user.id.bytes
            + device_id.bytes
            + public_bytes
            + base64.b64decode(challenge.nonce, validate=True)
            + payload_hash
        )
        Ed25519PublicKey.from_public_bytes(public_bytes).verify(
            base64.b64decode(proof, validate=True), signed
        )
        valid = not require_password or await verify_password_async(password, user.password_hash)
    except (ValueError, InvalidSignature):
        pass
    if not valid:
        await session.commit()
        raise HTTPException(
            status_code=403, detail="Не удалось подтвердить пароль и доверенное устройство"
        )
    challenge.consumed_at = now


@router.post("/bootstrap", status_code=201)
async def bootstrap_recovery(
    body: BootstrapRequest, request: Request, user: CurrentUser, session: SessionDep
) -> dict:
    require_available(request)
    if not user.email_verified or body.device.account_id != user.id:
        raise HTTPException(status_code=403, detail="Сначала подтверди почту этого аккаунта")
    digest = hashlib.sha256(
        b"coherent/bootstrap-backup/v1\0"
        + base64.b64decode(body.backup.nonce)
        + base64.b64decode(body.backup.ciphertext)
        + base64.b64decode(body.recovery_public_key)
    ).digest()
    await verify_device_request(
        session,
        user,
        body.challenge_id,
        body.device.device_id,
        body.device.signature_key,
        body.proof,
        body.current_password.get_secret_value(),
        "bootstrap",
        digest,
    )
    account = await session.get(E2eeAccount, user.id)
    if account is not None:
        # Network retries may repeat exactly the first device's existing setup.
        device = await session.get(E2eeDevice, body.device.device_id)
        if (
            account.first_device_id == body.device.device_id
            and device
            and device.user_id == user.id
            and device.signature_key == body.device.signature_key
            and device.revoked_at is None
            and account.recovery_backup == body.backup.model_dump_json()
            and account.recovery_public_key == body.recovery_public_key
        ):
            await session.commit()
            return {"configured": True}
        raise HTTPException(
            status_code=409,
            detail="Аккаунт уже настроен. Новое устройство нужно подтвердить с доверенного",
        )
    if await session.get(E2eeDevice, body.device.device_id) is not None:
        raise HTTPException(status_code=409, detail="Идентификатор устройства уже используется")
    session.add(
        E2eeAccount(
            user_id=user.id,
            first_device_id=body.device.device_id,
            recovery_backup=body.backup.model_dump_json(),
            recovery_public_key=body.recovery_public_key,
            revision=1,
        )
    )
    session.add(
        E2eeDevice(
            id=body.device.device_id,
            user_id=user.id,
            signature_key=body.device.signature_key,
            label=body.label,
            platform=body.platform,
            approved_at=datetime.now(UTC),
        )
    )
    try:
        await session.commit()
    except IntegrityError as error:
        await session.rollback()
        raise HTTPException(
            status_code=409, detail="Данные устройства изменились, повтори настройку"
        ) from error
    return {"configured": True}


async def authorize_trusted(
    body: DeviceProofRequest, request, user, session, purpose: str
) -> E2eeDevice:
    require_available(request)
    device = await session.get(E2eeDevice, body.device_id)
    if device is None or device.user_id != user.id or device.revoked_at is not None:
        raise HTTPException(status_code=403, detail="Это устройство ещё не подтверждено")
    await verify_device_request(
        session,
        user,
        body.challenge_id,
        device.id,
        device.signature_key,
        body.proof,
        body.current_password.get_secret_value(),
        purpose,
    )
    return device


@router.post("/recovery/authorize")
async def authorize_recovery_view(
    body: DeviceProofRequest, request: Request, user: CurrentUser, session: SessionDep
) -> dict:
    await authorize_trusted(body, request, user, session, "recovery_view")
    await session.commit()
    return {"authorized": True, "account_id": str(user.id), "device_id": str(body.device_id)}


@router.post("/recovery/confirm")
async def confirm_recovery_saved(
    body: DeviceProofRequest,
    request: Request,
    user: CurrentUser,
    session: SessionDep,
    background: BackgroundTasks,
) -> dict:
    await authorize_trusted(body, request, user, session, "confirm_recovery")
    account = await session.get(E2eeAccount, user.id)
    if account is None:
        raise HTTPException(status_code=409, detail="Настройка восстановления не завершена")
    first_confirmation = account.recovery_confirmed_at is None
    account.recovery_confirmed_at = datetime.now(UTC)
    await session.commit()
    if first_confirmation and user.email and user.email_verified:
        background.add_task(send_recovery_notice, request.app.state.settings, user.email)
    return {"confirmed": True}


@router.get("/recovery/material")
async def recovery_material(request: Request, user: CurrentUser, session: SessionDep) -> dict:
    require_available(request)
    account = await session.get(E2eeAccount, user.id)
    if account is None:
        raise HTTPException(
            status_code=409, detail="Сначала настрой ключ восстановления на первом устройстве"
        )
    rosters = list(
        await session.scalars(
            select(AccountRoster)
            .where(
                AccountRoster.user_id == user.id, AccountRoster.revision >= account.root_revision
            )
            .order_by(AccountRoster.revision)
        )
    )
    return {
        "public_key": account.recovery_public_key,
        "backup": json.loads(account.recovery_backup),
        "rosters": [{"payload": r.payload, "signature": r.signature} for r in rosters],
    }


@router.post("/devices/enroll")
async def enroll_device(
    body: EnrollRequest, request: Request, user: CurrentUser, session: SessionDep
) -> dict:
    """An authenticated login is insufficient: require a root-signed roster and device possession.

    The recovery mnemonic and decrypted archive root never enter this endpoint.
    """
    require_available(request)
    if body.device.account_id != user.id:
        raise HTTPException(status_code=403, detail="Устройство другого аккаунта")
    try:
        payload = EnrollPayload.model_validate_json(body.payload)
        roster = RosterPayload.model_validate_json(payload.roster.payload)
    except ValidationError as error:
        raise HTTPException(
            status_code=400, detail="Неверный формат подтверждения устройства"
        ) from error
    await session.scalar(select(User).where(User.id == user.id).with_for_update(key_share=True))
    account = await session.get(E2eeAccount, user.id)
    if account is None or roster.account_id != user.id:
        raise HTTPException(
            status_code=409, detail="Аккаунт ещё не подготовлен к защищённой переписке"
        )
    device = await session.get(E2eeDevice, body.device.device_id)
    existing = bool(
        device
        and device.user_id == user.id
        and device.signature_key == body.device.signature_key
        and device.revoked_at is None
    )
    link = None
    if body.link_id is not None and not existing:
        from coherent_api.models.device_link import DeviceLink
        from coherent_api.schemas.e2ee import DeviceBinding

        link = await session.get(DeviceLink, body.link_id, with_for_update=True)
        if (
            link is None
            or link.user_id != user.id
            or link.session_version != user.session_version
            or link.status != "delivered"
            or link.expires_at.replace(tzinfo=UTC) <= datetime.now(UTC)
            or link.new_device_id != body.device.device_id
            or DeviceBinding.model_validate_json(link.new_device) != body.device
        ):
            raise HTTPException(status_code=403, detail="Подтверждение другого устройства истекло")
        from coherent_api.services.mls import active_device

        await active_device(session, user, link.approver_id)
    await verify_device_request(
        session,
        user,
        body.challenge_id,
        body.device.device_id,
        body.device.signature_key,
        body.proof,
        body.current_password.get_secret_value(),
        "action",
        hashlib.sha256(body.payload.encode()).digest(),
        require_password=not existing and link is None,
    )
    try:
        signed = b"coherent/account-roster/v1\0" + payload.roster.payload.encode()
        Ed25519PublicKey.from_public_bytes(
            base64.b64decode(account.recovery_public_key, validate=True)
        ).verify(base64.b64decode(payload.roster.signature, validate=True), signed)
        for value in (roster.archive_public_key, roster.previous_hash):
            if len(base64.b64decode(value, validate=True)) != 32:
                raise ValueError("public encoding")
    except (ValueError, InvalidSignature) as error:
        raise HTTPException(
            status_code=403, detail="Ключ восстановления не подтвердил устройство"
        ) from error
    digest = base64.b64encode(
        hashlib.sha256(
            b"coherent/account-roster/v1\0"
            + payload.roster.payload.encode()
            + payload.roster.signature.encode()
        ).digest()
    ).decode()
    previous = (
        await session.get(AccountRoster, (user.id, account.roster_revision))
        if account.roster_revision
        else None
    )
    if previous and previous.digest == digest:
        if not existing:
            raise HTTPException(status_code=409, detail="Устройство не зарегистрировано")
        await session.commit()
        return {"approved": True, "device_id": str(device.id), "revision": previous.revision}
    if roster.revision != account.roster_revision + 1 or roster.previous_hash != (
        previous.digest if previous else base64.b64encode(bytes(32)).decode()
    ):
        raise HTTPException(
            status_code=409, detail="Список устройств изменился. Повтори подтверждение"
        )
    by_id = {d.device_id: d for d in roster.devices}
    if (
        len(by_id) != len(roster.devices)
        or len({d.signature_key for d in roster.devices}) != len(by_id)
        or any(d.account_id != user.id for d in roster.devices)
        or by_id.get(body.device.device_id) != body.device
    ):
        raise HTTPException(status_code=403, detail="Недопустимый состав устройств")
    known = list(await session.scalars(select(E2eeDevice).where(E2eeDevice.user_id == user.id)))
    # Addition only: revocation must rotate recovery/archival credentials before release.
    if set(by_id) != {d.id for d in known if d.revoked_at is None} | {body.device.device_id}:
        raise HTTPException(
            status_code=403, detail="Подтверждать можно только текущее новое устройство"
        )
    for d in known:
        if d.revoked_at is not None:
            continue
        if d.id not in by_id or d.signature_key != by_id[d.id].signature_key:
            raise HTTPException(
                status_code=403, detail="Существующие ключи устройств менять нельзя"
            )
    if previous:
        before = RosterPayload.model_validate_json(previous.payload)
        if (
            before.archive_public_key != roster.archive_public_key
            or before.history_roots != roster.history_roots
        ):
            raise HTTPException(status_code=403, detail="Ключ архива не совпадает")
    if device is not None and not existing:
        raise HTTPException(status_code=409, detail="Идентификатор устройства уже занят")
    if not existing:
        if not user.email_verified:
            raise HTTPException(status_code=403, detail="Сначала подтверди почту")
        session.add(
            E2eeDevice(
                id=body.device.device_id,
                user_id=user.id,
                signature_key=body.device.signature_key,
                label=payload.label.strip()[:64],
                platform=payload.platform,
                approved_at=datetime.now(UTC),
            )
        )
    session.add(
        AccountRoster(
            user_id=user.id,
            revision=roster.revision,
            payload=payload.roster.payload,
            signature=payload.roster.signature,
            digest=digest,
            signer_public_key=account.recovery_public_key,
        )
    )
    from coherent_api.services.mls import allocate_storage

    await allocate_storage(
        session, request.app.state.settings, len(payload.roster.payload.encode()) + 2048
    )
    account.roster_revision = roster.revision
    if link is not None:
        link.status = "completed"
        link.request = None
        link.response = None
        link.finalization = None
        link.envelope = None
    await session.commit()
    from coherent_api.services.security_events import notify_security

    await notify_security(request, session, user)
    return {"approved": True, "device_id": str(body.device.device_id), "revision": roster.revision}


@router.get("/contacts")
async def contact_pins(user: CurrentUser, session: SessionDep) -> dict:
    from coherent_api.models.e2ee import ContactPin

    pins = list(await session.scalars(select(ContactPin).where(ContactPin.user_id == user.id)))
    return {
        "pins": [
            {"account_id": str(p.account_id), "public_key": p.public_key, "proof": p.proof}
            for p in pins
        ]
    }


@router.post("/contacts")
async def save_contact_pins(
    body: ContactPinsRequest, request: Request, user: CurrentUser, session: SessionDep
) -> dict:
    from coherent_api.models.e2ee import ContactPin
    from coherent_api.services.mls import active_device, allocate_storage

    await active_device(session, user, body.device_id)
    await session.scalar(select(User).where(User.id == user.id).with_for_update(key_share=True))
    account = await session.get(E2eeAccount, user.id)
    assert account is not None
    known = list(await session.scalars(select(ContactPin).where(ContactPin.user_id == user.id)))
    by_id = {p.account_id: p for p in known}
    added = 0
    for pin in body.pins:
        if pin.account_id == user.id:
            raise HTTPException(status_code=400, detail="Неверный контакт")
        try:
            key = base64.b64decode(pin.public_key, validate=True)
            if len(key) != 32:
                raise ValueError("key")
            data = b"coherent/contact-pin/v1\0" + user.id.bytes + pin.account_id.bytes + key
            Ed25519PublicKey.from_public_bytes(
                base64.b64decode(account.recovery_public_key, validate=True)
            ).verify(base64.b64decode(pin.proof, validate=True), data)
        except (ValueError, InvalidSignature) as error:
            raise HTTPException(
                status_code=403, detail="Подтверждение контакта недействительно"
            ) from error
        old = by_id.get(pin.account_id)
        if old:
            old.public_key = pin.public_key
            old.proof = pin.proof
        else:
            if len(by_id) >= 1000:
                raise HTTPException(status_code=409, detail="Достигнут предел ключей контактов")
            if await session.get(User, pin.account_id) is None:
                raise HTTPException(status_code=404, detail="Контакт не найден")
            row = ContactPin(
                user_id=user.id,
                account_id=pin.account_id,
                public_key=pin.public_key,
                proof=pin.proof,
            )
            session.add(row)
            by_id[pin.account_id] = row
            added += 1
    await allocate_storage(session, request.app.state.settings, added * 1024)
    await session.commit()
    return {"saved": True}


@router.post("/devices/reset-trust")
async def reset_device_trust(
    body: EnrollRequest,
    request: Request,
    response: Response,
    user: CurrentUser,
    session: SessionDep,
):
    """Rotate archive/recovery roots and require every other device to pair again."""
    from sqlalchemy import exists, or_, update

    from coherent_api.api.v1.auth import set_session_cookies
    from coherent_api.models.conversation import Conversation
    from coherent_api.models.conversation_member import ConversationMember
    from coherent_api.models.device_link import DeviceLink
    from coherent_api.models.e2ee import ContactPin
    from coherent_api.models.mls import MlsState
    from coherent_api.models.server import ServerChannel
    from coherent_api.schemas.e2ee import RotationPayload
    from coherent_api.services.mls import active_device, allocate_storage, digest

    require_available(request)
    device = await active_device(session, user, body.device.device_id)
    if body.device.account_id != user.id or body.device.signature_key != device.signature_key:
        raise HTTPException(403, "Ключ устройства не совпадает")
    try:
        payload = RotationPayload.model_validate_json(body.payload)
        roster = RosterPayload.model_validate_json(payload.roster.payload)
    except ValidationError:
        raise HTTPException(400, "Неверные данные смены ключа") from None
    await verify_device_request(
        session,
        user,
        body.challenge_id,
        device.id,
        device.signature_key,
        body.proof,
        body.current_password.get_secret_value(),
        "action",
        hashlib.sha256(body.payload.encode()).digest(),
    )
    account = await session.get(E2eeAccount, user.id, with_for_update=True)
    previous = await session.get(AccountRoster, (user.id, account.roster_revision))
    if previous is None:
        raise HTTPException(409, "Сначала настрой доверенное устройство")
    before = RosterPayload.model_validate_json(previous.payload)
    expected_history = list(dict.fromkeys([*before.history_roots, account.recovery_public_key]))
    if (
        roster.account_id != user.id
        or roster.revision != account.roster_revision + 1
        or roster.previous_hash != previous.digest
        or roster.devices != [body.device]
        or roster.history_roots != expected_history
        or payload.public_key == account.recovery_public_key
        or roster.archive_public_key == before.archive_public_key
    ):
        raise HTTPException(409, "Список устройств изменился. Повтори смену ключа")
    try:
        public = base64.b64decode(payload.public_key, validate=True)
        if len(public) != 32:
            raise ValueError()
        Ed25519PublicKey.from_public_bytes(public).verify(
            base64.b64decode(payload.roster.signature, validate=True),
            b"coherent/account-roster/v1\0" + payload.roster.payload.encode(),
        )
    except (ValueError, InvalidSignature):
        raise HTTPException(403, "Новый ключ не подтвердил смену") from None
    now = datetime.now(UTC)
    await session.execute(
        update(E2eeDevice)
        .where(
            E2eeDevice.user_id == user.id,
            E2eeDevice.id != device.id,
            E2eeDevice.revoked_at.is_(None),
        )
        .values(revoked_at=now)
    )
    await session.execute(delete(ContactPin).where(ContactPin.user_id == user.id))
    await session.execute(
        update(DeviceLink)
        .where(
            DeviceLink.user_id == user.id,
            DeviceLink.status.not_in(["completed", "expired", "cancelled", "rejected"]),
        )
        .values(status="cancelled", request=None, response=None, finalization=None, envelope=None)
    )
    conversations = select(Conversation.id).where(
        ~exists(select(ServerChannel.id).where(ServerChannel.conversation_id == Conversation.id)),
        or_(
            Conversation.user_low_id == user.id,
            Conversation.user_high_id == user.id,
            exists(
                select(ConversationMember.user_id).where(
                    ConversationMember.conversation_id == Conversation.id,
                    ConversationMember.user_id == user.id,
                )
            ),
        ),
    )
    await session.execute(
        update(MlsState)
        .where(MlsState.conversation_id.in_(conversations))
        .values(
            group_id=None,
            epoch=0,
            roster="[]",
            lease_id=None,
            lease_device_id=None,
            lease_request_id=None,
            lease_nonce=None,
            lease_payload=None,
            lease_expires_at=None,
        )
    )
    account.recovery_public_key = payload.public_key
    account.recovery_backup = payload.backup.model_dump_json()
    account.roster_revision = roster.revision
    account.root_revision = roster.revision
    account.revision += 1
    account.recovery_confirmed_at = None
    session.add(
        AccountRoster(
            user_id=user.id,
            revision=roster.revision,
            payload=payload.roster.payload,
            signature=payload.roster.signature,
            digest=digest(
                b"coherent/account-roster/v1\0"
                + payload.roster.payload.encode()
                + payload.roster.signature.encode()
            ),
            signer_public_key=payload.public_key,
        )
    )
    await allocate_storage(session, request.app.state.settings, len(body.payload.encode()) + 2048)
    user.session_version += 1
    await session.commit()
    await set_session_cookies(response, user, request, session)
    from coherent_api.models.call import Call
    from coherent_api.models.call_member import CallMember
    from coherent_api.services.calls import end_call
    from coherent_api.services.livekit_media import remove_livekit_participant

    active_calls = list(
        await session.scalars(
            select(Call.id)
            .join(CallMember, CallMember.call_id == Call.id)
            .where(
                CallMember.user_id == user.id,
                CallMember.state.in_(["joined", "invited"]),
                Call.status.in_(["ringing", "active"]),
            )
        )
    )
    for call_id in active_calls:
        call, _ = await end_call(session, user, call_id, force=True)
        await remove_livekit_participant(request.app.state.settings, call_id, user.id)
        await request.app.state.message_events.publish(
            tuple(person.user_id for person in call.participants),
            {"type": "call", "call": call.model_dump(mode="json")},
        )
    await request.app.state.message_events.disconnect(user.id, code=4001)
    await request.app.state.message_events.publish_all({"type": "security"})
    return {"rotated": True, "public_key": payload.public_key}
