"""Opaque MLS transport. No plaintext, content keys or recovery words."""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column

from coherent_api.db.base import Base


class MlsState(Base):
    __tablename__ = "mls_states"
    conversation_id: Mapped[UUID] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), primary_key=True
    )
    group_id: Mapped[UUID | None] = mapped_column(Uuid, nullable=True)
    sequence: Mapped[int] = mapped_column(BigInteger, default=0)
    epoch: Mapped[int] = mapped_column(BigInteger, default=0)
    generation: Mapped[int] = mapped_column(Integer, default=0)
    roster: Mapped[str] = mapped_column(Text, default="[]")
    lease_id: Mapped[UUID | None] = mapped_column(Uuid, nullable=True)
    lease_device_id: Mapped[UUID | None] = mapped_column(Uuid, nullable=True)
    lease_request_id: Mapped[UUID | None] = mapped_column(Uuid, nullable=True)
    lease_nonce: Mapped[str | None] = mapped_column(String(44), nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    lease_payload: Mapped[str | None] = mapped_column(Text, nullable=True)


class MlsPackage(Base):
    __tablename__ = "mls_key_packages"
    id: Mapped[str] = mapped_column(String(44), primary_key=True)
    device_id: Mapped[UUID] = mapped_column(
        ForeignKey("e2ee_devices.id", ondelete="CASCADE"), index=True
    )
    wire: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reserved_id: Mapped[UUID | None] = mapped_column(Uuid, nullable=True)
    reserved_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class MlsEvent(Base):
    __tablename__ = "mls_events"
    __table_args__ = (
        UniqueConstraint("conversation_id", "sequence", name="uq_mls_event_sequence"),
    )
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True)
    conversation_id: Mapped[UUID] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    sequence: Mapped[int] = mapped_column(BigInteger)
    group_id: Mapped[UUID] = mapped_column(Uuid)
    device_id: Mapped[UUID] = mapped_column(ForeignKey("e2ee_devices.id"))
    payload: Mapped[str] = mapped_column(Text)
    nonce: Mapped[str] = mapped_column(String(44))
    proof: Mapped[str] = mapped_column(String(88))
    request_hash: Mapped[str] = mapped_column(String(44))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    message_id: Mapped[UUID | None] = mapped_column(ForeignKey("messages.id"), nullable=True)


class MlsStorage(Base):
    __tablename__ = "mls_storage"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    allocated_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
