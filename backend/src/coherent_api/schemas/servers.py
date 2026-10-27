from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


class CreateServerRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        value = value.strip()
        if not value or any(ord(char) < 32 for char in value):
            raise ValueError("Укажи название без управляющих символов")
        return value


class CreateChannelRequest(CreateServerRequest):
    category: str = Field(default="Текстовые каналы", min_length=1, max_length=64)

    @field_validator("category")
    @classmethod
    def clean_category(cls, value: str) -> str:
        return cls.clean_name(value)


class JoinServerRequest(BaseModel):
    code: str = Field(min_length=20, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")


class ServerChannelResponse(BaseModel):
    id: UUID
    conversation_id: UUID
    name: str
    category: str


class ServerResponse(BaseModel):
    id: UUID
    name: str
    owner_id: UUID
    member_count: int
    channels: list[ServerChannelResponse]


class ServerInviteResponse(BaseModel):
    code: str
    expires_at: datetime
    max_uses: int


class MemberRoleRequest(BaseModel):
    role: Literal["member", "moderator"]


class OwnershipRequest(BaseModel):
    user_id: UUID
