"""Reclaim expired protocol payloads, preserving key-package replay tombstones."""

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select

from coherent_api.models.device_link import DeviceLink
from coherent_api.models.mls import MlsPackage
from coherent_api.services.mls import allocate_storage

logger = logging.getLogger(__name__)


async def prune(session, settings):
    from coherent_api.models.auth_security import AuthThrottle, RevokedSession

    now = datetime.now(UTC)
    stale = list(
        await session.scalars(
            select(AuthThrottle.key)
            .where(AuthThrottle.started_at < now - timedelta(days=1))
            .limit(1000)
            .with_for_update(skip_locked=True)
        )
    )
    if stale:
        await session.execute(delete(AuthThrottle).where(AuthThrottle.key.in_(stale)))
    await session.execute(delete(RevokedSession).where(RevokedSession.expires_at < now))
    packages = list(
        await session.scalars(
            select(MlsPackage)
            .where(MlsPackage.expires_at < now, MlsPackage.wire != "")
            .limit(1000)
            .with_for_update(skip_locked=True)
        )
    )
    reclaimed = 0
    for package in packages:
        reclaimed += len(package.wire)
        package.wire = ""
        package.consumed_at = package.consumed_at or now
        package.reserved_id = None
        package.reserved_until = None
    links = list(
        await session.scalars(
            select(DeviceLink)
            .where(DeviceLink.expires_at < now - timedelta(days=1))
            .limit(1000)
            .with_for_update(skip_locked=True)
        )
    )
    if links:
        reclaimed += 65536 * len(links)
        await session.execute(
            delete(DeviceLink).where(DeviceLink.id.in_([link.id for link in links]))
        )
    from coherent_api.models.call import Call
    from coherent_api.models.call_media import CallMediaSession
    from coherent_api.models.conversation import Conversation
    from coherent_api.models.mls import MlsEvent

    retired = list(
        await session.scalars(
            select(CallMediaSession.conversation_id)
            .join(Call, Call.id == CallMediaSession.call_id)
            .where(
                Call.status.not_in(["ringing", "active"]), Call.ended_at < now - timedelta(days=1)
            )
            .limit(100)
        )
    )
    if retired:
        events = await session.scalars(
            select(MlsEvent).where(MlsEvent.conversation_id.in_(retired))
        )
        reclaimed += sum(len(event.payload.encode()) + 4096 for event in events)
        await session.execute(delete(Conversation).where(Conversation.id.in_(retired)))
    if reclaimed:
        await allocate_storage(session, settings, -reclaimed)
    await session.commit()


async def crypto_maintenance_loop(factory, settings):
    while True:
        try:
            async with factory() as session:
                await prune(session, settings)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Protocol storage cleanup failed")
        await asyncio.sleep(300)
