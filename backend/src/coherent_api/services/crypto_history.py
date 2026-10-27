from coherent_api.models.crypto_history import ConversationCryptoAccount


async def remember_accounts(session, conversation_id, users):
    if not users:
        return
    if session.get_bind().dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    else:
        from sqlalchemy.dialects.sqlite import insert
    await session.execute(
        insert(ConversationCryptoAccount)
        .values(
            [{"conversation_id": conversation_id, "user_id": uid} for uid in sorted(set(users))]
        )
        .on_conflict_do_nothing()
    )
