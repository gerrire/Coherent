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
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.responses import FileResponse

from coherent_api.api.dependencies import CurrentUser, SessionDep
from coherent_api.core.security import decode_access_token
from coherent_api.models.user import User
from coherent_api.schemas.messages import (
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
from coherent_api.services.messages import (
    ConversationNotFoundError,
    ConversationUserNotFoundError,
    GroupMembershipError,
    MessageCursorNotFoundError,
    ReadMessageNotFoundError,
    SelfConversationError,
    conversation_member_ids,
    create_group,
    list_conversations,
    list_messages,
    mark_conversation_read,
    open_conversation,
    rename_group,
    send_message,
)
from coherent_api.services.push import send_to_users

router = APIRouter(prefix="/conversations", tags=["Сообщения"])


@router.get("", response_model=ConversationsResponse)
async def get_conversations(user: CurrentUser, session: SessionDep) -> ConversationsResponse:
    return await list_conversations(session, user)


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
            "title": user.username,
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
    return FileResponse(
        path,
        media_type=attachment.media_type,
        filename=attachment.filename,
        content_disposition_type="inline" if inline else "attachment",
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
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

    result = MessageResponse.model_validate(message)
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
            "title": user.username,
            "body": result.body[:150],
            "url": f"/?conversation={conversation_id}",
            "tag": f"message-{result.id}",
        },
    )
    return result


@router.websocket("/events")
async def message_events(websocket: WebSocket) -> None:
    settings = websocket.app.state.settings
    origin = websocket.headers.get("origin")
    if origin is None or origin not in settings.cors_origins:
        await websocket.close(code=1008)
        return

    token = websocket.cookies.get("coherent_session")
    identity = decode_access_token(token, settings) if token else None
    if identity is None:
        await websocket.close(code=1008)
        return

    session_factory = websocket.app.state.session_factory
    async with session_factory() as session:
        user = await session.get(User, identity[0])
    if user is None or user.session_version != identity[1]:
        await websocket.close(code=1008)
        return
    user_id = user.id

    await websocket.accept()
    events = websocket.app.state.message_events
    if events.add(user_id, websocket):
        await events.publish_all({"type": "presence"})
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        if events.remove(user_id, websocket):
            await events.publish_all({"type": "presence"})
