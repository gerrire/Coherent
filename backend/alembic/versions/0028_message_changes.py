"""Track message edits and retain deletion markers for stable read positions."""

import sqlalchemy as sa

from alembic import op

revision = "0028_message_changes"
down_revision = "0027_cloud_chat_policy"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("messages", sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("messages", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))


def downgrade():
    op.drop_column("messages", "deleted_at")
    op.drop_column("messages", "edited_at")
