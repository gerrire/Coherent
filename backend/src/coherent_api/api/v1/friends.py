from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request, Response, status

from coherent_api.api.dependencies import CurrentUser, SessionDep
from coherent_api.schemas.friends import (
    CreateFriendRequest,
    FriendRequestResponse,
    FriendRequestsResponse,
    FriendsResponse,
    UserSearchItem,
)
from coherent_api.services.friends import (
    FriendRequestConflictError,
    FriendRequestNotFoundError,
    FriendRequestPermissionError,
    SelfFriendRequestError,
    UserNotFoundError,
    accept_friend_request,
    create_friend_request,
    get_friend_requests,
    get_friends,
    get_relationship,
    remove_friend_request,
    search_users,
)
from coherent_api.services.messages import list_conversations
from coherent_api.services.push import send_to_users

router = APIRouter(tags=["Пользователи и друзья"])


@router.get("/users/presence")
async def online_users(
    user: CurrentUser, session: SessionDep, request: Request
) -> dict[str, list[UUID]]:
    friends = await get_friends(session, user)
    conversations = await list_conversations(session, user)
    visible_ids = {friend.id for friend in friends.friends}
    visible_ids.update(
        member.id for conversation in conversations.conversations for member in conversation.members
    )
    visible_ids.discard(user.id)
    connected = request.app.state.message_events.connections
    return {"online_user_ids": [user_id for user_id in visible_ids if connected.get(user_id)]}


@router.get("/users/search", response_model=list[UserSearchItem])
async def find_users(
    user: CurrentUser,
    session: SessionDep,
    query: str = Query(min_length=2, max_length=32),
) -> list[UserSearchItem]:
    normalized_query = query.strip()
    if len(normalized_query) < 2:
        raise HTTPException(status_code=422, detail="Введите не менее двух символов")
    return await search_users(session, user, normalized_query)


@router.get("/friends", response_model=FriendsResponse)
async def list_friends(user: CurrentUser, session: SessionDep) -> FriendsResponse:
    return await get_friends(session, user)


@router.get("/users/{user_id}/relationship", response_model=UserSearchItem)
async def user_relationship(
    user_id: UUID, user: CurrentUser, session: SessionDep
) -> UserSearchItem:
    try:
        return await get_relationship(session, user, user_id)
    except UserNotFoundError as error:
        raise HTTPException(status_code=404, detail="Пользователь не найден") from error


@router.get("/friends/requests", response_model=FriendRequestsResponse)
async def list_friend_requests(
    user: CurrentUser,
    session: SessionDep,
) -> FriendRequestsResponse:
    return await get_friend_requests(session, user)


@router.post(
    "/friends/requests",
    response_model=FriendRequestResponse,
    status_code=status.HTTP_201_CREATED,
)
async def send_friend_request(
    body: CreateFriendRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    user: CurrentUser,
    session: SessionDep,
) -> FriendRequestResponse:
    try:
        friend_request = await create_friend_request(session, user, body.target_user_id)
    except SelfFriendRequestError as error:
        raise HTTPException(status_code=400, detail="Нельзя добавить самого себя") from error
    except UserNotFoundError as error:
        raise HTTPException(status_code=404, detail="Пользователь не найден") from error
    except FriendRequestConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error

    await request.app.state.message_events.publish(
        (friend_request.sender_id, friend_request.recipient_id),
        {"type": "friend_request"},
    )
    if friend_request.status == "pending":
        background_tasks.add_task(
            send_to_users,
            request.app.state.session_factory,
            request.app.state.settings,
            (friend_request.recipient_id,),
            {
                "title": "Заявка в друзья",
                "body": f"{user.username} хочет добавить тебя в друзья",
                "url": "/?friends=requests",
                "tag": f"friend-{friend_request.id}",
            },
        )

    return FriendRequestResponse(
        request_id=friend_request.id,
        status=friend_request.status,
    )


@router.post(
    "/friends/requests/{request_id}/accept",
    response_model=FriendRequestResponse,
)
async def accept_request(
    request_id: UUID,
    request: Request,
    user: CurrentUser,
    session: SessionDep,
) -> FriendRequestResponse:
    try:
        friend_request = await accept_friend_request(session, user, request_id)
    except FriendRequestNotFoundError as error:
        raise HTTPException(status_code=404, detail="Заявка не найдена") from error
    except FriendRequestPermissionError as error:
        raise HTTPException(
            status_code=403,
            detail="Эту заявку может принять только получатель",
        ) from error
    await request.app.state.message_events.publish(
        (friend_request.sender_id, friend_request.recipient_id),
        {"type": "friend_request"},
    )
    return FriendRequestResponse(request_id=friend_request.id, status=friend_request.status)


@router.delete("/friends/requests/{request_id}", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_or_decline_request(
    request_id: UUID,
    request: Request,
    user: CurrentUser,
    session: SessionDep,
) -> Response:
    try:
        friend_request = await remove_friend_request(session, user, request_id)
    except FriendRequestNotFoundError as error:
        raise HTTPException(status_code=404, detail="Заявка не найдена") from error
    except FriendRequestPermissionError as error:
        raise HTTPException(status_code=403, detail="Нет доступа к этой заявке") from error
    await request.app.state.message_events.publish(
        (friend_request.sender_id, friend_request.recipient_id),
        {"type": "friend_request"},
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
