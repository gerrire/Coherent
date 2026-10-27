from datetime import UTC, datetime

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from coherent_api.core.config import Settings
from coherent_api.core.security import hash_password_async, verify_password_async
from coherent_api.models.user import User
from coherent_api.schemas.auth import LoginRequest, RegisterRequest
from coherent_api.services.registration import claim_registration


class AccountAlreadyExistsError(Exception):
    pass


class InvalidCredentialsError(Exception):
    pass


async def register_user(
    session: AsyncSession, request: RegisterRequest, settings: Settings
) -> User:
    challenge = await claim_registration(
        session, settings, request.verification_id, request.email, request.code
    )
    duplicate = User.username == request.username
    if request.email is not None:
        duplicate = or_(duplicate, User.email == request.email)
    existing_user = await session.scalar(select(User).where(duplicate))
    if existing_user:
        raise AccountAlreadyExistsError

    user = User(
        email=request.email,
        username=request.username,
        password_hash=await hash_password_async(request.password),
        email_verified_at=datetime.now(UTC),
    )
    session.add(user)
    challenge.consumed_at = datetime.now(UTC)
    challenge.code_ciphertext = None
    challenge.code_digest = ""
    try:
        await session.commit()
    except IntegrityError as error:
        await session.rollback()
        raise AccountAlreadyExistsError from error
    await session.refresh(user)
    return user


async def authenticate_user(session: AsyncSession, request: LoginRequest) -> User:
    identifier = (
        User.username == request.username
        if request.username is not None
        else User.email == request.email
    )
    user = await session.scalar(select(User).where(identifier))
    if user is None or not await verify_password_async(request.password, user.password_hash):
        raise InvalidCredentialsError
    return user
