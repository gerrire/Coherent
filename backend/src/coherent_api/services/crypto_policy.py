from fastapi import HTTPException

from coherent_api.models.chat_policy import ChatPolicy
from coherent_api.models.mls import MlsState
from coherent_api.services.conversation_access import get_server_channel, is_call_media


async def chat_policy(session, lock=False):
    if not lock and "message_policy" in session.info:
        return session.info["message_policy"]
    from sqlalchemy import select

    query = select(ChatPolicy).where(ChatPolicy.id == 1).execution_options(populate_existing=True)
    if lock:
        query = query.with_for_update(read=True)
    policy = await session.scalar(query)
    session.info["message_policy"] = policy
    return policy


async def cloud_chats(session, lock=False):
    policy = await chat_policy(session, lock)
    if policy is not None:
        return policy.write_mode == "cloud_v1"
    # In-memory legacy protocol fixtures explicitly enable their old mode.
    settings = session.info.get("settings")
    return not (settings and settings.e2ee_messaging_enabled)


async def is_mls_conversation(session, conversation_id) -> bool:
    if await is_call_media(session, conversation_id):
        return True
    if await cloud_chats(session):
        return False
    if await get_server_channel(session, conversation_id) is not None:
        return False
    settings = session.info.get("settings")
    if settings and settings.e2ee_messaging_enabled:
        return True
    state = await session.get(MlsState, conversation_id)
    return bool(state and state.group_id)


async def require_cloud_write(session, conversation_id) -> None:
    await chat_policy(session, lock=True)
    if await is_mls_conversation(session, conversation_id):
        raise HTTPException(
            status_code=409,
            detail="Личная переписка требует сквозного шифрования. Обнови клиент и настрой ключи",
        )
