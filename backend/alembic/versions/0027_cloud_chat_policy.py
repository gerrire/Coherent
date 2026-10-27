"""Separate cloud chat policy from ephemeral MLS call identities; preserve data."""

from uuid import uuid4

import sqlalchemy as sa

from alembic import op

revision = "0027_cloud_chat_policy"
down_revision = "0026_device_sessions"
branch_labels = None
depends_on = None


def upgrade():
    table = op.create_table(
        "chat_policy",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("write_mode", sa.String(16), nullable=False),
        sa.Column("history_revision", sa.Uuid(), nullable=False),
        sa.Column("reset_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("write_mode IN ('cloud_v1', 'legacy_mls')", name="ck_chat_policy_mode"),
    )
    # Existing installations keep their current policy until an explicit reset.
    existing = op.get_bind().scalar(
        sa.text("SELECT count(*) FROM messages WHERE mls_payload IS NOT NULL")
    )
    op.bulk_insert(
        table,
        [
            {
                "id": 1,
                "write_mode": "legacy_mls" if existing else "cloud_v1",
                "history_revision": uuid4(),
            }
        ],
    )
    op.add_column(
        "e2ee_devices",
        sa.Column(
            "call_id", sa.Uuid(), sa.ForeignKey("calls.id", ondelete="CASCADE"), nullable=True
        ),
    )
    op.add_column(
        "e2ee_device_challenges",
        sa.Column(
            "call_id", sa.Uuid(), sa.ForeignKey("calls.id", ondelete="CASCADE"), nullable=True
        ),
    )


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT count(*) FROM chat_policy WHERE reset_at IS NOT NULL")):
        raise RuntimeError(
            "Keep the cloud policy and new messages; roll back only to a compatible application"
        )
    op.drop_column("e2ee_device_challenges", "call_id")
    op.drop_column("e2ee_devices", "call_id")
    op.drop_table("chat_policy")
