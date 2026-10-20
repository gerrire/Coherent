import logging
from datetime import UTC, datetime, timedelta
from uuid import UUID

from livekit import api as livekit_api
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from coherent_api.core.config import Settings
from coherent_api.models.call import Call
from coherent_api.models.user import User
from coherent_api.schemas.calls import CallJoinResponse, CallResponse, CurrentCallsResponse
from coherent_api.services.messages import get_conversation, other_user_id

RING_SECONDS = 60
MAX_CALL_HOURS = 4
logger = logging.getLogger(__name__)


def room_name(call_id: UUID) -> str:
    return f"coherent-call-{call_id}"


class CallNotFoundError(Exception):
    pass


class CallBusyError(Exception):
    pass


class CallStateError(Exception):
    pass


class CallForbiddenError(Exception):
    pass


def livekit_ready(settings: Settings) -> bool:
    return bool(settings.livekit_url and settings.livekit_api_key and settings.livekit_api_secret)


async def call_response(session: AsyncSession, call: Call) -> CallResponse:
    users = await session.scalars(select(User).where(User.id.in_((call.caller_id, call.callee_id))))
    names = {user.id: user.username for user in users}
    return CallResponse(
        id=call.id,
        conversation_id=call.conversation_id,
        caller_id=call.caller_id,
        caller_username=names.get(call.caller_id, "Удалённый пользователь"),
        callee_id=call.callee_id,
        callee_username=names.get(call.callee_id, "Удалённый пользователь"),
        status=call.status,
        created_at=call.created_at,
        expires_at=call.expires_at,
        answered_at=call.answered_at,
        ended_at=call.ended_at,
    )


async def expire_calls(session: AsyncSession, user_ids: tuple[UUID, ...]) -> bool:
    now = datetime.now(UTC)
    calls = await session.scalars(
        select(Call).where(
            Call.status.in_(("ringing", "active")),
            Call.expires_at <= now,
            or_(Call.caller_id.in_(user_ids), Call.callee_id.in_(user_ids)),
        )
    )
    changed = False
    for call in calls:
        call.status = "missed" if call.status == "ringing" else "ended"
        call.ended_at = now
        changed = True
    if changed:
        await session.flush()
    return changed


async def current_calls(session: AsyncSession, user: User) -> CurrentCallsResponse:
    if await expire_calls(session, (user.id,)):
        await session.commit()
    calls = await session.scalars(
        select(Call)
        .where(
            Call.status.in_(("ringing", "active")),
            or_(Call.caller_id == user.id, Call.callee_id == user.id),
        )
        .order_by(Call.created_at.desc())
    )
    return CurrentCallsResponse(calls=[await call_response(session, call) for call in calls])


async def start_call(session: AsyncSession, user: User, conversation_id: UUID) -> CallResponse:
    conversation = await get_conversation(session, user, conversation_id)
    callee_id = other_user_id(conversation, user.id)
    participant_ids = tuple(sorted((user.id, callee_id)))
    # Lock accounts in a stable order so two simultaneous calls cannot reserve one user twice.
    await session.scalars(
        select(User).where(User.id.in_(participant_ids)).order_by(User.id).with_for_update()
    )
    await expire_calls(session, participant_ids)
    existing = await session.scalar(
        select(Call.id)
        .where(
            Call.status.in_(("ringing", "active")),
            or_(Call.caller_id.in_(participant_ids), Call.callee_id.in_(participant_ids)),
        )
        .limit(1)
    )
    if existing is not None:
        raise CallBusyError

    call = Call(
        conversation_id=conversation_id,
        caller_id=user.id,
        callee_id=callee_id,
        status="ringing",
        expires_at=datetime.now(UTC) + timedelta(seconds=RING_SECONDS),
    )
    session.add(call)
    await session.commit()
    await session.refresh(call)
    return await call_response(session, call)


async def get_call(session: AsyncSession, user: User, call_id: UUID) -> Call:
    call = await session.scalar(
        select(Call)
        .where(Call.id == call_id, or_(Call.caller_id == user.id, Call.callee_id == user.id))
        .with_for_update()
    )
    if call is None:
        raise CallNotFoundError
    return call


def is_expired(call: Call) -> bool:
    expires_at = call.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    return expires_at <= datetime.now(UTC)


async def accept_call(session: AsyncSession, user: User, call_id: UUID) -> CallResponse:
    call = await get_call(session, user, call_id)
    if call.callee_id != user.id:
        raise CallForbiddenError
    if call.status != "ringing":
        raise CallStateError
    if is_expired(call):
        call.status = "missed"
        call.ended_at = datetime.now(UTC)
        await session.commit()
        raise CallStateError
    call.status = "active"
    call.answered_at = datetime.now(UTC)
    call.expires_at = call.answered_at + timedelta(hours=MAX_CALL_HOURS)
    await session.commit()
    return await call_response(session, call)


async def end_call(session: AsyncSession, user: User, call_id: UUID) -> tuple[CallResponse, bool]:
    call = await get_call(session, user, call_id)
    was_active = call.status == "active"
    if call.status == "ringing":
        call.status = "cancelled" if call.caller_id == user.id else "declined"
    elif call.status == "active":
        call.status = "ended"
    else:
        return await call_response(session, call), False
    call.ended_at = datetime.now(UTC)
    await session.commit()
    return await call_response(session, call), was_active


async def close_livekit_room(settings: Settings, call_id: UUID) -> None:
    if not livekit_ready(settings):
        return
    assert settings.livekit_url and settings.livekit_api_key and settings.livekit_api_secret
    try:
        async with livekit_api.LiveKitAPI(
            url=settings.livekit_url,
            api_key=settings.livekit_api_key,
            api_secret=settings.livekit_api_secret.get_secret_value(),
        ) as client:
            await client.room.delete_room(livekit_api.DeleteRoomRequest(room=room_name(call_id)))
    except livekit_api.ServerError as error:
        if error.status != 404:
            logger.warning("Could not close LiveKit room %s: %s", call_id, error)
    except (OSError, TimeoutError) as error:
        logger.warning("Could not reach LiveKit to close room %s: %s", call_id, error)


async def join_call(
    session: AsyncSession, user: User, call_id: UUID, settings: Settings
) -> CallJoinResponse:
    call = await get_call(session, user, call_id)
    if call.status != "active" or is_expired(call):
        raise CallStateError
    assert settings.livekit_url and settings.livekit_api_key and settings.livekit_api_secret
    token = (
        livekit_api.AccessToken(
            settings.livekit_api_key, settings.livekit_api_secret.get_secret_value()
        )
        .with_identity(str(user.id))
        .with_name(user.username)
        .with_grants(
            livekit_api.VideoGrants(
                room_join=True,
                room=room_name(call.id),
                can_publish=True,
                can_subscribe=True,
            )
        )
        .with_ttl(timedelta(minutes=2))
        .to_jwt()
    )
    return CallJoinResponse(server_url=settings.livekit_url, token=token)
