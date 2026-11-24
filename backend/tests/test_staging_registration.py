import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from coherent_api.models.registration import RegistrationChallenge
from coherent_api.services.email_verification import TEST_CODE_DIGEST


def enable_test_verification(client: TestClient) -> None:
    client.app.state.settings.test_email_verification_bypass = True
    client.app.state.settings.smtp_host = None


def begin(client: TestClient, csrf_token: str, email: str = "unused@example.com"):
    return client.post(
        "/api/v1/auth/registration/code",
        headers={"X-CSRF-Token": csrf_token},
        json={"email": email},
    )


def signup(
    client: TestClient,
    csrf_token: str,
    verification_id: str,
    code: str = "123456",
    email: str = "unused@example.com",
    username: str = "staging_user",
    **extra,
):
    return client.post(
        "/api/v1/auth/register",
        headers={"X-CSRF-Token": csrf_token},
        json={
            "verification_id": verification_id,
            "code": code,
            "email": email,
            "username": username,
            "password": "correct-horse-92",
            **extra,
        },
    )


@pytest.mark.parametrize("code", ["000000", "123456", "999999"])
def test_test_registration_accepts_any_six_digits_without_smtp(
    client: TestClient, csrf_token: str, code: str
) -> None:
    enable_test_verification(client)
    challenge = begin(client, csrf_token)
    assert challenge.status_code == 202
    assert challenge.json()["test_mode"] is True
    identity = challenge.json()["verification_id"]
    delivery = client.get(f"/api/v1/auth/registration/{identity}")
    assert delivery.status_code == 200
    assert delivery.json()["delivery"] == "test"
    assert client.app.state.signup_codes == {}

    async def outbox():
        async with client.app.state.session_factory() as session:
            return await session.get(RegistrationChallenge, UUID(identity))

    stored = asyncio.run(outbox())
    assert stored.code_digest == TEST_CODE_DIGEST
    assert stored.code_ciphertext is None
    assert stored.delivery_attempts == 0
    result = signup(client, csrf_token, identity, code=code)
    assert result.status_code == 201
    assert result.json()["user"]["email"] == "unused@example.com"
    assert result.json()["user"]["email_verified"] is True

    client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": csrf_token})
    assert (
        client.post(
            "/api/v1/auth/login",
            headers={"X-CSRF-Token": csrf_token},
            json={"username": "staging_user", "password": "wrong-password"},
        ).status_code
        == 401
    )


def test_default_mode_requires_real_smtp_code(client: TestClient, csrf_token: str) -> None:
    assert client.app.state.settings.allow_test_email_verification is False
    challenge = begin(client, csrf_token)
    assert challenge.status_code == 202
    assert challenge.json()["test_mode"] is False
    identity = challenge.json()["verification_id"]
    actual = client.app.state.signup_codes["unused@example.com"]
    wrong = f"{(int(actual) + 1) % 1_000_000:06d}"
    assert signup(client, csrf_token, identity, code=wrong).status_code == 400
    assert signup(client, csrf_token, identity, code=actual).status_code == 201


def test_default_mode_without_smtp_stays_unavailable(client: TestClient, csrf_token: str) -> None:
    client.app.state.settings.smtp_host = None
    assert begin(client, csrf_token).status_code == 503


def test_enabling_test_mode_does_not_bypass_an_existing_real_challenge(
    client: TestClient, csrf_token: str
) -> None:
    challenge = begin(client, csrf_token)
    actual = client.app.state.signup_codes["unused@example.com"]
    wrong = f"{(int(actual) + 1) % 1_000_000:06d}"
    enable_test_verification(client)
    identity = challenge.json()["verification_id"]
    assert signup(client, csrf_token, identity, code=wrong).status_code == 400
    assert signup(client, csrf_token, identity, code=actual).status_code == 201


def test_test_challenge_stops_working_when_bypass_is_disabled(
    client: TestClient, csrf_token: str
) -> None:
    enable_test_verification(client)
    identity = begin(client, csrf_token).json()["verification_id"]
    client.app.state.settings.test_email_verification_bypass = False
    assert signup(client, csrf_token, identity).status_code == 400


@pytest.mark.parametrize("invalid_state", ["expired", "wrong_email", "unknown", "locked"])
def test_test_challenges_still_require_valid_unexpired_email_bound_challenge(
    client: TestClient, csrf_token: str, invalid_state: str
) -> None:
    enable_test_verification(client)
    identity = begin(client, csrf_token).json()["verification_id"]
    if invalid_state in {"expired", "locked"}:

        async def invalidate():
            async with client.app.state.session_factory() as session:
                challenge = await session.get(RegistrationChallenge, UUID(identity))
                if invalid_state == "expired":
                    challenge.expires_at = datetime.now(UTC) - timedelta(seconds=1)
                else:
                    challenge.attempts = 5
                await session.commit()

        asyncio.run(invalidate())
    if invalid_state == "unknown":
        identity = str(uuid4())
    email = "different@example.com" if invalid_state == "wrong_email" else "unused@example.com"
    assert signup(client, csrf_token, identity, email=email).status_code == 400


def test_test_challenges_are_single_use_and_rate_limited(
    client: TestClient, csrf_token: str
) -> None:
    enable_test_verification(client)
    identity = begin(client, csrf_token).json()["verification_id"]
    assert begin(client, csrf_token).status_code == 429
    assert signup(client, csrf_token, identity).status_code == 201
    assert signup(client, csrf_token, identity, username="second_user").status_code == 400


@pytest.mark.parametrize("code", ["", "12345", "1234567", "abcdef"])
def test_test_mode_keeps_confirmation_input_validation(
    client: TestClient, csrf_token: str, code: str
) -> None:
    enable_test_verification(client)
    identity = begin(client, csrf_token).json()["verification_id"]
    assert signup(client, csrf_token, identity, code=code).status_code == 422


def test_test_mode_cannot_be_selected_by_request_and_keeps_csrf_and_password_checks(
    client: TestClient, csrf_token: str
) -> None:
    assert (
        client.post(
            "/api/v1/auth/registration/code",
            headers={"X-CSRF-Token": csrf_token},
            json={"email": "unused@example.com", "test_mode": True},
        ).status_code
        == 422
    )
    enable_test_verification(client)
    assert (
        client.post(
            "/api/v1/auth/registration/code", json={"email": "unused@example.com"}
        ).status_code
        == 403
    )
    assert begin(client, csrf_token, email="not-an-email").status_code == 422
    identity = begin(client, csrf_token).json()["verification_id"]
    assert signup(client, csrf_token, identity, test_mode=True).status_code == 422
    assert signup(client, csrf_token, identity, password="short").status_code == 422


def test_test_mode_preserves_account_uniqueness(client: TestClient, csrf_token: str) -> None:
    enable_test_verification(client)
    first = begin(client, csrf_token).json()["verification_id"]
    assert signup(client, csrf_token, first).status_code == 201
    second = begin(client, csrf_token, email="another@example.com").json()["verification_id"]
    assert signup(client, csrf_token, second, email="another@example.com").status_code == 409
