from fastapi.testclient import TestClient


def create_user(client: TestClient, csrf_token: str, name: str) -> tuple[str, str]:
    response = client.post(
        "/api/v1/auth/register",
        headers={"X-CSRF-Token": csrf_token},
        json={
            "email": f"{name}@example.com",
            "username": name,
            "password": "correct-horse-92",
        },
    )
    assert response.status_code == 201
    return response.json()["user"]["id"], client.cookies["coherent_session"]


def auth_headers(token: str, csrf_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", "X-CSRF-Token": csrf_token}


def test_direct_conversation_and_message_access(client: TestClient, csrf_token: str) -> None:
    alice_id, alice_token = create_user(client, csrf_token, "alice")
    bob_id, bob_token = create_user(client, csrf_token, "bob")
    _, charlie_token = create_user(client, csrf_token, "charlie")
    client.cookies.delete("coherent_session")

    opened = client.post(
        "/api/v1/conversations",
        headers=auth_headers(alice_token, csrf_token),
        json={"user_id": bob_id},
    )
    assert opened.status_code == 200
    conversation_id = opened.json()["id"]
    assert opened.json()["other_user"]["username"] == "bob"

    reopened = client.post(
        "/api/v1/conversations",
        headers=auth_headers(bob_token, csrf_token),
        json={"user_id": alice_id},
    )
    assert reopened.status_code == 200
    assert reopened.json()["id"] == conversation_id

    sent = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        headers=auth_headers(alice_token, csrf_token),
        json={"body": "  Привет, Боб!  "},
    )
    assert sent.status_code == 201
    assert sent.json()["body"] == "Привет, Боб!"

    inbox = client.get("/api/v1/conversations", headers=auth_headers(bob_token, csrf_token))
    assert inbox.status_code == 200
    assert inbox.json()["conversations"][0]["last_message"]["body"] == "Привет, Боб!"

    history = client.get(
        f"/api/v1/conversations/{conversation_id}/messages",
        headers=auth_headers(bob_token, csrf_token),
    )
    assert history.status_code == 200
    assert [item["body"] for item in history.json()["messages"]] == ["Привет, Боб!"]

    assert client.get(
        f"/api/v1/conversations/{conversation_id}/messages",
        headers=auth_headers(charlie_token, csrf_token),
    ).status_code == 404
    assert client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        headers=auth_headers(charlie_token, csrf_token),
        json={"body": "Не мой чат"},
    ).status_code == 404


def test_message_validation_and_pagination(client: TestClient, csrf_token: str) -> None:
    alice_id, alice_token = create_user(client, csrf_token, "alice")
    _, bob_token = create_user(client, csrf_token, "bob")
    client.cookies.delete("coherent_session")
    opened = client.post(
        "/api/v1/conversations",
        headers=auth_headers(bob_token, csrf_token),
        json={"user_id": alice_id},
    )
    conversation_id = opened.json()["id"]
    endpoint = f"/api/v1/conversations/{conversation_id}/messages"

    assert client.post(
        endpoint, headers=auth_headers(alice_token, csrf_token), json={"body": "  "}
    ).status_code == 422
    assert client.post(
        endpoint, headers={"Authorization": f"Bearer {alice_token}"}, json={"body": "Привет"}
    ).status_code == 403

    for number in range(52):
        response = client.post(
            endpoint,
            headers=auth_headers(alice_token, csrf_token),
            json={"body": f"Сообщение {number}"},
        )
        assert response.status_code == 201

    first_page = client.get(endpoint, headers=auth_headers(bob_token, csrf_token)).json()
    assert len(first_page["messages"]) == 50
    assert first_page["has_more"] is True
    assert first_page["messages"][-1]["body"] == "Сообщение 51"

    older = client.get(
        endpoint,
        headers=auth_headers(bob_token, csrf_token),
        params={"before": first_page["messages"][0]["id"]},
    ).json()
    assert [item["body"] for item in older["messages"]] == ["Сообщение 0", "Сообщение 1"]
    assert older["has_more"] is False


def test_new_message_is_delivered_to_recipient(client: TestClient, csrf_token: str) -> None:
    _, alice_token = create_user(client, csrf_token, "alice")
    bob_id, bob_token = create_user(client, csrf_token, "bob")
    client.cookies.delete("coherent_session")
    opened = client.post(
        "/api/v1/conversations",
        headers=auth_headers(alice_token, csrf_token),
        json={"user_id": bob_id},
    )
    conversation_id = opened.json()["id"]

    client.cookies.set("coherent_session", bob_token)
    with client.websocket_connect(
        "/api/v1/conversations/events",
        headers={"origin": "http://localhost:5173"},
    ) as websocket:
        client.cookies.delete("coherent_session")
        sent = client.post(
            f"/api/v1/conversations/{conversation_id}/messages",
            headers=auth_headers(alice_token, csrf_token),
            json={"body": "Сообщение сразу"},
        )
        assert sent.status_code == 201
        event = websocket.receive_json()
        assert event["type"] == "message"
        assert event["conversation_id"] == conversation_id
        assert event["message"]["body"] == "Сообщение сразу"


def test_unread_messages_follow_each_users_read_position(
    client: TestClient, csrf_token: str
) -> None:
    _, alice_token = create_user(client, csrf_token, "alice")
    bob_id, bob_token = create_user(client, csrf_token, "bob")
    _, stranger_token = create_user(client, csrf_token, "stranger")
    client.cookies.delete("coherent_session")
    conversation_id = client.post(
        "/api/v1/conversations",
        headers=auth_headers(alice_token, csrf_token),
        json={"user_id": bob_id},
    ).json()["id"]
    endpoint = f"/api/v1/conversations/{conversation_id}"

    first = client.post(
        f"{endpoint}/messages",
        headers=auth_headers(alice_token, csrf_token),
        json={"body": "Первое"},
    ).json()["id"]
    inbox = client.get("/api/v1/conversations", headers=auth_headers(bob_token, csrf_token))
    assert inbox.json()["conversations"][0]["unread"] is True
    assert client.get(
        "/api/v1/conversations", headers=auth_headers(alice_token, csrf_token)
    ).json()["conversations"][0]["unread"] is False
    assert client.post(
        f"{endpoint}/read",
        headers=auth_headers(stranger_token, csrf_token),
        json={"message_id": first},
    ).status_code == 404
    assert client.post(
        f"{endpoint}/read",
        headers=auth_headers(bob_token, csrf_token),
        json={"message_id": first},
    ).status_code == 204
    assert client.get(
        "/api/v1/conversations", headers=auth_headers(bob_token, csrf_token)
    ).json()["conversations"][0]["unread"] is False

    second = client.post(
        f"{endpoint}/messages",
        headers=auth_headers(alice_token, csrf_token),
        json={"body": "Второе"},
    ).json()["id"]
    assert client.get(
        "/api/v1/conversations", headers=auth_headers(bob_token, csrf_token)
    ).json()["conversations"][0]["unread"] is True
    assert client.post(
        f"{endpoint}/read",
        headers=auth_headers(bob_token, csrf_token),
        json={"message_id": second},
    ).status_code == 204
    assert client.post(
        f"{endpoint}/read",
        headers=auth_headers(bob_token, csrf_token),
        json={"message_id": first},
    ).status_code == 204
    assert client.get(
        "/api/v1/conversations", headers=auth_headers(bob_token, csrf_token)
    ).json()["conversations"][0]["unread"] is False
