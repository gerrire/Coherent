import asyncio
from datetime import UTC, datetime, timedelta
from time import monotonic
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

from fastapi.testclient import TestClient

from coherent_api.api.v1 import calls as calls_api
from coherent_api.core.config import Settings
from coherent_api.models.call import Call
from coherent_api.services import call_cleanup


def _register(client: TestClient, csrf_token: str, username: str) -> tuple[str, str]:
    response = client.post(
        "/api/v1/auth/register",
        headers={"X-CSRF-Token": csrf_token},
        json={"username": username, "password": "correct-horse-92"},
    )
    assert response.status_code == 201
    return response.json()["user"]["id"], client.cookies["coherent_session"]


def _headers(token: str, csrf_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", "X-CSRF-Token": csrf_token}


def _active_call(client: TestClient, csrf_token: str) -> tuple[str, str, str, str, str]:
    alice_id, alice_token = _register(client, csrf_token, "alice")
    bob_id, bob_token = _register(client, csrf_token, "bob")
    client.cookies.delete("coherent_session")
    conversation = client.post(
        "/api/v1/conversations",
        headers=_headers(alice_token, csrf_token),
        json={"user_id": bob_id},
    )
    assert conversation.status_code == 200
    started = client.post(
        f"/api/v1/conversations/{conversation.json()['id']}/calls",
        headers=_headers(alice_token, csrf_token),
    )
    assert started.status_code == 201
    call_id = started.json()["id"]
    accepted = client.post(
        f"/api/v1/calls/{call_id}/accept", headers=_headers(bob_token, csrf_token)
    )
    assert accepted.status_code == 200
    return call_id, alice_id, bob_id, alice_token, bob_token


def test_leaving_disconnects_participant_and_last_exit_closes_room(
    client: TestClient, csrf_token: str, monkeypatch
) -> None:
    monkeypatch.setattr(calls_api, "livekit_ready", lambda _: True)
    remove = AsyncMock()
    close = AsyncMock()
    monkeypatch.setattr(calls_api, "remove_livekit_participant", remove)
    monkeypatch.setattr(calls_api, "close_livekit_room", close)
    call_id, alice_id, _, alice_token, bob_token = _active_call(client, csrf_token)

    first = client.post(f"/api/v1/calls/{call_id}/end", headers=_headers(alice_token, csrf_token))
    assert first.status_code == 200
    assert first.json()["status"] == "active"
    remove.assert_awaited_once_with(client.app.state.settings, UUID(call_id), UUID(alice_id))
    close.assert_not_awaited()

    last = client.post(f"/api/v1/calls/{call_id}/end", headers=_headers(bob_token, csrf_token))
    assert last.status_code == 200
    assert last.json()["status"] == "ended"
    close.assert_awaited_once_with(client.app.state.settings, UUID(call_id))


def test_cleanup_expires_calls_without_a_user_request(
    client: TestClient, csrf_token: str, monkeypatch
) -> None:
    monkeypatch.setattr(calls_api, "livekit_ready", lambda _: True)
    call_id, _, _, _, _ = _active_call(client, csrf_token)

    async def expire() -> list:
        factory = client.app.state.session_factory
        async with factory() as session:
            call = await session.get(Call, UUID(call_id))
            assert call is not None
            call.expires_at = datetime.now(UTC) - timedelta(seconds=1)
            await session.commit()
        return await call_cleanup._expire_overdue(factory)

    expired = asyncio.run(expire())
    assert len(expired) == 1
    assert expired[0].status == "ended"
    assert all(participant.state == "left" for participant in expired[0].participants)


def test_cleanup_kicks_left_participant_and_deletes_ended_room(
    client: TestClient, csrf_token: str, monkeypatch
) -> None:
    monkeypatch.setattr(calls_api, "livekit_ready", lambda _: True)
    monkeypatch.setattr(calls_api, "remove_livekit_participant", AsyncMock())
    monkeypatch.setattr(calls_api, "close_livekit_room", AsyncMock())
    call_id, alice_id, bob_id, alice_token, bob_token = _active_call(client, csrf_token)
    client.post(f"/api/v1/calls/{call_id}/end", headers=_headers(alice_token, csrf_token))

    removed: list[str] = []
    deleted: list[str] = []

    class FakeRoom:
        async def list_rooms(self, _):
            return SimpleNamespace(rooms=[SimpleNamespace(name=f"coherent-call-{call_id}")])

        async def list_participants(self, _):
            return SimpleNamespace(
                participants=[SimpleNamespace(identity=alice_id), SimpleNamespace(identity=bob_id)]
            )

        async def remove_participant(self, request):
            removed.append(request.identity)

        async def delete_room(self, request):
            deleted.append(request.room)

    class FakeLiveKit:
        def __init__(self, **_):
            self.room = FakeRoom()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

    monkeypatch.setattr(call_cleanup.livekit_api, "LiveKitAPI", FakeLiveKit)
    settings = Settings(
        livekit_url="ws://localhost:7880",
        livekit_api_key="test-key",
        livekit_api_secret="test-secret",
    )
    factory = client.app.state.session_factory
    present = asyncio.run(call_cleanup._reconcile_rooms(factory, settings))
    assert present[UUID(call_id)] == {UUID(bob_id)}
    assert removed == [alice_id]

    client.post(f"/api/v1/calls/{call_id}/end", headers=_headers(bob_token, csrf_token))
    asyncio.run(call_cleanup._reconcile_rooms(factory, settings))
    assert deleted == [f"coherent-call-{call_id}"]


def test_cleanup_releases_stale_busy_members(
    client: TestClient, csrf_token: str, monkeypatch
) -> None:
    monkeypatch.setattr(calls_api, "livekit_ready", lambda _: True)
    call_id, alice_id, bob_id, _, _ = _active_call(client, csrf_token)
    monkeypatch.setattr(call_cleanup, "_still_absent", AsyncMock(return_value=True))
    close = AsyncMock()
    monkeypatch.setattr(call_cleanup, "close_livekit_room", close)
    settings = Settings(
        livekit_url="ws://localhost:7880",
        livekit_api_key="test-key",
        livekit_api_secret="test-secret",
    )
    missing_since = {
        (UUID(call_id), UUID(user_id)): monotonic() - call_cleanup.ABSENT_SECONDS - 1
        for user_id in (alice_id, bob_id)
    }

    asyncio.run(
        call_cleanup._release_absent(
            client.app.state.session_factory,
            settings,
            client.app.state.message_events,
            {},
            missing_since,
        )
    )

    async def status() -> str:
        async with client.app.state.session_factory() as session:
            call = await session.get(Call, UUID(call_id))
            assert call is not None
            return call.status

    assert asyncio.run(status()) == "ended"
    close.assert_awaited_once_with(settings, UUID(call_id))
