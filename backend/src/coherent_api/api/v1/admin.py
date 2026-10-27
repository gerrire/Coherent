"""Read-only operational overview for the configured administrator."""

import shutil
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel
from sqlalchemy import func, select

from coherent_api.api.dependencies import AdminUser, SessionDep
from coherent_api.models.call import Call
from coherent_api.models.conversation import Conversation
from coherent_api.models.message import Message
from coherent_api.models.message_attachment import MessageAttachment
from coherent_api.models.user import User
from coherent_api.services.attachments import attachment_storage_bytes

router = APIRouter(prefix="/admin", tags=["Администрирование"])


class RecentUser(BaseModel):
    username: str
    created_at: datetime


class AdminOverview(BaseModel):
    users: int
    conversations: int
    messages: int
    active_calls: int
    attachment_count: int
    attachment_bytes: int
    attachment_limit_bytes: int
    disk_free_bytes: int
    disk_total_bytes: int
    recent_users: list[RecentUser]
    online_users: int = 0
    cloud_encryption_enabled: bool = False
    legacy_plaintext_messages: int = 0
    legacy_plaintext_attachments: int = 0
    e2ee_storage_bytes: int = 0
    e2ee_storage_limit_bytes: int = 0
    pending_private_migration: int = 0
    backup: dict | None = None


@router.get("/overview", response_model=AdminOverview)
async def overview(request: Request, user: AdminUser, session: SessionDep) -> AdminOverview:
    settings = request.app.state.settings

    directory = Path(settings.attachment_dir)
    disk = shutil.disk_usage(directory if directory.exists() else directory.parent)
    recent = (
        await session.execute(
            select(User.username, User.created_at).order_by(User.created_at.desc()).limit(10)
        )
    ).all()
    import json

    from coherent_api.models.mls import MlsStorage
    from coherent_api.models.server import ServerChannel

    storage = await session.get(MlsStorage, 1)
    try:
        backup = json.loads(Path("/data/operations/backup-status.json").read_text())
        backup = {
            key: backup[key]
            for key in (
                "last_success_at",
                "bytes",
                "offsite_last_success_at",
                "offsite_bytes",
                "restore_checked_at",
            )
            if key in backup
        }
    except (OSError, ValueError, TypeError):
        backup = None
    return AdminOverview(
        e2ee_storage_bytes=storage.allocated_bytes if storage else 0,
        e2ee_storage_limit_bytes=settings.e2ee_storage_limit_mb * 1024 * 1024,
        pending_private_migration=await session.scalar(
            select(func.count())
            .select_from(Message)
            .where(
                Message.mls_payload.is_(None),
                ~Message.conversation_id.in_(select(ServerChannel.conversation_id)),
            )
        )
        or 0,
        backup=backup,
        users=await session.scalar(select(func.count()).select_from(User)) or 0,
        conversations=await session.scalar(select(func.count()).select_from(Conversation)) or 0,
        messages=await session.scalar(select(func.count()).select_from(Message)) or 0,
        active_calls=await session.scalar(
            select(func.count()).select_from(Call).where(Call.status == "active")
        )
        or 0,
        attachment_count=await session.scalar(select(func.count()).select_from(MessageAttachment))
        or 0,
        attachment_bytes=attachment_storage_bytes(directory),
        attachment_limit_bytes=settings.attachment_storage_limit_mb * 1024 * 1024,
        disk_free_bytes=disk.free,
        disk_total_bytes=disk.total,
        recent_users=[RecentUser(username=name, created_at=created) for name, created in recent],
        online_users=len(request.app.state.message_events.connections),
        cloud_encryption_enabled=request.app.state.chat_cipher.enabled,
        legacy_plaintext_messages=await session.scalar(
            select(func.count())
            .select_from(Message)
            .where(Message.body_ciphertext.is_(None), Message.mls_payload.is_(None))
        )
        or 0,
        legacy_plaintext_attachments=await session.scalar(
            select(func.count())
            .select_from(MessageAttachment)
            .where(
                MessageAttachment.encrypted.is_(False),
                MessageAttachment.client_encrypted.is_(False),
            )
        )
        or 0,
    )


@router.get("/metrics")
async def metrics(
    request: Request, user: AdminUser, hours: int = Query(default=24, ge=1, le=168)
) -> dict:
    return await request.app.state.server_metrics.snapshot(hours)
