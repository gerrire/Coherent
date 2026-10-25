import re
import unicodedata
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

USERNAME_PATTERN = re.compile(r"^[a-zA-Z0-9_]{3,32}$")


class RegisterRequest(BaseModel):
    email: EmailStr | None = None
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=8, max_length=128)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str | None) -> str | None:
        return value.strip().lower() if value is not None else None

    @field_validator("username")
    @classmethod
    def validate_username(cls, value: str) -> str:
        value = value.strip()
        if not USERNAME_PATTERN.fullmatch(value):
            raise ValueError("Имя должно содержать 3–32 латинские буквы, цифры или подчёркивания")
        return value.lower()


class LoginRequest(BaseModel):
    username: str | None = Field(default=None, max_length=32)
    email: EmailStr | None = None
    password: str = Field(min_length=1, max_length=128)

    @model_validator(mode="after")
    def require_one_identifier(self) -> "LoginRequest":
        if (self.username is None) == (self.email is None):
            raise ValueError("Укажи имя пользователя")
        return self

    @field_validator("username")
    @classmethod
    def normalize_username(cls, value: str | None) -> str | None:
        return value.strip().lower() if value is not None else None

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str | None) -> str | None:
        return value.strip().lower() if value is not None else None


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    email: EmailStr | None
    username: str
    display_name: str | None = None
    created_at: datetime
    is_admin: bool = False
    email_verified: bool = False
    email_delivery_available: bool = False


class AuthResponse(BaseModel):
    user: UserResponse


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


class UpdateProfileRequest(BaseModel):
    display_name: str = Field(min_length=1, max_length=64)

    @field_validator("display_name")
    @classmethod
    def clean_display_name(cls, value: str) -> str:
        value = value.strip()
        if not value or any(
            unicodedata.category(char) == "Cc"
            or char in "\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069"
            for char in value
        ):
            raise ValueError("Укажи отображаемое имя без управляющих символов")
        return value


class CsrfResponse(BaseModel):
    csrf_token: str


class EmailCodeRequest(BaseModel):
    email: EmailStr
    current_password: str = Field(min_length=1, max_length=128)

    @field_validator("email")
    @classmethod
    def normalize(cls, value: str) -> str:
        return value.strip().lower()


class EmailCodeConfirm(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")
