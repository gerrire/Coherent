import asyncio
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from coherent_api.core.config import Settings
from coherent_api.db.base import Base
from coherent_api.main import create_app
from coherent_api.models import conversation as conversation_model  # noqa: F401
from coherent_api.models import conversation_read as conversation_read_model  # noqa: F401
from coherent_api.models import friend_request as friend_request_model  # noqa: F401
from coherent_api.models import message as message_model  # noqa: F401
from coherent_api.models import user as user_model  # noqa: F401
from coherent_api.services import email_verification


@pytest.fixture
def client(tmp_path, monkeypatch) -> Iterator[TestClient]:
    database_path = tmp_path / "test.sqlite3"
    engine = create_async_engine(f"sqlite+aiosqlite:///{database_path}", poolclass=NullPool)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async def prepare_database() -> None:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.run(prepare_database())
    settings = Settings(
        database_url=f"sqlite+aiosqlite:///{database_path}",
        secret_key="test-secret-key-that-is-long-enough-for-tests",
        cors_origins=["http://localhost:5173"],
        attachment_dir=str(tmp_path / "attachments"),
        chat_master_key_path=None,
        cloud_encryption_required=False,
        smtp_host="local-test",
    )
    application = create_app(settings=settings, session_factory=session_factory)
    application.state.signup_codes = {}
    monkeypatch.setattr(
        email_verification,
        "send_code",
        lambda _settings, email, code: application.state.signup_codes.__setitem__(email, code),
    )
    with TestClient(application) as test_client:
        yield test_client
    asyncio.run(engine.dispose())


def verified_signup(client: TestClient, headers: dict, payload: dict):
    email = payload.get("email") or f"{payload['username']}@example.com"
    challenge = client.post(
        "/api/v1/auth/registration/code", headers=headers, json={"email": email}
    )
    if challenge.status_code != 202:
        return challenge
    return client.post(
        "/api/v1/auth/register",
        headers=headers,
        json={
            **payload,
            "email": email,
            "verification_id": challenge.json()["verification_id"],
            "code": client.app.state.signup_codes[email],
        },
    )


@pytest.fixture
def csrf_token(client: TestClient) -> str:
    response = client.get("/api/v1/auth/csrf")
    assert response.status_code == 200
    return response.json()["csrf_token"]
