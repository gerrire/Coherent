import asyncio
import base64
import hashlib
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pydantic import SecretStr
from sqlalchemy import func, select
from test_calls import _active_call, _headers

from coherent_api.api.v1 import calls as calls_api
from coherent_api.models.chat_policy import ChatPolicy
from coherent_api.models.conversation import Conversation
from coherent_api.models.e2ee import E2eeAccount
from coherent_api.models.message import Message
from coherent_api.models.user import User
from coherent_api.tools.reset_chat_history import reset


def test_call_identity_is_volatile_scoped_and_needs_no_recovery(client, csrf_token, monkeypatch):
    settings = client.app.state.settings
    monkeypatch.setattr(settings, "livekit_url", "ws://localhost:7880")
    monkeypatch.setattr(settings, "livekit_api_key", "isolated-call-key")
    monkeypatch.setattr(
        settings, "livekit_api_secret", SecretStr("isolated-call-secret-at-least-32-characters")
    )
    monkeypatch.setattr(calls_api, "remove_livekit_participant", AsyncMock())
    monkeypatch.setattr(calls_api, "close_livekit_room", AsyncMock())
    call_id, alice, _, token, _ = _active_call(client, csrf_token)
    headers = _headers(token, csrf_token)
    joined = client.post(f"/api/v1/calls/{call_id}/join", headers=headers)
    assert joined.status_code == 200
    assert joined.json()["crypto_protocol"] == "ephemeral_mls_v1"
    status = client.get("/api/v1/security/status", headers=headers).json()
    assert status["configured"] is False and status["setup_available"] is False
    assert (
        client.post(
            "/api/v1/security/challenges", headers=headers, json={"purpose": "bootstrap"}
        ).status_code
        == 409
    )
    signer = Ed25519PrivateKey.generate()
    device = {
        "version": 1,
        "account_id": alice,
        "device_id": str(uuid4()),
        "signature_key": base64.b64encode(signer.public_key().public_bytes_raw()).decode(),
    }
    challenge = client.post(
        "/api/v1/security/challenges",
        headers=headers,
        json={"purpose": "action", "call_id": call_id},
    )
    assert challenge.status_code == 200
    challenge = challenge.json()
    payload = f"coherent/call-device/v1:{call_id}:{device['device_id']}:{device['signature_key']}"
    signed = (
        b"coherent/device-proof/v1\0action\0"
        + UUID(alice).bytes
        + UUID(device["device_id"]).bytes
        + signer.public_key().public_bytes_raw()
        + base64.b64decode(challenge["nonce"])
        + hashlib.sha256(payload.encode()).digest()
    )
    body = {
        "challenge_id": challenge["challenge_id"],
        "device": device,
        "proof": base64.b64encode(signer.sign(signed)).decode(),
        "platform": "browser",
    }
    accepted = client.post(f"/api/v1/calls/{call_id}/crypto/devices", headers=headers, json=body)
    assert accepted.status_code == 200, accepted.text
    assert (
        client.post(
            f"/api/v1/calls/{call_id}/crypto/devices", headers=headers, json=body
        ).status_code
        == 403
    )
    media = joined.json()["media_conversation_id"]
    directory = client.get(f"/api/v1/conversations/{media}/secure", headers=headers)
    assert directory.status_code == 200
    assert directory.json()["call_devices"] == [device]
    login = client.post(
        "/api/v1/auth/login",
        headers={"X-CSRF-Token": csrf_token},
        json={"username": "alice", "password": "correct-horse-92"},
    )
    assert login.status_code == 200
    other = client.cookies["coherent_session"]
    client.cookies.delete("coherent_session")
    assert (
        client.post(
            "/api/v1/security/challenges",
            headers=_headers(other, csrf_token),
            json={"purpose": "action", "call_id": call_id},
        ).status_code
        == 403
    )
    assert client.post(f"/api/v1/calls/{call_id}/end", headers=headers).status_code == 200
    assert (
        client.get(
            f"/api/v1/security/key-packages/count?device_id={device['device_id']}", headers=headers
        ).status_code
        == 403
    )

    async def counts():
        async with client.app.state.session_factory() as session:
            return await session.scalar(select(func.count()).select_from(E2eeAccount))

    assert asyncio.run(counts()) == 0


def test_history_reset_preserves_accounts_and_is_not_repeatable(client, csrf_token):
    from conftest import verified_signup

    ids = []
    for name in ["alice", "bob"]:
        result = verified_signup(
            client,
            {"X-CSRF-Token": csrf_token},
            {"username": name, "password": "isolated-cloud-password-92"},
        )
        ids.append(UUID(result.json()["user"]["id"]))
    operation = uuid4()

    async def check():
        factory = client.app.state.session_factory
        async with factory() as session:
            conversation = Conversation(user_low_id=min(ids), user_high_id=max(ids))
            session.add(conversation)
            await session.flush()
            session.add(ChatPolicy(id=1, write_mode="legacy_mls", history_revision=uuid4()))
            session.add(
                Message(
                    conversation_id=conversation.id,
                    sender_id=ids[0],
                    body="legacy ciphertext placeholder",
                    mls_payload="{}",
                )
            )
            await session.commit()
            before = [
                (u.id, u.password_hash)
                for u in await session.scalars(select(User).order_by(User.id))
            ]
            cid = conversation.id
        assert (await reset(factory, operation))["messages"] == 1
        try:
            await reset(factory, operation, True, expected_messages=[])
        except RuntimeError as error:
            assert "Messages changed" in str(error)
        else:
            raise AssertionError("An outdated manifest must not erase messages")
        assert (await reset(factory, operation, True))["applied"]
        async with factory() as session:
            assert [
                (u.id, u.password_hash)
                for u in await session.scalars(select(User).order_by(User.id))
            ] == before
            assert await session.get(Conversation, cid) is not None
            assert await session.scalar(select(func.count()).select_from(Message)) == 0
            assert (await session.get(ChatPolicy, 1)).write_mode == "cloud_v1"
            session.add(Message(conversation_id=cid, sender_id=ids[0], body="new cloud fixture"))
            await session.commit()
        assert (await reset(factory, operation, True))["already_applied"]
        try:
            await reset(factory, uuid4(), True)
        except RuntimeError:
            pass
        else:
            raise AssertionError("A second reset must not erase new messages")
        async with factory() as session:
            assert await session.scalar(select(func.count()).select_from(Message)) == 1

    asyncio.run(check())
