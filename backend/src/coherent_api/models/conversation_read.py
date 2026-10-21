from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from coherent_api.db.base import Base


class ConversationRead(Base):
    __tablename__ = "conversation_reads"

    conversation_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    message_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    message_created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
