"""OPAQUE packet relay. Only an active trusted device can authorize a transfer."""

import base64
import json
from datetime import UTC, datetime, timedelta
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request
from pydantic import Field, ValidationError
from sqlalchemy import func, select

from coherent_api.api.dependencies import CurrentUser, SessionDep
from coherent_api.api.v1.e2ee import require_available
from coherent_api.models.device_link import DeviceLink
from coherent_api.models.e2ee import E2eeAccount, E2eeDevice
from coherent_api.models.user import User
from coherent_api.schemas.e2ee import DeviceBinding, StrictModel
from coherent_api.services.mls import action_signature, active_device, allocate_storage

router = APIRouter(prefix="/security/device-links", tags=["Подтверждение устройств"])


class LinkAction(StrictModel):
    device: DeviceBinding
    payload: str = Field(min_length=1, max_length=32768)
    proof: str = Field(min_length=88, max_length=88)


class StartPayload(StrictModel):
    operation: str = Field(pattern="^link_start$")
    id: UUID
    nonce: str = Field(min_length=44, max_length=44)
    label: str = Field(min_length=1, max_length=64)
    platform: str = Field(pattern="^(browser|windows|linux|macos|android|ios)$")


class StepPayload(StrictModel):
    operation: str = Field(pattern="^(offer|respond|deliver|reject|cancel)$")
    id: UUID
    packet: str | None = Field(default=None, max_length=16384)
    envelope: dict | None = None


def parse(model, value):
    try:
        return model.model_validate_json(value)
    except ValidationError:
        raise HTTPException(400, "Неверный формат подтверждения") from None


async def notify(request, user):
    await request.app.state.message_events.publish((user.id,), {"type": "device_link"})


async def expire(session, user):
    now = datetime.now(UTC)
    links = list(
        await session.scalars(
            select(DeviceLink).where(
                DeviceLink.user_id == user.id,
                DeviceLink.expires_at <= now,
                DeviceLink.status.not_in(["completed", "expired", "cancelled", "rejected"]),
            )
        )
    )
    for link in links:
        link.status = "expired"
        link.request = None
        link.response = None
        link.finalization = None
        link.envelope = None
    if links:
        await session.commit()


def binding(device):
    return {
        "version": 1,
        "account_id": str(device.user_id),
        "device_id": str(device.id),
        "signature_key": device.signature_key,
    }


async def view(session, link):
    old = await session.get(E2eeDevice, link.approver_id) if link.approver_id else None
    return {
        "id": str(link.id),
        "device": json.loads(link.new_device),
        "label": link.label,
        "platform": link.platform,
        "nonce": link.nonce,
        "status": link.status,
        "expires_at": link.expires_at.replace(tzinfo=UTC).isoformat(),
        "approver": binding(old) if old else None,
        "request": link.request,
        "response": link.response,
        "finalization": link.finalization,
        "envelope": json.loads(link.envelope) if link.envelope else None,
    }


@router.post("")
async def start_link(body: LinkAction, request: Request, user: CurrentUser, session: SessionDep):
    require_available(request)
    packet = parse(StartPayload, body.payload)
    if body.device.account_id != user.id:
        raise HTTPException(403, "Неверный аккаунт устройства")
    try:
        nonce = base64.b64decode(packet.nonce, validate=True)
        if len(nonce) != 32:
            raise ValueError()
    except ValueError:
        raise HTTPException(400, "Неверный запрос") from None
    account = await session.get(E2eeAccount, user.id)
    if account is None or not account.roster_revision:
        raise HTTPException(409, "Сначала настрой ключ на первом устройстве")
    if await session.get(E2eeDevice, body.device.device_id):
        raise HTTPException(409, "Устройство уже подтверждено")
    # The new key proves possession, without gaining any trusted-device permission.
    candidate = E2eeDevice(
        id=body.device.device_id, user_id=user.id, signature_key=body.device.signature_key
    )
    action_signature(candidate, packet.nonce, body.payload, body.proof)
    await expire(session, user)
    version = user.session_version
    user = await session.scalar(
        select(User)
        .where(User.id == user.id)
        .with_for_update(key_share=True)
        .execution_options(populate_existing=True)
    )
    if user.session_version != version:
        raise HTTPException(401, "Войди в аккаунт заново")
    existing = await session.get(DeviceLink, packet.id)
    if existing:
        if (
            existing.user_id != user.id
            or existing.new_device != body.device.model_dump_json()
            or existing.nonce != packet.nonce
        ):
            raise HTTPException(409, "Запрос уже существует")
        return await view(session, existing)
    count = await session.scalar(
        select(func.count())
        .select_from(DeviceLink)
        .where(
            DeviceLink.user_id == user.id,
            DeviceLink.created_at > datetime.now(UTC) - timedelta(hours=1),
        )
    )
    if (count or 0) >= 8:
        raise HTTPException(429, "Слишком много запросов. Повтори позже")
    previous = list(
        await session.scalars(
            select(DeviceLink).where(
                DeviceLink.user_id == user.id,
                DeviceLink.new_device_id == body.device.device_id,
                DeviceLink.status.in_(["pending", "offered", "responded", "delivered"]),
            )
        )
    )
    for old in previous:
        old.status = "cancelled"
        old.request = None
        old.response = None
        old.finalization = None
        old.envelope = None
    now = datetime.now(UTC)
    link = DeviceLink(
        id=packet.id,
        user_id=user.id,
        new_device_id=body.device.device_id,
        new_device=body.device.model_dump_json(),
        nonce=packet.nonce,
        label=packet.label.strip(),
        platform=packet.platform,
        session_version=user.session_version,
        status="pending",
        created_at=now,
        expires_at=now + timedelta(minutes=5),
    )
    await allocate_storage(session, request.app.state.settings, 65536)
    session.add(link)
    await session.commit()
    await notify(request, user)
    return await view(session, link)


@router.get("")
async def list_links(device_id: UUID, user: CurrentUser, session: SessionDep):
    await expire(session, user)
    device = await session.get(E2eeDevice, device_id)
    trusted = device is not None and device.user_id == user.id and device.revoked_at is None
    query = (
        select(DeviceLink)
        .where(
            DeviceLink.user_id == user.id,
            DeviceLink.session_version == user.session_version,
            DeviceLink.status.in_(["pending", "offered", "responded", "delivered"]),
        )
        .order_by(DeviceLink.created_at.desc())
        .limit(8)
    )
    if not trusted:
        query = query.where(DeviceLink.new_device_id == device_id)
    links = list(await session.scalars(query))
    return {"links": [await view(session, link) for link in links]}


@router.get("/{identity}")
async def get_link(identity: UUID, user: CurrentUser, session: SessionDep):
    await expire(session, user)
    link = await session.get(DeviceLink, identity)
    if link is None or link.user_id != user.id or link.session_version != user.session_version:
        raise HTTPException(404, "Запрос не найден")
    return await view(session, link)


@router.post("/{identity}")
async def step_link(
    identity: UUID, body: LinkAction, request: Request, user: CurrentUser, session: SessionDep
):
    packet = parse(StepPayload, body.payload)
    if packet.id != identity or body.device.account_id != user.id:
        raise HTTPException(403, "Неверное устройство")
    user = await session.scalar(
        select(User)
        .where(User.id == user.id)
        .with_for_update(key_share=True)
        .execution_options(populate_existing=True)
    )
    link = await session.get(DeviceLink, identity, with_for_update=True)
    if link is None or link.user_id != user.id or link.session_version != user.session_version:
        raise HTTPException(404, "Запрос не найден")
    if link.expires_at.replace(tzinfo=UTC) <= datetime.now(UTC):
        raise HTTPException(410, "Время подтверждения истекло")
    new = DeviceBinding.model_validate_json(link.new_device)
    is_new = body.device == new
    if is_new:
        device = E2eeDevice(id=new.device_id, user_id=user.id, signature_key=new.signature_key)
    else:
        device = await active_device(session, user, body.device.device_id)
        if device.signature_key != body.device.signature_key:
            raise HTTPException(403, "Ключ устройства изменился")
    action_signature(device, link.nonce, body.payload, body.proof)
    operation = packet.operation
    if operation == "offer":
        if is_new or not packet.packet or packet.envelope is not None:
            raise HTTPException(403, "Подтверждение доступно доверенному устройству")
        if (
            link.status == "offered"
            and link.approver_id == device.id
            and link.request == packet.packet
        ):
            return await view(session, link)
        if link.status != "pending":
            raise HTTPException(409, "Запрос уже обрабатывается другим устройством")
        link.approver_id = device.id
        link.request = packet.packet
        link.status = "offered"
    elif operation == "respond":
        if not is_new or not packet.packet or packet.envelope is not None:
            raise HTTPException(403, "Неверный ответ")
        if link.status == "responded" and link.response == packet.packet:
            return await view(session, link)
        if link.status != "offered":
            raise HTTPException(409, "Неверный этап подтверждения")
        link.response = packet.packet
        link.status = "responded"
    elif operation == "deliver":
        if is_new or link.approver_id != device.id or not packet.packet or not packet.envelope:
            raise HTTPException(403, "Неверное подтверждение")
        from coherent_api.schemas.mls import CipherEnvelope

        try:
            envelope = CipherEnvelope.model_validate(packet.envelope).model_dump_json()
        except ValidationError:
            raise HTTPException(400, "Неверный формат передачи ключей") from None
        if (
            link.status == "delivered"
            and link.finalization == packet.packet
            and link.envelope == envelope
        ):
            return await view(session, link)
        if link.status != "responded":
            raise HTTPException(409, "Неверный этап подтверждения")
        link.finalization = packet.packet
        link.envelope = envelope
        link.status = "delivered"
    else:
        if link.status == "completed":
            raise HTTPException(409, "Устройство уже подтверждено")
        link.status = "cancelled" if is_new else "rejected"
        link.request = None
        link.response = None
        link.finalization = None
        link.envelope = None
    await session.commit()
    await notify(request, user)
    return await view(session, link)
