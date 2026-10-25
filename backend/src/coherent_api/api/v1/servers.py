from uuid import UUID

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select

from coherent_api.api.dependencies import CurrentUser, SessionDep
from coherent_api.models.server import ServerChannel, ServerMember
from coherent_api.schemas.messages import ConversationResponse
from coherent_api.schemas.servers import (
    CreateChannelRequest,
    CreateServerRequest,
    JoinServerRequest,
    ServerInviteResponse,
    ServerResponse,
)
from coherent_api.services import servers
from coherent_api.services.conversation_access import get_conversation
from coherent_api.services.messages import conversation_response

router = APIRouter(prefix="/servers", tags=["Серверы"])


async def notify(request: Request, session: SessionDep, server_id: UUID) -> None:
    members = tuple(
        await session.scalars(
            select(ServerMember.user_id).where(ServerMember.server_id == server_id)
        )
    )
    await request.app.state.message_events.publish(
        members, {"type": "server", "server_id": str(server_id)}
    )


def server_error(error: Exception) -> HTTPException:
    if isinstance(error, servers.ServerPermissionError):
        return HTTPException(status_code=403, detail="Управление доступно владельцу сервера")
    if isinstance(error, servers.ServerLimitError):
        return HTTPException(status_code=409, detail=str(error))
    return HTTPException(status_code=404, detail="Сервер или приглашение недоступны")


@router.get("", response_model=list[ServerResponse])
async def list_servers(user: CurrentUser, session: SessionDep):
    return await servers.list_servers(session, user)


@router.post("", response_model=ServerResponse, status_code=status.HTTP_201_CREATED)
async def create_server(body: CreateServerRequest, user: CurrentUser, session: SessionDep):
    try:
        return await servers.create_server(session, user, body.name)
    except servers.ServerLimitError as error:
        raise server_error(error) from error


@router.post("/join", response_model=ServerResponse)
async def join_server(
    body: JoinServerRequest, request: Request, user: CurrentUser, session: SessionDep
):
    try:
        result = await servers.join_server(session, user, body.code)
    except (servers.ServerNotFoundError, servers.ServerLimitError) as error:
        raise server_error(error) from error
    await notify(request, session, result.id)
    return result


@router.post(
    "/{server_id}/channels", response_model=ServerResponse, status_code=status.HTTP_201_CREATED
)
async def create_channel(
    server_id: UUID,
    body: CreateChannelRequest,
    request: Request,
    user: CurrentUser,
    session: SessionDep,
):
    try:
        result = await servers.create_channel(session, user, server_id, body.name, body.category)
    except (
        servers.ServerNotFoundError,
        servers.ServerPermissionError,
        servers.ServerLimitError,
    ) as error:
        raise server_error(error) from error
    await notify(request, session, server_id)
    return result


@router.post("/{server_id}/invites", response_model=ServerInviteResponse)
async def create_invite(server_id: UUID, user: CurrentUser, session: SessionDep):
    try:
        return await servers.create_invite(session, user, server_id)
    except (servers.ServerNotFoundError, servers.ServerPermissionError) as error:
        raise server_error(error) from error


@router.get("/{server_id}/channels/{channel_id}/conversation", response_model=ConversationResponse)
async def channel_conversation(
    server_id: UUID, channel_id: UUID, user: CurrentUser, session: SessionDep
):
    try:
        await servers.get_server(session, user, server_id)
    except servers.ServerNotFoundError as error:
        raise server_error(error) from error
    channel = await session.get(ServerChannel, channel_id)
    if channel is None or channel.server_id != server_id:
        raise HTTPException(status_code=404, detail="Канал не найден")
    conversation = await get_conversation(session, user, channel.conversation_id)
    return (await conversation_response(session, conversation, user.id)).model_copy(
        update={"server_id": server_id, "channel_id": channel_id}
    )
