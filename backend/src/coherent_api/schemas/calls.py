from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

CallStatus = Literal["ringing", "active", "declined", "cancelled", "ended", "missed"]


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


class CurrentCallsResponse(BaseModel):
    calls: list[CallResponse] = Field(default_factory=list)


class CallJoinResponse(BaseModel):
    server_url: str
    token: str
