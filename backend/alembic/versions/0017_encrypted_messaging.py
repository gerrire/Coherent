"""Signed account device rosters and MLS delivery (legacy history is retained)."""

import sqlalchemy as sa

from alembic import op

revision = "0017_encrypted_messaging"
down_revision = "0016_registration_device_vault"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "e2ee_accounts",
        sa.Column("roster_revision", sa.Integer(), server_default="0", nullable=False),
    )
    op.create_table(
        "e2ee_account_rosters",
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column("revision", sa.Integer(), primary_key=True),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("signature", sa.String(88), nullable=False),
        sa.Column("digest", sa.String(44), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "e2ee_contact_pins",
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column(
            "account_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column("public_key", sa.String(44), nullable=False),
        sa.Column("proof", sa.String(88), nullable=False),
    )
    op.add_column("messages", sa.Column("mls_payload", sa.Text(), nullable=True))
    op.add_column(
        "message_attachments",
        sa.Column("client_encrypted", sa.Boolean(), server_default="false", nullable=False),
    )
    op.create_table(
        "mls_states",
        sa.Column(
            "conversation_id",
            sa.Uuid(),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("group_id", sa.Uuid(), nullable=True),
        sa.Column("sequence", sa.BigInteger(), nullable=False),
        sa.Column("epoch", sa.BigInteger(), nullable=False),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("roster", sa.Text(), nullable=False),
        sa.Column("lease_id", sa.Uuid(), nullable=True),
        sa.Column("lease_device_id", sa.Uuid(), nullable=True),
        sa.Column("lease_request_id", sa.Uuid(), nullable=True),
        sa.Column("lease_nonce", sa.String(44), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lease_payload", sa.Text(), nullable=True),
    )
    op.create_table(
        "mls_key_packages",
        sa.Column("id", sa.String(44), primary_key=True),
        sa.Column(
            "device_id",
            sa.Uuid(),
            sa.ForeignKey("e2ee_devices.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("wire", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reserved_id", sa.Uuid(), nullable=True),
        sa.Column("reserved_until", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_mls_key_packages_device_id", "mls_key_packages", ["device_id"])
    op.create_table(
        "mls_events",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "conversation_id",
            sa.Uuid(),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("sequence", sa.BigInteger(), nullable=False),
        sa.Column("group_id", sa.Uuid(), nullable=False),
        sa.Column("device_id", sa.Uuid(), sa.ForeignKey("e2ee_devices.id"), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("nonce", sa.String(44), nullable=False),
        sa.Column("proof", sa.String(88), nullable=False),
        sa.Column("request_hash", sa.String(44), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("message_id", sa.Uuid(), sa.ForeignKey("messages.id"), nullable=True),
        sa.UniqueConstraint("conversation_id", "sequence", name="uq_mls_event_sequence"),
    )
    op.create_index("ix_mls_events_conversation_id", "mls_events", ["conversation_id"])
    op.create_table(
        "mls_storage",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("allocated_bytes", sa.BigInteger(), nullable=False),
    )
    op.execute("INSERT INTO mls_storage (id,allocated_bytes) VALUES (1,0)")


def downgrade() -> None:
    if op.get_bind().scalar(sa.text("SELECT COUNT(*) FROM mls_events")) or op.get_bind().scalar(
        sa.text("SELECT COUNT(*) FROM e2ee_account_rosters")
    ):
        raise RuntimeError("Encrypted history and device identities must be preserved")
    op.drop_table("e2ee_contact_pins")
    op.drop_table("mls_storage")
    op.drop_table("mls_events")
    op.drop_table("mls_key_packages")
    op.drop_table("mls_states")
    op.drop_column("messages", "mls_payload")
    op.drop_column("message_attachments", "client_encrypted")
    op.drop_table("e2ee_account_rosters")
    op.drop_column("e2ee_accounts", "roster_revision")
