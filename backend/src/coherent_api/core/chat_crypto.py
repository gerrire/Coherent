"""Authenticated encryption at rest for cloud chat text; the API can decrypt it."""

import base64
import os
import stat
import tempfile
from collections import OrderedDict
from pathlib import Path
from uuid import UUID, uuid4

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from sqlalchemy.ext.asyncio import AsyncSession

from coherent_api.models.message import Message

FILE_MAGIC = b"COHFILE1"
FILE_OVERHEAD = len(FILE_MAGIC) + 12 + 16


class ChatCipher:
    def __init__(self, key: bytes | None = None) -> None:
        if key is not None and len(key) != 32:
            raise ValueError("Cloud chat key must contain exactly 32 random bytes")
        self._key = key
        self._conversation_keys: OrderedDict[UUID, AESGCM] = OrderedDict()

    @property
    def enabled(self) -> bool:
        return self._key is not None

    @classmethod
    def from_file(cls, path: str | None) -> "ChatCipher":
        if not path:
            return cls()
        descriptor = os.open(Path(path), os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(descriptor)
            private = info.st_mode & 0o077 == 0
            service_group = (
                info.st_uid == 0 and info.st_gid == os.getegid() and info.st_mode & 0o077 == 0o040
            )
            if not stat.S_ISREG(info.st_mode) or not (private or service_group):
                raise ValueError(
                    "Cloud chat key must be private or root-owned with service-group read access"
                )
            key = os.read(descriptor, 33)
        finally:
            os.close(descriptor)
        return cls(key)

    def _conversation_key(self, conversation_id: UUID) -> AESGCM:
        if self._key is None:
            raise ValueError("Cloud chat decryption key is not configured")
        existing = self._conversation_keys.get(conversation_id)
        if existing is not None:
            self._conversation_keys.move_to_end(conversation_id)
            return existing
        key = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=conversation_id.bytes,
            info=b"coherent/cloud-chat/v1",
        ).derive(self._key)
        result = AESGCM(key)
        self._conversation_keys[conversation_id] = result
        if len(self._conversation_keys) > 1024:
            self._conversation_keys.popitem(last=False)
        return result

    def encrypt(self, text: str, conversation_id: UUID, message_id: UUID) -> str:
        nonce = os.urandom(12)
        aad = b"coherent/message/v1:" + conversation_id.bytes + message_id.bytes
        ciphertext = self._conversation_key(conversation_id).encrypt(nonce, text.encode(), aad)
        return base64.b64encode(nonce + ciphertext).decode("ascii")

    def decrypt(self, ciphertext: str, conversation_id: UUID, message_id: UUID) -> str:
        payload = base64.b64decode(ciphertext, validate=True)
        aad = b"coherent/message/v1:" + conversation_id.bytes + message_id.bytes
        return (
            self._conversation_key(conversation_id)
            .decrypt(payload[:12], payload[12:], aad)
            .decode()
        )

    def _attachment_key(self, conversation_id: UUID, attachment_id: UUID) -> bytes:
        if self._key is None:
            raise ValueError("Cloud attachment decryption key is not configured")
        return HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=attachment_id.bytes,
            info=b"coherent/cloud-attachment/v1:" + conversation_id.bytes,
        ).derive(self._key)

    def attachment_encryptor(self, conversation_id: UUID, attachment_id: UUID):
        nonce = os.urandom(12)
        encryptor = Cipher(
            algorithms.AES(self._attachment_key(conversation_id, attachment_id)), modes.GCM(nonce)
        ).encryptor()
        encryptor.authenticate_additional_data(
            FILE_MAGIC + conversation_id.bytes + attachment_id.bytes
        )
        return FILE_MAGIC + nonce, encryptor

    def attachment_preview(self, source: Path, conversation_id: UUID, attachment_id: UUID) -> Path:
        """Authenticate completely before exposing a temporary plaintext response file."""
        temporary: Path | None = None
        try:
            with source.open("rb") as stored:
                header = stored.read(len(FILE_MAGIC) + 12)
                if header[: len(FILE_MAGIC)] != FILE_MAGIC or source.stat().st_size < FILE_OVERHEAD:
                    raise ValueError("Invalid encrypted attachment")
                stored.seek(-16, os.SEEK_END)
                tag = stored.read(16)
                remaining = stored.tell() - FILE_OVERHEAD
                stored.seek(len(header))
                decryptor = Cipher(
                    algorithms.AES(self._attachment_key(conversation_id, attachment_id)),
                    modes.GCM(header[len(FILE_MAGIC) :], tag),
                ).decryptor()
                decryptor.authenticate_additional_data(
                    FILE_MAGIC + conversation_id.bytes + attachment_id.bytes
                )
                with tempfile.NamedTemporaryFile(prefix="coherent-view-", delete=False) as output:
                    temporary = Path(output.name)
                    while remaining:
                        chunk = stored.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise ValueError("Truncated encrypted attachment")
                        remaining -= len(chunk)
                        output.write(decryptor.update(chunk))
                    output.write(decryptor.finalize())
            return temporary
        except BaseException:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
            raise


def session_cipher(session: AsyncSession) -> ChatCipher:
    return session.info.get("chat_cipher") or ChatCipher()


def cloud_message(
    session: AsyncSession,
    *,
    conversation_id: UUID,
    sender_id: UUID,
    body: str,
    attachment_count: int = 0,
) -> Message:
    message = Message(
        id=uuid4(),
        conversation_id=conversation_id,
        sender_id=sender_id,
        attachment_count=attachment_count,
    )
    set_cloud_body(session, message, body)
    return message


def set_cloud_body(session: AsyncSession, message: Message, body: str) -> None:
    cipher = session_cipher(session)
    settings = session.info.get("settings")
    if (
        not cipher.enabled
        and settings
        and (settings.app_env == "production" or settings.cloud_encryption_required)
    ):
        raise RuntimeError("Cloud encryption is required; refusing plaintext storage")
    message.body = "" if cipher.enabled else body
    message.body_ciphertext = (
        cipher.encrypt(body, message.conversation_id, message.id) if cipher.enabled else None
    )


def message_text(session: AsyncSession, message: Message) -> str:
    if message.body_ciphertext is not None:
        return session_cipher(session).decrypt(
            message.body_ciphertext, message.conversation_id, message.id
        )
    return message.body
