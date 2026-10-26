"""Opaque device approval relay."""

import sqlalchemy as sa

from alembic import op

revision = "0018_device_link_approval"
down_revision = "0017_encrypted_messaging"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "e2ee_device_links",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("new_device_id", sa.Uuid(), nullable=False),
        sa.Column("new_device", sa.Text(), nullable=False),
        sa.Column("label", sa.String(64), nullable=False),
        sa.Column("platform", sa.String(16), nullable=False),
        sa.Column("nonce", sa.String(44), nullable=False),
        sa.Column("session_version", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("approver_id", sa.Uuid(), sa.ForeignKey("e2ee_devices.id"), nullable=True),
        sa.Column("request", sa.Text(), nullable=True),
        sa.Column("response", sa.Text(), nullable=True),
        sa.Column("finalization", sa.Text(), nullable=True),
        sa.Column("envelope", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_e2ee_device_links_user_id", "e2ee_device_links", ["user_id"])
    op.create_index("ix_e2ee_device_links_new_device_id", "e2ee_device_links", ["new_device_id"])


def downgrade():
    op.drop_table("e2ee_device_links")
