"""Read-only operational overview for the configured administrator."""

import shutil
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func, select

from coherent_api.api.dependencies import CurrentUser, SessionDep
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


@router.get("/overview", response_model=AdminOverview)
async def overview(request: Request, user: CurrentUser, session: SessionDep) -> AdminOverview:
    settings = request.app.state.settings
    if not settings.admin_username or user.username != settings.admin_username:
        raise HTTPException(status_code=403, detail="Доступ только для администратора")

    directory = Path(settings.attachment_dir)
    disk = shutil.disk_usage(directory if directory.exists() else directory.parent)
    recent = (await session.execute(
        select(User.username, User.created_at).order_by(User.created_at.desc()).limit(10)
    )).all()
    return AdminOverview(
        users=await session.scalar(select(func.count()).select_from(User)) or 0,
        conversations=await session.scalar(select(func.count()).select_from(Conversation)) or 0,
        messages=await session.scalar(select(func.count()).select_from(Message)) or 0,
        active_calls=await session.scalar(select(func.count()).select_from(Call).where(Call.status == "active")) or 0,
        attachment_count=await session.scalar(select(func.count()).select_from(MessageAttachment)) or 0,
        attachment_bytes=attachment_storage_bytes(directory),
        attachment_limit_bytes=settings.attachment_storage_limit_mb * 1024 * 1024,
        disk_free_bytes=disk.free,
        disk_total_bytes=disk.total,
        recent_users=[RecentUser(username=name, created_at=created) for name, created in recent],
    )
