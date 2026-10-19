from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import text

router = APIRouter(tags=["Состояние сервиса"])


@router.get("/health/live", include_in_schema=False)
async def liveness() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/health/ready", include_in_schema=False)
async def readiness(request: Request) -> dict[str, str]:
    session_factory = request.app.state.session_factory
    async with session_factory() as session:
        try:
            await session.execute(text("SELECT 1"))
        except Exception as error:
            raise HTTPException(status_code=503, detail="База данных недоступна") from error
    return {"status": "ok"}
