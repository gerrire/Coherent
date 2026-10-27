"""Explicit message policy; media encryption is independent of chat storage."""

from datetime import datetime
from uuid import UUID

from sqlalchemy import CheckConstraint, DateTime, Integer, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from coherent_api.db.base import Base


class ChatPolicy(Base):
    __tablename__ = "chat_policy"
    __table_args__ = (
        CheckConstraint("write_mode IN ('cloud_v1', 'legacy_mls')", name="ck_chat_policy_mode"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    write_mode: Mapped[str] = mapped_column(String(16), nullable=False)
    history_revision: Mapped[UUID] = mapped_column(Uuid, nullable=False)
    reset_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
