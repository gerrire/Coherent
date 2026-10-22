"""Expire message files after three days while keeping text messages."""

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from coherent_api.models.message import Message
from coherent_api.models.message_attachment import MessageAttachment

logger = logging.getLogger(__name__)
RETENTION = timedelta(days=3)
SWEEP_SECONDS = 60
BATCH_SIZE = 100
EXPIRED_MESSAGE = "Вложение удалено"


def expiry_cutoff() -> datetime:
    return datetime.now(UTC) - RETENTION


def is_expired(created_at: datetime) -> bool:
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=UTC)
    return created_at <= expiry_cutoff()


async def expire_batch(
    session_factory: async_sessionmaker[AsyncSession], cutoff: datetime
) -> tuple[list[UUID], int]:
    async with session_factory() as session:
        messages = list(
            await session.scalars(
                select(Message)
                .where(Message.attachment_count > 0, Message.created_at <= cutoff)
                .order_by(Message.created_at, Message.id)
                .limit(BATCH_SIZE)
                .with_for_update(skip_locked=True)
            )
        )
        if not messages:
            return [], 0
        message_ids = [message.id for message in messages]
        file_ids = list(
            await session.scalars(
                select(MessageAttachment.id).where(MessageAttachment.message_id.in_(message_ids))
            )
        )
        for message in messages:
            if not message.body.strip():
                message.body = EXPIRED_MESSAGE
            message.attachment_count = 0
            message.attachments_expired = True
        await session.execute(
            delete(MessageAttachment).where(MessageAttachment.message_id.in_(message_ids))
        )
        await session.commit()
        return file_ids, len(messages)


def remove_files(directory: Path, file_ids: list[UUID]) -> None:
    for file_id in file_ids:
        (directory / str(file_id)).unlink(missing_ok=True)


def old_file_ids(directory: Path, cutoff: datetime) -> list[UUID]:
    if not directory.is_dir():
        return []
    candidates = []
    for path in directory.iterdir():
        if not path.is_file():
            continue
        try:
            file_id = UUID(path.name)
        except ValueError:
            continue
        if datetime.fromtimestamp(path.stat().st_mtime, UTC) <= cutoff:
            candidates.append(file_id)
    return candidates


async def remove_orphans(
    session_factory: async_sessionmaker[AsyncSession], directory: Path, cutoff: datetime
) -> None:
    candidates = await asyncio.to_thread(old_file_ids, directory, cutoff)
    for start in range(0, len(candidates), BATCH_SIZE):
        batch = candidates[start : start + BATCH_SIZE]
        async with session_factory() as session:
            referenced = set(
                await session.scalars(
                    select(MessageAttachment.id).where(MessageAttachment.id.in_(batch))
                )
            )
        orphans = [item for item in batch if item not in referenced]
        await asyncio.to_thread(remove_files, directory, orphans)


async def attachment_cleanup_loop(
    session_factory: async_sessionmaker[AsyncSession], storage: str
) -> None:
    directory = Path(storage)
    while True:
        try:
            cutoff = expiry_cutoff()
            while True:
                file_ids, count = await expire_batch(session_factory, cutoff)
                await asyncio.to_thread(remove_files, directory, file_ids)
                if count < BATCH_SIZE:
                    break
            await remove_orphans(session_factory, directory, cutoff)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Could not remove expired chat attachments")
        await asyncio.sleep(SWEEP_SECONDS)
