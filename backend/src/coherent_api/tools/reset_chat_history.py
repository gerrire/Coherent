"""Owner-authorized reset of messages, preserving accounts, social graph and call crypto.

Stop API writes and create/restore-check a fresh backup before --apply. Repeating
the same operation ID only resumes file cleanup; it never deletes new messages.
"""

import argparse
import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from coherent_api.core.chat_crypto import ChatCipher
from coherent_api.core.config import get_settings
from coherent_api.models.call_media import CallMediaSession
from coherent_api.models.call_member import CallMember
from coherent_api.models.chat_policy import ChatPolicy
from coherent_api.models.conversation_read import ConversationRead
from coherent_api.models.crypto_history import ConversationCryptoAccount
from coherent_api.models.message import Message
from coherent_api.models.message_attachment import MessageAttachment
from coherent_api.models.mls import MlsEvent, MlsState, MlsStorage


async def reset(factory, operation_id, apply=False, expected_messages=None):
    async with factory() as session:
        policy = await session.scalar(
            select(ChatPolicy).where(ChatPolicy.id == 1).with_for_update()
        )
        if policy is None:
            raise RuntimeError("Apply schema migrations before resetting history")
        if policy.history_revision == operation_id and policy.reset_at:
            return {"already_applied": True}
        if policy.reset_at:
            raise RuntimeError("History was already reset; refusing a second reset of new messages")
        report = {
            "messages": await session.scalar(select(func.count()).select_from(Message)),
            "attachments": await session.scalar(
                select(func.count()).select_from(MessageAttachment)
            ),
        }
        if not apply:
            return report
        if expected_messages is not None:
            current = set(await session.scalars(select(Message.id)))
            if current != {UUID(value) for value in expected_messages}:
                raise RuntimeError(
                    "Messages changed after the reset manifest was captured; "
                    "inspect the new data before continuing"
                )
        if await session.scalar(
            select(func.count()).select_from(CallMember).where(CallMember.state == "joined")
        ):
            raise RuntimeError("Wait until all active calls have ended")
        media = select(CallMediaSession.conversation_id)
        events = list(
            await session.scalars(select(MlsEvent).where(~MlsEvent.conversation_id.in_(media)))
        )
        reclaimed = sum(len(e.payload.encode()) * (2 if e.message_id else 1) + 4096 for e in events)
        await session.execute(delete(MlsEvent).where(~MlsEvent.conversation_id.in_(media)))
        await session.execute(delete(ConversationRead))
        await session.execute(delete(MessageAttachment))
        await session.execute(delete(Message))
        await session.execute(delete(MlsState).where(~MlsState.conversation_id.in_(media)))
        await session.execute(
            delete(ConversationCryptoAccount).where(
                ~ConversationCryptoAccount.conversation_id.in_(media)
            )
        )
        storage = await session.get(MlsStorage, 1, with_for_update=True)
        if storage:
            storage.allocated_bytes = max(0, storage.allocated_bytes - reclaimed)
        policy.write_mode = "cloud_v1"
        policy.history_revision = operation_id
        policy.reset_at = datetime.now(UTC)
        await session.commit()
        return {**report, "applied": True}


async def run(args):
    settings = get_settings()
    cipher = ChatCipher.from_file(settings.chat_master_key_path)
    if not cipher.enabled:
        raise RuntimeError("A valid existing cloud master key is required")
    engine = create_async_engine(settings.database_url)
    # Load all metadata for relationship resolution without starting the API.
    import coherent_api.api.v1.router  # noqa: F401

    factory = async_sessionmaker(engine, expire_on_commit=False)
    manifest = Path(args.manifest) if args.manifest else None
    try:
        async with factory() as session:
            encrypted = await session.scalar(
                select(Message).where(Message.body_ciphertext.is_not(None)).limit(1)
            )
            if encrypted is not None:
                cipher.decrypt(encrypted.body_ciphertext, encrypted.conversation_id, encrypted.id)
        if args.apply:
            if manifest is None:
                raise RuntimeError("Supply a private --manifest path for resumable file cleanup")
            if not manifest.exists():
                async with factory() as session:
                    ids = list(await session.scalars(select(MessageAttachment.id)))
                    messages = list(await session.scalars(select(Message.id)))
                import os

                fd = os.open(manifest, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "w") as output:
                    json.dump(
                        {
                            "operation_id": str(args.operation_id),
                            "attachments": [str(i) for i in ids],
                            "messages": [str(i) for i in messages],
                        },
                        output,
                    )
                    output.flush()
                    os.fsync(output.fileno())
            saved = json.loads(manifest.read_text())
            if saved["operation_id"] != str(args.operation_id):
                raise RuntimeError("Reset operation and cleanup manifest differ")
        result = await reset(
            factory, args.operation_id, args.apply, saved["messages"] if args.apply else None
        )
        if args.apply:
            root = Path(settings.attachment_dir)
            for identity in saved["attachments"]:
                (root / str(UUID(identity))).unlink(missing_ok=True)
        print(json.dumps(result))
    finally:
        await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--operation-id", type=UUID, required=True)
    parser.add_argument("--manifest")
    asyncio.run(run(parser.parse_args()))
