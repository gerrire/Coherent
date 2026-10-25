import mimetypes
import os
import shutil
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import UploadFile
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from coherent_api.core.chat_crypto import FILE_OVERHEAD, cloud_message, session_cipher
from coherent_api.core.config import Settings
from coherent_api.models.message import Message
from coherent_api.models.message_attachment import MessageAttachment
from coherent_api.models.user import User
from coherent_api.schemas.messages import AttachmentResponse, MessageResponse
from coherent_api.services.attachment_cleanup import is_expired
from coherent_api.services.conversation_access import conversation_member_ids, get_conversation
from coherent_api.services.messages import visible_message

MAX_FILE_SIZE = 25 * 1024 * 1024
MAX_TOTAL_SIZE = 50 * 1024 * 1024
MAX_FILES = 4


class AttachmentError(Exception):
    pass


class AttachmentQuotaError(AttachmentError):
    pass


def attachment_storage_bytes(directory: Path) -> int:
    if not directory.is_dir():
        return 0
    total = 0
    with os.scandir(directory) as entries:
        for entry in entries:
            try:
                if entry.is_file(follow_symlinks=False):
                    total += entry.stat(follow_symlinks=False).st_size
            except FileNotFoundError:
                # The retention worker may delete an expired file during this scan.
                continue
    return total


def safe_name(value: str | None) -> str:
    name = (value or "Файл").replace("\\", "/").split("/")[-1]
    name = "".join(char for char in name if char.isprintable() and char not in "\r\n\x00")
    return name[:255] or "Файл"


INLINE_TYPES = {
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "video/mp4",
    "video/webm",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "audio/webm",
}


def content_type(filename: str, declared: str | None) -> str:
    guessed, _ = mimetypes.guess_type(filename)
    if guessed and guessed == declared and guessed in INLINE_TYPES:
        return guessed
    return "application/octet-stream"


async def save_message_files(
    session: AsyncSession,
    user: User,
    conversation_id: UUID,
    body: str,
    files: list[UploadFile],
    settings: Settings,
) -> tuple[MessageResponse, tuple[UUID, ...]]:
    conversation = await get_conversation(session, user, conversation_id)
    clean_body = body.strip()
    if len(clean_body) > 4000 or not files or len(files) > MAX_FILES:
        raise AttachmentError("Можно отправить до четырёх файлов и 4000 символов текста")
    directory = Path(settings.attachment_dir)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    # Serialize quota checks across API workers before any bytes are written.
    if session.get_bind().dialect.name == "postgresql":
        await session.execute(text("SELECT pg_advisory_xact_lock(77814021)"))
    storage_used = attachment_storage_bytes(directory)
    storage_limit = settings.attachment_storage_limit_mb * 1024 * 1024
    free_reserve = settings.attachment_min_free_mb * 1024 * 1024
    stored: list[Path] = []
    attachments: list[MessageAttachment] = []
    total = 0
    storage_overhead = 0
    cipher = session_cipher(session)
    try:
        for upload in files:
            attachment_id = uuid4()
            path = directory / str(attachment_id)
            size = 0
            if cipher.enabled:
                storage_overhead += FILE_OVERHEAD
                if (
                    storage_used + total + storage_overhead > storage_limit
                    or shutil.disk_usage(directory).free - FILE_OVERHEAD < free_reserve
                ):
                    raise AttachmentQuotaError("Хранилище файлов заполнено. Попробуй позже.")
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as target:
                stored.append(path)
                encryptor = None
                if cipher.enabled:
                    header, encryptor = cipher.attachment_encryptor(conversation_id, attachment_id)
                    target.write(header)
                while chunk := await upload.read(1024 * 1024):
                    size += len(chunk)
                    total += len(chunk)
                    if size > MAX_FILE_SIZE or total > MAX_TOTAL_SIZE:
                        raise AttachmentError(
                            "Файл слишком большой: до 25 МБ на файл и 50 МБ на сообщение"
                        )
                    if (
                        storage_used + total + storage_overhead > storage_limit
                        or shutil.disk_usage(directory).free - len(chunk) < free_reserve
                    ):
                        raise AttachmentQuotaError(
                            "Хранилище файлов заполнено. Попробуй отправить файл позже."
                        )
                    target.write(encryptor.update(chunk) if encryptor is not None else chunk)
                if encryptor is not None:
                    target.write(encryptor.finalize())
                    target.write(encryptor.tag)
            if not size:
                raise AttachmentError("Пустой файл нельзя отправить")
            filename = safe_name(upload.filename)
            attachments.append(
                MessageAttachment(
                    id=attachment_id,
                    filename=filename,
                    media_type=content_type(filename, upload.content_type),
                    byte_size=size,
                    encrypted=cipher.enabled,
                )
            )
        message = cloud_message(
            session,
            conversation_id=conversation_id,
            sender_id=user.id,
            body=clean_body,
            attachment_count=len(attachments),
        )
        from datetime import UTC, datetime

        conversation.updated_at = datetime.now(UTC)
        session.add(message)
        await session.flush()
        for attachment in attachments:
            attachment.message_id = message.id
            session.add(attachment)
        await session.commit()
        await session.refresh(message)
        result = visible_message(session, message).model_copy(
            update={
                "attachments": [AttachmentResponse.model_validate(item) for item in attachments]
            }
        )
        return result, await conversation_member_ids(session, conversation)
    except Exception:
        await session.rollback()
        for path in stored:
            path.unlink(missing_ok=True)
        raise
    finally:
        for upload in files:
            await upload.close()


async def get_attachment(
    session: AsyncSession, user: User, conversation_id: UUID, attachment_id: UUID
) -> MessageAttachment | None:
    await get_conversation(session, user, conversation_id)
    attachment = await session.get(MessageAttachment, attachment_id)
    if attachment is None:
        return None
    message = await session.get(Message, attachment.message_id)
    return (
        attachment
        if message is not None
        and message.conversation_id == conversation_id
        and not is_expired(message.created_at)
        else None
    )
