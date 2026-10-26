"""Readiness regression: optional Recovery-copy acknowledgement cannot lock chats."""

import asyncio
import base64
import json
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from conftest import verified_signup
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import HTTPException
from fastapi.testclient import TestClient

from coherent_api.models.conversation import Conversation
from coherent_api.models.e2ee import AccountRoster, E2eeAccount, E2eeDevice
from coherent_api.models.mls import MlsPackage
from coherent_api.services.mls import directory, eligible_devices


def test_unconfirmed_recovery_and_empty_offline_device_do_not_lock_chat(
    client: TestClient, csrf_token: str
):
    ids = []
    for name in ("alice", "bob"):
        result = verified_signup(
            client,
            {"X-CSRF-Token": csrf_token},
            {"username": name, "password": "test-device-password-92"},
        )
        assert result.status_code == 201
        ids.append(UUID(result.json()["user"]["id"]))
    now = datetime.now(UTC)
    ready_ids, offline_ids = [], []

    async def check():
        from coherent_api.models.user import User

        async with client.app.state.session_factory() as session:
            conversation = Conversation(user_low_id=min(ids), user_high_id=max(ids))
            session.add(conversation)
            for uid in ids:
                bindings = []
                for available in (True, False):
                    did = uuid4()
                    key = base64.b64encode(
                        Ed25519PrivateKey.generate().public_key().public_bytes_raw()
                    ).decode()
                    session.add(
                        E2eeDevice(
                            id=did,
                            user_id=uid,
                            signature_key=key,
                            label="QA",
                            platform="browser",
                            approved_at=now,
                        )
                    )
                    bindings.append(
                        {
                            "version": 1,
                            "account_id": str(uid),
                            "device_id": str(did),
                            "signature_key": key,
                        }
                    )
                    if available:
                        ready_ids.append(did)
                        session.add(
                            MlsPackage(
                                id=base64.b64encode(did.bytes * 2).decode(),
                                device_id=did,
                                wire="fixture-not-used-as-crypto",
                                expires_at=now + timedelta(hours=1),
                            )
                        )
                    else:
                        offline_ids.append(did)
                public = base64.b64encode(bytes(32)).decode()
                session.add(
                    E2eeAccount(
                        user_id=uid,
                        first_device_id=ready_ids[-1],
                        recovery_backup="fixture",
                        recovery_public_key=public,
                        roster_revision=1,
                        recovery_confirmed_at=None,
                    )
                )
                session.add(
                    AccountRoster(
                        user_id=uid,
                        revision=1,
                        payload=json.dumps(
                            {
                                "version": 1,
                                "account_id": str(uid),
                                "revision": 1,
                                "previous_hash": public,
                                "archive_public_key": public,
                                "devices": bindings,
                            }
                        ),
                        signature="fixture-not-used-for-verification",
                        digest=public,
                    )
                )
            await session.commit()
            user = await session.get(User, ids[0])
            result = await directory(session, user, conversation.id)
            assert all(a["ready"] for a in result["accounts"])
            assert set(result["eligible_devices"]) == set(map(str, ready_ids))
            assert not set(map(str, offline_ids)) & set(result["eligible_devices"])
            # The current authorized device need not have a public package for itself.
            assert set(
                await eligible_devices(session, conversation, offline_ids[0], reset=True)
            ) == set(ready_ids + [offline_ids[0]])
            try:
                await eligible_devices(session, conversation, uuid4(), reset=True)
            except HTTPException as error:
                assert error.status_code == 403
            else:
                raise AssertionError("An unknown device must not become eligible")

    asyncio.run(check())
