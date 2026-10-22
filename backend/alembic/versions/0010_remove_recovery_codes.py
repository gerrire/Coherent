"""Remove temporary account recovery codes."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0010_remove_recovery_codes"
down_revision: str | None = "0009_attachments_push_recovery"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_table("recovery_codes")


def downgrade() -> None:
    op.create_table(
        "recovery_codes",
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column("code_hash", sa.String(64), primary_key=True),
    )
