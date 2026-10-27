"""Dedicated, hidden MLS groups for call media keys."""

import sqlalchemy as sa

from alembic import op

revision = "0022_call_mls"
down_revision = "0021_recovery_rotation"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "call_media_sessions",
        sa.Column(
            "call_id", sa.Uuid(), sa.ForeignKey("calls.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column(
            "conversation_id",
            sa.Uuid(),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
    )


def downgrade():
    op.drop_table("call_media_sessions")
