"""Authenticated public identities for a single call; private keys stay in RAM."""

import hashlib
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import select

from coherent_api.models.call import Call
from coherent_api.models.call_member import CallMember
from coherent_api.models.e2ee import E2eeDevice
from coherent_api.services.calls import is_expired


async def joined_call(session, user, call_id):
    call = await session.get(Call, call_id, populate_existing=True)
    member = await session.get(CallMember, (call_id, user.id))
    if call is None or member is None:
        raise HTTPException(404, "Звонок недоступен")
    if call.status != "active" or is_expired(call) or member is None or member.state != "joined":
        raise HTTPException(403, "Сначала подключись к звонку")
    digest = session.info.get("auth_session_digest")
    if member.session_digest and digest != member.session_digest:
        raise HTTPException(403, "Звонок подключён в другой сессии")
    return call


async def register_call_device(session, user, call_id, body):
    from coherent_api.api.v1.e2ee import verify_device_request
    from coherent_api.models.user import User

    # Serialize two refreshes from the same account, including first registration.
    await session.scalar(select(User).where(User.id == user.id).with_for_update())
    await joined_call(session, user, call_id)
    if body.device.account_id != user.id:
        raise HTTPException(403, "Аккаунт устройства не совпадает")
    payload = (
        f"coherent/call-device/v1:{call_id}:{body.device.device_id}:{body.device.signature_key}"
    )
    await verify_device_request(
        session,
        user,
        body.challenge_id,
        body.device.device_id,
        body.device.signature_key,
        body.proof,
        "",
        "action",
        hashlib.sha256(payload.encode()).digest(),
        require_password=False,
        call_id=call_id,
    )
    existing = await session.get(E2eeDevice, body.device.device_id)
    if existing:
        if (
            existing.call_id != call_id
            or existing.user_id != user.id
            or existing.signature_key != body.device.signature_key
            or existing.revoked_at
        ):
            raise HTTPException(409, "Ключ звонка уже изменился")
    else:
        from coherent_api.services.auth_security import throttle

        await throttle(session, "call-device", f"{user.id}:{call_id}", 40, 3600)
        previous = list(
            await session.scalars(
                select(E2eeDevice).where(
                    E2eeDevice.call_id == call_id,
                    E2eeDevice.user_id == user.id,
                    E2eeDevice.revoked_at.is_(None),
                )
            )
        )
        for device in previous:
            device.revoked_at = datetime.now(UTC)
        session.add(
            E2eeDevice(
                id=body.device.device_id,
                user_id=user.id,
                signature_key=body.device.signature_key,
                label="Одноразовый ключ звонка",
                platform=body.platform,
                call_id=call_id,
                approved_at=datetime.now(UTC),
            )
        )
    await session.commit()
    return {"registered": True}


async def call_devices(session, conversation_id, include_retired=False):
    from coherent_api.models.call_media import CallMediaSession

    link = await session.scalar(
        select(CallMediaSession).where(CallMediaSession.conversation_id == conversation_id)
    )
    if link is None:
        return None
    query = select(E2eeDevice).where(E2eeDevice.call_id == link.call_id)
    if not include_retired:
        query = query.join(
            CallMember,
            (CallMember.call_id == link.call_id) & (CallMember.user_id == E2eeDevice.user_id),
        ).where(CallMember.state == "joined", E2eeDevice.revoked_at.is_(None))
    return list(await session.scalars(query.order_by(E2eeDevice.approved_at, E2eeDevice.id)))
