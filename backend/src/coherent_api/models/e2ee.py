from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from coherent_api.db.base import Base


class E2eeAccount(Base):
    __tablename__ = "e2ee_accounts"
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    first_device_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True))
    recovery_backup: Mapped[str] = mapped_column(Text)
    recovery_public_key: Mapped[str] = mapped_column(String(44))
    revision: Mapped[int] = mapped_column(Integer, default=1)
    root_revision: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    roster_revision: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    recovery_confirmed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class E2eeDevice(Base):
    __tablename__ = "e2ee_devices"
    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    signature_key: Mapped[str] = mapped_column(String(44), unique=True)
    label: Mapped[str] = mapped_column(String(64))
    platform: Mapped[str] = mapped_column(String(16))
    approved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DeviceChallenge(Base):
    __tablename__ = "e2ee_device_challenges"
    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    purpose: Mapped[str] = mapped_column(String(24))
    nonce: Mapped[str] = mapped_column(String(44))
    session_version: Mapped[int] = mapped_column(Integer)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AccountRoster(Base):
    __tablename__ = "e2ee_account_rosters"
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    revision: Mapped[int] = mapped_column(Integer, primary_key=True)
    signer_public_key: Mapped[str | None] = mapped_column(String(44), nullable=True)
    payload: Mapped[str] = mapped_column(Text)
    signature: Mapped[str] = mapped_column(String(88))
    digest: Mapped[str] = mapped_column(String(44))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )


class ContactPin(Base):
    __tablename__ = "e2ee_contact_pins"
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    account_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    public_key: Mapped[str] = mapped_column(String(44))
    proof: Mapped[str] = mapped_column(String(88))
