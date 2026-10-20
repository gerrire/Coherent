from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from coherent_api.db.base import Base


class Call(Base):
    __tablename__ = "calls"
    __table_args__ = (
        CheckConstraint("caller_id <> callee_id", name="ck_calls_not_self"),
        CheckConstraint(
            "status IN ('ringing', 'active', 'declined', 'cancelled', 'ended', 'missed')",
            name="ck_calls_status",
        ),
        Index("ix_calls_caller_status", "caller_id", "status"),
        Index("ix_calls_callee_status", "callee_id", "status"),
        Index("ix_calls_conversation_created", "conversation_id", "created_at"),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    conversation_id: Mapped[UUID] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False
    )
    caller_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    callee_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="ringing")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC), server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    answered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
