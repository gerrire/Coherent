"""Add named group conversations and their membership."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0007_group_conversations"
down_revision: str | None = "0006_group_call_members"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "conversations", sa.Column("kind", sa.String(16), server_default="direct", nullable=False)
    )
    op.add_column("conversations", sa.Column("name", sa.String(64), nullable=True))
    op.alter_column("conversations", "user_low_id", existing_type=sa.Uuid(), nullable=True)
    op.alter_column("conversations", "user_high_id", existing_type=sa.Uuid(), nullable=True)
    op.drop_constraint("ck_conversations_not_self", "conversations", type_="check")
    op.create_check_constraint(
        "ck_conversations_kind_members",
        "conversations",
        "(kind = 'direct' AND user_low_id IS NOT NULL AND user_high_id IS NOT NULL "
        "AND user_low_id <> user_high_id) OR (kind = 'group' AND user_low_id IS NULL "
        "AND user_high_id IS NULL)",
    )
    op.create_table(
        "conversation_members",
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column(
            "joined_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("conversation_id", "user_id"),
    )
    op.create_index("ix_conversation_members_user", "conversation_members", ["user_id"])


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM conversations WHERE kind = 'group'"))
    op.drop_index("ix_conversation_members_user", table_name="conversation_members")
    op.drop_table("conversation_members")
    op.drop_constraint("ck_conversations_kind_members", "conversations", type_="check")
    op.create_check_constraint(
        "ck_conversations_not_self", "conversations", "user_low_id <> user_high_id"
    )
    op.alter_column("conversations", "user_high_id", existing_type=sa.Uuid(), nullable=False)
    op.alter_column("conversations", "user_low_id", existing_type=sa.Uuid(), nullable=False)
    op.drop_column("conversations", "name")
    op.drop_column("conversations", "kind")
