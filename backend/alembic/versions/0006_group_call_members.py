"""Track each invited and joined participant in a call."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0006_group_call_members"
down_revision: str | None = "0005_optional_user_email"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "call_members",
        sa.Column("call_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("state", sa.String(length=16), nullable=False),
        sa.Column(
            "invited_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("joined_at", sa.DateTime(timezone=True)),
        sa.Column("left_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint(
            "state IN ('invited', 'joined', 'declined', 'left')",
            name="ck_call_members_state",
        ),
        sa.ForeignKeyConstraint(["call_id"], ["calls.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("call_id", "user_id"),
    )
    op.create_index("ix_call_members_user_state", "call_members", ["user_id", "state"])
    op.execute(
        sa.text(
            """
            INSERT INTO call_members (call_id, user_id, state, invited_at, joined_at, left_at)
            SELECT id, caller_id,
                   CASE WHEN status IN ('ringing', 'active') THEN 'joined' ELSE 'left' END,
                   created_at, created_at,
                   CASE WHEN status IN ('ringing', 'active') THEN NULL ELSE ended_at END
            FROM calls
            """
        )
    )
    op.execute(
        sa.text(
            """
            INSERT INTO call_members (call_id, user_id, state, invited_at, joined_at, left_at)
            SELECT id, callee_id,
                   CASE WHEN status = 'ringing' THEN 'invited'
                        WHEN status = 'active' THEN 'joined' ELSE 'left' END,
                   created_at,
                   CASE WHEN status = 'active' THEN answered_at ELSE NULL END,
                   CASE WHEN status IN ('ringing', 'active') THEN NULL ELSE ended_at END
            FROM calls
            """
        )
    )


def downgrade() -> None:
    op.drop_index("ix_call_members_user_state", table_name="call_members")
    op.drop_table("call_members")
