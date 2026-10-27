"""Retain public verification material for former group members."""

import sqlalchemy as sa

from alembic import op

revision = "0024_crypto_history"
down_revision = "0023_operational_metrics"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "mls_conversation_accounts",
        sa.Column(
            "conversation_id",
            sa.Uuid(),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
        ),
    )
    op.execute(
        "INSERT INTO mls_conversation_accounts (conversation_id,user_id) "
        "SELECT id,user_low_id FROM conversations WHERE user_low_id IS NOT NULL "
        "UNION SELECT id,user_high_id FROM conversations WHERE user_high_id IS NOT NULL "
        "UNION SELECT conversation_id,user_id FROM conversation_members"
    )


def downgrade():
    op.drop_table("mls_conversation_accounts")
