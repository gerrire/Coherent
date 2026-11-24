import asyncio
import json
from datetime import UTC, datetime, timedelta
from time import time
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import pytest
from conftest import verified_signup
from fastapi.testclient import TestClient
from pydantic import SecretStr, ValidationError
from sqlalchemy import event

from coherent_api.api.v1 import call_translation as translation_api
from coherent_api.api.v1 import calls as calls_api
from coherent_api.core.config import Settings
from coherent_api.models.call import Call
from coherent_api.services.gigachat_translation import (
    CACHE_SECONDS,
    MAX_CACHE_ENTRIES,
    MAX_DISTINCT_PER_USER,
    MAX_INFLIGHT,
    GigaChatTranslationService,
    TranslationProviderError,
)


def response(text="Привет"):
    return {
        "choices": [{"finish_reason": "stop", "message": {"content": json.dumps({"text": text})}}]
    }


def settings(**patch):
    return Settings(
        _env_file=None, gigachat_enabled=True, gigachat_auth_key="private-test-key", **patch
    )


def request_values(**patch):
    return {
        "call_id": uuid4(),
        "requester_id": uuid4(),
        "speaker_id": uuid4(),
        "segment_id": uuid4(),
        "text": "Hello",
        "source": "en",
        "target": "ru",
        **patch,
    }


@pytest.mark.asyncio
async def test_proxy_oauth_is_cached_and_request_is_structured_and_bounded(monkeypatch):
    service = GigaChatTranslationService(settings())
    upstream = AsyncMock(
        side_effect=[
            (200, {"access_token": "token", "expires_at": (time() + 1800) * 1000}),
            (200, response()),
            (200, response("Пока")),
        ]
    )
    monkeypatch.setattr(service, "_request_json", upstream)
    assert await service.translate(**request_values()) == "Привет"
    assert await service.translate(**request_values(text="Goodbye")) == "Пока"
    assert upstream.await_count == 3
    oauth = upstream.await_args_list[0]
    assert oauth.args[0] == "https://ngw.devices.sberbank.ru:9443/api/v2/oauth"
    assert oauth.kwargs["headers"]["Authorization"] == "Basic private-test-key"
    UUID(oauth.kwargs["headers"]["RqUID"])
    assert oauth.kwargs["data"] == {"scope": "GIGACHAT_API_PERS"}
    chat = upstream.await_args_list[1]
    assert chat.args[0] == "https://api.giga.chat/v1/chat/completions"
    assert chat.kwargs["headers"]["Authorization"] == "Bearer token"
    assert chat.kwargs["json"]["response_format"]["strict"] is True
    assert json.loads(chat.kwargs["json"]["messages"][1]["content"])["target"] == "Russian"
    assert "private-test-key" not in str(chat.kwargs["json"])
    await service.close()


@pytest.mark.asyncio
async def test_same_segment_deduplicates_100_listeners_and_cancel_does_not_abort(monkeypatch):
    service = GigaChatTranslationService(settings())
    gate = asyncio.Event()

    async def translate(*_):
        await gate.wait()
        return "Одна озвучка"

    upstream = AsyncMock(side_effect=translate)
    monkeypatch.setattr(service, "_translate_upstream", upstream)
    values = request_values()
    tasks = [
        asyncio.create_task(service.translate(**{**values, "requester_id": uuid4()}))
        for _ in range(100)
    ]
    await asyncio.sleep(0)
    tasks[0].cancel()
    gate.set()
    results = await asyncio.gather(*tasks, return_exceptions=True)
    assert isinstance(results[0], asyncio.CancelledError)
    assert results[1:] == ["Одна озвучка"] * 99
    assert await service.translate(**values) == "Одна озвучка"
    upstream.assert_awaited_once()
    await service.close()


@pytest.mark.asyncio
async def test_cache_expires_is_bounded_and_does_not_confuse_changed_text(monkeypatch):
    now = [0.0]
    service = GigaChatTranslationService(settings(), clock=lambda: now[0])
    upstream = AsyncMock(return_value="Перевод")
    monkeypatch.setattr(service, "_translate_upstream", upstream)
    values = request_values()
    await service.translate(**values)
    await service.translate(**{**values, "text": "Different"})
    assert upstream.await_count == 2
    now[0] += CACHE_SECONDS + 1
    await service.translate(**values)
    assert upstream.await_count == 3
    for _ in range(MAX_CACHE_ENTRIES + 5):
        await service.translate(**request_values())
    assert len(service._cache) == MAX_CACHE_ENTRIES
    assert all("Hello" not in str(key) for key in service._cache)
    await service.close()
    assert not service._cache and not service._rates


@pytest.mark.asyncio
async def test_rate_limit_applies_to_new_work_but_cached_results_are_free(monkeypatch):
    service = GigaChatTranslationService(settings())
    monkeypatch.setattr(service, "_translate_upstream", AsyncMock(return_value="Готово"))
    values = request_values()
    await service.translate(**values)
    for _ in range(MAX_DISTINCT_PER_USER - 1):
        await service.translate(**{**values, "segment_id": uuid4()})
    with pytest.raises(TranslationProviderError) as error:
        await service.translate(**{**values, "segment_id": uuid4()})
    assert error.value.status_code == 429
    assert await service.translate(**values) == "Готово"
    await service.close()


@pytest.mark.asyncio
async def test_inflight_work_is_bounded_and_shutdown_cancels_it(monkeypatch):
    service = GigaChatTranslationService(settings())
    gate = asyncio.Event()

    async def wait_for_gate(*_):
        await gate.wait()
        return "Готово"

    monkeypatch.setattr(service, "_translate_upstream", AsyncMock(side_effect=wait_for_gate))
    tasks = [
        asyncio.create_task(service.translate(**request_values())) for _ in range(MAX_INFLIGHT)
    ]
    await asyncio.sleep(0)
    with pytest.raises(TranslationProviderError) as error:
        await service.translate(**request_values())
    assert error.value.status_code == 429
    await service.close()
    results = await asyncio.gather(*tasks, return_exceptions=True)
    assert all(isinstance(value, asyncio.CancelledError) for value in results)
    assert not service._inflight


@pytest.mark.asyncio
async def test_expired_auth_refreshes_only_once_and_handles_second_denial(monkeypatch):
    service = GigaChatTranslationService(settings())
    upstream = AsyncMock(
        side_effect=[
            (200, {"access_token": "first", "expires_at": time() + 1800}),
            (401, {}),
            (200, {"access_token": "second", "expires_at": time() + 1800}),
            (401, {}),
        ]
    )
    monkeypatch.setattr(service, "_request_json", upstream)
    with pytest.raises(TranslationProviderError) as error:
        await service.translate(**request_values())
    assert error.value.status_code == 503
    assert upstream.await_count == 4
    assert "first" not in str(error.value) and "second" not in str(error.value)
    await service.close()


@pytest.mark.asyncio
async def test_total_timeout_includes_provider_and_drops_inflight(monkeypatch):
    service = GigaChatTranslationService(settings(gigachat_timeout_seconds=2))

    async def never_respond(*_):
        await asyncio.Event().wait()

    monkeypatch.setattr(service, "_translate_upstream", never_respond)
    with pytest.raises(TranslationProviderError) as error:
        await service.translate(**request_values())
    assert error.value.status_code == 504
    assert not service._cache and not service._inflight
    await service.close()


@pytest.mark.asyncio
async def test_bad_ca_bundle_fails_closed_without_disabling_certificate_validation(tmp_path):
    service = GigaChatTranslationService(
        settings(gigachat_ca_bundle=str(tmp_path / "missing-ca.pem"))
    )
    with pytest.raises(TranslationProviderError) as error:
        await service._client()
    assert error.value.status_code == 503
    assert service._session is None
    assert "missing-ca.pem" not in str(error.value)
    await service.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "code,expected", [(402, 503), (403, 503), (404, 503), (429, 429), (500, 502)]
)
async def test_upstream_errors_are_sanitized_without_retrying_paid_calls(
    code, expected, monkeypatch
):
    service = GigaChatTranslationService(settings())
    upstream = AsyncMock(
        side_effect=[
            (200, {"access_token": "token", "expires_at": time() + 1800}),
            (code, {"message": "PRIVATE PROVIDER CONTENT"}),
        ]
    )
    monkeypatch.setattr(service, "_request_json", upstream)
    with pytest.raises(TranslationProviderError) as error:
        await service.translate(**request_values())
    assert error.value.status_code == expected
    assert "PRIVATE" not in str(error.value)
    assert upstream.await_count == 2
    await service.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"choices": []},
        response(""),
        response("x" * 601),
        response("bad\u0000text"),
        response("bad\ud800text"),
        {"choices": [{"finish_reason": "length", "message": {"content": '{"text":"partial"}'}}]},
    ],
)
async def test_partial_or_malformed_translations_are_not_spoken(payload, monkeypatch):
    service = GigaChatTranslationService(settings())
    monkeypatch.setattr(
        service,
        "_request_json",
        AsyncMock(
            side_effect=[
                (200, {"access_token": "token", "expires_at": time() + 1800}),
                (200, payload),
            ]
        ),
    )
    with pytest.raises(TranslationProviderError) as error:
        await service.translate(**request_values())
    assert error.value.status_code == 502
    assert not service._cache
    await service.close()


def register(client, csrf, name):
    result = verified_signup(
        client, {"X-CSRF-Token": csrf}, {"username": name, "password": "correct-horse-92"}
    )
    assert result.status_code == 201
    return result.json()["user"]["id"], client.cookies["coherent_session"]


def headers(token, csrf):
    return {"Authorization": f"Bearer {token}", "X-CSRF-Token": csrf}


def active_call(client, csrf, monkeypatch):
    monkeypatch.setattr(calls_api, "livekit_ready", lambda _: True)
    alice, first = register(client, csrf, "translate_alice")
    bob, second = register(client, csrf, "translate_bob")
    client.cookies.delete("coherent_session")
    conversation = client.post(
        "/api/v1/conversations", headers=headers(first, csrf), json={"user_id": bob}
    ).json()["id"]
    call = client.post(f"/api/v1/conversations/{conversation}/calls", headers=headers(first, csrf))
    assert call.status_code == 201
    call_id = call.json()["id"]
    assert (
        client.post(f"/api/v1/calls/{call_id}/accept", headers=headers(second, csrf)).status_code
        == 200
    )
    return call_id, alice, first


def test_api_requires_active_membership_session_and_csrf_before_provider(
    client: TestClient,
    csrf_token,
    monkeypatch,
):
    call_id, speaker, token = active_call(client, csrf_token, monkeypatch)
    _, outsider = register(client, csrf_token, "translate_outsider")
    client.cookies.delete("coherent_session")
    provider = AsyncMock(return_value="Привет")
    monkeypatch.setattr(client.app.state.gigachat_translation, "translate", provider)
    url = f"/api/v1/calls/{call_id}/translation"
    body = {
        "text": "Hello",
        "source_language": "en",
        "target_language": "ru",
        "segment_id": str(uuid4()),
        "speaker_id": speaker,
    }
    assert (
        client.post(url, headers={"Authorization": f"Bearer {token}"}, json=body).status_code == 403
    )
    assert client.post(url, headers=headers(outsider, csrf_token), json=body).status_code == 404
    assert (
        client.post(
            url, headers=headers(token, csrf_token), json={**body, "text": "x" * 601}
        ).status_code
        == 422
    )
    assert (
        client.post(
            url, headers=headers(token, csrf_token), json={**body, "target_language": "xx"}
        ).status_code
        == 422
    )
    assert (
        client.post(
            url, headers=headers(token, csrf_token), json={**body, "speaker_id": str(uuid4())}
        ).status_code
        == 409
    )
    provider.assert_not_awaited()
    accepted = client.post(url, headers=headers(token, csrf_token), json=body)
    assert accepted.status_code == 200 and accepted.json() == {"text": "Привет"}
    assert provider.await_args.kwargs["requester_id"] == UUID(speaker)
    login = client.post(
        "/api/v1/auth/login",
        headers={"X-CSRF-Token": csrf_token},
        json={"username": "translate_alice", "password": "correct-horse-92"},
    )
    assert login.status_code == 200
    assert client.post(url, headers={"X-CSRF-Token": csrf_token}, json=body).status_code == 409
    client.cookies.delete("coherent_session")
    assert (
        client.post(f"/api/v1/calls/{call_id}/end", headers=headers(token, csrf_token)).status_code
        == 200
    )
    assert client.post(url, headers=headers(token, csrf_token), json=body).status_code == 409


def test_config_has_no_key_and_missing_configuration_does_not_break_calls(
    client, csrf_token, monkeypatch
):
    call_id, speaker, token = active_call(client, csrf_token, monkeypatch)
    url = f"/api/v1/calls/{call_id}/translation"
    config = client.get(f"{url}/config", headers=headers(token, csrf_token))
    assert config.status_code == 200
    assert config.json() == {"enabled": False, "configured": False, "model": None}
    settings_obj = client.app.state.settings
    monkeypatch.setattr(settings_obj, "gigachat_enabled", True)
    monkeypatch.setattr(settings_obj, "gigachat_auth_key", SecretStr("never-public"))
    config = client.get(f"{url}/config", headers=headers(token, csrf_token))
    assert config.json() == {"enabled": True, "configured": True, "model": "GigaChat-2"}
    assert "never-public" not in config.text
    monkeypatch.setattr(settings_obj, "gigachat_auth_key", None)
    result = client.post(
        url,
        headers=headers(token, csrf_token),
        json={
            "text": "Hello",
            "source_language": "en",
            "target_language": "ru",
            "segment_id": str(uuid4()),
            "speaker_id": speaker,
        },
    )
    assert result.status_code == 503


def test_expired_call_cannot_use_proxy(client, csrf_token, monkeypatch):
    call_id, _, token = active_call(client, csrf_token, monkeypatch)

    async def expire():
        async with client.app.state.session_factory() as session:
            call = await session.get(Call, UUID(call_id))
            call.expires_at = datetime.now(UTC) - timedelta(seconds=1)
            await session.commit()

    asyncio.run(expire())
    config = client.get(
        f"/api/v1/calls/{call_id}/translation/config", headers=headers(token, csrf_token)
    )
    assert config.status_code == 409


def test_result_is_not_returned_after_call_ends_during_provider_request(
    client,
    csrf_token,
    monkeypatch,
):
    call_id, speaker, token = active_call(client, csrf_token, monkeypatch)

    async def end_during_translation(**_):
        async with client.app.state.session_factory() as session:
            call = await session.get(Call, UUID(call_id))
            call.status = "ended"
            call.ended_at = datetime.now(UTC)
            await session.commit()
        return "Старый результат"

    monkeypatch.setattr(
        client.app.state.gigachat_translation,
        "translate",
        end_during_translation,
    )
    result = client.post(
        f"/api/v1/calls/{call_id}/translation",
        headers=headers(token, csrf_token),
        json={
            "text": "Hello",
            "source_language": "en",
            "target_language": "ru",
            "segment_id": str(uuid4()),
            "speaker_id": speaker,
        },
    )
    assert result.status_code == 409
    assert "Старый результат" not in result.text


def test_official_upstream_urls_only():
    with pytest.raises(ValidationError):
        settings(gigachat_base_url="https://attacker.example/v1")
    with pytest.raises(ValidationError):
        settings(gigachat_scope="invalid")


def test_provider_wait_releases_request_database_connection(client, csrf_token, monkeypatch):
    call_id, speaker, token = active_call(client, csrf_token, monkeypatch)
    engine = client.app.state.session_factory.kw["bind"]
    returned_connections = set()
    observed = {}
    original = translation_api.active_translation_member

    def checked_in(connection, _record):
        returned_connections.add(id(connection))

    async def observe_membership(call, user, session):
        await original(call, user, session)
        if not observed:
            connection = await session.connection()
            observed["connection"] = connection.sync_connection.connection.dbapi_connection
            observed["session"] = session

    async def provider(**_):
        assert not observed["session"].in_transaction()
        assert id(observed["connection"]) in returned_connections
        return "Перевод без занятого соединения БД"

    event.listen(engine.sync_engine, "checkin", checked_in)
    monkeypatch.setattr(translation_api, "active_translation_member", observe_membership)
    monkeypatch.setattr(client.app.state.gigachat_translation, "translate", provider)
    try:
        result = client.post(
            f"/api/v1/calls/{call_id}/translation",
            headers=headers(token, csrf_token),
            json={
                "text": "Hello",
                "source_language": "en",
                "target_language": "ru",
                "segment_id": str(uuid4()),
                "speaker_id": speaker,
            },
        )
        assert result.status_code == 200
    finally:
        event.remove(engine.sync_engine, "checkin", checked_in)


def test_caption_validation_errors_never_echo_the_transcript(client, csrf_token, monkeypatch):
    call_id, speaker, token = active_call(client, csrf_token, monkeypatch)
    url = f"/api/v1/calls/{call_id}/translation"
    request_headers = {**headers(token, csrf_token), "Content-Type": "application/json"}
    marker = "PRIVATE-CAPTION-DO-NOT-ECHO"
    invalid_json = client.post(url, headers=request_headers, content=f'{{"text":"{marker}",broken')
    invalid_field = client.post(
        url,
        headers=request_headers,
        json={
            "text": marker * 30,
            "source_language": "en",
            "target_language": "ru",
            "segment_id": str(uuid4()),
            "speaker_id": speaker,
        },
    )
    for result in (invalid_json, invalid_field):
        assert result.status_code == 422
        assert result.json() == {"detail": "Некорректная фраза или параметры перевода звонка."}
        assert marker not in result.text
