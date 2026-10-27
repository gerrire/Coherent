from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from coherent_api.db.session import get_session
from coherent_api.models.user import User
from coherent_api.services.auth_security import remember_session, valid_session

bearer_scheme = HTTPBearer(auto_error=False)
SessionDep = Annotated[AsyncSession, Depends(get_session)]


async def get_current_user(
    request: Request,
    session: SessionDep,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
) -> User:
    token = request.cookies.get("coherent_session")
    if token is None and credentials is not None:
        token = credentials.credentials

    settings = request.app.state.settings
    identity = await valid_session(session, token, settings) if token else None
    if identity is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Требуется войти в аккаунт",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = await session.scalar(select(User).where(User.id == identity[0]))
    if user is None or user.session_version != identity[1]:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Сессия недействительна"
        )
    await remember_session(session, token, user, settings, request.headers.get("user-agent", ""))
    from coherent_api.services.auth_security import token_digest

    session.info["auth_session_digest"] = token_digest(token)
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


async def get_admin_user(request: Request, user: CurrentUser) -> User:
    if (
        not request.app.state.settings.admin_username
        or user.username != request.app.state.settings.admin_username
    ):
        raise HTTPException(status_code=403, detail="Доступ только для администратора")
    return user


AdminUser = Annotated[User, Depends(get_admin_user)]
