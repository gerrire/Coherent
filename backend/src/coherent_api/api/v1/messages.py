from uuid import UUID

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect, status

from coherent_api.api.dependencies import CurrentUser, SessionDep
from coherent_api.core.security import decode_access_token
from coherent_api.models.user import User
from coherent_api.schemas.messages import (
    ConversationResponse,
    ConversationsResponse,
    MessageResponse,
    MessagesResponse,
    OpenConversationRequest,
    SendMessageRequest,
)
from coherent_api.services.messages import (
    ConversationNotFoundError,
    ConversationUserNotFoundError,
    MessageCursorNotFoundError,
    SelfConversationError,
    list_conversations,
    list_messages,
    open_conversation,
    other_user_id,
    send_message,
)

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


@router.post(
    "/{conversation_id}/messages",
    response_model=MessageResponse,
    status_code=status.HTTP_201_CREATED,
)
async def post_message(
    conversation_id: UUID,
    body: SendMessageRequest,
    request: Request,
    user: CurrentUser,
    session: SessionDep,
) -> MessageResponse:
    try:
        message, conversation = await send_message(session, user, conversation_id, body.body)
    except ConversationNotFoundError as error:
        raise HTTPException(status_code=404, detail="Беседа не найдена") from error

    result = MessageResponse.model_validate(message)
    await request.app.state.message_events.publish(
        (user.id, other_user_id(conversation, user.id)),
        {
            "type": "message",
            "conversation_id": str(conversation_id),
            "message": result.model_dump(mode="json"),
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
    user_id = decode_access_token(token, settings) if token else None
    if user_id is None:
        await websocket.close(code=1008)
        return

    session_factory = websocket.app.state.session_factory
    async with session_factory() as session:
        user = await session.get(User, user_id)
    if user is None:
        await websocket.close(code=1008)
        return

    await websocket.accept()
    events = websocket.app.state.message_events
    events.add(user_id, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        events.remove(user_id, websocket)
