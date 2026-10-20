from uuid import UUID

from fastapi import APIRouter, HTTPException, Request, status

from coherent_api.api.dependencies import CurrentUser, SessionDep
from coherent_api.schemas.calls import (
    CallJoinResponse,
    CallResponse,
    CreateCallRequest,
    CurrentCallsResponse,
    InviteCallRequest,
)
from coherent_api.services.calls import (
    CallBusyError,
    CallForbiddenError,
    CallFullError,
    CallInviteError,
    CallNotFoundError,
    CallStateError,
    accept_call,
    close_livekit_room,
    current_calls,
    end_call,
    invite_to_call,
    join_call,
    livekit_ready,
    start_call,
)
from coherent_api.services.messages import ConversationNotFoundError

router = APIRouter(tags=["Звонки"])


async def publish_call(request: Request, call: CallResponse) -> None:
    await request.app.state.message_events.publish(
        tuple(participant.user_id for participant in call.participants),
        {"type": "call", "call": call.model_dump(mode="json")},
    )


@router.get("/calls/current", response_model=CurrentCallsResponse)
async def get_current_calls(user: CurrentUser, session: SessionDep) -> CurrentCallsResponse:
    return await current_calls(session, user)


@router.post(
    "/conversations/{conversation_id}/calls",
    response_model=CallResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_call(
    conversation_id: UUID,
    request: Request,
    user: CurrentUser,
    session: SessionDep,
    body: CreateCallRequest | None = None,
) -> CallResponse:
    if not livekit_ready(request.app.state.settings):
        raise HTTPException(status_code=503, detail="Сервер звонков пока не настроен")
    try:
        call = await start_call(session, user, conversation_id, body.invitee_ids if body else None)
    except ConversationNotFoundError as error:
        raise HTTPException(status_code=404, detail="Беседа не найдена") from error
    except CallBusyError as error:
        raise HTTPException(status_code=409, detail="Один из участников уже занят") from error
    except CallFullError as error:
        raise HTTPException(
            status_code=409, detail="В звонке может быть не более 10 участников"
        ) from error
    except CallInviteError as error:
        raise HTTPException(
            status_code=400, detail=str(error) or "Некорректный список участников"
        ) from error
    await publish_call(request, call)
    return call


@router.post("/calls/{call_id}/accept", response_model=CallResponse)
async def answer_call(
    call_id: UUID, request: Request, user: CurrentUser, session: SessionDep
) -> CallResponse:
    try:
        call = await accept_call(session, user, call_id)
    except CallNotFoundError as error:
        raise HTTPException(status_code=404, detail="Звонок не найден") from error
    except CallForbiddenError as error:
        raise HTTPException(
            status_code=403, detail="К этому звонку нельзя подключиться"
        ) from error
    except CallBusyError as error:
        raise HTTPException(status_code=409, detail="Сначала выйди из другого звонка") from error
    except CallStateError as error:
        raise HTTPException(status_code=409, detail="Этот вызов уже недоступен") from error
    await publish_call(request, call)
    return call


@router.post("/calls/{call_id}/end", response_model=CallResponse)
async def finish_call(
    call_id: UUID, request: Request, user: CurrentUser, session: SessionDep
) -> CallResponse:
    try:
        call, was_active = await end_call(session, user, call_id)
    except CallNotFoundError as error:
        raise HTTPException(status_code=404, detail="Звонок не найден") from error
    if was_active:
        await close_livekit_room(request.app.state.settings, call.id)
    await publish_call(request, call)
    return call


@router.post("/calls/{call_id}/invite", response_model=CallResponse)
async def invite_call_participants(
    call_id: UUID,
    body: InviteCallRequest,
    request: Request,
    user: CurrentUser,
    session: SessionDep,
) -> CallResponse:
    try:
        call = await invite_to_call(session, user, call_id, body.user_ids)
    except CallNotFoundError as error:
        raise HTTPException(status_code=404, detail="Звонок не найден") from error
    except CallStateError as error:
        raise HTTPException(
            status_code=409, detail="Приглашать может только участник звонка"
        ) from error
    except CallBusyError as error:
        raise HTTPException(status_code=409, detail="Один из приглашённых уже занят") from error
    except CallFullError as error:
        raise HTTPException(
            status_code=409, detail="В звонке может быть не более 10 участников"
        ) from error
    except CallInviteError as error:
        raise HTTPException(
            status_code=400, detail=str(error) or "Некорректный список участников"
        ) from error
    await publish_call(request, call)
    return call


@router.post("/calls/{call_id}/join", response_model=CallJoinResponse)
async def get_join_token(
    call_id: UUID, request: Request, user: CurrentUser, session: SessionDep
) -> CallJoinResponse:
    if not livekit_ready(request.app.state.settings):
        raise HTTPException(status_code=503, detail="Сервер звонков пока не настроен")
    try:
        return await join_call(session, user, call_id, request.app.state.settings)
    except CallNotFoundError as error:
        raise HTTPException(status_code=404, detail="Звонок не найден") from error
    except CallStateError as error:
        raise HTTPException(status_code=409, detail="Этот вызов уже недоступен") from error
