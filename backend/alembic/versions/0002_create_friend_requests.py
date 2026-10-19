"""Create friend requests table."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0002_create_friend_requests"
down_revision: str | None = "0001_create_users"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "friend_requests",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("sender_id", sa.Uuid(), nullable=False),
        sa.Column("recipient_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=16), server_default="pending", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint("sender_id <> recipient_id", name="ck_friend_requests_not_self"),
        sa.CheckConstraint(
            "status IN ('pending', 'accepted')",
            name="ck_friend_requests_status",
        ),
        sa.ForeignKeyConstraint(["recipient_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["sender_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("sender_id", "recipient_id", name="uq_friend_requests_pair"),
    )
    op.create_index(
        "ix_friend_requests_recipient_status",
        "friend_requests",
        ["recipient_id", "status"],
    )
    op.create_index(
        "ix_friend_requests_sender_status",
        "friend_requests",
        ["sender_id", "status"],
    )


def downgrade() -> None:
    op.drop_index("ix_friend_requests_sender_status", table_name="friend_requests")
    op.drop_index("ix_friend_requests_recipient_status", table_name="friend_requests")
    op.drop_table("friend_requests")
