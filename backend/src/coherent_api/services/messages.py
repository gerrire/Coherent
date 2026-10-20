from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import and_, exists, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from coherent_api.models.conversation import Conversation
from coherent_api.models.conversation_member import ConversationMember
from coherent_api.models.friend_request import FriendRequest
from coherent_api.models.message import Message
from coherent_api.models.user import User
from coherent_api.schemas.messages import (
    ConversationResponse,
    ConversationsResponse,
    ConversationUser,
    MessageResponse,
    MessagesResponse,
)


class ConversationNotFoundError(Exception):
    pass


class ConversationUserNotFoundError(Exception):
    pass


class SelfConversationError(Exception):
    pass


class MessageCursorNotFoundError(Exception):
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


async def conversation_response(
    session: AsyncSession,
    conversation: Conversation,
    current_user_id: UUID,
    last_message: Message | None = None,
) -> ConversationResponse:
    member_ids = await conversation_member_ids(session, conversation)
    users = list(await session.scalars(select(User).where(User.id.in_(member_ids))))
    by_id = {user.id: user for user in users}
    members = [
        ConversationUser(id=by_id[uid].id, username=by_id[uid].username)
        for uid in member_ids
        if uid in by_id
    ]
    other = next((member for member in members if member.id != current_user_id), None)
    return ConversationResponse(
        id=conversation.id,
        kind=conversation.kind,
        name=conversation.name,
        members=members,
        other_user=other if conversation.kind == "direct" else None,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
        last_message=MessageResponse.model_validate(last_message) if last_message else None,
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


async def create_group(
    session: AsyncSession, current_user: User, user_ids: list[UUID], name: str | None
) -> ConversationResponse:
    targets = set(user_ids)
    if len(targets) != len(user_ids) or not 2 <= len(targets) <= 9:
        raise GroupMembershipError("Для группы выбери от 2 до 9 друзей")
    await validate_friends(session, current_user.id, targets)
    users = list(await session.scalars(select(User).where(User.id.in_(targets))))
    if len(users) != len(targets):
        raise ConversationUserNotFoundError
    display_name = (name or "").strip() or "Группа: " + ", ".join(
        user.username for user in sorted(users, key=lambda item: item.username)
    )
    conversation = Conversation(kind="group", name=display_name[:64])
    session.add(conversation)
    await session.flush()
    for user_id in (current_user.id, *sorted(targets)):
        session.add(ConversationMember(conversation_id=conversation.id, user_id=user_id))
    await session.commit()
    await session.refresh(conversation)
    return await conversation_response(session, conversation, current_user.id)


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


async def rename_group(
    session: AsyncSession, current_user: User, conversation_id: UUID, name: str
) -> ConversationResponse:
    conversation = await get_conversation(session, current_user, conversation_id)
    clean_name = name.strip()
    if conversation.kind != "group" or not clean_name:
        raise GroupMembershipError("Укажи название группы")
    conversation.name = clean_name
    conversation.updated_at = datetime.now(UTC)
    await session.commit()
    return await conversation_response(session, conversation, current_user.id)


async def open_conversation(
    session: AsyncSession, current_user: User, target_user_id: UUID
) -> ConversationResponse:
    if target_user_id == current_user.id:
        raise SelfConversationError
    target_user = await session.get(User, target_user_id)
    if target_user is None:
        raise ConversationUserNotFoundError

    low_id, high_id = sorted((current_user.id, target_user_id))
    query = select(Conversation).where(
        Conversation.user_low_id == low_id, Conversation.user_high_id == high_id
    )
    conversation = await session.scalar(query)
    if conversation is None:
        conversation = Conversation(user_low_id=low_id, user_high_id=high_id)
        session.add(conversation)
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            conversation = await session.scalar(query)
            if conversation is None:
                raise
        else:
            await session.refresh(conversation)

    last_message = await session.scalar(
        select(Message)
        .where(Message.conversation_id == conversation.id)
        .order_by(Message.created_at.desc(), Message.id.desc())
        .limit(1)
    )
    return await conversation_response(session, conversation, current_user.id, last_message)


async def list_conversations(session: AsyncSession, current_user: User) -> ConversationsResponse:
    last_message_id = (
        select(Message.id)
        .where(Message.conversation_id == Conversation.id)
        .order_by(Message.created_at.desc(), Message.id.desc())
        .limit(1)
        .correlate(Conversation)
        .scalar_subquery()
    )
    group_member = exists(
        select(ConversationMember.user_id).where(
            ConversationMember.conversation_id == Conversation.id,
            ConversationMember.user_id == current_user.id,
        )
    )
    rows = (
        await session.execute(
            select(Conversation, Message)
            .outerjoin(Message, Message.id == last_message_id)
            .where(
                or_(
                    Conversation.user_low_id == current_user.id,
                    Conversation.user_high_id == current_user.id,
                    group_member,
                )
            )
            .order_by(Conversation.updated_at.desc(), Conversation.id.desc())
            .limit(100)
        )
    ).all()
    return ConversationsResponse(
        conversations=[
            await conversation_response(session, conversation, current_user.id, last_message)
            for conversation, last_message in rows
        ]
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


async def list_messages(
    session: AsyncSession,
    current_user: User,
    conversation_id: UUID,
    before: UUID | None,
) -> MessagesResponse:
    await get_conversation(session, current_user, conversation_id)
    query = select(Message).where(Message.conversation_id == conversation_id)
    if before is not None:
        cursor = await session.get(Message, before)
        if cursor is None or cursor.conversation_id != conversation_id:
            raise MessageCursorNotFoundError
        query = query.where(
            or_(
                Message.created_at < cursor.created_at,
                and_(Message.created_at == cursor.created_at, Message.id < cursor.id),
            )
        )

    messages = list(
        await session.scalars(
            query.order_by(Message.created_at.desc(), Message.id.desc()).limit(51)
        )
    )
    return MessagesResponse(
        messages=[MessageResponse.model_validate(message) for message in reversed(messages[:50])],
        has_more=len(messages) > 50,
    )


async def send_message(
    session: AsyncSession, current_user: User, conversation_id: UUID, body: str
) -> tuple[Message, Conversation]:
    conversation = await get_conversation(session, current_user, conversation_id)
    message = Message(conversation_id=conversation_id, sender_id=current_user.id, body=body)
    conversation.updated_at = datetime.now(UTC)
    session.add(message)
    await session.commit()
    await session.refresh(message)
    return message, conversation
