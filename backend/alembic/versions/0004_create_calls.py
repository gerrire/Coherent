"""Create direct calls."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0004_create_calls"
down_revision: str | None = "0003_create_messages"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "calls",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("caller_id", sa.Uuid(), nullable=False),
        sa.Column("callee_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("answered_at", sa.DateTime(timezone=True)),
        sa.Column("ended_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint("caller_id <> callee_id", name="ck_calls_not_self"),
        sa.CheckConstraint(
            "status IN ('ringing', 'active', 'declined', 'cancelled', 'ended', 'missed')",
            name="ck_calls_status",
        ),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["caller_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["callee_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_calls_caller_status", "calls", ["caller_id", "status"])
    op.create_index("ix_calls_callee_status", "calls", ["callee_id", "status"])
    op.create_index("ix_calls_conversation_created", "calls", ["conversation_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_calls_conversation_created", table_name="calls")
    op.drop_index("ix_calls_callee_status", table_name="calls")
    op.drop_index("ix_calls_caller_status", table_name="calls")
    op.drop_table("calls")
