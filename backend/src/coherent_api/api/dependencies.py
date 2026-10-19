from typing import Annotated
from uuid import UUID

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from coherent_api.core.security import decode_access_token
from coherent_api.db.session import get_session
from coherent_api.models.user import User

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
    user_id: UUID | None = decode_access_token(token, settings) if token else None
    if user_id is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Требуется войти в аккаунт",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = await session.scalar(select(User).where(User.id == user_id))
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Аккаунт не найден")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]
