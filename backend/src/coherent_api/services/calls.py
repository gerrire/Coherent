from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from coherent_api.core.config import Settings
from coherent_api.models.call import Call
from coherent_api.models.call_member import CallMember
from coherent_api.models.user import User
from coherent_api.schemas.calls import (
    CallJoinResponse,
    CallParticipant,
    CallResponse,
    CurrentCallsResponse,
)
from coherent_api.services.call_media import sync_members
from coherent_api.services.conversation_access import (
    GroupMembershipError,
    add_group_members,
    conversation_member_ids,
    get_conversation,
    get_server_channel,
    is_call_media,
    other_user_id,
    validate_friends,
)
from coherent_api.services.livekit_media import issue_join_token

RING_SECONDS = 60
MAX_CALL_HOURS = 4
MAX_CALL_MEMBERS = 10
LAST_PARTICIPANT_MINUTES = 3


class CallNotFoundError(Exception):
    pass


class CallBusyError(Exception):
    pass


class CallStateError(Exception):
    pass


class CallForbiddenError(Exception):
    pass


class CallFullError(Exception):
    pass


class CallInviteError(Exception):
    pass


async def call_response(session: AsyncSession, call: Call) -> CallResponse:
    rows = (
        await session.execute(
            select(CallMember, User)
            .join(User, User.id == CallMember.user_id)
            .where(CallMember.call_id == call.id)
            .order_by(CallMember.invited_at, User.username)
        )
    ).all()
    names = {member.user_id: person.username for member, person in rows}
    display_names = {member.user_id: person.public_name for member, person in rows}
    return CallResponse(
        id=call.id,
        conversation_id=call.conversation_id,
        caller_id=call.caller_id,
        caller_username=names.get(call.caller_id, "Удалённый пользователь"),
        caller_display_name=display_names.get(call.caller_id),
        callee_id=call.callee_id,
        callee_username=names.get(call.callee_id, "Удалённый пользователь"),
        callee_display_name=display_names.get(call.callee_id),
        status=call.status,
        created_at=call.created_at,
        expires_at=call.expires_at,
        answered_at=call.answered_at,
        ended_at=call.ended_at,
        participants=[
            CallParticipant(
                user_id=member.user_id,
                username=person.username,
                display_name=person.display_name,
                state=member.state,
            )
            for member, person in rows
        ],
    )


async def expire_calls(session: AsyncSession, user_ids: tuple[UUID, ...]) -> bool:
    now = datetime.now(UTC)
    calls = await session.scalars(
        select(Call)
        .join(CallMember, CallMember.call_id == Call.id)
        .where(
            Call.status.in_(("ringing", "active")),
            Call.expires_at <= now,
            CallMember.user_id.in_(user_ids),
        )
    )
    changed = False
    for call in calls:
        call.status = "missed" if call.status == "ringing" else "ended"
        call.ended_at = now
        await release_members(session, call.id, now)
        await sync_members(session, call)
        changed = True
    if changed:
        await session.flush()
    return changed


async def current_calls(session: AsyncSession, user: User) -> CurrentCallsResponse:
    if await expire_calls(session, (user.id,)):
        await session.commit()
    calls = await session.scalars(
        select(Call)
        .join(CallMember, CallMember.call_id == Call.id)
        .where(
            Call.status.in_(("ringing", "active")),
            CallMember.user_id == user.id,
            CallMember.state.in_(("invited", "joined", "left")),
        )
        .order_by(Call.created_at.desc())
    )
    return CurrentCallsResponse(calls=[await call_response(session, call) for call in calls])


async def busy_call(session: AsyncSession, user_ids: tuple[UUID, ...]) -> UUID | None:
    return await session.scalar(
        select(Call.id)
        .join(CallMember, CallMember.call_id == Call.id)
        .where(
            Call.status.in_(("ringing", "active")),
            CallMember.state.in_(("invited", "joined")),
            CallMember.user_id.in_(user_ids),
        )
        .limit(1)
    )


async def release_members(session: AsyncSession, call_id: UUID, when: datetime) -> None:
    members = await session.scalars(
        select(CallMember).where(
            CallMember.call_id == call_id,
            CallMember.state.in_(("invited", "joined")),
        )
    )
    for member in members:
        member.state = "left"
        member.left_at = when


async def start_call(
    session: AsyncSession, user: User, conversation_id: UUID, invitee_ids: list[UUID] | None = None
) -> CallResponse:
    conversation = await get_conversation(session, user, conversation_id)
    if await get_server_channel(session, conversation_id) is not None or await is_call_media(
        session, conversation_id
    ):
        raise CallInviteError("Этот канал предназначен для текстовых сообщений")
    extras = set(invitee_ids or ())
    if conversation.kind == "group":
        if extras:
            raise CallInviteError
        participant_ids = tuple(sorted(await conversation_member_ids(session, conversation)))
        others = sorted(set(participant_ids) - {user.id})
        if not others:
            raise CallInviteError
        callee_id = others[0]
    else:
        callee_id = other_user_id(conversation, user.id)
        if extras:
            raise CallInviteError
        participant_ids = tuple(sorted((user.id, callee_id)))
    if len(participant_ids) > MAX_CALL_MEMBERS:
        raise CallFullError
    # Lock accounts in a stable order so two simultaneous calls cannot reserve one user twice.
    users = list(
        await session.scalars(
            select(User)
            .where(User.id.in_(participant_ids))
            .order_by(User.id)
            .with_for_update(key_share=True)
        )
    )
    if len(users) != len(participant_ids):
        raise CallInviteError
    await expire_calls(session, participant_ids)
    reconnect = await session.scalar(
        select(Call)
        .join(CallMember, CallMember.call_id == Call.id)
        .where(
            Call.conversation_id == conversation_id,
            Call.status == "active",
            Call.expires_at > datetime.now(UTC),
            CallMember.user_id == user.id,
            CallMember.state == "left",
        )
        .order_by(Call.created_at.desc())
        .limit(1)
    )
    if reconnect is not None:
        return await accept_call(session, user, reconnect.id)
    existing = await busy_call(session, participant_ids)
    if existing is not None:
        raise CallBusyError

    call_id = uuid4()
    now = datetime.now(UTC)
    call = Call(
        id=call_id,
        conversation_id=conversation_id,
        caller_id=user.id,
        callee_id=callee_id,
        status="ringing",
        expires_at=now + timedelta(seconds=RING_SECONDS),
    )
    session.add(call)
    session.add(CallMember(call_id=call_id, user_id=user.id, state="joined", joined_at=now))
    for target_id in sorted(set(participant_ids) - {user.id}):
        session.add(CallMember(call_id=call_id, user_id=target_id, state="invited"))
    await session.commit()
    await session.refresh(call)
    return await call_response(session, call)


async def get_call(session: AsyncSession, user: User, call_id: UUID) -> Call:
    call = await session.scalar(select(Call).where(Call.id == call_id).with_for_update())
    if call is None or await session.get(CallMember, (call_id, user.id)) is None:
        raise CallNotFoundError
    return call


def is_expired(call: Call) -> bool:
    expires_at = call.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    return expires_at <= datetime.now(UTC)


async def accept_call(session: AsyncSession, user: User, call_id: UUID) -> CallResponse:
    call = await get_call(session, user, call_id)
    member = await session.get(CallMember, (call_id, user.id))
    assert member is not None
    if member.state != "invited" and not (call.status == "active" and member.state == "left"):
        raise CallForbiddenError
    if call.status not in ("ringing", "active"):
        raise CallStateError
    if is_expired(call):
        call.status = "missed" if call.status == "ringing" else "ended"
        call.ended_at = datetime.now(UTC)
        await release_members(session, call.id, call.ended_at)
        await session.commit()
        raise CallStateError
    now = datetime.now(UTC)
    if await busy_call(session, (user.id,)) not in (None, call.id):
        raise CallBusyError
    joined_before = (
        await session.scalar(
            select(func.count())
            .select_from(CallMember)
            .where(CallMember.call_id == call_id, CallMember.state == "joined")
        )
        or 0
    )
    member.state = "joined"
    member.joined_at = now
    member.left_at = None
    if call.status == "ringing":
        call.status = "active"
        call.answered_at = now
        call.expires_at = now + timedelta(hours=MAX_CALL_HOURS)
    elif joined_before == 0:
        call.expires_at = now + timedelta(minutes=LAST_PARTICIPANT_MINUTES)
    elif joined_before == 1:
        call.expires_at = now + timedelta(hours=MAX_CALL_HOURS)
    await sync_members(session, call)
    await session.commit()
    return await call_response(session, call)


async def end_call(session: AsyncSession, user: User, call_id: UUID) -> tuple[CallResponse, bool]:
    call = await get_call(session, user, call_id)
    member = await session.get(CallMember, (call_id, user.id))
    assert member is not None
    if call.status not in ("ringing", "active") or member.state not in ("invited", "joined"):
        return await call_response(session, call), False
    now = datetime.now(UTC)
    was_active = False
    member.state = "declined" if member.state == "invited" else "left"
    member.left_at = now
    if call.status == "ringing" and user.id == call.caller_id:
        call.status = "cancelled"
    elif call.status == "ringing":
        invited = await session.scalar(
            select(func.count())
            .select_from(CallMember)
            .where(CallMember.call_id == call_id, CallMember.state == "invited")
        )
        if not invited:
            call.status = "declined"
    elif call.status == "active":
        joined = await session.scalar(
            select(func.count())
            .select_from(CallMember)
            .where(CallMember.call_id == call_id, CallMember.state == "joined")
        )
        if not joined:
            call.status = "ended"
            was_active = True
        elif joined == 1:
            call.expires_at = now + timedelta(minutes=LAST_PARTICIPANT_MINUTES)
    if call.status not in ("ringing", "active"):
        call.ended_at = now
        await release_members(session, call.id, now)
    await sync_members(session, call)
    await session.commit()
    return await call_response(session, call), was_active


async def invite_to_call(
    session: AsyncSession, user: User, call_id: UUID, target_ids: list[UUID]
) -> CallResponse:
    targets = set(target_ids)
    if not targets or user.id in targets:
        raise CallInviteError
    users = list(
        await session.scalars(
            select(User)
            .where(User.id.in_(targets))
            .order_by(User.id)
            .with_for_update(key_share=True)
        )
    )
    if len(users) != len(targets):
        raise CallInviteError
    call = await get_call(session, user, call_id)
    conversation = await get_conversation(session, user, call.conversation_id)
    if conversation.kind != "group":
        raise CallInviteError("Создайте групповой чат для общего звонка")
    inviter = await session.get(CallMember, (call_id, user.id))
    if call.status != "active" or is_expired(call) or inviter is None or inviter.state != "joined":
        raise CallStateError
    members = list(await session.scalars(select(CallMember).where(CallMember.call_id == call_id)))
    by_user = {member.user_id: member for member in members}
    if any(
        by_user.get(target) and by_user[target].state in ("invited", "joined") for target in targets
    ):
        raise CallInviteError
    occupied = sum(member.state in ("invited", "joined") for member in members)
    if occupied + len(targets) > MAX_CALL_MEMBERS:
        raise CallFullError
    await expire_calls(session, tuple(sorted(targets)))
    if await busy_call(session, tuple(sorted(targets))) is not None:
        raise CallBusyError
    try:
        await validate_friends(session, user.id, targets)
        existing_group_members = set(await conversation_member_ids(session, conversation))
        newcomers = targets - existing_group_members
        if newcomers:
            await add_group_members(session, user, conversation, newcomers)
    except GroupMembershipError as error:
        raise CallInviteError(str(error)) from error
    now = datetime.now(UTC)
    for target_id in targets:
        existing = by_user.get(target_id)
        if existing:
            existing.state = "invited"
            existing.invited_at = now
            existing.joined_at = None
            existing.left_at = None
        else:
            session.add(CallMember(call_id=call_id, user_id=target_id, state="invited"))
    await sync_members(session, call)
    await session.commit()
    return await call_response(session, call)


async def join_call(
    session: AsyncSession, user: User, call_id: UUID, settings: Settings
) -> CallJoinResponse:
    call = await get_call(session, user, call_id)
    member = await session.get(CallMember, (call_id, user.id))
    if call.status != "active" or is_expired(call) or member is None or member.state != "joined":
        raise CallStateError
    assert settings.livekit_url and settings.livekit_api_key and settings.livekit_api_secret
    token = issue_join_token(settings, call.id, user.id, user.public_name)
    media_id = await sync_members(session, call)
    await session.commit()
    return CallJoinResponse(
        server_url=settings.livekit_url, token=token, media_conversation_id=media_id
    )
