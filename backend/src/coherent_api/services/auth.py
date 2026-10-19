from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from coherent_api.core.security import hash_password, verify_password
from coherent_api.models.user import User
from coherent_api.schemas.auth import LoginRequest, RegisterRequest


class AccountAlreadyExistsError(Exception):
    pass


class InvalidCredentialsError(Exception):
    pass


async def register_user(session: AsyncSession, request: RegisterRequest) -> User:
    existing_user = await session.scalar(
        select(User).where(or_(User.email == request.email, User.username == request.username))
    )
    if existing_user:
        raise AccountAlreadyExistsError

    user = User(
        email=request.email,
        username=request.username,
        password_hash=hash_password(request.password),
    )
    session.add(user)
    try:
        await session.commit()
    except IntegrityError as error:
        await session.rollback()
        raise AccountAlreadyExistsError from error
    await session.refresh(user)
    return user


async def authenticate_user(session: AsyncSession, request: LoginRequest) -> User:
    user = await session.scalar(select(User).where(User.email == request.email))
    if user is None or not verify_password(request.password, user.password_hash):
        raise InvalidCredentialsError
    return user
