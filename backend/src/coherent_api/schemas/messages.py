from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class OpenConversationRequest(BaseModel):
    user_id: UUID


class CreateGroupRequest(BaseModel):
    user_ids: list[UUID] = Field(min_length=2, max_length=9)
    name: str | None = Field(default=None, max_length=64)


class AddGroupMembersRequest(BaseModel):
    user_ids: list[UUID] = Field(min_length=1, max_length=9)


class RenameConversationRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)


class SendMessageRequest(BaseModel):
    body: str = Field(min_length=1, max_length=4000)
    reply_to_id: UUID | None = None

    @field_validator("body")
    @classmethod
    def reject_blank_message(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Сообщение не может быть пустым")
        return value


class MarkConversationReadRequest(BaseModel):
    message_id: UUID


class AttachmentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    filename: str
    media_type: str
    byte_size: int


class MessageReplyResponse(BaseModel):
    id: UUID
    sender_id: UUID
    sender_name: str
    body: str
    attachment_count: int = 0
    attachments_expired: bool = False
    created_at: datetime
    edited_at: datetime | None = None
    deleted_at: datetime | None = None


class MessageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    conversation_id: UUID
    sender_id: UUID
    reply_to_id: UUID | None = None
    reply_to: MessageReplyResponse | None = None
    crypto: dict | None = None
    body: str
    attachment_count: int = 0
    attachments_expired: bool = False
    attachments: list[AttachmentResponse] = Field(default_factory=list)
    created_at: datetime
    edited_at: datetime | None = None
    deleted_at: datetime | None = None


class ConversationUser(BaseModel):
    id: UUID
    username: str
    display_name: str | None = None


class ConversationResponse(BaseModel):
    id: UUID
    kind: str
    owner_id: UUID | None = None
    encryption: str = "cloud"
    name: str | None = None
    members: list[ConversationUser] = Field(default_factory=list)
    other_user: ConversationUser | None = None
    created_at: datetime
    updated_at: datetime
    last_message: MessageResponse | None = None
    unread: bool = False
    server_id: UUID | None = None
    channel_id: UUID | None = None


class ConversationsResponse(BaseModel):
    conversations: list[ConversationResponse] = Field(default_factory=list)
    next_cursor: str | None = None


class MessagesResponse(BaseModel):
    messages: list[MessageResponse] = Field(default_factory=list)
    has_more: bool = False
    has_newer: bool = False
