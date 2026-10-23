"""Shared conversation membership rules for messages and calls."""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from coherent_api.models.conversation import Conversation
from coherent_api.models.conversation_member import ConversationMember
from coherent_api.models.friend_request import FriendRequest
from coherent_api.models.user import User


class ConversationNotFoundError(Exception):
    pass


class GroupMembershipError(Exception):
    pass


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
    if conversation.kind == "direct":
        allowed = current_user.id in (conversation.user_low_id, conversation.user_high_id)
    else:
        allowed = (
            await session.get(ConversationMember, (conversation_id, current_user.id)) is not None
        )
    if not allowed:
        raise ConversationNotFoundError
    return conversation


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
    await validate_friends(session, current_user.id, target_ids)
    current = set(await conversation_member_ids(session, conversation))
    if target_ids & current:
        raise GroupMembershipError("Пользователь уже в группе")
    if len(current) + len(target_ids) > 10:
        raise GroupMembershipError("В группе может быть не более 10 участников")
    for target_id in sorted(target_ids):
        session.add(ConversationMember(conversation_id=conversation.id, user_id=target_id))
    conversation.updated_at = datetime.now(UTC)
    await session.flush()
