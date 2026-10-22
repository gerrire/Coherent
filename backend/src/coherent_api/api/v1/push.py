from fastapi import APIRouter, HTTPException, Request, status

from coherent_api.api.dependencies import CurrentUser, SessionDep
from coherent_api.schemas.push import (
    PushKeyResponse,
    PushSubscriptionDelete,
    PushSubscriptionRequest,
)
from coherent_api.services.push import public_key, subscribe, unsubscribe, valid_endpoint

router = APIRouter(prefix="/push", tags=["Уведомления"])


@router.get("/key", response_model=PushKeyResponse)
async def get_public_key(request: Request, user: CurrentUser) -> PushKeyResponse:
    return PushKeyResponse(public_key=public_key(request.app.state.settings))


@router.post("/subscriptions", status_code=status.HTTP_204_NO_CONTENT)
async def add_subscription(
    body: PushSubscriptionRequest, user: CurrentUser, session: SessionDep
) -> None:
    if not valid_endpoint(body.endpoint):
        raise HTTPException(status_code=400, detail="Сервис уведомлений не поддерживается")
    await subscribe(session, user.id, body.endpoint, body.keys.p256dh, body.keys.auth)


@router.post("/subscriptions/remove", status_code=status.HTTP_204_NO_CONTENT)
async def remove_subscription(
    body: PushSubscriptionDelete, user: CurrentUser, session: SessionDep
) -> None:
    await unsubscribe(session, user.id, body.endpoint)
