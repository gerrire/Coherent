import base64
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RecoveryEnvelope(StrictModel):
    version: Literal[1]
    nonce: str = Field(max_length=16)
    ciphertext: str = Field(max_length=64)

    @field_validator("nonce", "ciphertext")
    @classmethod
    def validate_bytes(cls, value: str, info) -> str:
        decoded = base64.b64decode(value, validate=True)
        if (
            len(decoded) != (12 if info.field_name == "nonce" else 48)
            or base64.b64encode(decoded).decode() != value
        ):
            raise ValueError("Invalid encrypted backup")
        return value


class DeviceBinding(StrictModel):
    version: Literal[1]
    account_id: UUID
    device_id: UUID
    signature_key: str = Field(max_length=44)

    @field_validator("signature_key")
    @classmethod
    def validate_key(cls, value: str) -> str:
        decoded = base64.b64decode(value, validate=True)
        if len(decoded) != 32 or base64.b64encode(decoded).decode() != value:
            raise ValueError("Invalid public key")
        return value


class ChallengeRequest(StrictModel):
    purpose: Literal["bootstrap", "recovery_view", "confirm_recovery", "action"]


class BootstrapRequest(StrictModel):
    challenge_id: UUID
    device: DeviceBinding
    proof: str = Field(min_length=88, max_length=88)
    backup: RecoveryEnvelope
    recovery_public_key: str = Field(min_length=44, max_length=44)

    @field_validator("recovery_public_key")
    @classmethod
    def valid_recovery_public(cls, value: str) -> str:
        decoded = base64.b64decode(value, validate=True)
        if len(decoded) != 32 or base64.b64encode(decoded).decode() != value:
            raise ValueError("Invalid recovery public key")
        return value

    current_password: SecretStr = Field(min_length=1, max_length=128)
    label: str = Field(min_length=1, max_length=64)
    platform: Literal["browser", "windows", "macos", "linux", "android", "ios"]

    @field_validator("label")
    @classmethod
    def label_printable(cls, value: str) -> str:
        if not value.strip() or not value.isprintable():
            raise ValueError("Invalid device name")
        return value.strip()


class DeviceProofRequest(StrictModel):
    challenge_id: UUID
    device_id: UUID
    proof: str = Field(min_length=88, max_length=88)
    current_password: SecretStr = Field(min_length=1, max_length=128)


class SignedRoster(StrictModel):
    payload: str = Field(min_length=1, max_length=32768)
    signature: str = Field(min_length=88, max_length=88)


class RosterPayload(StrictModel):
    version: Literal[1]
    account_id: UUID
    revision: int = Field(ge=1, le=1024)
    previous_hash: str = Field(min_length=44, max_length=44)
    archive_public_key: str = Field(min_length=44, max_length=44)
    devices: list[DeviceBinding] = Field(min_length=1, max_length=16)
    history_roots: list[str] = Field(default_factory=list, max_length=128)

    @field_validator("history_roots")
    @classmethod
    def valid_history_roots(cls, values: list[str]) -> list[str]:
        if len(set(values)) != len(values):
            raise ValueError("Duplicate history roots")
        for value in values:
            raw = base64.b64decode(value, validate=True)
            if len(raw) != 32 or base64.b64encode(raw).decode() != value:
                raise ValueError("Invalid history root")
        return values


class EnrollPayload(StrictModel):
    operation: Literal["enroll"]
    roster: SignedRoster
    label: str = Field(min_length=1, max_length=64)
    platform: Literal["browser", "windows", "macos", "linux", "android", "ios"]


class EnrollRequest(StrictModel):
    link_id: UUID | None = None
    challenge_id: UUID
    device: DeviceBinding
    proof: str = Field(min_length=88, max_length=88)
    payload: str = Field(min_length=1, max_length=49152)
    current_password: SecretStr = Field(default=SecretStr(""), max_length=128)


class ContactPinPayload(StrictModel):
    account_id: UUID
    public_key: str = Field(min_length=44, max_length=44)
    proof: str = Field(min_length=88, max_length=88)


class ContactPinsRequest(StrictModel):
    device_id: UUID
    pins: list[ContactPinPayload] = Field(max_length=1000)


class RotationEnvelope(StrictModel):
    version: Literal[1]
    nonce: str = Field(min_length=16, max_length=16)
    ciphertext: str = Field(min_length=64, max_length=24000)

    @field_validator("nonce", "ciphertext")
    @classmethod
    def encoding(cls, value, info):
        raw = base64.b64decode(value, validate=True)
        if base64.b64encode(raw).decode() != value or (
            info.field_name == "nonce" and len(raw) != 12
        ):
            raise ValueError("Invalid backup")
        return value


class RotationPayload(StrictModel):
    operation: Literal["rotate_recovery"]
    public_key: str = Field(min_length=44, max_length=44)
    backup: RotationEnvelope
    roster: SignedRoster
