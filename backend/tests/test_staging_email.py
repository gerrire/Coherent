import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from conftest import verified_signup

from coherent_api.models.email_verification import EmailVerification
from coherent_api.services import email_verification

PASSWORD = "Staging-email-QA-2026!"


def signup(client, csrf_token):
    response = verified_signup(
        client,
        {"X-CSRF-Token": csrf_token},
        {"email": "before@example.com", "username": "email_tester", "password": PASSWORD},
    )
    assert response.status_code == 201
    return response.json()["user"]["id"], {"X-CSRF-Token": csrf_token}


def enable_test_mode(client):
    settings = client.app.state.settings
    settings.app_env = "test"
    settings.test_email_verification_bypass = True
    settings.smtp_host = None


def request_change(client, headers, email="after@example.com", password=PASSWORD):
    return client.post(
        "/api/v1/auth/email/code",
        headers=headers,
        json={"email": email, "current_password": password},
    )


@pytest.mark.parametrize("code", ["000000", "987654"])
def test_test_email_accepts_any_six_digits_without_smtp(client, csrf_token, monkeypatch, code):
    _, headers = signup(client, csrf_token)
    enable_test_mode(client)

    def unexpected_mail(*_args):
        pytest.fail("Test email confirmation must never send SMTP")

    monkeypatch.setattr(email_verification, "send_code", unexpected_mail)
    assert request_change(client, headers, password="wrong-password").status_code == 400
    assert request_change(client, headers).status_code == 202
    assert request_change(client, headers).status_code == 429
    confirmed = client.post("/api/v1/auth/email/confirm", headers=headers, json={"code": code})
    assert confirmed.status_code == 200
    assert confirmed.json()["email"] == "after@example.com"
    assert confirmed.json()["email_verified"] is True
    assert (
        client.post("/api/v1/auth/email/confirm", headers=headers, json={"code": code}).status_code
        == 400
    )


def test_real_email_challenge_stays_strict_when_test_mode_is_enabled(client, csrf_token):
    _, headers = signup(client, csrf_token)
    assert request_change(client, headers).status_code == 202
    correct = client.app.state.signup_codes["after@example.com"]
    wrong = "000000" if correct != "000000" else "111111"
    enable_test_mode(client)
    assert (
        client.post("/api/v1/auth/email/confirm", headers=headers, json={"code": wrong}).status_code
        == 400
    )
    assert (
        client.post(
            "/api/v1/auth/email/confirm", headers=headers, json={"code": correct}
        ).status_code
        == 200
    )


def test_test_email_challenge_is_rejected_after_test_mode_is_disabled(client, csrf_token):
    _, headers = signup(client, csrf_token)
    enable_test_mode(client)
    assert request_change(client, headers).status_code == 202
    client.app.state.settings.test_email_verification_bypass = False
    assert (
        client.post(
            "/api/v1/auth/email/confirm", headers=headers, json={"code": "000000"}
        ).status_code
        == 400
    )


def test_test_email_challenge_still_expires(client, csrf_token):
    user_id, headers = signup(client, csrf_token)
    enable_test_mode(client)
    assert request_change(client, headers).status_code == 202

    async def expire():
        async with client.app.state.session_factory() as session:
            challenge = await session.get(EmailVerification, UUID(user_id))
            challenge.expires_at = datetime.now(UTC) - timedelta(seconds=1)
            await session.commit()

    asyncio.run(expire())
    assert (
        client.post(
            "/api/v1/auth/email/confirm", headers=headers, json={"code": "000000"}
        ).status_code
        == 400
    )
