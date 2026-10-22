from pydantic import BaseModel, Field


class PushKeys(BaseModel):
    p256dh: str = Field(min_length=40, max_length=256)
    auth: str = Field(min_length=10, max_length=256)


class PushSubscriptionRequest(BaseModel):
    endpoint: str = Field(min_length=20, max_length=2000)
    keys: PushKeys


class PushSubscriptionDelete(BaseModel):
    endpoint: str = Field(min_length=20, max_length=2000)


class PushKeyResponse(BaseModel):
    public_key: str
