"""Archive signer generations for safe device trust resets."""

import sqlalchemy as sa

from alembic import op

revision = "0021_recovery_rotation"
down_revision = "0020_membership"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "e2ee_accounts",
        sa.Column("root_revision", sa.Integer(), nullable=False, server_default="1"),
    )
    op.add_column(
        "e2ee_account_rosters", sa.Column("signer_public_key", sa.String(44), nullable=True)
    )
    op.execute(
        "UPDATE e2ee_account_rosters SET signer_public_key="
        "(SELECT recovery_public_key FROM e2ee_accounts "
        "WHERE user_id=e2ee_account_rosters.user_id)"
    )


def downgrade():
    op.drop_column("e2ee_account_rosters", "signer_public_key")
    op.drop_column("e2ee_accounts", "root_revision")
