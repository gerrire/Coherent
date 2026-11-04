from uuid import UUID

from sqlalchemy import and_, exists, literal, or_, select, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from coherent_api.models.call import Call
from coherent_api.models.call_member import CallMember
from coherent_api.models.message import Message
from coherent_api.models.user import User
from coherent_api.schemas.messages import MissedCallEvent


class TimelineCursorNotFoundError(Exception):
    pass


async def timeline_page(
    session: AsyncSession,
    user_id: UUID,
    conversation_id: UUID,
    before: UUID | None,
    around: UUID | None,
) -> tuple[list[Message], list[MissedCallEvent], bool, bool]:
    """Page over both kinds of entries after the caller checks conversation access."""
    member = select(CallMember.user_id).where(
        CallMember.call_id == Call.id, CallMember.user_id == user_id
    )
    entries = union_all(
        select(Message.id, Message.created_at, literal(False).label("is_call")).where(
            Message.conversation_id == conversation_id
        ),
        select(Call.id, Call.created_at, literal(True).label("is_call")).where(
            Call.conversation_id == conversation_id,
            Call.status == "missed",
            or_(
                Call.caller_id == user_id,
                exists(
                    member.where(CallMember.joined_at.is_(None), CallMember.state != "declined")
                ),
                and_(Call.callee_id == user_id, ~exists(member)),
            ),
        ),
    ).subquery()
    query = select(entries)
    if before is not None and around is not None:
        raise TimelineCursorNotFoundError
    older = query
    if before is not None or around is not None:
        anchor = query.where(entries.c.id == (before or around))
        if around is not None:
            anchor = anchor.where(entries.c.is_call.is_(False))
        cursor = (await session.execute(anchor)).first()
        if cursor is None:
            raise TimelineCursorNotFoundError
        older = query.where(
            or_(
                entries.c.created_at < cursor.created_at,
                and_(entries.c.created_at == cursor.created_at, entries.c.id < cursor.id),
            )
        )
    descending = (entries.c.created_at.desc(), entries.c.id.desc())
    if around is None:
        rows = (await session.execute(older.order_by(*descending).limit(51))).all()
        page = list(reversed(rows[:50]))
        has_more, has_newer = len(rows) > 50, False
    else:
        earlier = (await session.execute(older.order_by(*descending).limit(26))).all()
        later = (
            await session.execute(
                query.where(
                    or_(
                        entries.c.created_at > cursor.created_at,
                        and_(entries.c.created_at == cursor.created_at, entries.c.id >= cursor.id),
                    )
                )
                .order_by(entries.c.created_at, entries.c.id)
                .limit(26)
            )
        ).all()
        page = list(reversed(earlier[:25])) + list(later[:25])
        has_more, has_newer = len(earlier) > 25, len(later) > 25

    message_ids = [row.id for row in page if not row.is_call]
    call_ids = [row.id for row in page if row.is_call]
    messages = (
        {
            message.id: message
            for message in await session.scalars(select(Message).where(Message.id.in_(message_ids)))
        }
        if message_ids
        else {}
    )
    calls = (
        {
            call.id: MissedCallEvent(
                id=call.id,
                caller_id=call.caller_id,
                caller_username=username,
                caller_display_name=display_name,
                created_at=call.created_at,
            )
            for call, username, display_name in await session.execute(
                select(Call, User.username, User.display_name)
                .join(User, User.id == Call.caller_id)
                .where(Call.id.in_(call_ids))
            )
        }
        if call_ids
        else {}
    )
    return (
        [messages[id_] for id_ in message_ids if id_ in messages],
        [calls[id_] for id_ in call_ids if id_ in calls],
        has_more,
        has_newer,
    )
