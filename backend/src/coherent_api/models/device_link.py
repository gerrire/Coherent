"""Short-lived opaque device pairing relay; no PIN, password or plaintext keys."""

from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from coherent_api.db.base import Base


class DeviceLink(Base):
    __tablename__ = "e2ee_device_links"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    new_device_id: Mapped[UUID] = mapped_column(Uuid, index=True)
    new_device: Mapped[str] = mapped_column(Text)
    label: Mapped[str] = mapped_column(String(64))
    platform: Mapped[str] = mapped_column(String(16))
    nonce: Mapped[str] = mapped_column(String(44))
    session_version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), default="pending")
    approver_id: Mapped[UUID | None] = mapped_column(ForeignKey("e2ee_devices.id"), nullable=True)
    request: Mapped[str | None] = mapped_column(Text, nullable=True)
    response: Mapped[str | None] = mapped_column(Text, nullable=True)
    finalization: Mapped[str | None] = mapped_column(Text, nullable=True)
    envelope: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
