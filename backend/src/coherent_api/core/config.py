from functools import lru_cache

from pydantic import SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"), env_file_encoding="utf-8", extra="ignore"
    )

    app_name: str = "Coherent API"
    app_env: str = "development"
    api_prefix: str = "/api/v1"
    secret_key: SecretStr = SecretStr(
        "development-only-secret-key-change-before-deployment-123456"
    )
    database_url: str = "postgresql+asyncpg://coherent:coherent@localhost:5432/coherent"
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
    cookie_secure: bool = False
    access_token_ttl_minutes: int = 60 * 24 * 7

    @model_validator(mode="after")
    def validate_production_secrets(self) -> "Settings":
        if self.access_token_ttl_minutes < 1:
            raise ValueError("ACCESS_TOKEN_TTL_MINUTES must be a positive value")

        if self.app_env == "production":
            secret = self.secret_key.get_secret_value()
            if len(secret) < 32 or secret.startswith("development-only-"):
                raise ValueError("SECRET_KEY must contain at least 32 characters in production")
            if not self.cookie_secure:
                raise ValueError("COOKIE_SECURE must be enabled in production")
            if "*" in self.cors_origins:
                raise ValueError("CORS_ORIGINS must list explicit domains in production")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
