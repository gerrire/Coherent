"""Add ciphertext storage; retain legacy text until an explicit backfill."""

import sqlalchemy as sa

from alembic import op

revision = "0014_cloud_message_encryption"
down_revision = "0013_community_servers"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("body_ciphertext", sa.Text(), nullable=True))
    op.add_column(
        "message_attachments",
        sa.Column("encrypted", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    with op.batch_alter_table("messages") as table:
        table.drop_constraint("ck_messages_not_blank", type_="check")
        table.create_check_constraint(
            "ck_messages_not_blank",
            "body_ciphertext IS NOT NULL OR length(trim(body)) > 0 OR attachment_count > 0",
        )


def downgrade() -> None:
    # Ciphertext must be explicitly decrypted with its key before schema rollback.
    connection = op.get_bind()
    if connection.scalar(
        sa.text("SELECT count(*) FROM messages WHERE body_ciphertext IS NOT NULL")
    ):
        raise RuntimeError("Decrypt cloud messages before rolling back this migration")
    with op.batch_alter_table("messages") as table:
        table.drop_constraint("ck_messages_not_blank", type_="check")
        table.create_check_constraint(
            "ck_messages_not_blank", "length(trim(body)) > 0 OR attachment_count > 0"
        )
        table.drop_column("body_ciphertext")
    op.drop_column("message_attachments", "encrypted")
