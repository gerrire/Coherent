import asyncio
import base64
import json
import logging
import os
from pathlib import Path
from urllib.parse import urlparse
from uuid import UUID

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pywebpush import WebPushException, webpush
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from coherent_api.core.config import Settings
from coherent_api.models.push_subscription import PushSubscription

logger = logging.getLogger(__name__)


def public_key(settings: Settings) -> str:
    path = Path(settings.vapid_key_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        key = ec.generate_private_key(ec.SECP256R1())
        private_bytes = key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(descriptor, "wb") as target:
                target.write(private_bytes)
    key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    assert isinstance(key, ec.EllipticCurvePrivateKey)
    encoded = key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return base64.urlsafe_b64encode(encoded).rstrip(b"=").decode("ascii")


def valid_endpoint(endpoint: str) -> bool:
    try:
        parsed = urlparse(endpoint)
        host = (parsed.hostname or "").lower()
        return (
            endpoint.isascii()
            and len(endpoint) <= 1024
            and parsed.scheme == "https"
            and parsed.port in (None, 443)
            and not parsed.username
            and not parsed.password
            and (
                host
                in {
                    "fcm.googleapis.com",
                    "updates.push.services.mozilla.com",
                    "push.services.mozilla.com",
                    "web.push.apple.com",
                    "wns.windows.com",
                }
                or host.endswith(".notify.windows.com")
            )
        )
    except ValueError:
        return False


async def subscribe(
    session: AsyncSession, user_id: UUID, endpoint: str, p256dh: str, auth: str
) -> None:
    subscription = await session.scalar(
        select(PushSubscription).where(PushSubscription.endpoint == endpoint)
    )
    if subscription is None:
        subscription = PushSubscription(endpoint=endpoint)
        session.add(subscription)
    subscription.user_id = user_id
    subscription.p256dh = p256dh
    subscription.auth = auth
    await session.commit()


async def unsubscribe(session: AsyncSession, user_id: UUID, endpoint: str) -> None:
    await session.execute(
        delete(PushSubscription).where(
            PushSubscription.user_id == user_id, PushSubscription.endpoint == endpoint
        )
    )
    await session.commit()


async def send_to_users(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
    user_ids: tuple[UUID, ...],
    payload: dict,
) -> None:
    if not user_ids:
        return
    async with session_factory() as session:
        subscriptions = list(
            await session.scalars(
                select(PushSubscription).where(PushSubscription.user_id.in_(set(user_ids)))
            )
        )
    if not subscriptions:
        return
    public_key(settings)

    def send_one(subscription: PushSubscription) -> int | None:
        try:
            webpush(
                subscription_info={
                    "endpoint": subscription.endpoint,
                    "keys": {
                        "p256dh": subscription.p256dh,
                        "auth": subscription.auth,
                    },
                },
                data=json.dumps(
                    {**payload, "account_id": str(subscription.user_id)}, ensure_ascii=False
                ),
                vapid_private_key=settings.vapid_key_path,
                vapid_claims={"sub": settings.vapid_subject},
                ttl=180,
                timeout=5,
            )
        except WebPushException as error:
            logger.warning("Push delivery failed: %s", error.status_code)
            return error.status_code
        except Exception:
            logger.exception("Push delivery failed")
        return None

    results = await asyncio.gather(*(asyncio.to_thread(send_one, sub) for sub in subscriptions))
    stale = [sub.id for sub, code in zip(subscriptions, results, strict=True) if code in (404, 410)]
    if stale:
        async with session_factory() as session:
            await session.execute(delete(PushSubscription).where(PushSubscription.id.in_(stale)))
            await session.commit()
