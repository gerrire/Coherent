import secrets

from fastapi import APIRouter, HTTPException, Request, Response, status

from coherent_api.api.dependencies import CurrentUser, SessionDep
from coherent_api.core.security import create_access_token, hash_password, verify_password
from coherent_api.models.user import User
from coherent_api.schemas.auth import (
    AuthResponse,
    ChangePasswordRequest,
    CsrfResponse,
    EmailCodeConfirm,
    EmailCodeRequest,
    LoginRequest,
    RegisterRequest,
    UpdateProfileRequest,
    UserResponse,
)
from coherent_api.services.auth import (
    AccountAlreadyExistsError,
    InvalidCredentialsError,
    authenticate_user,
    register_user,
)
from coherent_api.services.email_verification import (
    EmailCodeError,
    EmailRateError,
    confirm_code,
    request_code,
)

router = APIRouter(prefix="/auth", tags=["Авторизация"])
SESSION_COOKIE = "coherent_session"
CSRF_COOKIE = "coherent_csrf"
CSRF_MAX_AGE = 60 * 60 * 24 * 7


def user_response(user: User, request: Request) -> UserResponse:
    return UserResponse.model_validate(user).model_copy(
        update={
            "is_admin": user.username == request.app.state.settings.admin_username,
            "email_delivery_available": bool(request.app.state.settings.smtp_host),
        }
    )


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
    return AuthResponse(user=user_response(user, request))


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
    return AuthResponse(user=user_response(user, request))


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
async def get_me(user: CurrentUser, request: Request) -> UserResponse:
    return user_response(user, request)


@router.patch("/profile", response_model=UserResponse)
async def update_profile(
    body: UpdateProfileRequest, request: Request, user: CurrentUser, session: SessionDep
) -> UserResponse:
    user.display_name = body.display_name
    await session.commit()
    await request.app.state.message_events.publish_all({"type": "profile"})
    return user_response(user, request)


@router.post("/email/code", status_code=status.HTTP_202_ACCEPTED)
async def request_email_code(
    body: EmailCodeRequest, request: Request, user: CurrentUser, session: SessionDep
) -> dict:
    if not request.app.state.settings.smtp_host:
        raise HTTPException(status_code=503, detail="Отправка писем ещё настраивается")
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Текущий пароль указан неверно")
    try:
        await request_code(session, request.app.state.settings, user, body.email)
    except EmailRateError as error:
        raise HTTPException(
            status_code=429,
            detail="Подожди перед повторной отправкой кода",
            headers={"Retry-After": "60"},
        ) from error
    except Exception as error:
        await session.rollback()
        raise HTTPException(
            status_code=503, detail="Не удалось отправить письмо. Попробуй позже."
        ) from error
    return {"expires_in_seconds": 600, "retry_after_seconds": 60}


@router.post("/email/confirm", response_model=UserResponse)
async def confirm_email_code(
    body: EmailCodeConfirm, request: Request, user: CurrentUser, session: SessionDep
) -> UserResponse:
    try:
        await confirm_code(session, request.app.state.settings, user, body.code)
    except EmailCodeError as error:
        raise HTTPException(
            status_code=400, detail="Код недействителен, истёк или исчерпал попытки"
        ) from error
    return user_response(user, request)


@router.post("/password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    body: ChangePasswordRequest,
    request: Request,
    response: Response,
    user: CurrentUser,
    session: SessionDep,
) -> None:
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Текущий пароль указан неверно")
    user.password_hash = hash_password(body.new_password)
    user.session_version += 1
    await session.commit()
    set_session_cookies(response, user, request)
    await request.app.state.message_events.disconnect(user.id, code=4001)
