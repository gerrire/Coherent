import pytest
from conftest import verified_signup
from starlette.websockets import WebSocketDisconnect


def signup(client, csrf, name):
    response = verified_signup(
        client,
        {"X-CSRF-Token": csrf},
        {
            "username": name,
            "password": "Sessions-QA-2026!",
        },
    )
    assert response.status_code == 201
    return client.cookies["coherent_session"]


def test_device_session_revocation_is_scoped_and_closes_socket(client, csrf_token):
    first = signup(client, csrf_token, "sessions_owner")
    assert (
        client.post(
            "/api/v1/auth/login",
            headers={"X-CSRF-Token": csrf_token},
            json={
                "username": "sessions_owner",
                "password": "Sessions-QA-2026!",
            },
        ).status_code
        == 200
    )
    second = client.cookies["coherent_session"]
    rows = client.get("/api/v1/auth/sessions").json()["sessions"]
    assert len(rows) == 2
    assert sum(row["current"] for row in rows) == 1
    target = next(row for row in rows if not row["current"])
    assert all("digest" not in row for row in rows)
    with client.websocket_connect(
        "/api/v1/conversations/events",
        headers={
            "origin": "http://localhost:5173",
            "cookie": f"coherent_session={first}",
        },
    ) as socket:
        assert socket.receive_json()["type"] == "presence"
        response = client.delete(
            f"/api/v1/auth/sessions/{target['id']}", headers={"X-CSRF-Token": csrf_token}
        )
        assert response.status_code == 204
        with pytest.raises(WebSocketDisconnect):
            socket.receive_json()
    client.cookies.delete("coherent_session")
    assert (
        client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {first}"}).status_code
        == 401
    )
    assert (
        client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {second}"}).status_code
        == 200
    )
    remaining = client.get(
        "/api/v1/auth/sessions", headers={"Authorization": f"Bearer {second}"}
    ).json()["sessions"]
    assert len(remaining) == 1
    assert remaining[0]["current"]


def test_cannot_end_someone_elses_session_or_reuse_current_revoked_token(client, csrf_token):
    first = signup(client, csrf_token, "sessions_first")
    target = client.get("/api/v1/auth/sessions").json()["sessions"][0]
    signup(client, csrf_token, "sessions_other")
    assert (
        client.delete(
            f"/api/v1/auth/sessions/{target['id']}", headers={"X-CSRF-Token": csrf_token}
        ).status_code
        == 404
    )
    client.cookies.delete("coherent_session")
    assert (
        client.delete(
            f"/api/v1/auth/sessions/{target['id']}",
            headers={
                "Authorization": f"Bearer {first}",
                "X-CSRF-Token": csrf_token,
            },
        ).status_code
        == 204
    )
    assert (
        client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {first}"}).status_code
        == 401
    )
