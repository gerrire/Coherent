from logging.config import fileConfig

from sqlalchemy import pool
from sqlalchemy.ext.asyncio import async_engine_from_config

from alembic import context
from coherent_api.core.config import get_settings
from coherent_api.db.base import Base
from coherent_api.models import call as call_model  # noqa: F401
from coherent_api.models import call_member as call_member_model  # noqa: F401
from coherent_api.models import conversation as conversation_model  # noqa: F401
from coherent_api.models import conversation_member as conversation_member_model  # noqa: F401
from coherent_api.models import conversation_read as conversation_read_model  # noqa: F401
from coherent_api.models import friend_request as friend_request_model  # noqa: F401
from coherent_api.models import message as message_model  # noqa: F401
from coherent_api.models import message_attachment as message_attachment_model  # noqa: F401
from coherent_api.models import push_subscription as push_subscription_model  # noqa: F401
from coherent_api.models import user as user_model  # noqa: F401

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

settings = get_settings()
config.set_main_option("sqlalchemy.url", settings.database_url.replace("%", "%%"))
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=settings.database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    import asyncio

    asyncio.run(run_migrations_online())
