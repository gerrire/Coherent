"""Session revocation and shared attempt counters."""

import sqlalchemy as sa

from alembic import op

revision = "0019_auth_security"
down_revision = "0018_device_link_approval"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("e2ee_device_challenges") as batch:
        batch.drop_constraint("uq_device_challenge_purpose", type_="unique")
    op.create_table(
        "auth_throttles",
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
    )
    op.create_index("ix_auth_throttles_started_at", "auth_throttles", ["started_at"])
    op.create_table(
        "revoked_sessions",
        sa.Column("digest", sa.String(64), primary_key=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_revoked_sessions_expires_at", "revoked_sessions", ["expires_at"])


def downgrade():
    op.execute("DELETE FROM e2ee_device_challenges")
    with op.batch_alter_table("e2ee_device_challenges") as batch:
        batch.create_unique_constraint("uq_device_challenge_purpose", ["user_id", "purpose"])
    op.drop_table("revoked_sessions")
    op.drop_table("auth_throttles")
