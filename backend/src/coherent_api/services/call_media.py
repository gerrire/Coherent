"""Call membership controls a separate MLS group. No media key enters the API."""

from sqlalchemy import delete, select

from coherent_api.models.call_media import CallMediaSession
from coherent_api.models.call_member import CallMember
from coherent_api.models.conversation import Conversation
from coherent_api.models.conversation_member import ConversationMember
from coherent_api.services.crypto_history import remember_accounts


async def sync_members(session, call):
    await session.flush()
    link = await session.get(CallMediaSession, call.id)
    joined = (
        set(
            await session.scalars(
                select(CallMember.user_id).where(
                    CallMember.call_id == call.id, CallMember.state == "joined"
                )
            )
        )
        if call.status in ("ringing", "active")
        else set()
    )
    if link is None:
        if not joined:
            return None
        conversation = Conversation(kind="group", name="Защищённый звонок", owner_id=call.caller_id)
        session.add(conversation)
        await session.flush()
        link = CallMediaSession(call_id=call.id, conversation_id=conversation.id)
        session.add(link)
    current = set(
        await session.scalars(
            select(ConversationMember.user_id).where(
                ConversationMember.conversation_id == link.conversation_id
            )
        )
    )

    await remember_accounts(session, link.conversation_id, current | joined)
    await session.execute(
        delete(ConversationMember).where(
            ConversationMember.conversation_id == link.conversation_id,
            ConversationMember.user_id.not_in(joined),
        )
    )
    for user_id in joined - current:
        session.add(ConversationMember(conversation_id=link.conversation_id, user_id=user_id))
    await session.flush()
    return link.conversation_id
