import re
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictStr, field_validator

TranslationLanguage = Literal["ru", "en", "de", "fr", "es"]
CONTROL_CHARACTERS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class CallTranslationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: StrictStr = Field(min_length=1, max_length=600)
    source_language: TranslationLanguage
    target_language: TranslationLanguage
    segment_id: UUID
    speaker_id: UUID

    @field_validator("text")
    @classmethod
    def validate_text(cls, text: str) -> str:
        text = text.strip()
        if not text or CONTROL_CHARACTERS.search(text):
            raise ValueError("Expected a non-empty caption without control characters")
        try:
            text.encode("utf-8")
        except UnicodeError as error:
            raise ValueError("Expected valid Unicode text") from error
        return text


class CallTranslationResponse(BaseModel):
    text: str


class CallTranslationConfig(BaseModel):
    enabled: bool
    configured: bool
    model: str | None
