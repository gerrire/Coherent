"""Explicit group ownership and server moderation roles."""

import sqlalchemy as sa

from alembic import op

revision = "0020_membership"
down_revision = "0019_auth_security"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("conversations") as batch:
        batch.add_column(sa.Column("owner_id", sa.Uuid(), nullable=True))
        batch.create_foreign_key(
            "fk_conversation_owner", "users", ["owner_id"], ["id"], ondelete="SET NULL"
        )
    op.execute(
        "UPDATE conversations SET owner_id = "
        "(SELECT user_id FROM conversation_members WHERE conversation_id = conversations.id "
        "ORDER BY joined_at, user_id LIMIT 1) WHERE kind = 'group' "
        "AND NOT EXISTS (SELECT 1 FROM server_channels WHERE conversation_id = conversations.id)"
    )
    op.add_column(
        "server_members", sa.Column("role", sa.String(16), nullable=False, server_default="member")
    )


def downgrade():
    op.drop_column("server_members", "role")
    with op.batch_alter_table("conversations") as batch:
        batch.drop_constraint("fk_conversation_owner", type_="foreignkey")
        batch.drop_column("owner_id")
