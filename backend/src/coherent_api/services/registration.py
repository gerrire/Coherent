"""Email proof before account creation; bounded encrypted SMTP outbox.

Only login verification codes enter this outbox. Recovery phrases are never
accepted by a server endpoint or mail job.
"""

import asyncio
import base64
import hashlib
import hmac
import os
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import delete, func, or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from coherent_api.core.config import Settings
from coherent_api.models.registration import RegistrationChallenge
from coherent_api.services import email_verification


class RegistrationCodeError(Exception):
    pass


class RegistrationRateError(Exception):
    pass


def code_digest(settings: Settings, identity: UUID, email: str, code: str) -> str:
    return hmac.new(
        settings.secret_key.get_secret_value().encode(),
        b"coherent/registration-code/v1\0"
        + identity.bytes
        + email.encode()
        + b"\0"
        + code.encode(),
        hashlib.sha256,
    ).hexdigest()


def outbox_cipher(settings: Settings) -> AESGCM:
    key = hmac.new(
        settings.secret_key.get_secret_value().encode(),
        b"coherent/registration-mail-outbox/key/v1",
        hashlib.sha256,
    ).digest()
    return AESGCM(key)


async def begin_registration(
    session: AsyncSession, settings: Settings, email: str, client_ip: str
) -> RegistrationChallenge:
    now = datetime.now(UTC)
    ip_digest = hmac.new(
        settings.secret_key.get_secret_value().encode(),
        b"coherent/signup-ip/v1\0" + now.date().isoformat().encode() + b"\0" + client_ip.encode(),
        hashlib.sha256,
    ).hexdigest()
    if session.get_bind().dialect.name == "postgresql":
        await session.execute(text("SELECT pg_advisory_xact_lock(824018263419)"))
    hour = now - timedelta(hours=1)
    recent = RegistrationChallenge.created_at > hour
    total = await session.scalar(
        select(func.count()).select_from(RegistrationChallenge).where(recent)
    )
    recipient = await session.scalar(
        select(func.count())
        .select_from(RegistrationChallenge)
        .where(recent, RegistrationChallenge.email == email)
    )
    ip_count = await session.scalar(
        select(func.count())
        .select_from(RegistrationChallenge)
        .where(recent, RegistrationChallenge.ip_digest == ip_digest)
    )
    last = await session.scalar(
        select(RegistrationChallenge.id)
        .where(
            RegistrationChallenge.email == email,
            RegistrationChallenge.created_at > now - timedelta(seconds=60),
        )
        .limit(1)
    )
    if (total or 0) >= 400 or (recipient or 0) >= 5 or (ip_count or 0) >= 20 or last:
        raise RegistrationRateError
    identity = uuid4()
    code = f"{secrets.randbelow(1_000_000):06d}"
    nonce = os.urandom(12)
    encrypted = outbox_cipher(settings).encrypt(nonce, code.encode(), identity.bytes)
    challenge = RegistrationChallenge(
        id=identity,
        email=email,
        ip_digest=ip_digest,
        code_digest=code_digest(settings, identity, email, code),
        code_ciphertext=base64.b64encode(nonce + encrypted).decode(),
        created_at=now,
        expires_at=now + timedelta(minutes=10),
        attempts=0,
        delivery_attempts=0,
        next_delivery_at=now,
    )
    session.add(challenge)
    await session.commit()
    return challenge


async def claim_registration(
    session: AsyncSession, settings: Settings, identity: UUID, email: str, code: str
) -> RegistrationChallenge:
    challenge = await session.scalar(
        select(RegistrationChallenge).where(RegistrationChallenge.id == identity).with_for_update()
    )
    now = datetime.now(UTC)
    if (
        challenge is None
        or challenge.consumed_at is not None
        or challenge.expires_at.replace(tzinfo=UTC) <= now
        or challenge.attempts >= 5
    ):
        raise RegistrationCodeError
    challenge.attempts += 1
    if challenge.email != email or not hmac.compare_digest(
        challenge.code_digest, code_digest(settings, identity, email, code)
    ):
        await session.commit()
        raise RegistrationCodeError
    return challenge


async def deliver_registration_code(
    session_factory: async_sessionmaker[AsyncSession], settings: Settings, identity: UUID
) -> None:
    now, owner = datetime.now(UTC), uuid4()
    async with session_factory() as session:
        result = await session.execute(
            update(RegistrationChallenge)
            .where(
                RegistrationChallenge.id == identity,
                RegistrationChallenge.consumed_at.is_(None),
                RegistrationChallenge.code_ciphertext.is_not(None),
                RegistrationChallenge.expires_at > now,
                RegistrationChallenge.next_delivery_at <= now,
                RegistrationChallenge.delivery_attempts < 5,
                or_(
                    RegistrationChallenge.lease_until.is_(None),
                    RegistrationChallenge.lease_until < now,
                ),
            )
            .values(
                lease_owner=owner,
                lease_until=now + timedelta(seconds=45),
                delivery_attempts=RegistrationChallenge.delivery_attempts + 1,
            )
        )
        await session.commit()
        if result.rowcount != 1:
            return
        challenge = await session.get(RegistrationChallenge, identity)
        assert challenge is not None and challenge.code_ciphertext is not None
        recipient, ciphertext, attempts = (
            challenge.email,
            challenge.code_ciphertext,
            challenge.delivery_attempts,
        )
    succeeded = False
    try:
        encoded = base64.b64decode(ciphertext, validate=True)
        code = outbox_cipher(settings).decrypt(encoded[:12], encoded[12:], identity.bytes).decode()
        await asyncio.to_thread(email_verification.send_code, settings, recipient, code)
        succeeded = True
    except Exception:
        # No addresses, codes, mail bodies or SMTP exception payloads in logs.
        pass
    async with session_factory() as session:
        values = {"lease_owner": None, "lease_until": None}
        if succeeded:
            values.update(code_ciphertext=None, delivered_at=datetime.now(UTC))
        elif attempts >= 5:
            values.update(code_ciphertext=None)
        else:
            values.update(
                next_delivery_at=datetime.now(UTC) + timedelta(seconds=min(120, 5 * 2**attempts))
            )
        await session.execute(
            update(RegistrationChallenge)
            .where(RegistrationChallenge.id == identity, RegistrationChallenge.lease_owner == owner)
            .values(**values)
        )
        await session.commit()


async def registration_mail_loop(
    session_factory: async_sessionmaker[AsyncSession], settings: Settings
) -> None:
    while True:
        try:
            now = datetime.now(UTC)
            async with session_factory() as session:
                await session.execute(
                    delete(RegistrationChallenge).where(
                        RegistrationChallenge.created_at < now - timedelta(days=1)
                    )
                )
                await session.execute(
                    update(RegistrationChallenge)
                    .where(
                        RegistrationChallenge.expires_at <= now,
                        RegistrationChallenge.code_ciphertext.is_not(None),
                    )
                    .values(code_ciphertext=None, code_digest="")
                )
                await session.commit()
                identities = list(
                    await session.scalars(
                        select(RegistrationChallenge.id)
                        .where(
                            RegistrationChallenge.code_ciphertext.is_not(None),
                            RegistrationChallenge.consumed_at.is_(None),
                            RegistrationChallenge.expires_at > now,
                            RegistrationChallenge.next_delivery_at <= now,
                            or_(
                                RegistrationChallenge.lease_until.is_(None),
                                RegistrationChallenge.lease_until < now,
                            ),
                        )
                        .order_by(RegistrationChallenge.created_at)
                        .limit(10)
                    )
                )
            for identity in identities:
                await deliver_registration_code(session_factory, settings, identity)
        except Exception:
            pass
        await asyncio.sleep(3)
