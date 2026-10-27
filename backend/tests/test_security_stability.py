import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from conftest import verified_signup
from fastapi.testclient import TestClient
from sqlalchemy import select
from starlette.websockets import WebSocketDisconnect

from coherent_api.models.auth_security import AuthThrottle


def test_cloud_key_allows_only_private_or_root_service_group(tmp_path, monkeypatch):
    import os
    from types import SimpleNamespace

    from coherent_api.core.chat_crypto import ChatCipher

    key = tmp_path / "service.key"
    key.write_bytes(os.urandom(32))
    key.chmod(0o640)
    real_fstat = os.fstat
    monkeypatch.setattr(os, "getegid", lambda: 10001)

    def metadata(descriptor):
        info = real_fstat(descriptor)
        return SimpleNamespace(st_mode=info.st_mode, st_uid=0, st_gid=10001)

    monkeypatch.setattr(os, "fstat", metadata)
    assert ChatCipher.from_file(str(key)).enabled
    monkeypatch.setattr(os, "getegid", lambda: 10002)
    with pytest.raises(ValueError):
        ChatCipher.from_file(str(key))
    monkeypatch.setattr(os, "getegid", lambda: 10001)
    key.chmod(0o660)
    with pytest.raises(ValueError):
        ChatCipher.from_file(str(key))


def signup(client, csrf, name):
    response = verified_signup(
        client, {"X-CSRF-Token": csrf}, {"username": name, "password": "Security-QA-only-2026!"}
    )
    assert response.status_code == 201
    return response.json()["user"], client.cookies["coherent_session"]


def headers(token, csrf):
    return {"Authorization": f"Bearer {token}", "X-CSRF-Token": csrf}


def test_logout_revokes_one_token_and_its_existing_socket(client: TestClient, csrf_token):
    _, first = signup(client, csrf_token, "session_user")
    login = client.post(
        "/api/v1/auth/login",
        headers={"X-CSRF-Token": csrf_token},
        json={"username": "session_user", "password": "Security-QA-only-2026!"},
    )
    assert login.status_code == 200
    second = client.cookies["coherent_session"]
    assert first != second
    client.cookies.delete("coherent_session")
    with client.websocket_connect(
        "/api/v1/conversations/events",
        headers={"origin": "http://localhost:5173", "cookie": f"coherent_session={first}"},
    ) as socket:
        assert socket.receive_json()["type"] == "presence"
        result = client.post("/api/v1/auth/logout", headers=headers(first, csrf_token))
        assert result.status_code == 204
        with pytest.raises(WebSocketDisconnect):
            socket.receive_json()
    assert client.get("/api/v1/auth/me", headers=headers(first, csrf_token)).status_code == 401
    assert client.get("/api/v1/auth/me", headers=headers(second, csrf_token)).status_code == 200


def test_login_throttle_expires_without_permanent_account_lock(client, csrf_token):
    signup(client, csrf_token, "rate_user")
    client.cookies.delete("coherent_session")
    for _ in range(12):
        assert (
            client.post(
                "/api/v1/auth/login",
                headers={"X-CSRF-Token": csrf_token},
                json={"username": "rate_user", "password": "wrong-password"},
            ).status_code
            == 401
        )
    denied = client.post(
        "/api/v1/auth/login",
        headers={"X-CSRF-Token": csrf_token},
        json={"username": "rate_user", "password": "Security-QA-only-2026!"},
    )
    assert denied.status_code == 429
    assert 0 < int(denied.headers["retry-after"]) <= 300

    async def expire():
        async with client.app.state.session_factory() as session:
            for bucket in await session.scalars(select(AuthThrottle)):
                bucket.started_at = datetime.now(UTC) - timedelta(minutes=10)
            await session.commit()

    asyncio.run(expire())
    assert (
        client.post(
            "/api/v1/auth/login",
            headers={"X-CSRF-Token": csrf_token},
            json={"username": "rate_user", "password": "Security-QA-only-2026!"},
        ).status_code
        == 200
    )


def test_group_owner_can_remove_member_and_members_can_leave(client, csrf_token):
    from uuid import uuid4

    from coherent_api.models.conversation import Conversation
    from coherent_api.models.conversation_member import ConversationMember

    alice, at = signup(client, csrf_token, "group_owner")
    bob, bt = signup(client, csrf_token, "group_member")
    eve, et = signup(client, csrf_token, "group_outsider")
    gid = uuid4()

    async def prepare():
        async with client.app.state.session_factory() as session:
            session.add(
                Conversation(id=gid, kind="group", name="Private group", owner_id=UUID(alice["id"]))
            )
            await session.flush()
            for person in (alice, bob):
                session.add(ConversationMember(conversation_id=gid, user_id=UUID(person["id"])))
            await session.commit()

    asyncio.run(prepare())
    client.cookies.delete("coherent_session")
    path = f"/api/v1/conversations/{gid}/members/"
    assert client.delete(path + alice["id"], headers=headers(bt, csrf_token)).status_code == 403
    assert client.delete(path + bob["id"], headers=headers(et, csrf_token)).status_code == 404
    assert client.delete(path + bob["id"], headers=headers(at, csrf_token)).status_code == 204
    assert (
        client.get(
            f"/api/v1/conversations/{gid}/messages", headers=headers(bt, csrf_token)
        ).status_code
        == 404
    )
    assert client.delete(path + alice["id"], headers=headers(at, csrf_token)).status_code == 204


def test_server_transfer_and_departure_free_membership_slot(client, csrf_token):
    alice, at = signup(client, csrf_token, "server_owner")
    bob, bt = signup(client, csrf_token, "server_member")
    client.cookies.delete("coherent_session")
    server = client.post(
        "/api/v1/servers", headers=headers(at, csrf_token), json={"name": "Server QA"}
    ).json()
    sid = server["id"]
    invite = client.post(f"/api/v1/servers/{sid}/invites", headers=headers(at, csrf_token)).json()[
        "code"
    ]
    assert (
        client.post(
            "/api/v1/servers/join", headers=headers(bt, csrf_token), json={"code": invite}
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/v1/servers/{sid}",
            headers=headers(bt, csrf_token),
            json={"name": "Forged rename"},
        ).status_code
        == 403
    )
    assert (
        client.post(
            f"/api/v1/servers/{sid}/owner",
            headers=headers(at, csrf_token),
            json={"user_id": bob["id"]},
        ).status_code
        == 200
    )
    assert (
        client.delete(
            f"/api/v1/servers/{sid}/members/{alice['id']}", headers=headers(at, csrf_token)
        ).status_code
        == 204
    )
    assert client.get("/api/v1/servers", headers=headers(at, csrf_token)).json() == []
    assert (
        client.get(f"/api/v1/servers/{sid}/members", headers=headers(at, csrf_token)).status_code
        == 404
    )
    assert (
        client.delete(f"/api/v1/servers/{sid}", headers=headers(bt, csrf_token)).status_code == 204
    )
