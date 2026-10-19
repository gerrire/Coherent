from fastapi.testclient import TestClient


def register(client: TestClient, csrf_token: str, email: str = "alex@example.com"):
    return client.post(
        "/api/v1/auth/register",
        headers={"X-CSRF-Token": csrf_token},
        json={"email": email, "username": "alex_dev", "password": "correct-horse-92"},
    )


def test_register_login_and_logout(client: TestClient, csrf_token: str) -> None:
    registration = register(client, csrf_token)
    assert registration.status_code == 201
    assert registration.json()["user"]["username"] == "alex_dev"
    assert "coherent_session" in client.cookies

    current_user = client.get("/api/v1/auth/me")
    assert current_user.status_code == 200
    assert current_user.json()["email"] == "alex@example.com"

    logout = client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": csrf_token})
    assert logout.status_code == 204
    assert client.get("/api/v1/auth/me").status_code == 401

    login = client.post(
        "/api/v1/auth/login",
        headers={"X-CSRF-Token": csrf_token},
        json={"email": "alex@example.com", "password": "correct-horse-92"},
    )
    assert login.status_code == 200
    assert client.get("/api/v1/auth/me").status_code == 200


def test_duplicate_email_or_username_is_rejected(client: TestClient, csrf_token: str) -> None:
    assert register(client, csrf_token).status_code == 201
    duplicate = register(client, csrf_token, email="another@example.com")
    assert duplicate.status_code == 409


def test_mutating_requests_require_csrf_token(client: TestClient) -> None:
    response = client.post(
        "/api/v1/auth/register",
        json={"email": "alex@example.com", "username": "alex_dev", "password": "correct-horse-92"},
    )
    assert response.status_code == 403


def test_invalid_credentials_do_not_create_a_session(
    client: TestClient, csrf_token: str
) -> None:
    register(client, csrf_token)
    client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": csrf_token})
    response = client.post(
        "/api/v1/auth/login",
        headers={"X-CSRF-Token": csrf_token},
        json={"email": "alex@example.com", "password": "not-the-password"},
    )
    assert response.status_code == 401
    assert "coherent_session" not in client.cookies


def test_users_can_find_and_add_each_other(
    client: TestClient,
    csrf_token: str,
) -> None:
    first_registration = register(client, csrf_token)
    first_token = client.cookies["coherent_session"]
    second_registration = client.post(
        "/api/v1/auth/register",
        headers={"X-CSRF-Token": csrf_token},
        json={
            "email": "sam@example.com",
            "username": "sam_player",
            "password": "correct-horse-93",
        },
    )
    second_token = client.cookies["coherent_session"]
    client.cookies.delete("coherent_session")

    first_user_id = first_registration.json()["user"]["id"]
    second_user_id = second_registration.json()["user"]["id"]
    assert second_registration.status_code == 201

    first_headers = {
        "Authorization": f"Bearer {first_token}",
        "X-CSRF-Token": csrf_token,
    }
    second_headers = {
        "Authorization": f"Bearer {second_token}",
        "X-CSRF-Token": csrf_token,
    }

    search = client.get(
        "/api/v1/users/search",
        params={"query": "sam"},
        headers=first_headers,
    )
    assert search.status_code == 200
    assert search.json()[0]["username"] == "sam_player"
    assert search.json()[0]["relationship"] == "none"

    sent_request = client.post(
        "/api/v1/friends/requests",
        headers=first_headers,
        json={"target_user_id": second_user_id},
    )
    assert sent_request.status_code == 201
    request_id = sent_request.json()["request_id"]

    incoming = client.get("/api/v1/friends/requests", headers=second_headers)
    assert incoming.status_code == 200
    assert incoming.json()["incoming"][0]["username"] == "alex_dev"

    accepted = client.post(
        f"/api/v1/friends/requests/{request_id}/accept",
        headers=second_headers,
    )
    assert accepted.status_code == 200
    assert accepted.json()["status"] == "accepted"

    friends = client.get("/api/v1/friends", headers=first_headers)
    assert friends.status_code == 200
    assert friends.json()["friends"][0]["id"] == second_user_id

    result_after_accept = client.get(
        "/api/v1/users/search",
        params={"query": "sam"},
        headers=first_headers,
    )
    assert result_after_accept.json()[0]["relationship"] == "friends"
    assert first_user_id != second_user_id
