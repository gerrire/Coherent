import base64
import json
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import and_, delete, exists, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from coherent_api.core.chat_crypto import cloud_message, message_text, set_cloud_body
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
    MessageReplyResponse,
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
from coherent_api.services.crypto_policy import (
    cloud_chats,
    is_mls_conversation,
    require_cloud_write,
)


class ConversationUserNotFoundError(Exception):
    pass


class SelfConversationError(Exception):
    pass


class MessageCursorNotFoundError(Exception):
    pass


class ReadMessageNotFoundError(Exception):
    pass


class MessageChangeError(Exception):
    pass


class MessageReplyError(Exception):
    pass


async def validate_reply(
    session: AsyncSession, conversation_id: UUID, reply_to_id: UUID | None
) -> None:
    if reply_to_id is None:
        return
    target = await session.scalar(
        select(Message).where(
            Message.id == reply_to_id,
            Message.conversation_id == conversation_id,
            Message.deleted_at.is_(None),
            Message.mls_payload.is_(None),
        )
    )
    if target is None:
        raise MessageReplyError(
            "Сообщение для ответа недоступно. Сними ответ и отправь текст снова."
        )


async def with_reply_previews(
    session: AsyncSession, messages: list[MessageResponse]
) -> list[MessageResponse]:
    targets = {item.reply_to_id for item in messages if item.reply_to_id and not item.deleted_at}
    if not targets:
        return messages
    rows = (
        await session.execute(
            select(Message, User.username, User.display_name)
            .join(User, User.id == Message.sender_id)
            .where(
                Message.id.in_(targets),
                Message.conversation_id.in_({m.conversation_id for m in messages}),
            )
        )
    ).all()
    replies = {}
    for target, username, display_name in rows:
        visible = visible_message(session, target)
        replies[target.id] = (
            target.conversation_id,
            MessageReplyResponse(
                id=target.id,
                sender_id=target.sender_id,
                sender_name=(display_name or "").strip() or username,
                body=visible.body[:500],
                attachment_count=visible.attachment_count,
                attachments_expired=visible.attachments_expired,
                created_at=target.created_at,
                edited_at=target.edited_at,
                deleted_at=target.deleted_at,
            ),
        )
    return [
        message.model_copy(update={"reply_to": replies[message.reply_to_id][1]})
        if not message.deleted_at
        and message.reply_to_id in replies
        and replies[message.reply_to_id][0] == message.conversation_id
        else message
        for message in messages
    ]


def visible_message(
    session: AsyncSession, message: Message, attachments: list[AttachmentResponse] | None = None
) -> MessageResponse:
    if message.deleted_at is not None:
        return MessageResponse.model_validate(message).model_copy(
            update={
                "body": "Сообщение удалено",
                "crypto": None,
                "attachments": [],
                "attachment_count": 0,
                "attachments_expired": False,
            }
        )
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
        if settings and settings.e2ee_messaging_enabled and not await cloud_chats(session)
        else set()
        if await cloud_chats(session)
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
    around: UUID | None = None,
) -> MessagesResponse:
    await get_conversation(session, current_user, conversation_id)
    if before is not None and around is not None:
        raise MessageCursorNotFoundError
    query = select(Message).where(Message.conversation_id == conversation_id)
    cursor = None
    if before is not None or around is not None:
        cursor = await session.get(Message, before or around)
        if cursor is None or cursor.conversation_id != conversation_id:
            raise MessageCursorNotFoundError
    if cursor is not None and before is not None:
        query = query.where(
            or_(
                Message.created_at < cursor.created_at,
                and_(Message.created_at == cursor.created_at, Message.id < cursor.id),
            )
        )

    has_newer = False
    if cursor is not None and around is not None:
        older = list(
            await session.scalars(
                query.where(
                    or_(
                        Message.created_at < cursor.created_at,
                        and_(Message.created_at == cursor.created_at, Message.id < cursor.id),
                    )
                )
                .order_by(Message.created_at.desc(), Message.id.desc())
                .limit(26)
            )
        )
        newer = list(
            await session.scalars(
                query.where(
                    or_(
                        Message.created_at > cursor.created_at,
                        and_(Message.created_at == cursor.created_at, Message.id >= cursor.id),
                    )
                )
                .order_by(Message.created_at, Message.id)
                .limit(26)
            )
        )
        page = list(reversed(older[:25])) + newer[:25]
        has_more = len(older) > 25
        has_newer = len(newer) > 25
    else:
        messages = list(
            await session.scalars(
                query.order_by(Message.created_at.desc(), Message.id.desc()).limit(51)
            )
        )
        page = list(reversed(messages[:50]))
        has_more = len(messages) > 50
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
        messages=await with_reply_previews(
            session,
            [visible_message(session, message, by_message.get(message.id, [])) for message in page],
        ),
        has_more=has_more,
        has_newer=has_newer,
    )


async def send_message(
    session: AsyncSession,
    current_user: User,
    conversation_id: UUID,
    body: str,
    reply_to_id: UUID | None = None,
) -> tuple[Message, Conversation]:
    conversation = await get_conversation(session, current_user, conversation_id)
    await require_cloud_write(session, conversation_id)
    await validate_reply(session, conversation_id, reply_to_id)
    message = cloud_message(
        session,
        conversation_id=conversation_id,
        sender_id=current_user.id,
        body=body,
        reply_to_id=reply_to_id,
    )
    conversation.updated_at = datetime.now(UTC)
    session.add(message)
    await session.commit()
    await session.refresh(message)
    return message, conversation


async def change_message(
    session: AsyncSession,
    current_user: User,
    conversation_id: UUID,
    message_id: UUID,
    body: str | None,
) -> tuple[MessageResponse, tuple[UUID, ...], list[UUID]]:
    """Only the author can change a message; tombstones keep pagination stable."""
    conversation = await get_conversation(session, current_user, conversation_id)
    await require_cloud_write(session, conversation_id)
    message = await session.scalar(
        select(Message)
        .where(Message.id == message_id, Message.conversation_id == conversation_id)
        .with_for_update()
    )
    if message is None:
        raise ReadMessageNotFoundError
    if message.sender_id != current_user.id:
        raise MessageChangeError("Можно изменять и удалять только свои сообщения")
    if message.mls_payload:
        raise MessageChangeError("Изменение старых E2EE-сообщений недоступно")
    attachments = list(
        await session.scalars(
            select(MessageAttachment).where(MessageAttachment.message_id == message.id)
        )
    )
    removed_files: list[UUID] = []
    if body is None:
        if message.deleted_at is None:
            removed_files = [item.id for item in attachments]
            await session.execute(
                delete(MessageAttachment).where(MessageAttachment.message_id == message.id)
            )
            # Erase the ciphertext itself, not merely its visible presentation.
            message.body = "Сообщение удалено"
            message.body_ciphertext = None
            message.attachment_count = 0
            message.attachments_expired = False
            message.deleted_at = datetime.now(UTC)
            message.reply_to_id = None
        attachments = []
    else:
        if message.deleted_at is not None:
            raise MessageChangeError("Удалённое сообщение нельзя редактировать")
        # Reuse the same authenticated conversation/message identity and a new nonce.
        set_cloud_body(session, message, body)
        message.edited_at = datetime.now(UTC)
    member_ids = tuple(await conversation_member_ids(session, conversation))
    await session.commit()
    return (
        (
            await with_reply_previews(
                session,
                [
                    visible_message(
                        session,
                        message,
                        [AttachmentResponse.model_validate(a) for a in attachments],
                    )
                ],
            )
        )[0],
        member_ids,
        removed_files,
    )
