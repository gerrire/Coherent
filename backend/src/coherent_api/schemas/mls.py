import base64
from typing import Literal
from uuid import UUID

from pydantic import Field, field_validator

from coherent_api.schemas.e2ee import StrictModel


class CipherEnvelope(StrictModel):
    version: Literal[1]
    nonce: str = Field(min_length=16, max_length=16)
    ciphertext: str = Field(min_length=24, max_length=100000)

    @field_validator("nonce", "ciphertext")
    @classmethod
    def valid_base64(cls, value: str, info) -> str:
        data = base64.b64decode(value, validate=True)
        if base64.b64encode(data).decode() != value or (
            info.field_name == "nonce" and len(data) != 12
        ):
            raise ValueError("Invalid encrypted data")
        return value


class HistoryBackup(StrictModel):
    version: Literal[1]
    recipient: UUID
    encapsulated: str = Field(min_length=44, max_length=44)
    ciphertext: str = Field(min_length=24, max_length=16384)

    @field_validator("encapsulated", "ciphertext")
    @classmethod
    def valid_base64(cls, value: str, info) -> str:
        data = base64.b64decode(value, validate=True)
        if base64.b64encode(data).decode() != value or (
            info.field_name == "encapsulated" and len(data) != 32
        ):
            raise ValueError("Invalid archive")
        return value


class Context(StrictModel):
    conversation_id: UUID
    message_id: UUID
    sender_account_id: UUID
    sender_device_id: UUID


class EncryptedFile(StrictModel):
    id: UUID
    byte_size: int = Field(gt=0, le=25 * 1024 * 1024 + 4096)
    digest: str = Field(min_length=44, max_length=44)


class MessagePacket(StrictModel):
    context: Context
    epoch: int = Field(ge=0, le=2**53 - 1)
    wire: str = Field(min_length=4, max_length=131072)
    body: CipherEnvelope
    backups: dict[UUID, HistoryBackup] = Field(min_length=1, max_length=10)


class LeaseRequest(StrictModel):
    device_id: UUID
    request_id: UUID
    operation: Literal["init", "add", "message", "reset"]


class TransportPayload(StrictModel):
    version: Literal[1]
    conversation_id: UUID
    group_id: UUID
    request_id: UUID
    lease_id: UUID
    expected_sequence: int = Field(ge=0, le=2**53 - 2)
    operation: Literal["init", "add", "message", "reset", "migrate"]
    previous_epoch: int = Field(ge=0, le=2**53 - 2)
    commit: str | None = Field(default=None, max_length=1400000)
    welcome: str | None = Field(default=None, max_length=1400000)
    targets: list[UUID] = Field(default_factory=list, max_length=100)
    package_ids: list[str] = Field(default_factory=list, max_length=100)
    roster: list[UUID] = Field(max_length=100, min_length=1)
    message: MessagePacket | None = None
    source_files: list[UUID] | None = Field(default=None, max_length=4)
    files: list[EncryptedFile] = Field(default_factory=list, max_length=4)


class TransportRequest(StrictModel):
    device_id: UUID
    payload: str = Field(min_length=1, max_length=2 * 1024 * 1024)
    proof: str = Field(min_length=88, max_length=88)


class CancelPayload(StrictModel):
    operation: Literal["cancel"]
    conversation_id: UUID
    lease_id: UUID
    request_id: UUID


class CancelRequest(TransportRequest):
    nonce: str = Field(min_length=44, max_length=44)
