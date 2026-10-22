import secrets

from fastapi import APIRouter, HTTPException, Request, Response, status

from coherent_api.api.dependencies import CurrentUser, SessionDep
from coherent_api.core.security import create_access_token, hash_password
from coherent_api.models.user import User
from coherent_api.schemas.auth import (
    AuthResponse,
    ChangePasswordRequest,
    CsrfResponse,
    LoginRequest,
    RegisterRequest,
    UserResponse,
)
from coherent_api.services.auth import (
    AccountAlreadyExistsError,
    InvalidCredentialsError,
    authenticate_user,
    register_user,
)

router = APIRouter(prefix="/auth", tags=["Авторизация"])
SESSION_COOKIE = "coherent_session"
CSRF_COOKIE = "coherent_csrf"
CSRF_MAX_AGE = 60 * 60 * 24 * 7


def set_session_cookies(response: Response, user: User, request: Request) -> None:
    settings = request.app.state.settings
    token = create_access_token(user.id, settings, user.session_version)
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        max_age=settings.access_token_ttl_minutes * 60,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )


@router.get("/csrf", response_model=CsrfResponse)
async def issue_csrf_token(request: Request, response: Response) -> CsrfResponse:
    token = secrets.token_urlsafe(32)
    response.set_cookie(
        key=CSRF_COOKIE,
        value=token,
        max_age=CSRF_MAX_AGE,
        httponly=False,
        secure=request.app.state.settings.cookie_secure,
        samesite="lax",
        path="/",
    )
    return CsrfResponse(csrf_token=token)


@router.post("/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
async def register(
    body: RegisterRequest,
    request: Request,
    response: Response,
    session: SessionDep,
) -> AuthResponse:
    try:
        user = await register_user(session, body)
    except AccountAlreadyExistsError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "Пользователь с таким именем уже существует"
                if body.email is None
                else "Пользователь с таким именем или адресом почты уже существует"
            ),
        ) from error

    set_session_cookies(response, user, request)
    return AuthResponse(user=UserResponse.model_validate(user))


@router.post("/login", response_model=AuthResponse)
async def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    session: SessionDep,
) -> AuthResponse:
    try:
        user = await authenticate_user(session, body)
    except InvalidCredentialsError as error:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Неверное имя пользователя или пароль",
            headers={"WWW-Authenticate": "Bearer"},
        ) from error

    set_session_cookies(response, user, request)
    return AuthResponse(user=UserResponse.model_validate(user))


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(request: Request, response: Response) -> Response:
    settings = request.app.state.settings
    response.delete_cookie(
        key=SESSION_COOKIE,
        path="/",
        secure=settings.cookie_secure,
        httponly=True,
        samesite="lax",
    )
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/me", response_model=UserResponse)
async def get_me(user: CurrentUser) -> UserResponse:
    return UserResponse.model_validate(user)


@router.post("/password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    body: ChangePasswordRequest,
    request: Request,
    response: Response,
    user: CurrentUser,
    session: SessionDep,
) -> None:
    user.password_hash = hash_password(body.new_password)
    user.session_version += 1
    await session.commit()
    set_session_cookies(response, user, request)
    await request.app.state.message_events.disconnect(user.id, code=4001)
