from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, status

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
    current_calls,
    end_call,
    invite_to_call,
    join_call,
    start_call,
)
from coherent_api.services.conversation_access import ConversationNotFoundError
from coherent_api.services.livekit_media import (
    close_livekit_room,
    livekit_ready,
    remove_livekit_participant,
)
from coherent_api.services.push import send_to_users

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
    background_tasks: BackgroundTasks,
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
    invited = tuple(
        p.user_id for p in call.participants if p.state == "invited" and p.user_id != user.id
    )
    background_tasks.add_task(
        send_to_users,
        request.app.state.session_factory,
        request.app.state.settings,
        invited,
        {
            "title": "Входящий звонок",
            "body": f"{user.public_name} звонит тебе",
            "url": f"/?conversation={conversation_id}",
            "tag": f"call-{call.id}",
        },
    )
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
        raise HTTPException(status_code=403, detail="К этому звонку нельзя подключиться") from error
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
        call, _ = await end_call(session, user, call_id)
    except CallNotFoundError as error:
        raise HTTPException(status_code=404, detail="Звонок не найден") from error
    if call.status not in ("ringing", "active"):
        await close_livekit_room(request.app.state.settings, call.id)
    elif call.status == "active":
        await remove_livekit_participant(request.app.state.settings, call.id, user.id)
    await publish_call(request, call)
    return call


@router.post("/calls/{call_id}/invite", response_model=CallResponse)
async def invite_call_participants(
    call_id: UUID,
    body: InviteCallRequest,
    request: Request,
    background_tasks: BackgroundTasks,
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
    invited = tuple(
        p.user_id for p in call.participants if p.state == "invited" and p.user_id in body.user_ids
    )
    background_tasks.add_task(
        send_to_users,
        request.app.state.session_factory,
        request.app.state.settings,
        invited,
        {
            "title": "Приглашение в звонок",
            "body": f"{user.public_name} приглашает тебя",
            "url": f"/?conversation={call.conversation_id}",
            "tag": f"call-{call.id}",
        },
    )
    return call


@router.post("/calls/{call_id}/join", response_model=CallJoinResponse)
async def get_join_token(
    call_id: UUID, request: Request, user: CurrentUser, session: SessionDep
) -> CallJoinResponse:
    if not livekit_ready(request.app.state.settings):
        raise HTTPException(status_code=503, detail="Сервер звонков пока не настроен")
    try:
        from coherent_api.services.auth_security import token_digest

        token = request.cookies.get("coherent_session") or request.headers.get(
            "authorization", ""
        ).removeprefix("Bearer ")
        return await join_call(
            session, user, call_id, request.app.state.settings, token_digest(token)
        )
    except CallNotFoundError as error:
        raise HTTPException(status_code=404, detail="Звонок не найден") from error
    except CallStateError as error:
        raise HTTPException(status_code=409, detail="Этот вызов уже недоступен") from error


@router.post("/calls/media-events")
async def media_events(request: Request, session: SessionDep):
    """Only LiveKit's signed, body-bound webhook can enter this endpoint."""
    from livekit import api as livekit_api

    from coherent_api.models.call import Call
    from coherent_api.models.call_member import CallMember
    from coherent_api.services.calls import is_expired
    from coherent_api.services.livekit_media import ROOM_PREFIX

    settings = request.app.state.settings
    if not livekit_ready(settings):
        raise HTTPException(503, "Медиа-сервер недоступен")
    try:
        receiver = livekit_api.WebhookReceiver(
            livekit_api.TokenVerifier(
                settings.livekit_api_key, settings.livekit_api_secret.get_secret_value()
            )
        )
        raw = await request.body()
        if len(raw) > 65536:
            raise ValueError("size")
        event = receiver.receive(raw.decode(), request.headers.get("authorization", ""))
    except Exception:
        raise HTTPException(401, "Подпись события недействительна") from None
    if event.event == "participant_joined" and event.room.name.startswith(ROOM_PREFIX):
        try:
            call_id = UUID(event.room.name.removeprefix(ROOM_PREFIX))
            user_id = UUID(event.participant.identity)
        except ValueError:
            raise HTTPException(400, "Неверный участник") from None
        call = await session.get(Call, call_id)
        member = await session.get(CallMember, (call_id, user_id))
        if (
            call is None
            or call.status != "active"
            or is_expired(call)
            or member is None
            or member.state != "joined"
        ):
            await remove_livekit_participant(settings, call_id, user_id)
    return {"received": True}


@router.get("/calls/{call_id}/crypto")
async def call_crypto(call_id: UUID, user: CurrentUser, session: SessionDep):
    from coherent_api.models.call_member import CallMember
    from coherent_api.models.conversation import Conversation
    from coherent_api.services.call_media import sync_members
    from coherent_api.services.calls import get_call, is_expired
    from coherent_api.services.messages import conversation_response

    try:
        call = await get_call(session, user, call_id)
    except CallNotFoundError:
        raise HTTPException(404, "Звонок недоступен") from None
    member = await session.get(CallMember, (call_id, user.id))
    if call.status != "active" or is_expired(call) or member.state != "joined":
        raise HTTPException(403, "Войди в звонок перед настройкой шифрования")
    media_id = await sync_members(session, call)
    await session.commit()
    conversation = await session.get(Conversation, media_id)
    return await conversation_response(session, conversation, user.id)
