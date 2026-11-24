from uuid import UUID

from fastapi import APIRouter, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from sqlalchemy import select

from coherent_api.api.dependencies import CurrentUser, SessionDep
from coherent_api.models.call import Call
from coherent_api.models.call_member import CallMember
from coherent_api.schemas.call_translation import (
    CallTranslationConfig,
    CallTranslationRequest,
    CallTranslationResponse,
)
from coherent_api.services.calls import is_expired
from coherent_api.services.gigachat_translation import TranslationProviderError


class CaptionRoute(APIRoute):
    """Keep private caption input out of FastAPI's default 422 input echo."""

    def get_route_handler(self):
        original = super().get_route_handler()

        async def sanitized(request: Request):
            try:
                return await original(request)
            except RequestValidationError:
                raise HTTPException(
                    422, "Некорректная фраза или параметры перевода звонка."
                ) from None

        return sanitized


router = APIRouter(tags=["Перевод звонков"], route_class=CaptionRoute)


async def active_translation_member(call_id: UUID, user_id: UUID, session) -> None:
    row = (
        await session.execute(
            select(Call, CallMember)
            .join(CallMember, CallMember.call_id == Call.id)
            .where(
                Call.id == call_id,
                CallMember.user_id == user_id,
            )
            .execution_options(populate_existing=True)
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(404, "Звонок не найден")
    call, member = row
    if call.status != "active" or is_expired(call) or member.state != "joined":
        raise HTTPException(409, "Перевод доступен только участникам активного звонка")
    digest = session.info.get("auth_session_digest")
    if not digest or not member.session_digest or member.session_digest != digest:
        raise HTTPException(409, "Используй перевод на устройстве, с которого идёт звонок")


@router.get("/calls/{call_id}/translation/config", response_model=CallTranslationConfig)
async def translation_config(
    call_id: UUID,
    request: Request,
    user: CurrentUser,
    session: SessionDep,
) -> CallTranslationConfig:
    await active_translation_member(call_id, user.id, session)
    settings = request.app.state.settings
    service = request.app.state.gigachat_translation
    return CallTranslationConfig(
        enabled=settings.gigachat_enabled,
        configured=service.configured,
        model=settings.gigachat_model if settings.gigachat_enabled else None,
    )


@router.post("/calls/{call_id}/translation", response_model=CallTranslationResponse)
async def translate_call_caption(
    call_id: UUID,
    body: CallTranslationRequest,
    request: Request,
    user: CurrentUser,
    session: SessionDep,
) -> CallTranslationResponse:
    requester_id = user.id
    await active_translation_member(call_id, requester_id, session)
    speaker = await session.get(CallMember, (call_id, body.speaker_id))
    if speaker is None or speaker.state != "joined":
        raise HTTPException(409, "Говорящий уже не участвует в звонке")
    # This route has only read call data after the auth dependency's session
    # bookkeeping. Release the transaction/DB connection during slow provider IO
    # so listeners do not exhaust the pool used by chats and ending calls.
    await session.commit()
    try:
        translated = await request.app.state.gigachat_translation.translate(
            call_id=call_id,
            requester_id=requester_id,
            speaker_id=body.speaker_id,
            segment_id=body.segment_id,
            text=body.text,
            source=body.source_language,
            target=body.target_language,
        )
    except TranslationProviderError as error:
        raise HTTPException(error.status_code, str(error)) from error
    # Joining another session or ending the call while a provider is responding
    # must not deliver a stale cloud result to this endpoint.
    await active_translation_member(call_id, requester_id, session)
    return CallTranslationResponse(text=translated)
