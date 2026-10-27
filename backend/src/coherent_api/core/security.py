import asyncio
import secrets
from datetime import UTC, datetime, timedelta
from functools import partial
from uuid import UUID
from weakref import WeakKeyDictionary

import jwt
from anyio import CapacityLimiter, to_thread
from pwdlib import PasswordHash
from pwdlib.exceptions import UnknownHashError

from coherent_api.core.config import Settings

password_hasher = PasswordHash.recommended()
ALGORITHM = "HS256"
TOKEN_ISSUER = "coherent"
_password_limiters = WeakKeyDictionary()


def password_limiter():
    loop = asyncio.get_running_loop()
    limiter = _password_limiters.get(loop)
    if limiter is None:
        limiter = CapacityLimiter(2)
        _password_limiters[loop] = limiter
    return limiter


def hash_password(password: str) -> str:
    return password_hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return password_hasher.verify(password, password_hash)
    except UnknownHashError:
        return False


async def hash_password_async(password: str) -> str:
    return await to_thread.run_sync(partial(hash_password, password), limiter=password_limiter())


async def verify_password_async(password: str, password_hash: str) -> bool:
    return await to_thread.run_sync(
        partial(verify_password, password, password_hash), limiter=password_limiter()
    )


def create_access_token(user_id: UUID, settings: Settings, session_version: int = 0) -> str:
    now = datetime.now(UTC)
    payload = {
        "sub": str(user_id),
        "ver": session_version,
        "jti": secrets.token_urlsafe(24),
        "iss": TOKEN_ISSUER,
        "iat": now,
        "exp": now + timedelta(minutes=settings.access_token_ttl_minutes),
    }
    return jwt.encode(payload, settings.secret_key.get_secret_value(), algorithm=ALGORITHM)


def decode_access_token(token: str, settings: Settings) -> tuple[UUID, int] | None:
    try:
        payload = jwt.decode(
            token,
            settings.secret_key.get_secret_value(),
            algorithms=[ALGORITHM],
            issuer=TOKEN_ISSUER,
            options={"require": ["sub", "exp", "iat", "iss"]},
        )
        return UUID(payload["sub"]), int(payload.get("ver", 0))
    except (jwt.InvalidTokenError, ValueError, KeyError, TypeError):
        return None


def access_token_expiry(token: str, settings: Settings) -> datetime | None:
    if decode_access_token(token, settings) is None:
        return None
    payload = jwt.decode(
        token, settings.secret_key.get_secret_value(), algorithms=[ALGORITHM], issuer=TOKEN_ISSUER
    )
    return datetime.fromtimestamp(payload["exp"], UTC)
