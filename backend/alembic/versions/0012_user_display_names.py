"""Add an optional public name without changing account logins."""

import sqlalchemy as sa

from alembic import op

revision = "0012_user_display_names"
down_revision = "0011_expired_attachment_marker"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("display_name", sa.String(64), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "display_name")
