"""Remember that a message used to contain an expired attachment."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0011_expired_attachment_marker"
down_revision: str | None = "0010_remove_recovery_codes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column("attachments_expired", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.execute(
        sa.text(
            "UPDATE messages SET body = :new_body, attachments_expired = true "
            "WHERE body = :old_body AND attachment_count = 0"
        ).bindparams(old_body="Файлы удалены через 3 дня", new_body="Вложение удалено")
    )


def downgrade() -> None:
    op.drop_column("messages", "attachments_expired")
