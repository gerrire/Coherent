import asyncio
import hmac
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from coherent_api.api.v1.router import api_router
from coherent_api.core.config import Settings, get_settings
from coherent_api.services.attachment_cleanup import attachment_cleanup_loop
from coherent_api.services.call_cleanup import call_cleanup_loop
from coherent_api.services.calls import livekit_ready
from coherent_api.services.events import MessageEvents


def create_app(
    settings: Settings | None = None,
    session_factory: async_sessionmaker | None = None,
) -> FastAPI:
    app_settings = settings or get_settings()
    engine = None
    if session_factory is None:
        engine = create_async_engine(app_settings.database_url, pool_pre_ping=True)
        session_factory = async_sessionmaker(engine, expire_on_commit=False)

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        attachments_cleanup = asyncio.create_task(
            attachment_cleanup_loop(session_factory, app_settings.attachment_dir)
        )
        cleanup = None
        if livekit_ready(app_settings):
            cleanup = asyncio.create_task(
                call_cleanup_loop(session_factory, app_settings, application.state.message_events)
            )
        try:
            yield
        finally:
            attachments_cleanup.cancel()
            with suppress(asyncio.CancelledError):
                await attachments_cleanup
            if cleanup is not None:
                cleanup.cancel()
                with suppress(asyncio.CancelledError):
                    await cleanup
            if engine is not None:
                await engine.dispose()

    app = FastAPI(
        title=app_settings.app_name,
        version="0.1.0",
        description="API сервиса Coherent",
        docs_url="/api/docs" if app_settings.app_env != "production" else None,
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.settings = app_settings
    app.state.session_factory = session_factory
    app.state.message_events = MessageEvents()

    app.add_middleware(
        CORSMiddleware,
        allow_origins=app_settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "X-CSRF-Token", "Authorization"],
    )

    @app.middleware("http")
    async def verify_csrf(request: Request, call_next):
        if request.method in {"POST", "PUT", "PATCH", "DELETE"} and request.url.path.startswith(
            f"{app_settings.api_prefix}/"
        ):
            cookie_token = request.cookies.get("coherent_csrf")
            header_token = request.headers.get("X-CSRF-Token")
            tokens_match = (
                cookie_token is not None
                and header_token is not None
                and hmac.compare_digest(cookie_token, header_token)
            )
            if not tokens_match:
                return JSONResponse(
                    status_code=403,
                    content={"detail": "Проверка CSRF не пройдена"},
                )
        return await call_next(request)

    app.include_router(api_router, prefix=app_settings.api_prefix)
    return app
app = create_app()
