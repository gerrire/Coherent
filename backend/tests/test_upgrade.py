import asyncio
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from conftest import verified_signup
from cryptography.exceptions import InvalidTag
from fastapi.testclient import TestClient
from sqlalchemy import select

from coherent_api.core.chat_crypto import ChatCipher
from coherent_api.models.email_verification import EmailVerification
from coherent_api.models.message import Message
from coherent_api.models.message_attachment import MessageAttachment
from coherent_api.services import email_verification
from coherent_api.services.attachment_cleanup import expire_batch, remove_files


def register(client: TestClient, csrf: str, name: str) -> tuple[str, dict]:
    response = verified_signup(
        client,
        headers={"X-CSRF-Token": csrf},
        payload={"username": name, "password": "correct-horse-92"},
    )
    assert response.status_code == 201
    token = client.cookies["coherent_session"]
    client.cookies.delete("coherent_session")
    return response.json()["user"]["id"], {"Authorization": f"Bearer {token}", "X-CSRF-Token": csrf}


def test_display_names_preserve_logins_and_admin_boundary(client: TestClient, csrf_token: str):
    _, alice = register(client, csrf_token, "alice")
    client.app.state.settings.admin_username = "gerrire"
    updated = client.patch("/api/v1/auth/profile", headers=alice, json={"display_name": "gerrire"})
    assert updated.status_code == 200
    assert updated.json()["username"] == "alice"
    assert updated.json()["display_name"] == "gerrire"
    assert updated.json()["is_admin"] is False
    assert client.get("/api/v1/admin/overview", headers=alice).status_code == 403
    assert client.get("/api/v1/admin/metrics", headers=alice).status_code == 403
    assert (
        client.patch("/api/v1/auth/profile", headers=alice, json={"display_name": "\n"}).status_code
        == 422
    )
    login = client.post(
        "/api/v1/auth/login",
        headers={"X-CSRF-Token": csrf_token},
        json={"username": "alice", "password": "correct-horse-92"},
    )
    assert login.status_code == 200
    assert login.json()["user"]["display_name"] == "gerrire"


def test_cipher_binds_messages_to_their_ids_and_key(tmp_path: Path):
    cipher = ChatCipher(os.urandom(32))
    conversation, message = uuid4(), uuid4()
    encrypted = cipher.encrypt("Привет 👋", conversation, message)
    assert cipher.decrypt(encrypted, conversation, message) == "Привет 👋"
    assert cipher.encrypt("Привет 👋", conversation, message) != encrypted
    with pytest.raises(InvalidTag):
        cipher.decrypt(encrypted, conversation, uuid4())
    with pytest.raises(InvalidTag):
        cipher.decrypt(encrypted, uuid4(), message)
    with pytest.raises(InvalidTag):
        ChatCipher(os.urandom(32)).decrypt(encrypted, conversation, message)
    with pytest.raises(ValueError):
        ChatCipher().decrypt(encrypted, conversation, message)
    key = tmp_path / "master"
    key.write_bytes(os.urandom(32))
    key.chmod(0o644)
    with pytest.raises(ValueError):
        ChatCipher.from_file(str(key))
    key.chmod(0o600)
    assert ChatCipher.from_file(str(key)).enabled


def test_encrypted_chat_and_files_remain_readable_for_members(client: TestClient, csrf_token: str):
    _, alice = register(client, csrf_token, "alice")
    bob_id, bob = register(client, csrf_token, "bob")
    _, outsider = register(client, csrf_token, "outsider")
    conversation = client.post(
        "/api/v1/conversations", headers=alice, json={"user_id": bob_id}
    ).json()["id"]
    endpoint = f"/api/v1/conversations/{conversation}"
    legacy = client.post(f"{endpoint}/messages", headers=alice, json={"body": "Старая история"})
    assert legacy.status_code == 201
    client.app.state.chat_cipher = ChatCipher(os.urandom(32))
    sent = client.post(f"{endpoint}/messages", headers=alice, json={"body": "Секретный текст"})
    assert sent.status_code == 201
    assert sent.json()["body"] == "Секретный текст"
    data = b"a-private-attachment" * 100_000
    uploaded = client.post(
        f"{endpoint}/messages/attachments",
        headers=alice,
        data={"body": "Подпись к файлу"},
        files={"files": ("data.bin", data, "application/octet-stream")},
    )
    assert uploaded.status_code == 201
    assert uploaded.json()["body"] == "Подпись к файлу"
    attachment = uploaded.json()["attachments"][0]["id"]

    async def stored():
        async with client.app.state.session_factory() as session:
            message = await session.get(Message, UUID(sent.json()["id"]))
            file = await session.get(MessageAttachment, UUID(attachment))
            return message.body, message.body_ciphertext, file.encrypted

    body, ciphertext, encrypted_file = asyncio.run(stored())
    assert body == "" and ciphertext and "Секретный" not in ciphertext
    assert encrypted_file is True
    raw = (Path(client.app.state.settings.attachment_dir) / attachment).read_bytes()
    assert data[:100] not in raw
    assert len(raw) > len(data)
    assert client.get(f"{endpoint}/attachments/{attachment}", headers=outsider).status_code == 404
    download = client.get(f"{endpoint}/attachments/{attachment}", headers=bob)
    assert download.status_code == 200 and download.content == data
    partial = client.get(
        f"{endpoint}/attachments/{attachment}", headers={**bob, "Range": "bytes=5-25"}
    )
    assert partial.status_code == 206 and partial.content == data[5:26]
    history = client.get(f"{endpoint}/messages", headers=bob).json()["messages"]
    assert [item["body"] for item in history] == [
        "Старая история",
        "Секретный текст",
        "Подпись к файлу",
    ]
    assert all("body_ciphertext" not in item for item in history)
    assert (
        client.get("/api/v1/conversations", headers=bob).json()["conversations"][0]["last_message"][
            "body"
        ]
        == "Подпись к файлу"
    )
    corrupt = bytearray(raw)
    corrupt[-1] ^= 1
    source = Path(client.app.state.settings.attachment_dir) / attachment
    source.write_bytes(corrupt)
    with pytest.raises(InvalidTag):
        client.app.state.chat_cipher.attachment_preview(
            source, UUID(conversation), UUID(attachment)
        )


def test_server_membership_protects_channels_and_owner_actions(client: TestClient, csrf_token: str):
    _, owner = register(client, csrf_token, "owner")
    _, member = register(client, csrf_token, "member")
    _, outsider = register(client, csrf_token, "outsider")
    created = client.post("/api/v1/servers", headers=owner, json={"name": "Наш сервер"})
    assert created.status_code == 201
    server = created.json()
    root = f"/api/v1/servers/{server['id']}"
    channel = server["channels"][0]
    opening = f"{root}/channels/{channel['id']}/conversation"
    messages = f"/api/v1/conversations/{channel['conversation_id']}/messages"
    assert client.get(opening, headers=member).status_code == 404
    assert client.get(messages, headers=outsider).status_code == 404
    invite = client.post(f"{root}/invites", headers=owner).json()["code"]
    assert (
        client.post("/api/v1/servers/join", headers=member, json={"code": invite}).status_code
        == 200
    )
    assert client.get(opening, headers=member).status_code == 200
    assert client.post(messages, headers=member, json={"body": "Привет серверу"}).status_code == 201
    assert client.get(messages, headers=owner).json()["messages"][0]["body"] == "Привет серверу"
    assert (
        client.post(f"{root}/channels", headers=member, json={"name": "чужой"}).status_code == 403
    )
    assert client.post(f"{root}/invites", headers=member).status_code == 403
    assert (
        client.patch(
            f"/api/v1/conversations/{channel['conversation_id']}",
            headers=member,
            json={"name": "Обход"},
        ).status_code
        == 400
    )
    assert client.get("/api/v1/conversations", headers=member).json()["conversations"] == []
    assert (
        client.post(
            f"{root}/channels", headers=owner, json={"name": "игры", "category": "Досуг"}
        ).status_code
        == 201
    )
    replacement = client.post(f"{root}/invites", headers=owner).json()["code"]
    assert (
        client.post("/api/v1/servers/join", headers=outsider, json={"code": invite}).status_code
        == 404
    )
    assert (
        client.post(
            "/api/v1/servers/join", headers=outsider, json={"code": replacement}
        ).status_code
        == 200
    )


def test_email_codes_are_bounded_single_use_and_not_stored_raw(
    client: TestClient, csrf_token: str, monkeypatch
):
    _, user = register(client, csrf_token, "alice")
    captured: list[str] = []
    client.app.state.settings.smtp_host = "local-test"
    monkeypatch.setattr(
        email_verification, "send_code", lambda _settings, _email, code: captured.append(code)
    )
    request = {"email": "alice@example.com", "current_password": "correct-horse-92"}
    assert client.post("/api/v1/auth/email/code", headers=user, json=request).status_code == 202
    assert client.post("/api/v1/auth/email/code", headers=user, json=request).status_code == 429
    assert len(captured) == 1

    async def stored():
        async with client.app.state.session_factory() as session:
            return await session.scalar(select(EmailVerification.code_digest))

    assert asyncio.run(stored()) != captured[0]
    wrong = f"{(int(captured[0]) + 1) % 1_000_000:06d}"
    assert (
        client.post("/api/v1/auth/email/confirm", headers=user, json={"code": wrong}).status_code
        == 400
    )
    confirmed = client.post("/api/v1/auth/email/confirm", headers=user, json={"code": captured[0]})
    assert confirmed.status_code == 200
    assert confirmed.json()["email_verified"] is True
    assert confirmed.json()["email"] == "alice@example.com"
    assert (
        client.post(
            "/api/v1/auth/email/confirm", headers=user, json={"code": captured[0]}
        ).status_code
        == 400
    )


def test_email_code_locks_after_five_attempts(client: TestClient, csrf_token: str, monkeypatch):
    _, user = register(client, csrf_token, "alice")
    captured: list[str] = []
    client.app.state.settings.smtp_host = "local-test"
    monkeypatch.setattr(
        email_verification, "send_code", lambda _settings, _email, code: captured.append(code)
    )
    request = {"email": "alice@example.com", "current_password": "correct-horse-92"}
    assert client.post("/api/v1/auth/email/code", headers=user, json=request).status_code == 202
    wrong = f"{(int(captured[0]) + 1) % 1_000_000:06d}"
    for _ in range(5):
        assert (
            client.post(
                "/api/v1/auth/email/confirm", headers=user, json={"code": wrong}
            ).status_code
            == 400
        )
    assert (
        client.post(
            "/api/v1/auth/email/confirm", headers=user, json={"code": captured[0]}
        ).status_code
        == 400
    )


def test_encrypted_attachment_retention_preserves_captions(client: TestClient, csrf_token: str):
    _, alice = register(client, csrf_token, "alice")
    bob_id, bob = register(client, csrf_token, "bob")
    client.app.state.chat_cipher = ChatCipher(os.urandom(32))
    conversation = client.post(
        "/api/v1/conversations", headers=alice, json={"user_id": bob_id}
    ).json()["id"]
    root = f"/api/v1/conversations/{conversation}"
    uploaded = []
    for caption in ["", "Подпись остаётся"]:
        response = client.post(
            f"{root}/messages/attachments",
            headers=alice,
            data={"body": caption},
            files={"files": ("file.txt", b"private", "text/plain")},
        )
        assert response.status_code == 201
        uploaded.append(response.json())

    async def expire():
        async with client.app.state.session_factory() as session:
            for item in uploaded:
                message = await session.get(Message, UUID(item["id"]))
                message.created_at = datetime.now(UTC) - timedelta(days=4)
            await session.commit()
        return await expire_batch(
            client.app.state.session_factory, datetime.now(UTC) - timedelta(days=3)
        )

    files, count = asyncio.run(expire())
    assert count == 2
    remove_files(Path(client.app.state.settings.attachment_dir), files)
    history = client.get(f"{root}/messages", headers=bob).json()["messages"]
    assert sorted(item["body"] for item in history) == ["Вложение удалено", "Подпись остаётся"]
    assert all(item["attachments_expired"] and not item["attachments"] for item in history)
    assert all(
        not (Path(client.app.state.settings.attachment_dir) / str(file)).exists() for file in files
    )


@pytest.mark.parametrize("reason", ["expired", "password_changed"])
def test_email_code_expiry_and_session_binding(
    client: TestClient, csrf_token: str, monkeypatch, reason: str
):
    user_id, user = register(client, csrf_token, "alice")
    captured = []
    client.app.state.settings.smtp_host = "local-test"
    monkeypatch.setattr(
        email_verification, "send_code", lambda _settings, _email, code: captured.append(code)
    )
    assert (
        client.post(
            "/api/v1/auth/email/code",
            headers=user,
            json={"email": "alice@example.com", "current_password": "correct-horse-92"},
        ).status_code
        == 202
    )

    async def invalidate():
        from coherent_api.models.user import User

        async with client.app.state.session_factory() as session:
            challenge = await session.get(EmailVerification, UUID(user_id))
            if reason == "expired":
                challenge.expires_at = datetime.now(UTC) - timedelta(seconds=1)
            else:
                account = await session.get(User, UUID(user_id))
                account.session_version += 1
            await session.commit()

    asyncio.run(invalidate())
    if reason == "password_changed":
        login = client.post(
            "/api/v1/auth/login",
            headers={"X-CSRF-Token": csrf_token},
            json={"username": "alice", "password": "correct-horse-92"},
        )
        user["Authorization"] = f"Bearer {client.cookies['coherent_session']}"
        assert login.status_code == 200
    assert (
        client.post(
            "/api/v1/auth/email/confirm", headers=user, json={"code": captured[0]}
        ).status_code
        == 400
    )
