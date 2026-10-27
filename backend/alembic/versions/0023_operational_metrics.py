"""Small persisted operational history; contains no user payloads."""

import sqlalchemy as sa

from alembic import op

revision = "0023_operational_metrics"
down_revision = "0022_call_mls"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "operational_metrics",
        sa.Column("at", sa.DateTime(timezone=True), primary_key=True),
        sa.Column("payload", sa.Text(), nullable=False),
    )


def downgrade():
    op.drop_table("operational_metrics")
