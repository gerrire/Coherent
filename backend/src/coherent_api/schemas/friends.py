from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

RelationshipStatus = Literal["none", "outgoing_pending", "incoming_pending", "friends"]


class UserSearchItem(BaseModel):
    id: UUID
    username: str
    display_name: str | None = None
    relationship: RelationshipStatus
    request_id: UUID | None = None


class FriendItem(BaseModel):
    id: UUID
    username: str
    display_name: str | None = None
    since: datetime


class FriendRequestItem(BaseModel):
    request_id: UUID
    user_id: UUID
    username: str
    display_name: str | None = None
    created_at: datetime


class FriendRequestsResponse(BaseModel):
    incoming: list[FriendRequestItem] = Field(default_factory=list)
    outgoing: list[FriendRequestItem] = Field(default_factory=list)


class FriendsResponse(BaseModel):
    friends: list[FriendItem] = Field(default_factory=list)


class CreateFriendRequest(BaseModel):
    target_user_id: UUID


class FriendRequestResponse(BaseModel):
    request_id: UUID
    status: Literal["pending", "accepted"]
