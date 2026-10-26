"""Backfill legacy message text, in bounded transactions, after key provisioning."""

import argparse
import asyncio

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from coherent_api.core.chat_crypto import ChatCipher
from coherent_api.core.config import get_settings
from coherent_api.models import conversation as conversation_model  # noqa: F401
from coherent_api.models import user as user_model  # noqa: F401
from coherent_api.models.message import Message


async def run(apply: bool) -> None:
    settings = get_settings()
    cipher = ChatCipher.from_file(settings.chat_master_key_path)
    if not cipher.enabled:
        raise RuntimeError("Configure CHAT_MASTER_KEY_PATH before encrypting history")
    engine = create_async_engine(settings.database_url)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with factory() as session:
            existing = await session.scalar(
                select(Message).where(Message.body_ciphertext.is_not(None)).limit(1)
            )
            if existing is not None:
                cipher.decrypt(existing.body_ciphertext, existing.conversation_id, existing.id)
            count = await session.scalar(
                select(func.count())
                .select_from(Message)
                .where(Message.body_ciphertext.is_(None), Message.mls_payload.is_(None))
            )
            print(f"Legacy messages: {count}")
        if not apply:
            print("Dry run. Use --apply after backing up the database and master key separately.")
            return
        converted = 0
        while True:
            async with factory() as session:
                batch = list(
                    await session.scalars(
                        select(Message)
                        .where(Message.body_ciphertext.is_(None), Message.mls_payload.is_(None))
                        .order_by(Message.id)
                        .limit(100)
                        .with_for_update(skip_locked=True)
                    )
                )
                if not batch:
                    break
                for message in batch:
                    ciphertext = cipher.encrypt(message.body, message.conversation_id, message.id)
                    if (
                        cipher.decrypt(ciphertext, message.conversation_id, message.id)
                        != message.body
                    ):
                        raise RuntimeError("Encryption verification failed; transaction cancelled")
                    message.body_ciphertext = ciphertext
                    message.body = ""
                await session.commit()
                converted += len(batch)
        print(f"Encrypted and verified messages: {converted}")
    finally:
        await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    asyncio.run(run(parser.parse_args().apply))
