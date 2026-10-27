import asyncio
from pathlib import Path
from typing import Annotated
from uuid import UUID

from fastapi import (
    APIRouter,
    BackgroundTasks,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from coherent_api.api.dependencies import CurrentUser, SessionDep
from coherent_api.schemas.messages import (
    AddGroupMembersRequest,
    ConversationResponse,
    ConversationsResponse,
    CreateGroupRequest,
    MarkConversationReadRequest,
    MessageResponse,
    MessagesResponse,
    OpenConversationRequest,
    RenameConversationRequest,
    SendMessageRequest,
)
from coherent_api.services.attachments import (
    INLINE_TYPES,
    AttachmentError,
    AttachmentQuotaError,
    get_attachment,
    save_message_files,
)
from coherent_api.services.conversation_access import (
    ConversationNotFoundError,
    GroupMembershipError,
    conversation_member_ids,
)
from coherent_api.services.messages import (
    ConversationUserNotFoundError,
    MessageCursorNotFoundError,
    ReadMessageNotFoundError,
    SelfConversationError,
    conversation_response,
    create_group,
    list_conversations,
    list_messages,
    mark_conversation_read,
    open_conversation,
    rename_group,
    send_message,
    visible_message,
)
from coherent_api.services.push import send_to_users

router = APIRouter(prefix="/conversations", tags=["Сообщения"])


@router.get("", response_model=ConversationsResponse)
async def get_conversations(
    user: CurrentUser, session: SessionDep, cursor: str | None = None
) -> ConversationsResponse:
    if cursor and len(cursor) > 256:
        raise HTTPException(400, "Неверная позиция списка бесед")
    try:
        return await list_conversations(session, user, cursor)
    except MessageCursorNotFoundError:
        raise HTTPException(400, "Неверная позиция списка бесед") from None


@router.post("", response_model=ConversationResponse)
async def create_or_open_conversation(
    body: OpenConversationRequest, user: CurrentUser, session: SessionDep
) -> ConversationResponse:
    try:
        return await open_conversation(session, user, body.user_id)
    except SelfConversationError as error:
        raise HTTPException(status_code=400, detail="Нельзя написать самому себе") from error
    except ConversationUserNotFoundError as error:
        raise HTTPException(status_code=404, detail="Пользователь не найден") from error


@router.post("/groups", response_model=ConversationResponse, status_code=status.HTTP_201_CREATED)
async def create_group_conversation(
    body: CreateGroupRequest, request: Request, user: CurrentUser, session: SessionDep
) -> ConversationResponse:
    try:
        result = await create_group(session, user, body.user_ids, body.name)
    except GroupMembershipError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except ConversationUserNotFoundError as error:
        raise HTTPException(status_code=404, detail="Пользователь не найден") from error
    await request.app.state.message_events.publish(
        tuple(member.id for member in result.members), {"type": "conversation"}
    )
    return result


@router.post(
    "/{conversation_id}/messages/attachments",
    response_model=MessageResponse,
    status_code=status.HTTP_201_CREATED,
)
async def post_message_attachments(
    conversation_id: UUID,
    request: Request,
    background_tasks: BackgroundTasks,
    user: CurrentUser,
    session: SessionDep,
    files: Annotated[list[UploadFile], File()],
    body: str = Form(""),
) -> MessageResponse:
    try:
        result, member_ids = await save_message_files(
            session,
            user,
            conversation_id,
            body,
            files,
            request.app.state.settings,
        )
    except ConversationNotFoundError as error:
        raise HTTPException(status_code=404, detail="Беседа не найдена") from error
    except AttachmentQuotaError as error:
        raise HTTPException(status_code=507, detail=str(error)) from error
    except AttachmentError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    await request.app.state.message_events.publish(
        member_ids,
        {
            "type": "message",
            "conversation_id": str(conversation_id),
            "message": result.model_dump(mode="json"),
        },
    )
    background_tasks.add_task(
        send_to_users,
        request.app.state.session_factory,
        request.app.state.settings,
        tuple(uid for uid in member_ids if uid != user.id),
        {
            "title": user.public_name,
            "body": result.body or "Новое вложение",
            "url": f"/?conversation={conversation_id}",
            "tag": f"message-{result.id}",
        },
    )
    return result


@router.get("/{conversation_id}/attachments/{attachment_id}")
async def download_attachment(
    conversation_id: UUID,
    attachment_id: UUID,
    request: Request,
    user: CurrentUser,
    session: SessionDep,
) -> FileResponse:
    try:
        attachment = await get_attachment(session, user, conversation_id, attachment_id)
    except ConversationNotFoundError as error:
        raise HTTPException(status_code=404, detail="Беседа не найдена") from error
    path = Path(request.app.state.settings.attachment_dir) / str(attachment_id)
    if attachment is None or not path.is_file():
        raise HTTPException(status_code=404, detail="Файл не найден")
    inline = attachment.media_type in INLINE_TYPES
    background = None
    if attachment.encrypted:
        path = await asyncio.to_thread(
            request.app.state.chat_cipher.attachment_preview, path, conversation_id, attachment_id
        )
        background = BackgroundTask(path.unlink, missing_ok=True)
    return FileResponse(
        path,
        media_type=attachment.media_type,
        filename=attachment.filename,
        content_disposition_type="inline" if inline else "attachment",
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
        background=background,
    )


@router.patch("/{conversation_id}", response_model=ConversationResponse)
async def rename_group_conversation(
    conversation_id: UUID,
    body: RenameConversationRequest,
    request: Request,
    user: CurrentUser,
    session: SessionDep,
) -> ConversationResponse:
    try:
        result = await rename_group(session, user, conversation_id, body.name)
    except ConversationNotFoundError as error:
        raise HTTPException(status_code=404, detail="Беседа не найдена") from error
    except GroupMembershipError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    await request.app.state.message_events.publish(
        tuple(member.id for member in result.members), {"type": "conversation"}
    )
    return result


@router.get("/{conversation_id}/messages", response_model=MessagesResponse)
async def get_messages(
    conversation_id: UUID,
    user: CurrentUser,
    session: SessionDep,
    before: UUID | None = None,
) -> MessagesResponse:
    try:
        return await list_messages(session, user, conversation_id, before)
    except ConversationNotFoundError as error:
        raise HTTPException(status_code=404, detail="Беседа не найдена") from error
    except MessageCursorNotFoundError as error:
        raise HTTPException(status_code=400, detail="Сообщение для загрузки не найдено") from error


@router.post("/{conversation_id}/read", status_code=status.HTTP_204_NO_CONTENT)
async def mark_read(
    conversation_id: UUID,
    body: MarkConversationReadRequest,
    user: CurrentUser,
    session: SessionDep,
) -> None:
    try:
        await mark_conversation_read(session, user, conversation_id, body.message_id)
    except ConversationNotFoundError as error:
        raise HTTPException(status_code=404, detail="Беседа не найдена") from error
    except ReadMessageNotFoundError as error:
        raise HTTPException(status_code=404, detail="Сообщение не найдено") from error


@router.post(
    "/{conversation_id}/messages",
    response_model=MessageResponse,
    status_code=status.HTTP_201_CREATED,
)
async def post_message(
    conversation_id: UUID,
    body: SendMessageRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    user: CurrentUser,
    session: SessionDep,
) -> MessageResponse:
    try:
        message, conversation = await send_message(session, user, conversation_id, body.body)
    except ConversationNotFoundError as error:
        raise HTTPException(status_code=404, detail="Беседа не найдена") from error

    result = visible_message(session, message)
    await request.app.state.message_events.publish(
        await conversation_member_ids(session, conversation),
        {
            "type": "message",
            "conversation_id": str(conversation_id),
            "message": result.model_dump(mode="json"),
        },
    )
    member_ids = await conversation_member_ids(session, conversation)
    background_tasks.add_task(
        send_to_users,
        request.app.state.session_factory,
        request.app.state.settings,
        tuple(uid for uid in member_ids if uid != user.id),
        {
            "title": user.public_name,
            "body": result.body[:150],
            "url": f"/?conversation={conversation_id}",
            "tag": f"message-{result.id}",
        },
    )
    return result


@router.get("/{conversation_id}/messages/{message_id}", response_model=MessageResponse)
async def get_single_message(
    conversation_id: UUID, message_id: UUID, user: CurrentUser, session: SessionDep
) -> MessageResponse:
    from coherent_api.models.message import Message
    from coherent_api.services.conversation_access import get_conversation

    try:
        await get_conversation(session, user, conversation_id)
    except ConversationNotFoundError as error:
        raise HTTPException(status_code=404, detail="Беседа не найдена") from error
    message = await session.get(Message, message_id)
    if message is None or message.conversation_id != conversation_id:
        raise HTTPException(status_code=404, detail="Сообщение не найдено")
    from sqlalchemy import select

    from coherent_api.models.message_attachment import MessageAttachment
    from coherent_api.schemas.messages import AttachmentResponse

    attachments = list(
        await session.scalars(
            select(MessageAttachment).where(MessageAttachment.message_id == message.id)
        )
    )
    return visible_message(
        session, message, [AttachmentResponse.model_validate(a) for a in attachments]
    )


@router.post("/{conversation_id}/members", response_model=ConversationResponse)
async def add_members(
    conversation_id: UUID,
    body: AddGroupMembersRequest,
    request: Request,
    user: CurrentUser,
    session: SessionDep,
):
    from coherent_api.services.conversation_access import add_group_members, get_conversation

    try:
        conversation = await get_conversation(session, user, conversation_id)
        await add_group_members(session, user, conversation, set(body.user_ids))
        await session.commit()
    except GroupMembershipError as error:
        raise HTTPException(409, str(error)) from error
    except ConversationNotFoundError:
        raise HTTPException(404, "Группа недоступна") from None
    result = await conversation_response(session, conversation, user.id)
    await request.app.state.message_events.publish(
        tuple(m.id for m in result.members),
        {"type": "conversation", "conversation_id": str(conversation_id)},
    )
    return result


@router.delete("/{conversation_id}/members/{target_id}", status_code=204)
async def remove_member(
    conversation_id: UUID, target_id: UUID, request: Request, user: CurrentUser, session: SessionDep
):
    from coherent_api.services.conversation_access import remove_group_member

    try:
        members, call_id = await remove_group_member(session, user, conversation_id, target_id)
    except GroupMembershipError as error:
        raise HTTPException(403, str(error)) from error
    except ConversationNotFoundError:
        raise HTTPException(404, "Группа недоступна") from None
    if call_id:
        from coherent_api.services.livekit_media import remove_livekit_participant

        await remove_livekit_participant(request.app.state.settings, call_id, target_id)
    await request.app.state.message_events.publish(
        members,
        {
            "type": "conversation",
            "conversation_id": str(conversation_id),
            "removed_user_id": str(target_id),
        },
    )


@router.get("/{conversation_id}/migration")
async def migration_status(conversation_id: UUID, user: CurrentUser, session: SessionDep):
    from sqlalchemy import func, select

    from coherent_api.models.message import Message
    from coherent_api.services.conversation_access import get_conversation

    try:
        await get_conversation(session, user, conversation_id)
    except ConversationNotFoundError:
        raise HTTPException(404, "Беседа недоступна") from None
    rows = (
        await session.execute(
            select(Message.sender_id, func.count())
            .where(Message.conversation_id == conversation_id, Message.mls_payload.is_(None))
            .group_by(Message.sender_id)
        )
    ).all()
    own = sum(count for uid, count in rows if uid == user.id)
    return {
        "remaining": sum(count for _, count in rows),
        "own_remaining": own,
        "other_remaining": sum(count for uid, count in rows if uid != user.id),
    }
