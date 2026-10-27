"""Shared conversation membership rules for messages and calls."""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from coherent_api.models.conversation import Conversation
from coherent_api.models.conversation_member import ConversationMember
from coherent_api.models.friend_request import FriendRequest
from coherent_api.models.server import ServerChannel, ServerMember
from coherent_api.models.user import User


class ConversationNotFoundError(Exception):
    pass


class GroupMembershipError(Exception):
    pass


async def get_server_channel(session: AsyncSession, conversation_id: UUID) -> ServerChannel | None:
    return await session.scalar(
        select(ServerChannel).where(ServerChannel.conversation_id == conversation_id)
    )


def other_user_id(conversation: Conversation, user_id: UUID) -> UUID:
    if conversation.kind != "direct":
        raise GroupMembershipError
    result = (
        conversation.user_high_id
        if conversation.user_low_id == user_id
        else conversation.user_low_id
    )
    assert result is not None
    return result


async def conversation_member_ids(
    session: AsyncSession, conversation: Conversation
) -> tuple[UUID, ...]:
    if conversation.kind == "direct":
        assert conversation.user_low_id is not None and conversation.user_high_id is not None
        return (conversation.user_low_id, conversation.user_high_id)
    channel = await get_server_channel(session, conversation.id)
    if channel is not None:
        return tuple(
            await session.scalars(
                select(ServerMember.user_id)
                .where(ServerMember.server_id == channel.server_id)
                .order_by(ServerMember.joined_at, ServerMember.user_id)
            )
        )
    return tuple(
        await session.scalars(
            select(ConversationMember.user_id)
            .where(ConversationMember.conversation_id == conversation.id)
            .order_by(ConversationMember.joined_at, ConversationMember.user_id)
        )
    )


async def get_conversation(
    session: AsyncSession, current_user: User, conversation_id: UUID
) -> Conversation:
    conversation = await session.get(Conversation, conversation_id)
    if conversation is None:
        raise ConversationNotFoundError
    from coherent_api.models.call_media import CallMediaSession

    media = await session.scalar(
        select(CallMediaSession).where(CallMediaSession.conversation_id == conversation_id)
    )
    if media:
        from coherent_api.models.call import Call
        from coherent_api.models.call_member import CallMember
        from coherent_api.services.calls import is_expired

        call = await session.get(Call, media.call_id)
        member = await session.get(CallMember, (media.call_id, current_user.id))
        if (
            call is None
            or call.status != "active"
            or is_expired(call)
            or member is None
            or member.state != "joined"
        ):
            raise ConversationNotFoundError
    if conversation.kind == "direct":
        allowed = current_user.id in (conversation.user_low_id, conversation.user_high_id)
    else:
        channel = await get_server_channel(session, conversation_id)
        allowed = (
            await session.get(ServerMember, (channel.server_id, current_user.id)) is not None
            if channel is not None
            else await session.get(ConversationMember, (conversation_id, current_user.id))
            is not None
        )
    if not allowed:
        raise ConversationNotFoundError
    return conversation


async def is_call_media(session, conversation_id):
    from coherent_api.models.call_media import CallMediaSession

    return (
        await session.scalar(
            select(CallMediaSession.call_id).where(
                CallMediaSession.conversation_id == conversation_id
            )
        )
        is not None
    )


async def validate_friends(session: AsyncSession, user_id: UUID, target_ids: set[UUID]) -> None:
    if not target_ids or user_id in target_ids:
        raise GroupMembershipError("Выбери друзей для группы")
    relations = list(
        await session.scalars(
            select(FriendRequest).where(
                FriendRequest.status == "accepted",
                or_(
                    and_(
                        FriendRequest.sender_id == user_id,
                        FriendRequest.recipient_id.in_(target_ids),
                    ),
                    and_(
                        FriendRequest.recipient_id == user_id,
                        FriendRequest.sender_id.in_(target_ids),
                    ),
                ),
            )
        )
    )
    accepted = {r.recipient_id if r.sender_id == user_id else r.sender_id for r in relations}
    if accepted != target_ids:
        raise GroupMembershipError("В группу можно добавить только своих друзей")


async def add_group_members(
    session: AsyncSession, current_user: User, conversation: Conversation, target_ids: set[UUID]
) -> None:
    if conversation.kind != "group":
        raise GroupMembershipError("Создайте групповой чат для общего звонка")
    if await get_server_channel(session, conversation.id) is not None or await is_call_media(
        session, conversation.id
    ):
        raise GroupMembershipError("Состав этой беседы управляется через сервер или звонок")
    conversation = await session.scalar(
        select(Conversation)
        .where(Conversation.id == conversation.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    await validate_friends(session, current_user.id, target_ids)
    current = set(await conversation_member_ids(session, conversation))
    if target_ids & current:
        raise GroupMembershipError("Пользователь уже в группе")
    if len(current) + len(target_ids) > 10:
        raise GroupMembershipError("В группе может быть не более 10 участников")
    await require_ready_accounts(session, target_ids)
    for target_id in sorted(target_ids):
        session.add(ConversationMember(conversation_id=conversation.id, user_id=target_id))
    conversation.updated_at = datetime.now(UTC)
    await session.flush()


async def require_ready_accounts(session, targets: set[UUID]) -> None:
    from coherent_api.models.e2ee import E2eeAccount

    settings = session.info.get("settings")
    if not settings or not settings.e2ee_messaging_enabled:
        return
    ready = set(
        await session.scalars(
            select(E2eeAccount.user_id).where(
                E2eeAccount.user_id.in_(targets), E2eeAccount.roster_revision > 0
            )
        )
    )
    if ready != targets:
        raise GroupMembershipError(
            "Сначала участники должны настроить защищённую переписку в профиле"
        )


async def remove_group_member(session, user: User, conversation_id: UUID, target_id: UUID):
    from coherent_api.models.call import Call
    from coherent_api.models.call_member import CallMember

    conversation = await get_conversation(session, user, conversation_id)
    if (
        conversation.kind != "group"
        or await get_server_channel(session, conversation_id)
        or await is_call_media(session, conversation_id)
    ):
        raise GroupMembershipError("Составом канала управляют настройки сервера")
    members = await conversation_member_ids(session, conversation)
    if target_id not in members or (target_id != user.id and conversation.owner_id != user.id):
        raise GroupMembershipError("Удалять участников может владелец группы")
    active = await session.scalar(
        select(Call.id)
        .join(CallMember, CallMember.call_id == Call.id)
        .where(
            Call.conversation_id == conversation_id,
            Call.status.in_(["ringing", "active"]),
            CallMember.user_id == target_id,
            CallMember.state.in_(["joined", "invited"]),
        )
    )
    if active:
        from coherent_api.services.calls import end_call

        target = await session.get(User, target_id)
        await end_call(session, target, active)
    conversation = await session.scalar(
        select(Conversation)
        .where(Conversation.id == conversation_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    members = await conversation_member_ids(session, conversation)
    if target_id not in members or (target_id != user.id and conversation.owner_id != user.id):
        raise GroupMembershipError("Состав группы изменился. Обнови беседу")
    from coherent_api.services.crypto_history import remember_accounts

    await remember_accounts(session, conversation_id, members)
    member = await session.get(ConversationMember, (conversation_id, target_id))
    await session.delete(member)
    if conversation.owner_id == target_id:
        conversation.owner_id = next((uid for uid in members if uid != target_id), None)
    conversation.updated_at = datetime.now(UTC)
    await session.commit()
    return members, active
