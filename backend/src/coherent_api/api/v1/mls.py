import base64
import hashlib
import json
from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, Request, UploadFile
from pydantic import Field, ValidationError
from sqlalchemy import func, select

from coherent_api.api.dependencies import CurrentUser, SessionDep
from coherent_api.api.v1.e2ee import verify_device_request
from coherent_api.models.mls import MlsEvent, MlsPackage, MlsState
from coherent_api.schemas.e2ee import EnrollRequest, StrictModel
from coherent_api.schemas.mls import CancelPayload, CancelRequest, LeaseRequest, TransportRequest
from coherent_api.services import mls
from coherent_api.services.conversation_access import conversation_member_ids, get_conversation
from coherent_api.services.messages import visible_message
from coherent_api.services.push import send_to_users

router = APIRouter(tags=["Защищённая переписка"])


class PackagesPayload(StrictModel):
    operation: str = Field(pattern="^publish_packages$")
    packages: list[str] = Field(min_length=1, max_length=16)


@router.get("/security/key-packages/count")
async def package_count(device_id: UUID, user: CurrentUser, session: SessionDep) -> dict:
    await mls.active_device(session, user, device_id)
    now = datetime.now(UTC)
    count = await session.scalar(
        select(func.count())
        .select_from(MlsPackage)
        .where(
            MlsPackage.device_id == device_id,
            MlsPackage.consumed_at.is_(None),
            MlsPackage.expires_at > now,
        )
    )
    return {"available": count or 0}


@router.post("/security/key-packages")
async def publish_packages(
    body: EnrollRequest, request: Request, user: CurrentUser, session: SessionDep
) -> dict:
    device = await mls.active_device(session, user, body.device.device_id)
    if body.device.account_id != user.id or body.device.signature_key != device.signature_key:
        raise HTTPException(status_code=403, detail="Ключ устройства не совпадает")
    try:
        payload = PackagesPayload.model_validate_json(body.payload)
    except ValidationError as error:
        raise HTTPException(status_code=400, detail="Неверный набор ключей") from error
    await verify_device_request(
        session,
        user,
        body.challenge_id,
        device.id,
        device.signature_key,
        body.proof,
        "",
        "action",
        hashlib.sha256(body.payload.encode()).digest(),
        require_password=False,
    )
    now = datetime.now(UTC)
    added = []
    for wire in payload.packages:
        try:
            if len(wire) > 65536:
                raise ValueError("size")
            raw = base64.b64decode(wire, validate=True)
            if len(raw) < 64 or base64.b64encode(raw).decode() != wire:
                raise ValueError("encoding")
        except ValueError as error:
            raise HTTPException(status_code=400, detail="Неверный пакет ключа") from error
        identity = mls.digest(raw)
        existing = await session.get(MlsPackage, identity)
        if existing:
            if existing.device_id != device.id:
                raise HTTPException(status_code=409, detail="Пакет принадлежит другому устройству")
        elif identity not in {p.id for p in added}:
            added.append(
                MlsPackage(
                    id=identity,
                    device_id=device.id,
                    wire=wire,
                    created_at=now,
                    expires_at=now + timedelta(days=7),
                )
            )
    count = await session.scalar(
        select(func.count())
        .select_from(MlsPackage)
        .where(
            MlsPackage.device_id == device.id,
            MlsPackage.consumed_at.is_(None),
            MlsPackage.expires_at > now,
        )
    )
    if (count or 0) + len(added) > 32:
        raise HTTPException(status_code=409, detail="Запас одноразовых ключей уже заполнен")
    await mls.allocate_storage(
        session, request.app.state.settings, sum(len(p.wire) + 1024 for p in added)
    )
    session.add_all(added)
    await session.commit()
    from coherent_api.services.security_events import notify_security

    await notify_security(request, session, user)
    return {"published": True}


@router.get("/conversations/{conversation_id}/secure")
async def secure_directory(conversation_id: UUID, user: CurrentUser, session: SessionDep) -> dict:
    return await mls.directory(session, user, conversation_id)


@router.post("/conversations/{conversation_id}/secure/lease")
async def acquire_lease(
    conversation_id: UUID,
    body: LeaseRequest,
    request: Request,
    user: CurrentUser,
    session: SessionDep,
) -> dict:
    if not request.app.state.settings.e2ee_messaging_enabled:
        state = await session.get(MlsState, conversation_id)
        if state is None or state.group_id is None:
            raise HTTPException(
                status_code=409, detail="Новая защищённая переписка ещё не включена"
            )
    if body.recover:
        device = await mls.active_device(session, user, body.device_id)
        state = await session.get(MlsState, conversation_id)
        if not body.challenge_id or not body.proof or not body.recovery_group_id:
            raise HTTPException(
                status_code=403, detail="Подтверди восстановление ключом устройства"
            )
        if state is None or state.group_id != body.recovery_group_id:
            raise HTTPException(
                status_code=409, detail="Защищённая сессия уже обновилась. Повтори подключение"
            )
        payload = json.dumps(
            {
                "operation": "recover_session",
                "conversation_id": str(conversation_id),
                "device_id": str(body.device_id),
                "request_id": str(body.request_id),
                "group_id": str(body.recovery_group_id),
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        await verify_device_request(
            session,
            user,
            body.challenge_id,
            device.id,
            device.signature_key,
            body.proof,
            "",
            "action",
            hashlib.sha256(payload.encode()).digest(),
            require_password=False,
        )
    return await mls.lease(session, user, conversation_id, body)


@router.get("/conversations/{conversation_id}/secure/events")
async def secure_events(
    conversation_id: UUID, device_id: UUID, user: CurrentUser, session: SessionDep, after: int = 0
) -> dict:
    if after < 0 or after > 2**53 - 1:
        raise HTTPException(status_code=400, detail="Неверная позиция")
    return await mls.events(session, user, conversation_id, device_id, after)


@router.get("/conversations/{conversation_id}/secure/operations/{identity}")
async def operation_status(
    conversation_id: UUID, identity: UUID, device_id: UUID, user: CurrentUser, session: SessionDep
) -> dict:
    await mls.active_device(session, user, device_id)
    await mls.secure_conversation(session, user, conversation_id)
    event = await session.get(MlsEvent, identity)
    if event and event.conversation_id == conversation_id and event.device_id == device_id:
        return {"accepted": True, "event": await mls.event_view(session, event)}
    return {"accepted": False}


async def publish(body, conversation_id, files, request, user, session, background):
    try:
        event = await mls.publish(
            session,
            user,
            request.app.state.settings,
            conversation_id,
            body.device_id,
            body.payload,
            body.proof,
            files,
        )
    except ValidationError as error:
        raise HTTPException(status_code=400, detail="Неверный формат защищённого пакета") from error
    if event.get("duplicate"):
        return event
    packet = json.loads(body.payload)
    conversation = await get_conversation(session, user, conversation_id)
    members = await conversation_member_ids(session, conversation)
    if packet["operation"] in ("message", "migrate"):
        from coherent_api.models.message import Message

        message = await session.get(Message, UUID(packet["message"]["context"]["message_id"]))
        result = visible_message(session, message)
        await request.app.state.message_events.publish(
            members,
            {
                "type": "message",
                "conversation_id": str(conversation_id),
                "message": result.model_dump(mode="json"),
            },
        )
        if packet["operation"] == "migrate":
            return event
        background.add_task(
            send_to_users,
            request.app.state.session_factory,
            request.app.state.settings,
            tuple(uid for uid in members if uid != user.id),
            {
                "title": "Когерент",
                "body": "Новое защищённое сообщение",
                "url": f"/?conversation={conversation_id}",
                "tag": f"message-{message.id}",
            },
        )
    else:
        await request.app.state.message_events.publish(
            members, {"type": "conversation", "conversation_id": str(conversation_id)}
        )
    return event


@router.post("/conversations/{conversation_id}/secure/publish")
async def publish_json(
    conversation_id: UUID,
    body: TransportRequest,
    request: Request,
    user: CurrentUser,
    session: SessionDep,
    background: BackgroundTasks,
) -> dict:
    return await publish(body, conversation_id, [], request, user, session, background)


@router.post("/conversations/{conversation_id}/secure/files")
async def publish_files(
    conversation_id: UUID,
    request: Request,
    user: CurrentUser,
    session: SessionDep,
    background: BackgroundTasks,
    data: str = Form(...),
    files: Annotated[list[UploadFile] | None, File()] = None,
) -> dict:
    try:
        body = TransportRequest.model_validate_json(data)
    except ValidationError as error:
        raise HTTPException(
            status_code=400, detail="Неверный формат защищённого запроса"
        ) from error
    files = files or []
    if len(files) > 4:
        raise HTTPException(status_code=400, detail="До четырёх файлов")
    return await publish(body, conversation_id, files, request, user, session, background)


@router.post("/conversations/{conversation_id}/secure/cancel")
async def cancel_candidate(
    conversation_id: UUID, body: CancelRequest, user: CurrentUser, session: SessionDep
) -> dict:
    try:
        payload = CancelPayload.model_validate_json(body.payload)
    except ValidationError as error:
        raise HTTPException(status_code=400, detail="Неверный запрос отмены") from error
    if payload.conversation_id != conversation_id:
        raise HTTPException(status_code=400, detail="Беседа не совпадает")
    device = await mls.active_device(session, user, body.device_id)
    await mls.secure_conversation(session, user, conversation_id, lock=True)
    mls.action_signature(device, body.nonce, body.payload, body.proof)
    event = await session.get(MlsEvent, payload.request_id)
    if event:
        if event.device_id != device.id or event.conversation_id != conversation_id:
            raise HTTPException(status_code=403, detail="Чужой запрос")
        return {"accepted": True, "event": await mls.event_view(session, event)}
    state = await session.get(MlsState, conversation_id)
    if (
        state
        and state.lease_id == payload.lease_id
        and state.lease_device_id == device.id
        and state.lease_request_id == payload.request_id
    ):
        if state.lease_nonce != body.nonce:
            raise HTTPException(status_code=403, detail="Подтверждение не совпадает")
        state.lease_id = None
        state.lease_device_id = None
        state.lease_request_id = None
        state.lease_nonce = None
        state.lease_expires_at = None
        state.lease_payload = None
        await session.commit()
    return {"accepted": False}
