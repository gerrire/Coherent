"""Add community membership, text channels and revocable invites."""

import sqlalchemy as sa

from alembic import op

revision = "0013_community_servers"
down_revision = "0012_user_display_names"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "servers",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column(
            "owner_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_table(
        "server_members",
        sa.Column(
            "server_id",
            sa.Uuid(),
            sa.ForeignKey("servers.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column(
            "joined_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("ix_server_members_user_id", "server_members", ["user_id"])
    op.create_table(
        "server_channels",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "server_id", sa.Uuid(), sa.ForeignKey("servers.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "conversation_id",
            sa.Uuid(),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("category", sa.String(64), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
    )
    op.create_index("ix_server_channels_server_id", "server_channels", ["server_id"])
    op.create_table(
        "server_invites",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "server_id", sa.Uuid(), sa.ForeignKey("servers.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("uses", sa.Integer(), nullable=False),
        sa.Column("max_uses", sa.Integer(), nullable=False),
    )
    op.create_index("ix_server_invites_server_id", "server_invites", ["server_id"])


def downgrade() -> None:
    op.drop_table("server_invites")
    op.drop_table("server_channels")
    op.drop_table("server_members")
    op.drop_table("servers")
