from fastapi import HTTPException

from coherent_api.models.mls import MlsState
from coherent_api.services.conversation_access import get_server_channel


async def is_mls_conversation(session, conversation_id) -> bool:
    if await get_server_channel(session, conversation_id) is not None:
        return False
    settings = session.info.get("settings")
    if settings and settings.e2ee_messaging_enabled:
        return True
    state = await session.get(MlsState, conversation_id)
    return bool(state and state.group_id)


async def require_cloud_write(session, conversation_id) -> None:
    if await is_mls_conversation(session, conversation_id):
        raise HTTPException(
            status_code=409,
            detail="Личная переписка требует сквозного шифрования. Обнови клиент и настрой ключи",
        )
