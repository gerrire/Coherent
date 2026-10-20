"""Allow username-only accounts while preserving existing email addresses."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0005_optional_user_email"
down_revision: str | None = "0004_create_calls"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column("users", "email", existing_type=sa.String(length=320), nullable=True)


def downgrade() -> None:
    users = sa.table("users", sa.column("id", sa.Uuid()), sa.column("email", sa.String(320)))
    connection = op.get_bind()
    user_ids = connection.execute(sa.select(users.c.id).where(users.c.email.is_(None))).scalars()
    for user_id in user_ids:
        connection.execute(
            sa.update(users)
            .where(users.c.id == user_id)
            .values(email=f"unavailable-{user_id}@invalid.local")
        )
    op.alter_column("users", "email", existing_type=sa.String(length=320), nullable=False)
