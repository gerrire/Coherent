"""Keep database call state and self-hosted LiveKit rooms in sync."""

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from time import monotonic
from uuid import UUID

from livekit import api as livekit_api
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from coherent_api.core.config import Settings
from coherent_api.models.call import Call
from coherent_api.models.call_member import CallMember
from coherent_api.schemas.calls import CallResponse
from coherent_api.services.calls import (
    LAST_PARTICIPANT_MINUTES,
    call_response,
    is_expired,
    release_members,
)
from coherent_api.services.events import MessageEvents
from coherent_api.services.livekit_media import (
    ROOM_PREFIX,
    close_livekit_room,
    livekit_client,
    room_name,
)

logger = logging.getLogger(__name__)
SWEEP_SECONDS = 5
ABSENT_SECONDS = 60
LIVEKIT_REQUEST_SECONDS = 8


async def _publish(events: MessageEvents, call: CallResponse) -> None:
    await events.publish(
        tuple(participant.user_id for participant in call.participants),
        {"type": "call", "call": call.model_dump(mode="json")},
    )


async def _expire_overdue(
    session_factory: async_sessionmaker[AsyncSession],
) -> list[CallResponse]:
    now = datetime.now(UTC)
    async with session_factory() as session:
        calls = list(
            await session.scalars(
                select(Call)
                .where(Call.status.in_(("ringing", "active")), Call.expires_at <= now)
                .order_by(Call.expires_at)
                .limit(100)
                .with_for_update(skip_locked=True)
            )
        )
        for call in calls:
            call.status = "missed" if call.status == "ringing" else "ended"
            call.ended_at = now
            await release_members(session, call.id, now)
        if calls:
            await session.commit()
        return [await call_response(session, call) for call in calls]


async def _reconcile_rooms(
    session_factory: async_sessionmaker[AsyncSession], settings: Settings
) -> dict[UUID, set[UUID]]:
    present: dict[UUID, set[UUID]] = {}
    async with livekit_client(settings) as client:
        rooms = await asyncio.wait_for(
            client.room.list_rooms(livekit_api.ListRoomsRequest()), LIVEKIT_REQUEST_SECONDS
        )
        for room in rooms.rooms:
            if not room.name.startswith(ROOM_PREFIX):
                continue
            try:
                call_id = UUID(room.name[len(ROOM_PREFIX) :])
            except ValueError:
                continue
            async with session_factory() as session:
                call = await session.get(Call, call_id)
                active = call is not None and call.status == "active" and not is_expired(call)
                joined = (
                    set(
                        await session.scalars(
                            select(CallMember.user_id).where(
                                CallMember.call_id == call_id, CallMember.state == "joined"
                            )
                        )
                    )
                    if active
                    else set()
                )
            if not active:
                try:
                    await asyncio.wait_for(
                        client.room.delete_room(livekit_api.DeleteRoomRequest(room=room.name)),
                        LIVEKIT_REQUEST_SECONDS,
                    )
                except livekit_api.ServerError as error:
                    if error.status != 404:
                        raise
                continue
            try:
                participants = await asyncio.wait_for(
                    client.room.list_participants(
                        livekit_api.ListParticipantsRequest(room=room.name)
                    ),
                    LIVEKIT_REQUEST_SECONDS,
                )
            except livekit_api.ServerError as error:
                if error.status == 404:
                    continue
                raise
            present[call_id] = set()
            for participant in participants.participants:
                try:
                    participant_id = UUID(participant.identity)
                except ValueError:
                    participant_id = None
                if participant_id in joined:
                    present[call_id].add(participant_id)
                    continue
                try:
                    await asyncio.wait_for(
                        client.room.remove_participant(
                            livekit_api.RoomParticipantIdentity(
                                room=room.name, identity=participant.identity
                            )
                        ),
                        LIVEKIT_REQUEST_SECONDS,
                    )
                except livekit_api.ServerError as error:
                    if error.status != 404:
                        raise
                logger.warning("Removed unauthorized LiveKit participant from call %s", call_id)
    return present


async def _mark_absent(
    session_factory: async_sessionmaker[AsyncSession], call_id: UUID, user_id: UUID
) -> CallResponse | None:
    now = datetime.now(UTC)
    async with session_factory() as session:
        call = await session.scalar(select(Call).where(Call.id == call_id).with_for_update())
        member = await session.get(CallMember, (call_id, user_id))
        if call is None or call.status != "active" or member is None or member.state != "joined":
            return None
        member.state = "left"
        member.left_at = now
        await session.flush()
        joined = (
            await session.scalar(
                select(func.count())
                .select_from(CallMember)
                .where(CallMember.call_id == call_id, CallMember.state == "joined")
            )
            or 0
        )
        if joined == 0:
            call.status = "ended"
            call.ended_at = now
            await release_members(session, call_id, now)
        elif joined == 1:
            call.expires_at = now + timedelta(minutes=LAST_PARTICIPANT_MINUTES)
        await session.commit()
        logger.info("Released absent participant from call %s", call_id)
        return await call_response(session, call)


async def _still_absent(settings: Settings, call_id: UUID, user_id: UUID) -> bool:
    async with livekit_client(settings) as client:
        try:
            await asyncio.wait_for(
                client.room.get_participant(
                    livekit_api.RoomParticipantIdentity(
                        room=room_name(call_id), identity=str(user_id)
                    )
                ),
                LIVEKIT_REQUEST_SECONDS,
            )
        except livekit_api.ServerError as error:
            if error.status == 404:
                return True
            raise
    return False


async def _release_absent(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
    events: MessageEvents,
    present: dict[UUID, set[UUID]],
    missing_since: dict[tuple[UUID, UUID], float],
) -> None:
    async with session_factory() as session:
        joined = list(
            (
                await session.execute(
                    select(Call.id, CallMember.user_id)
                    .join(CallMember, CallMember.call_id == Call.id)
                    .where(
                        Call.status == "active",
                        Call.expires_at > datetime.now(UTC),
                        CallMember.state == "joined",
                    )
                )
            ).all()
        )
    now = monotonic()
    still_missing: set[tuple[UUID, UUID]] = set()
    for call_id, user_id in joined:
        key = (call_id, user_id)
        if user_id in present.get(call_id, set()):
            missing_since.pop(key, None)
            continue
        still_missing.add(key)
        first_missing = missing_since.setdefault(key, now)
        if now - first_missing < ABSENT_SECONDS:
            continue
        if not await _still_absent(settings, call_id, user_id):
            missing_since.pop(key, None)
            continue
        call = await _mark_absent(session_factory, call_id, user_id)
        missing_since.pop(key, None)
        if call is not None:
            await _publish(events, call)
            if call.status == "ended":
                await close_livekit_room(settings, call.id)
    for key in set(missing_since) - still_missing:
        missing_since.pop(key, None)


async def call_cleanup_loop(
    session_factory: async_sessionmaker[AsyncSession], settings: Settings, events: MessageEvents
) -> None:
    missing_since: dict[tuple[UUID, UUID], float] = {}
    while True:
        try:
            expired = await _expire_overdue(session_factory)
            for call in expired:
                await _publish(events, call)
                if call.status == "ended":
                    await close_livekit_room(settings, call.id)
            present = await _reconcile_rooms(session_factory, settings)
            await _release_absent(session_factory, settings, events, present, missing_since)
        except asyncio.CancelledError:
            raise
        except Exception:
            missing_since.clear()
            logger.exception("Call cleanup failed; retrying")
        await asyncio.sleep(SWEEP_SECONDS)
