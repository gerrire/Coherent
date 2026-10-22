import hashlib
import secrets
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from coherent_api.core.security import hash_password, verify_password
from coherent_api.models.recovery_code import RecoveryCode
from coherent_api.models.user import User


def code_hash(code: str) -> str:
    normalized = code.upper().replace("-", "").replace(" ", "")
    return hashlib.sha256(normalized.encode("ascii", errors="ignore")).hexdigest()


async def issue_recovery_codes(session: AsyncSession, user: User) -> list[str]:
    await session.execute(delete(RecoveryCode).where(RecoveryCode.user_id == user.id))
    codes = []
    for _ in range(8):
        raw = secrets.token_hex(12).upper()
        code = "-".join(raw[index : index + 6] for index in range(0, 24, 6))
        session.add(RecoveryCode(user_id=user.id, code_hash=code_hash(code)))
        codes.append(code)
    await session.commit()
    return codes


async def recover_account(
    session: AsyncSession, username: str, code: str, new_password: str
) -> UUID | None:
    user = await session.scalar(select(User).where(User.username == username.strip().lower()))
    if user is None:
        return None
    # Lock the user to prevent a code being used by simultaneous requests.
    user = await session.scalar(select(User).where(User.id == user.id).with_for_update())
    if user is None:
        return None
    recovery = await session.get(RecoveryCode, (user.id, code_hash(code)))
    if recovery is None:
        await session.rollback()
        return None
    await session.delete(recovery)
    user.password_hash = hash_password(new_password)
    user.session_version += 1
    await session.commit()
    return user.id


async def regenerate_recovery_codes(
    session: AsyncSession, user: User, password: str
) -> list[str] | None:
    if not verify_password(password, user.password_hash):
        return None
    return await issue_recovery_codes(session, user)
