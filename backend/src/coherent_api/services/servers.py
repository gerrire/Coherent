import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from coherent_api.models.conversation import Conversation
from coherent_api.models.server import Server, ServerChannel, ServerInvite, ServerMember
from coherent_api.models.user import User
from coherent_api.schemas.servers import ServerChannelResponse, ServerInviteResponse, ServerResponse


class ServerNotFoundError(Exception):
    pass


class ServerPermissionError(Exception):
    pass


class ServerLimitError(Exception):
    pass


async def get_server(
    session: AsyncSession, user: User, server_id: UUID, *, owner: bool = False
) -> Server:
    server = await session.get(Server, server_id)
    if server is None or await session.get(ServerMember, (server_id, user.id)) is None:
        raise ServerNotFoundError
    if owner and server.owner_id != user.id:
        raise ServerPermissionError
    return server


async def response(session: AsyncSession, server: Server) -> ServerResponse:
    channels = await session.scalars(
        select(ServerChannel)
        .where(ServerChannel.server_id == server.id)
        .order_by(ServerChannel.position, ServerChannel.id)
    )
    return ServerResponse(
        id=server.id,
        name=server.name,
        owner_id=server.owner_id,
        member_count=await session.scalar(
            select(func.count())
            .select_from(ServerMember)
            .where(ServerMember.server_id == server.id)
        )
        or 0,
        channels=[
            ServerChannelResponse(
                id=channel.id,
                conversation_id=channel.conversation_id,
                name=channel.name,
                category=channel.category,
            )
            for channel in channels
        ],
    )


async def list_servers(session: AsyncSession, user: User) -> list[ServerResponse]:
    servers = await session.scalars(
        select(Server)
        .join(ServerMember, ServerMember.server_id == Server.id)
        .where(ServerMember.user_id == user.id)
        .order_by(Server.created_at)
    )
    return [await response(session, server) for server in servers]


async def check_capacity(session: AsyncSession, user: User) -> None:
    await session.execute(select(User.id).where(User.id == user.id).with_for_update(key_share=True))
    count = (
        await session.scalar(
            select(func.count()).select_from(ServerMember).where(ServerMember.user_id == user.id)
        )
        or 0
    )
    if count >= 20:
        raise ServerLimitError("Можно состоять не более чем в 20 серверах")


async def create_channel(
    session: AsyncSession, user: User, server_id: UUID, name: str, category: str
) -> ServerResponse:
    server = await manage_server(session, user, server_id)
    await session.execute(select(Server.id).where(Server.id == server_id).with_for_update())
    count = (
        await session.scalar(
            select(func.count())
            .select_from(ServerChannel)
            .where(ServerChannel.server_id == server_id)
        )
        or 0
    )
    if count >= 50:
        raise ServerLimitError("На сервере может быть до 50 каналов")
    conversation = Conversation(kind="group", name=name)
    session.add(conversation)
    await session.flush()
    session.add(
        ServerChannel(
            server_id=server_id,
            conversation_id=conversation.id,
            name=name,
            category=category,
            position=count,
        )
    )
    await session.commit()
    return await response(session, server)


async def create_server(session: AsyncSession, user: User, name: str) -> ServerResponse:
    await check_capacity(session, user)
    server = Server(name=name, owner_id=user.id)
    session.add(server)
    await session.flush()
    session.add(ServerMember(server_id=server.id, user_id=user.id))
    await session.flush()
    return await create_channel(session, user, server.id, "общий", "Текстовые каналы")


async def create_invite(session: AsyncSession, user: User, server_id: UUID) -> ServerInviteResponse:
    await manage_server(session, user, server_id)
    await session.execute(select(Server.id).where(Server.id == server_id).with_for_update())
    # Replacing the previous invitation also provides an explicit way to revoke it.
    await session.execute(delete(ServerInvite).where(ServerInvite.server_id == server_id))
    code = secrets.token_urlsafe(24)
    invite = ServerInvite(
        server_id=server_id,
        token_hash=hashlib.sha256(code.encode()).hexdigest(),
        expires_at=datetime.now(UTC) + timedelta(days=7),
        max_uses=25,
    )
    session.add(invite)
    await session.commit()
    return ServerInviteResponse(code=code, expires_at=invite.expires_at, max_uses=invite.max_uses)


async def join_server(session: AsyncSession, user: User, code: str) -> ServerResponse:
    token_hash = hashlib.sha256(code.encode()).hexdigest()
    server_id = await session.scalar(
        select(ServerInvite.server_id).where(ServerInvite.token_hash == token_hash)
    )
    if server_id is None:
        raise ServerNotFoundError
    # All invitation mutations lock the server first, then the invitation.
    server = await session.scalar(
        select(Server)
        .where(Server.id == server_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if server is None:
        raise ServerNotFoundError
    invite = await session.scalar(
        select(ServerInvite)
        .where(ServerInvite.token_hash == token_hash, ServerInvite.server_id == server.id)
        .with_for_update()
    )
    if (
        invite is None
        or invite.expires_at.replace(tzinfo=UTC) <= datetime.now(UTC)
        or invite.uses >= invite.max_uses
    ):
        raise ServerNotFoundError
    if await session.get(ServerMember, (server.id, user.id)) is None:
        await check_capacity(session, user)
        count = (
            await session.scalar(
                select(func.count())
                .select_from(ServerMember)
                .where(ServerMember.server_id == server.id)
            )
            or 0
        )
        if count >= 100:
            raise ServerLimitError("На сервере уже 100 участников")
        session.add(ServerMember(server_id=server.id, user_id=user.id))
        invite.uses += 1
        await session.commit()
    return await response(session, server)


async def members(session, user, server_id):
    server = await get_server(session, user, server_id)
    rows = (
        await session.execute(
            select(ServerMember, User)
            .join(User, User.id == ServerMember.user_id)
            .where(ServerMember.server_id == server_id)
            .order_by(ServerMember.joined_at, User.username)
        )
    ).all()
    return [
        {
            "id": str(person.id),
            "username": person.username,
            "display_name": person.display_name,
            "role": "owner" if server.owner_id == person.id else member.role,
        }
        for member, person in rows
    ]


async def manage_server(session, user, server_id, *, owner=False):
    server = await get_server(session, user, server_id)
    server = await session.scalar(
        select(Server)
        .where(Server.id == server_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    member = await session.get(ServerMember, (server_id, user.id), populate_existing=True)
    if server.owner_id != user.id and (owner or member.role != "moderator"):
        raise ServerPermissionError
    return server


async def update_server(session, user, server_id, name):
    server = await manage_server(session, user, server_id, owner=True)
    server.name = name
    await session.commit()
    return await response(session, server)


async def change_role(session, user, server_id, target_id, role):
    server = await manage_server(session, user, server_id, owner=True)
    target = await session.get(ServerMember, (server_id, target_id))
    if target is None or target_id == server.owner_id:
        raise ServerPermissionError
    target.role = role
    await session.commit()


async def transfer_owner(session, user, server_id, target_id):
    server = await manage_server(session, user, server_id, owner=True)
    if target_id == user.id or await session.get(ServerMember, (server_id, target_id)) is None:
        raise ServerPermissionError
    server.owner_id = target_id
    await session.commit()
    return await response(session, server)


async def remove_member(session, user, server_id, target_id):
    server = await get_server(session, user, server_id)
    server = await session.scalar(
        select(Server)
        .where(Server.id == server_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if target_id == server.owner_id:
        raise ServerLimitError("Сначала передай владение другому участнику или удали сервер")
    target = await session.get(ServerMember, (server_id, target_id))
    if target is None:
        raise ServerNotFoundError
    if target_id != user.id:
        await manage_server(session, user, server_id)
        if target.role == "moderator" and server.owner_id != user.id:
            raise ServerPermissionError
    await session.delete(target)
    await session.commit()


async def update_channel(session, user, server_id, channel_id, name, category):
    server = await manage_server(session, user, server_id)
    channel = await session.get(ServerChannel, channel_id)
    if channel is None or channel.server_id != server_id:
        raise ServerNotFoundError
    channel.name, channel.category = name, category
    conversation = await session.get(Conversation, channel.conversation_id)
    conversation.name = name
    await session.commit()
    return await response(session, server)


async def delete_channel(session, user, server_id, channel_id):
    server = await manage_server(session, user, server_id)
    channel = await session.get(ServerChannel, channel_id)
    if channel is None or channel.server_id != server_id:
        raise ServerNotFoundError
    count = await session.scalar(
        select(func.count()).select_from(ServerChannel).where(ServerChannel.server_id == server_id)
    )
    if count <= 1:
        raise ServerLimitError("На сервере должен остаться хотя бы один текстовый канал")
    await session.execute(delete(Conversation).where(Conversation.id == channel.conversation_id))
    await session.commit()
    return await response(session, server)


async def delete_server(session, user, server_id):
    await manage_server(session, user, server_id, owner=True)
    ids = list(
        await session.scalars(
            select(ServerChannel.conversation_id).where(ServerChannel.server_id == server_id)
        )
    )
    await session.execute(delete(Conversation).where(Conversation.id.in_(ids)))
    await session.execute(delete(Server).where(Server.id == server_id))
    await session.commit()
