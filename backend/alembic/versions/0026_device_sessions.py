"""Track individual logins without retaining bearer tokens."""

import sqlalchemy as sa

from alembic import op

revision = "0026_device_sessions"
down_revision = "0025_redundant_indexes"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "auth_sessions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("digest", sa.String(64), nullable=False, unique=True),
        sa.Column("session_version", sa.Integer(), nullable=False),
        sa.Column("agent", sa.String(300), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_auth_sessions_user_id", "auth_sessions", ["user_id"])
    op.create_index("ix_auth_sessions_expires_at", "auth_sessions", ["expires_at"])
    op.add_column("call_members", sa.Column("session_digest", sa.String(64)))


def downgrade():
    op.drop_column("call_members", "session_digest")
    op.drop_table("auth_sessions")
