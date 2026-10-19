from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from coherent_api.models.conversation import Conversation
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


def other_user_id(conversation: Conversation, user_id: UUID) -> UUID:
    return (
        conversation.user_high_id
        if conversation.user_low_id == user_id
        else conversation.user_low_id
    )


def conversation_response(
    conversation: Conversation,
    other_user: User,
    last_message: Message | None = None,
) -> ConversationResponse:
    return ConversationResponse(
        id=conversation.id,
        other_user=ConversationUser(id=other_user.id, username=other_user.username),
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
        last_message=MessageResponse.model_validate(last_message) if last_message else None,
    )


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
    return conversation_response(conversation, target_user, last_message)


async def list_conversations(
    session: AsyncSession, current_user: User
) -> ConversationsResponse:
    last_message_id = (
        select(Message.id)
        .where(Message.conversation_id == Conversation.id)
        .order_by(Message.created_at.desc(), Message.id.desc())
        .limit(1)
        .correlate(Conversation)
        .scalar_subquery()
    )
    rows = (
        await session.execute(
            select(Conversation, Message)
            .outerjoin(Message, Message.id == last_message_id)
            .where(
                or_(
                    Conversation.user_low_id == current_user.id,
                    Conversation.user_high_id == current_user.id,
                )
            )
            .order_by(Conversation.updated_at.desc(), Conversation.id.desc())
            .limit(100)
        )
    ).all()
    if not rows:
        return ConversationsResponse()

    other_ids = [other_user_id(conversation, current_user.id) for conversation, _ in rows]
    users = await session.scalars(select(User).where(User.id.in_(other_ids)))
    users_by_id = {user.id: user for user in users}
    return ConversationsResponse(
        conversations=[
            conversation_response(conversation, users_by_id[other_id], last_message)
            for (conversation, last_message), other_id in zip(rows, other_ids, strict=True)
            if other_id in users_by_id
        ]
    )


async def get_conversation(
    session: AsyncSession, current_user: User, conversation_id: UUID
) -> Conversation:
    conversation = await session.scalar(
        select(Conversation).where(
            Conversation.id == conversation_id,
            or_(
                Conversation.user_low_id == current_user.id,
                Conversation.user_high_id == current_user.id,
            ),
        )
    )
    if conversation is None:
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
