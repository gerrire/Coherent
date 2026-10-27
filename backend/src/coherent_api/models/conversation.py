from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from coherent_api.db.base import Base


class Conversation(Base):
    __tablename__ = "conversations"
    __table_args__ = (
        UniqueConstraint("user_low_id", "user_high_id", name="uq_conversations_pair"),
        CheckConstraint(
            "(kind = 'direct' AND user_low_id IS NOT NULL AND user_high_id IS NOT NULL "
            "AND user_low_id <> user_high_id) OR (kind = 'group' AND user_low_id IS NULL "
            "AND user_high_id IS NULL)",
            name="ck_conversations_kind_members",
        ),
        Index("ix_conversations_user_low_updated", "user_low_id", "updated_at"),
        Index("ix_conversations_user_high_updated", "user_high_id", "updated_at"),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    kind: Mapped[str] = mapped_column(
        String(16), default="direct", server_default="direct", nullable=False
    )
    owner_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str | None] = mapped_column(String(64))
    user_low_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    user_high_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC), server_default=func.now()
    )
