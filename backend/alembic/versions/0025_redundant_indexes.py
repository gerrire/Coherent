"""Remove legacy duplicate indexes already covered by unique constraints."""

from alembic import op

revision = "0025_redundant_indexes"
down_revision = "0024_crypto_history"
branch_labels = None
depends_on = None


def upgrade():
    op.drop_index("ix_users_username", table_name="users")
    op.drop_index("ix_users_email", table_name="users")


def downgrade():
    op.create_index("ix_users_email", "users", ["email"], unique=False)
    op.create_index("ix_users_username", "users", ["username"], unique=False)
