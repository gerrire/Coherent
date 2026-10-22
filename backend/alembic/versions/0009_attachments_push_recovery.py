"""Store message files, browser subscriptions, and account recovery codes."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0009_attachments_push_recovery"
down_revision: str | None = "0008_conversation_reads"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "messages", sa.Column("attachment_count", sa.Integer(), nullable=False, server_default="0")
    )
    op.drop_constraint("ck_messages_not_blank", "messages", type_="check")
    op.create_check_constraint(
        "ck_messages_not_blank", "messages", "length(trim(body)) > 0 OR attachment_count > 0"
    )
    op.add_column(
        "users", sa.Column("session_version", sa.Integer(), nullable=False, server_default="0")
    )
    op.create_table(
        "message_attachments",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "message_id",
            sa.Uuid(),
            sa.ForeignKey("messages.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column("media_type", sa.String(100), nullable=False),
        sa.Column("byte_size", sa.BigInteger(), nullable=False),
    )
    op.create_index("ix_message_attachments_message_id", "message_attachments", ["message_id"])
    op.create_table(
        "recovery_codes",
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column("code_hash", sa.String(64), primary_key=True),
    )
    op.create_table(
        "push_subscriptions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("endpoint", sa.Text(), nullable=False, unique=True),
        sa.Column("p256dh", sa.String(256), nullable=False),
        sa.Column("auth", sa.String(256), nullable=False),
    )
    op.create_index("ix_push_subscriptions_user_id", "push_subscriptions", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_push_subscriptions_user_id", table_name="push_subscriptions")
    op.drop_table("push_subscriptions")
    op.drop_table("recovery_codes")
    op.drop_index("ix_message_attachments_message_id", table_name="message_attachments")
    op.drop_table("message_attachments")
    op.drop_column("users", "session_version")
    op.drop_constraint("ck_messages_not_blank", "messages", type_="check")
    op.create_check_constraint("ck_messages_not_blank", "messages", "length(trim(body)) > 0")
    op.drop_column("messages", "attachment_count")
