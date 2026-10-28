from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, Text, Uuid, func, text
from sqlalchemy.orm import Mapped, mapped_column

from coherent_api.db.base import Base


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        CheckConstraint(
            "body_ciphertext IS NOT NULL OR length(trim(body)) > 0 OR attachment_count > 0",
            name="ck_messages_not_blank",
        ),
        CheckConstraint("length(body) <= 4000", name="ck_messages_body_length"),
        Index("ix_messages_conversation_created", "conversation_id", "created_at", "id"),
        Index(
            "ix_messages_reply_to_id",
            "reply_to_id",
            postgresql_where=text("reply_to_id IS NOT NULL"),
        ),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    conversation_id: Mapped[UUID] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False
    )
    sender_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    reply_to_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("messages.id", name="fk_messages_reply_to_id", ondelete="SET NULL"),
        nullable=True,
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    mls_payload: Mapped[str | None] = mapped_column(Text, nullable=True)
    body_ciphertext: Mapped[str | None] = mapped_column(Text, nullable=True)
    attachment_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    attachments_expired: Mapped[bool] = mapped_column(
        nullable=False, default=False, server_default="false"
    )
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC), server_default=func.now()
    )
