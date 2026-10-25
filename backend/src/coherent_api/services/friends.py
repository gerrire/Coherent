from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from coherent_api.models.friend_request import FriendRequest
from coherent_api.models.user import User
from coherent_api.schemas.friends import (
    FriendItem,
    FriendRequestItem,
    FriendRequestsResponse,
    FriendsResponse,
    UserSearchItem,
)


class UserNotFoundError(Exception):
    pass


class SelfFriendRequestError(Exception):
    pass


class FriendRequestConflictError(Exception):
    pass


class FriendRequestNotFoundError(Exception):
    pass


class FriendRequestPermissionError(Exception):
    pass


async def get_relationship(
    session: AsyncSession, current_user: User, target_user_id: UUID
) -> UserSearchItem:
    target = await session.get(User, target_user_id)
    if target is None or target.id == current_user.id:
        raise UserNotFoundError
    relation = await session.scalar(
        select(FriendRequest).where(
            or_(
                (FriendRequest.sender_id == current_user.id)
                & (FriendRequest.recipient_id == target_user_id),
                (FriendRequest.sender_id == target_user_id)
                & (FriendRequest.recipient_id == current_user.id),
            )
        )
    )
    if relation is None:
        return UserSearchItem(
            id=target.id,
            username=target.username,
            display_name=target.display_name,
            relationship="none",
        )
    if relation.status == "accepted":
        status = "friends"
    elif relation.sender_id == current_user.id:
        status = "outgoing_pending"
    else:
        status = "incoming_pending"
    return UserSearchItem(
        id=target.id,
        username=target.username,
        display_name=target.display_name,
        relationship=status,
        request_id=relation.id,
    )


async def search_users(
    session: AsyncSession,
    current_user: User,
    query: str,
) -> list[UserSearchItem]:
    escaped_query = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    users = list(
        await session.scalars(
            select(User)
            .where(
                User.id != current_user.id,
                or_(
                    User.username.ilike(f"%{escaped_query}%", escape="\\"),
                    User.display_name.ilike(f"%{escaped_query}%", escape="\\"),
                ),
            )
            .order_by(User.username)
            .limit(20)
        )
    )
    if not users:
        return []

    user_ids = [user.id for user in users]
    relations = list(
        await session.scalars(
            select(FriendRequest).where(
                FriendRequest.status.in_(("pending", "accepted")),
                or_(
                    (FriendRequest.sender_id == current_user.id)
                    & FriendRequest.recipient_id.in_(user_ids),
                    (FriendRequest.recipient_id == current_user.id)
                    & FriendRequest.sender_id.in_(user_ids),
                ),
            )
        )
    )
    relation_by_user: dict[UUID, FriendRequest] = {}
    for relation in relations:
        other_user_id = (
            relation.recipient_id if relation.sender_id == current_user.id else relation.sender_id
        )
        relation_by_user[other_user_id] = relation

    results = []
    for user in users:
        relation = relation_by_user.get(user.id)
        if relation is None:
            results.append(
                UserSearchItem(
                    id=user.id,
                    username=user.username,
                    display_name=user.display_name,
                    relationship="none",
                )
            )
        elif relation.status == "accepted":
            results.append(
                UserSearchItem(
                    id=user.id,
                    username=user.username,
                    display_name=user.display_name,
                    relationship="friends",
                    request_id=relation.id,
                )
            )
        elif relation.sender_id == current_user.id:
            results.append(
                UserSearchItem(
                    id=user.id,
                    username=user.username,
                    display_name=user.display_name,
                    relationship="outgoing_pending",
                    request_id=relation.id,
                )
            )
        else:
            results.append(
                UserSearchItem(
                    id=user.id,
                    username=user.username,
                    display_name=user.display_name,
                    relationship="incoming_pending",
                    request_id=relation.id,
                )
            )
    return results


async def create_friend_request(
    session: AsyncSession,
    current_user: User,
    target_user_id: UUID,
) -> FriendRequest:
    if current_user.id == target_user_id:
        raise SelfFriendRequestError

    target_user = await session.get(User, target_user_id)
    if target_user is None:
        raise UserNotFoundError

    existing_relation = await session.scalar(
        select(FriendRequest).where(
            or_(
                (FriendRequest.sender_id == current_user.id)
                & (FriendRequest.recipient_id == target_user_id),
                (FriendRequest.sender_id == target_user_id)
                & (FriendRequest.recipient_id == current_user.id),
            )
        )
    )
    if existing_relation is not None:
        if existing_relation.status == "accepted":
            raise FriendRequestConflictError("Вы уже друзья")
        if existing_relation.sender_id == current_user.id:
            raise FriendRequestConflictError("Заявка уже отправлена")
        existing_relation.status = "accepted"
        await session.commit()
        await session.refresh(existing_relation)
        return existing_relation

    friend_request = FriendRequest(sender_id=current_user.id, recipient_id=target_user_id)
    session.add(friend_request)
    try:
        await session.commit()
    except IntegrityError as error:
        await session.rollback()
        raise FriendRequestConflictError("Заявка уже отправлена") from error
    await session.refresh(friend_request)
    return friend_request


async def get_friends(session: AsyncSession, current_user: User) -> FriendsResponse:
    relations = list(
        await session.scalars(
            select(FriendRequest)
            .where(
                FriendRequest.status == "accepted",
                or_(
                    FriendRequest.sender_id == current_user.id,
                    FriendRequest.recipient_id == current_user.id,
                ),
            )
            .order_by(FriendRequest.created_at.desc())
        )
    )
    if not relations:
        return FriendsResponse()

    other_ids = [
        relation.recipient_id if relation.sender_id == current_user.id else relation.sender_id
        for relation in relations
    ]
    users = await session.scalars(select(User).where(User.id.in_(other_ids)))
    user_by_id = {user.id: user for user in users}
    return FriendsResponse(
        friends=[
            FriendItem(
                id=user_by_id[other_id].id,
                username=user_by_id[other_id].username,
                display_name=user_by_id[other_id].display_name,
                since=relation.created_at,
            )
            for relation, other_id in zip(relations, other_ids, strict=True)
            if other_id in user_by_id
        ]
    )


async def get_friend_requests(
    session: AsyncSession,
    current_user: User,
) -> FriendRequestsResponse:
    relations = list(
        await session.scalars(
            select(FriendRequest)
            .where(
                FriendRequest.status == "pending",
                or_(
                    FriendRequest.sender_id == current_user.id,
                    FriendRequest.recipient_id == current_user.id,
                ),
            )
            .order_by(FriendRequest.created_at.desc())
        )
    )
    if not relations:
        return FriendRequestsResponse()

    other_ids = [
        relation.sender_id if relation.recipient_id == current_user.id else relation.recipient_id
        for relation in relations
    ]
    users = await session.scalars(select(User).where(User.id.in_(other_ids)))
    user_by_id = {user.id: user for user in users}

    incoming: list[FriendRequestItem] = []
    outgoing: list[FriendRequestItem] = []
    for relation, other_id in zip(relations, other_ids, strict=True):
        user = user_by_id.get(other_id)
        if user is None:
            continue
        request_item = FriendRequestItem(
            request_id=relation.id,
            user_id=user.id,
            username=user.username,
            display_name=user.display_name,
            created_at=relation.created_at,
        )
        if relation.recipient_id == current_user.id:
            incoming.append(request_item)
        else:
            outgoing.append(request_item)
    return FriendRequestsResponse(incoming=incoming, outgoing=outgoing)


async def accept_friend_request(
    session: AsyncSession,
    current_user: User,
    request_id: UUID,
) -> FriendRequest:
    friend_request = await session.get(FriendRequest, request_id)
    if friend_request is None or friend_request.status != "pending":
        raise FriendRequestNotFoundError
    if friend_request.recipient_id != current_user.id:
        raise FriendRequestPermissionError

    friend_request.status = "accepted"
    await session.commit()
    await session.refresh(friend_request)
    return friend_request


async def remove_friend_request(
    session: AsyncSession,
    current_user: User,
    request_id: UUID,
) -> FriendRequest:
    friend_request = await session.get(FriendRequest, request_id)
    if friend_request is None or friend_request.status != "pending":
        raise FriendRequestNotFoundError
    if current_user.id not in (friend_request.sender_id, friend_request.recipient_id):
        raise FriendRequestPermissionError
    await session.delete(friend_request)
    await session.commit()
    return friend_request
