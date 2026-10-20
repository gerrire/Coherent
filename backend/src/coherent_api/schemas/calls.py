from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

CallStatus = Literal["ringing", "active", "declined", "cancelled", "ended", "missed"]


class CallParticipant(BaseModel):
    user_id: UUID
    username: str
    state: Literal["invited", "joined", "declined", "left"]


class CallResponse(BaseModel):
    id: UUID
    conversation_id: UUID
    caller_id: UUID
    caller_username: str
    callee_id: UUID
    callee_username: str
    status: CallStatus
    created_at: datetime
    expires_at: datetime
    answered_at: datetime | None
    ended_at: datetime | None
    participants: list[CallParticipant] = Field(default_factory=list)


class CurrentCallsResponse(BaseModel):
    calls: list[CallResponse] = Field(default_factory=list)


class CallJoinResponse(BaseModel):
    server_url: str
    token: str


class CreateCallRequest(BaseModel):
    invitee_ids: list[UUID] = Field(default_factory=list, max_length=8)


class InviteCallRequest(BaseModel):
    user_ids: list[UUID] = Field(min_length=1, max_length=9)
