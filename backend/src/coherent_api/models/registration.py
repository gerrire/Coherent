from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, Index, Integer, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from coherent_api.db.base import Base


class RegistrationChallenge(Base):
    __tablename__ = "registration_challenges"
    __table_args__ = (
        Index("ix_registration_email_created", "email", "created_at"),
        Index("ix_registration_ip_created", "ip_digest", "created_at"),
        Index("ix_registration_delivery", "next_delivery_at", "expires_at"),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True)
    email: Mapped[str] = mapped_column(String(320))
    ip_digest: Mapped[str] = mapped_column(String(64))
    code_digest: Mapped[str] = mapped_column(String(64))
    code_ciphertext: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    delivery_attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_delivery_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    lease_owner: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
