"""Verified email signup and opaque device/recovery bootstrap, no chat conversion."""

import sqlalchemy as sa

from alembic import op

revision = "0016_registration_device_vault"
down_revision = "0015_email_verification"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("pending_email", sa.String(320), nullable=True))
    op.execute(
        "UPDATE users SET pending_email = email, email = NULL WHERE email_verified_at IS NULL"
    )
    op.create_table(
        "registration_challenges",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("ip_digest", sa.String(64), nullable=False),
        sa.Column("code_digest", sa.String(64), nullable=False),
        sa.Column("code_ciphertext", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("delivery_attempts", sa.Integer(), nullable=False),
        sa.Column("next_delivery_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lease_owner", sa.Uuid(), nullable=True),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_registration_email_created", "registration_challenges", ["email", "created_at"]
    )
    op.create_index(
        "ix_registration_ip_created", "registration_challenges", ["ip_digest", "created_at"]
    )
    op.create_index(
        "ix_registration_delivery", "registration_challenges", ["next_delivery_at", "expires_at"]
    )
    op.create_index(
        "ix_registration_challenges_created_at", "registration_challenges", ["created_at"]
    )
    op.create_table(
        "e2ee_accounts",
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column("first_device_id", sa.Uuid(), nullable=False),
        sa.Column("recovery_backup", sa.Text(), nullable=False),
        sa.Column("recovery_public_key", sa.String(44), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("recovery_confirmed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_table(
        "e2ee_devices",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("signature_key", sa.String(44), nullable=False, unique=True),
        sa.Column("label", sa.String(64), nullable=False),
        sa.Column("platform", sa.String(16), nullable=False),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_e2ee_devices_user_id", "e2ee_devices", ["user_id"])
    op.create_table(
        "e2ee_device_challenges",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("purpose", sa.String(24), nullable=False),
        sa.Column("nonce", sa.String(44), nullable=False),
        sa.Column("session_version", sa.Integer(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("user_id", "purpose", name="uq_device_challenge_purpose"),
    )


def downgrade() -> None:
    connection = op.get_bind()
    if connection.scalar(sa.text("SELECT count(*) FROM e2ee_accounts")) or connection.scalar(
        sa.text("SELECT count(*) FROM users WHERE pending_email IS NOT NULL")
    ):
        raise RuntimeError(
            "Device, recovery and pending email data must be preserved before a downgrade"
        )
    op.drop_table("e2ee_device_challenges")
    op.drop_table("e2ee_devices")
    op.drop_table("e2ee_accounts")
    op.drop_table("registration_challenges")
    # Do not turn unverified legacy hints back into verified email ownership.
    op.drop_column("users", "pending_email")
