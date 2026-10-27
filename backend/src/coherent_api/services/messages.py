import base64
import json
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import and_, exists, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from coherent_api.core.chat_crypto import cloud_message, message_text
from coherent_api.models.call_media import CallMediaSession
from coherent_api.models.conversation import Conversation
from coherent_api.models.conversation_member import ConversationMember
from coherent_api.models.conversation_read import ConversationRead
from coherent_api.models.message import Message
from coherent_api.models.message_attachment import MessageAttachment
from coherent_api.models.server import ServerChannel
from coherent_api.models.user import User
from coherent_api.schemas.messages import (
    AttachmentResponse,
    ConversationResponse,
    ConversationsResponse,
    ConversationUser,
    MessageResponse,
    MessagesResponse,
)
from coherent_api.services.attachment_cleanup import EXPIRED_MESSAGE, is_expired
from coherent_api.services.conversation_access import (
    GroupMembershipError,
    conversation_member_ids,
    get_conversation,
    get_server_channel,
    validate_friends,
)
from coherent_api.services.crypto_policy import is_mls_conversation, require_cloud_write


class ConversationUserNotFoundError(Exception):
    pass


class SelfConversationError(Exception):
    pass


class MessageCursorNotFoundError(Exception):
    pass


class ReadMessageNotFoundError(Exception):
    pass


def visible_message(
    session: AsyncSession, message: Message, attachments: list[AttachmentResponse] | None = None
) -> MessageResponse:
    body = "Зашифрованное сообщение" if message.mls_payload else message_text(session, message)
    result = MessageResponse.model_validate(message).model_copy(update={"body": body})
    if message.mls_payload:
        result = result.model_copy(update={"crypto": json.loads(message.mls_payload)})
    if message.attachments_expired or (message.attachment_count and is_expired(message.created_at)):
        return result.model_copy(
            update={
                "body": body or EXPIRED_MESSAGE,
                "attachment_count": 0,
                "attachments_expired": True,
                "attachments": [],
            }
        )
    return result.model_copy(update={"attachments": attachments or []})


async def conversation_response(
    session: AsyncSession,
    conversation: Conversation,
    current_user_id: UUID,
    last_message: Message | None = None,
    last_read: ConversationRead | None = None,
    cached_users: list[User] | None = None,
    encrypted: bool | None = None,
) -> ConversationResponse:
    users = cached_users
    if users is None:
        member_ids = await conversation_member_ids(session, conversation)
        users = list(await session.scalars(select(User).where(User.id.in_(member_ids))))
    else:
        member_ids = [person.id for person in users]
    by_id = {user.id: user for user in users}
    members = [
        ConversationUser(
            id=by_id[uid].id, username=by_id[uid].username, display_name=by_id[uid].display_name
        )
        for uid in member_ids
        if uid in by_id
    ]
    other = next((member for member in members if member.id != current_user_id), None)
    return ConversationResponse(
        id=conversation.id,
        kind=conversation.kind,
        owner_id=conversation.owner_id,
        encryption="mls"
        if (
            encrypted
            if encrypted is not None
            else await is_mls_conversation(session, conversation.id)
        )
        else "cloud",
        name=conversation.name,
        members=members,
        other_user=other if conversation.kind == "direct" else None,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
        last_message=visible_message(session, last_message) if last_message else None,
        unread=bool(
            last_message
            and last_message.sender_id != current_user_id
            and (
                last_read is None
                or (last_message.created_at.replace(tzinfo=UTC), last_message.id)
                > (last_read.message_created_at.replace(tzinfo=UTC), last_read.message_id)
            )
        ),
    )


async def create_group(
    session: AsyncSession, current_user: User, user_ids: list[UUID], name: str | None
) -> ConversationResponse:
    targets = set(user_ids)
    if len(targets) != len(user_ids) or not 2 <= len(targets) <= 9:
        raise GroupMembershipError("Для группы выбери от 2 до 9 друзей")
    await validate_friends(session, current_user.id, targets)
    from coherent_api.services.conversation_access import require_ready_accounts

    await require_ready_accounts(session, targets | {current_user.id})
    users = list(await session.scalars(select(User).where(User.id.in_(targets))))
    if len(users) != len(targets):
        raise ConversationUserNotFoundError
    display_name = (name or "").strip() or "Группа: " + ", ".join(
        user.public_name for user in sorted(users, key=lambda item: item.username)
    )
    conversation = Conversation(kind="group", name=display_name[:64], owner_id=current_user.id)
    session.add(conversation)
    await session.flush()
    for user_id in (current_user.id, *sorted(targets)):
        session.add(ConversationMember(conversation_id=conversation.id, user_id=user_id))
    await session.commit()
    await session.refresh(conversation)
    return await conversation_response(session, conversation, current_user.id)


async def rename_group(
    session: AsyncSession, current_user: User, conversation_id: UUID, name: str
) -> ConversationResponse:
    conversation = await get_conversation(session, current_user, conversation_id)
    from coherent_api.services.conversation_access import is_call_media

    if await get_server_channel(session, conversation_id) is not None or await is_call_media(
        session, conversation_id
    ):
        raise GroupMembershipError("Каналом управляет владелец сервера")
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
    last_read = await session.get(ConversationRead, (conversation.id, current_user.id))
    return await conversation_response(
        session, conversation, current_user.id, last_message, last_read
    )


async def list_conversations(
    session: AsyncSession, current_user: User, cursor: str | None = None
) -> ConversationsResponse:
    position = None
    if cursor:
        try:
            raw = json.loads(base64.urlsafe_b64decode(cursor.encode()).decode())
            position = (datetime.fromisoformat(raw[0]), UUID(raw[1]))
        except (ValueError, TypeError, KeyError, IndexError):
            raise MessageCursorNotFoundError from None
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
                ~exists(
                    select(CallMediaSession.call_id).where(
                        CallMediaSession.conversation_id == Conversation.id
                    )
                ),
                ~exists(
                    select(ServerChannel.id).where(ServerChannel.conversation_id == Conversation.id)
                ),
                or_(
                    Conversation.user_low_id == current_user.id,
                    Conversation.user_high_id == current_user.id,
                    group_member,
                ),
            )
            .where(
                or_(
                    Conversation.updated_at < position[0],
                    and_(Conversation.updated_at == position[0], Conversation.id < position[1]),
                )
                if position
                else True
            )
            .order_by(Conversation.updated_at.desc(), Conversation.id.desc())
            .limit(101)
        )
    ).all()
    more = len(rows) > 100
    rows = rows[:100]
    ids = [conversation.id for conversation, _ in rows]
    group_members = list(
        (
            await session.execute(
                select(ConversationMember.conversation_id, ConversationMember.user_id)
                .where(ConversationMember.conversation_id.in_(ids))
                .order_by(ConversationMember.joined_at, ConversationMember.user_id)
            )
        ).all()
    )
    grouped = {}
    for cid, uid in group_members:
        grouped.setdefault(cid, []).append(uid)
    by_conversation = {
        c.id: (
            list((c.user_low_id, c.user_high_id)) if c.kind == "direct" else grouped.get(c.id, [])
        )
        for c, _ in rows
    }
    people = {
        p.id: p
        for p in await session.scalars(
            select(User).where(
                User.id.in_({uid for members in by_conversation.values() for uid in members})
            )
        )
    }
    from coherent_api.models.mls import MlsState

    settings = session.info.get("settings")
    encrypted_ids = (
        set(ids)
        if settings and settings.e2ee_messaging_enabled
        else set(
            await session.scalars(
                select(MlsState.conversation_id).where(
                    MlsState.conversation_id.in_(ids), MlsState.group_id.is_not(None)
                )
            )
        )
    )
    reads = {
        item.conversation_id: item
        for item in await session.scalars(
            select(ConversationRead).where(
                ConversationRead.user_id == current_user.id,
                ConversationRead.conversation_id.in_([conversation.id for conversation, _ in rows]),
            )
        )
    }
    return ConversationsResponse(
        conversations=[
            await conversation_response(
                session,
                conversation,
                current_user.id,
                last_message,
                reads.get(conversation.id),
                [people[uid] for uid in by_conversation[conversation.id] if uid in people],
                conversation.id in encrypted_ids,
            )
            for conversation, last_message in rows
        ],
        next_cursor=base64.urlsafe_b64encode(
            json.dumps([rows[-1][0].updated_at.isoformat(), str(rows[-1][0].id)]).encode()
        ).decode()
        if more
        else None,
    )


async def mark_conversation_read(
    session: AsyncSession, current_user: User, conversation_id: UUID, message_id: UUID
) -> None:
    await get_conversation(session, current_user, conversation_id)
    message = await session.get(Message, message_id)
    if message is None or message.conversation_id != conversation_id:
        raise ReadMessageNotFoundError
    marker = await session.get(ConversationRead, (conversation_id, current_user.id))
    if marker is None:
        session.add(
            ConversationRead(
                conversation_id=conversation_id,
                user_id=current_user.id,
                message_id=message.id,
                message_created_at=message.created_at,
            )
        )
    elif (message.created_at.replace(tzinfo=UTC), message.id) > (
        marker.message_created_at.replace(tzinfo=UTC),
        marker.message_id,
    ):
        marker.message_id = message.id
        marker.message_created_at = message.created_at
    try:
        await session.commit()
    except IntegrityError:
        # Another device may create the same read position at the same time.
        await session.rollback()
        marker = await session.get(ConversationRead, (conversation_id, current_user.id))
        if marker is None:
            raise
        if (message.created_at.replace(tzinfo=UTC), message.id) > (
            marker.message_created_at.replace(tzinfo=UTC),
            marker.message_id,
        ):
            marker.message_id = message.id
            marker.message_created_at = message.created_at
            await session.commit()


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
    page = list(reversed(messages[:50]))
    attachments = (
        list(
            await session.scalars(
                select(MessageAttachment).where(
                    MessageAttachment.message_id.in_([item.id for item in page])
                )
            )
        )
        if page
        else []
    )
    by_message: dict[UUID, list[AttachmentResponse]] = {}
    for attachment in attachments:
        by_message.setdefault(attachment.message_id, []).append(
            AttachmentResponse.model_validate(attachment)
        )
    return MessagesResponse(
        messages=[
            visible_message(session, message, by_message.get(message.id, [])) for message in page
        ],
        has_more=len(messages) > 50,
    )


async def send_message(
    session: AsyncSession, current_user: User, conversation_id: UUID, body: str
) -> tuple[Message, Conversation]:
    conversation = await get_conversation(session, current_user, conversation_id)
    await require_cloud_write(session, conversation_id)
    message = cloud_message(
        session, conversation_id=conversation_id, sender_id=current_user.id, body=body
    )
    conversation.updated_at = datetime.now(UTC)
    session.add(message)
    await session.commit()
    await session.refresh(message)
    return message, conversation
