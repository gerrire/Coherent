import pytest
from pydantic import ValidationError

from coherent_api.core.config import Settings


def secure_settings(environment: str, **overrides) -> Settings:
    return Settings(
        _env_file=None,
        **{
            "app_env": environment,
            "secret_key": "non-default-secret-key-with-at-least-thirty-two-characters",
            "cloud_encryption_required": True,
            "chat_master_key_path": "/run/private/master-key",
            "cookie_secure": True,
            "cors_origins": ["https://dev.coherent-web.ru"],
            **overrides,
        },
    )


@pytest.mark.parametrize("environment", ["development", "test", "staging", "production"])
def test_email_code_bypass_is_disabled_by_default(environment: str) -> None:
    settings = secure_settings(environment)
    assert settings.test_email_verification_bypass is False
    assert settings.allow_test_email_verification is False


@pytest.mark.parametrize("environment", ["development", "test", "staging"])
def test_email_code_bypass_requires_explicit_allowed_environment(environment: str) -> None:
    assert secure_settings(environment, test_email_verification_bypass=True)
    assert (
        secure_settings(
            environment, test_email_verification_bypass=True
        ).allow_test_email_verification
        is True
    )


@pytest.mark.parametrize("environment", ["production", "prod", "unknown", "Production"])
def test_production_or_unrecognized_environment_rejects_test_bypass(environment: str) -> None:
    with pytest.raises(ValidationError):
        secure_settings(environment, test_email_verification_bypass=True)


def test_runtime_gate_still_fails_closed_if_settings_are_copied_without_validation() -> None:
    production = secure_settings("production")
    invalid = production.model_copy(update={"test_email_verification_bypass": True})
    assert invalid.allow_test_email_verification is False


@pytest.mark.parametrize("environment", ["production", "staging"])
@pytest.mark.parametrize(
    "overrides",
    [
        {"secret_key": "development-only-not-a-real-secret"},
        {"cookie_secure": False},
        {"cloud_encryption_required": False},
        {"chat_master_key_path": None},
        {"cors_origins": ["*"]},
        {
            "livekit_url": "ws://example.com",
            "livekit_api_key": "key",
            "livekit_api_secret": "secret",
        },
    ],
)
def test_staging_keeps_production_security_requirements(environment: str, overrides: dict) -> None:
    with pytest.raises(ValidationError):
        secure_settings(environment, **overrides)
