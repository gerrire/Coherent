"""References for replies without copying message contents into plaintext."""

import sqlalchemy as sa

from alembic import op

revision = "0029_message_replies"
down_revision = "0028_message_changes"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("messages", sa.Column("reply_to_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_messages_reply_to_id",
        "messages",
        "messages",
        ["reply_to_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_messages_reply_to_id",
        "messages",
        ["reply_to_id"],
        postgresql_where=sa.text("reply_to_id IS NOT NULL"),
    )


def downgrade():
    op.drop_index("ix_messages_reply_to_id", table_name="messages")
    op.drop_constraint("fk_messages_reply_to_id", "messages", type_="foreignkey")
    op.drop_column("messages", "reply_to_id")
