import secrets
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response, status
from sqlalchemy import select

from coherent_api.api.dependencies import CurrentUser, SessionDep
from coherent_api.core.security import (
    create_access_token,
    hash_password_async,
    verify_password_async,
)
from coherent_api.models.auth_security import AuthSession
from coherent_api.models.registration import RegistrationChallenge
from coherent_api.models.user import User
from coherent_api.schemas.auth import (
    AuthResponse,
    ChangePasswordRequest,
    CsrfResponse,
    EmailCodeConfirm,
    EmailCodeRequest,
    LoginRequest,
    RegisterRequest,
    RegistrationCodeRequest,
    UpdateProfileRequest,
    UserResponse,
)
from coherent_api.services.auth import (
    AccountAlreadyExistsError,
    InvalidCredentialsError,
    authenticate_user,
    register_user,
)
from coherent_api.services.auth_security import (
    remember_session,
    revoke_record,
    revoke_session,
    throttle,
    token_digest,
)
from coherent_api.services.email_verification import (
    EmailCodeError,
    EmailRateError,
    confirm_code,
    request_code,
)
from coherent_api.services.registration import (
    RegistrationCodeError,
    RegistrationRateError,
    begin_registration,
    deliver_registration_code,
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
            "email": user.email or user.pending_email,
        }
    )


async def set_session_cookies(response: Response, user: User, request: Request, session) -> None:
    settings = request.app.state.settings
    token = create_access_token(user.id, settings, user.session_version)
    await remember_session(session, token, user, settings, request.headers.get("user-agent", ""))
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
        user = await register_user(session, body, request.app.state.settings)
    except RegistrationCodeError as error:
        raise HTTPException(
            status_code=400, detail="Код почты недействителен, истёк или исчерпал попытки"
        ) from error
    except AccountAlreadyExistsError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "Пользователь с таким именем уже существует"
                if body.email is None
                else "Пользователь с таким именем или адресом почты уже существует"
            ),
        ) from error

    await set_session_cookies(response, user, request, session)
    return AuthResponse(user=user_response(user, request))


@router.post("/registration/code", status_code=202)
async def registration_email_code(
    body: RegistrationCodeRequest,
    request: Request,
    session: SessionDep,
    background: BackgroundTasks,
) -> dict:
    settings = request.app.state.settings
    if not settings.smtp_host:
        raise HTTPException(
            status_code=503,
            detail="Регистрация временно недоступна: отправка писем ещё настраивается",
        )
    try:
        challenge = await begin_registration(
            session, settings, body.email, request.client.host if request.client else "unknown"
        )
    except RegistrationRateError as error:
        raise HTTPException(
            status_code=429,
            detail="Подожди перед новой отправкой кода",
            headers={"Retry-After": "60"},
        ) from error
    background.add_task(
        deliver_registration_code, request.app.state.session_factory, settings, challenge.id
    )
    return {
        "verification_id": str(challenge.id),
        "expires_in_seconds": 600,
        "retry_after_seconds": 60,
    }


@router.get("/registration/{verification_id}")
async def registration_delivery(verification_id: UUID, session: SessionDep) -> dict:
    challenge = await session.get(RegistrationChallenge, verification_id)
    if (
        challenge is None
        or challenge.consumed_at is not None
        or challenge.expires_at.replace(tzinfo=UTC) <= datetime.now(UTC)
    ):
        raise HTTPException(status_code=404, detail="Запрос подтверждения истёк")
    delivery = (
        "sent"
        if challenge.delivered_at
        else ("failed" if challenge.code_ciphertext is None else "pending")
    )
    return {"delivery": delivery}


@router.post("/login", response_model=AuthResponse)
async def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    session: SessionDep,
) -> AuthResponse:
    host = request.client.host if request.client else "unknown"
    await throttle(session, "login-ip", host, 60, 300)
    account_id = await session.scalar(
        select(User.id).where(
            User.username == body.username
            if body.username is not None
            else User.email == body.email
        )
    )
    if account_id:
        await throttle(session, "login-account", str(account_id), 12, 300)
    try:
        user = await authenticate_user(session, body)
    except InvalidCredentialsError as error:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Неверное имя пользователя или пароль",
            headers={"WWW-Authenticate": "Bearer"},
        ) from error

    await set_session_cookies(response, user, request, session)
    return AuthResponse(user=user_response(user, request))


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(request: Request, response: Response, session: SessionDep) -> Response:
    settings = request.app.state.settings
    token = request.cookies.get(SESSION_COOKIE) or request.headers.get(
        "authorization", ""
    ).removeprefix("Bearer ")
    if token:
        await revoke_session(session, token, settings)
        await request.app.state.message_events.disconnect_session(token_digest(token))
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


@router.get("/sessions")
async def list_sessions(request: Request, user: CurrentUser, session: SessionDep) -> dict:
    token = request.cookies.get(SESSION_COOKIE) or request.headers.get(
        "authorization", ""
    ).removeprefix("Bearer ")
    rows = await session.scalars(
        select(AuthSession)
        .where(
            AuthSession.user_id == user.id,
            AuthSession.revoked_at.is_(None),
            AuthSession.session_version == user.session_version,
            AuthSession.expires_at > datetime.now(UTC),
        )
        .order_by(AuthSession.last_seen_at.desc())
    )
    return {
        "sessions": [
            {
                "id": str(row.id),
                "agent": row.agent,
                "current": row.digest == token_digest(token),
                "created_at": row.created_at,
                "last_seen_at": row.last_seen_at,
                "expires_at": row.expires_at,
            }
            for row in rows
        ]
    }


@router.delete("/sessions/{session_id}", status_code=204)
async def terminate_session(
    session_id: UUID, request: Request, user: CurrentUser, session: SessionDep
) -> None:
    row = await session.scalar(
        select(AuthSession)
        .where(
            AuthSession.id == session_id,
            AuthSession.user_id == user.id,
        )
        .with_for_update()
    )
    if row is None:
        raise HTTPException(404, "Сессия не найдена")
    await revoke_record(session, row)
    await request.app.state.message_events.disconnect_session(row.digest)
    # End only calls joined from this login, preserving other devices' calls.
    from coherent_api.api.v1.calls import finish_call
    from coherent_api.models.call_member import CallMember

    calls = list(
        await session.scalars(
            select(CallMember.call_id).where(
                CallMember.user_id == user.id,
                CallMember.session_digest == row.digest,
                CallMember.state == "joined",
            )
        )
    )
    caller_digest = session.info.get("auth_session_digest")
    try:
        # The explicitly revoked login owns these calls, not the requesting login.
        session.info["auth_session_digest"] = row.digest
        for call_id in calls:
            await finish_call(call_id, request, user, session)
    finally:
        session.info["auth_session_digest"] = caller_digest


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
    if not await verify_password_async(body.current_password, user.password_hash):
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
    if not await verify_password_async(body.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Текущий пароль указан неверно")
    user.password_hash = await hash_password_async(body.new_password)
    user.session_version += 1
    await session.commit()
    await set_session_cookies(response, user, request, session)
    await request.app.state.message_events.disconnect(user.id, code=4001)
