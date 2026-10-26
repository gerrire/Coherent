from sqlalchemy import or_, select

from coherent_api.models.conversation import Conversation
from coherent_api.models.conversation_member import ConversationMember
from coherent_api.services.conversation_access import conversation_member_ids


async def notify_security(request, session, user):
    groups = select(ConversationMember.conversation_id).where(ConversationMember.user_id == user.id)
    conversations = list(
        await session.scalars(
            select(Conversation).where(
                or_(
                    Conversation.user_low_id == user.id,
                    Conversation.user_high_id == user.id,
                    Conversation.id.in_(groups),
                )
            )
        )
    )
    peers = {user.id}
    for conversation in conversations:
        peers.update(await conversation_member_ids(session, conversation))
    await request.app.state.message_events.publish(tuple(peers), {"type": "security"})
