import hashlib
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import delete, select

from coherent_api.core.security import access_token_expiry, decode_access_token
from coherent_api.models.auth_security import AuthThrottle, RevokedSession


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def valid_session(session, token: str, settings):
    identity = decode_access_token(token, settings)
    if identity is None or await session.get(RevokedSession, token_digest(token)):
        return None
    return identity


async def revoke_session(session, token: str, settings) -> None:
    expires = access_token_expiry(token, settings)
    if expires is None:
        return
    key = token_digest(token)
    if session.get_bind().dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    else:
        from sqlalchemy.dialects.sqlite import insert
    await session.execute(
        insert(RevokedSession).values(digest=key, expires_at=expires).on_conflict_do_nothing()
    )
    await session.execute(
        delete(RevokedSession)
        .where(RevokedSession.expires_at < datetime.now(UTC))
        .execution_options(synchronize_session=False)
    )
    await session.commit()


async def throttle(session, namespace: str, identifier: str, limit: int, seconds: int) -> None:
    """Count attempts before expensive work, including failed or abandoned requests."""
    now = datetime.now(UTC)
    key = hashlib.sha256(f"{namespace}\0{identifier}".encode()).hexdigest()
    dialect = session.get_bind().dialect.name
    if dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    else:
        from sqlalchemy.dialects.sqlite import insert
    await session.execute(
        insert(AuthThrottle).values(key=key, started_at=now, attempts=0).on_conflict_do_nothing()
    )
    bucket = await session.scalar(
        select(AuthThrottle).where(AuthThrottle.key == key).with_for_update()
    )
    elapsed = (now - bucket.started_at.replace(tzinfo=UTC)).total_seconds()
    if elapsed >= seconds:
        bucket.started_at, bucket.attempts = now, 0
    if bucket.attempts >= limit:
        await session.commit()
        raise HTTPException(
            429,
            "Слишком много попыток. Попробуй немного позже",
            headers={"Retry-After": str(max(1, int(seconds - elapsed)))},
        )
    bucket.attempts += 1
    await session.commit()
