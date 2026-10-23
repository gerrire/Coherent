"""LiveKit room operations and short-lived media credentials for calls."""

import asyncio
import logging
from datetime import timedelta
from uuid import UUID

from livekit import api as livekit_api

from coherent_api.core.config import Settings

logger = logging.getLogger(__name__)
ROOM_PREFIX = "coherent-call-"


def room_name(call_id: UUID) -> str:
    return f"{ROOM_PREFIX}{call_id}"


def livekit_ready(settings: Settings) -> bool:
    return bool(settings.livekit_url and settings.livekit_api_key and settings.livekit_api_secret)


def livekit_client(settings: Settings) -> livekit_api.LiveKitAPI:
    assert settings.livekit_url and settings.livekit_api_key and settings.livekit_api_secret
    return livekit_api.LiveKitAPI(
        url=settings.livekit_url,
        api_key=settings.livekit_api_key,
        api_secret=settings.livekit_api_secret.get_secret_value(),
    )


async def close_livekit_room(settings: Settings, call_id: UUID) -> None:
    if not livekit_ready(settings):
        return
    try:
        async with asyncio.timeout(8):
            async with livekit_client(settings) as client:
                await client.room.delete_room(
                    livekit_api.DeleteRoomRequest(room=room_name(call_id))
                )
    except livekit_api.ServerError as error:
        if error.status != 404:
            logger.warning("Could not close LiveKit room %s: %s", call_id, error)
    except Exception as error:
        logger.warning("Could not reach LiveKit to close room %s: %s", call_id, error)


async def remove_livekit_participant(settings: Settings, call_id: UUID, user_id: UUID) -> None:
    if not livekit_ready(settings):
        return
    try:
        async with asyncio.timeout(8):
            async with livekit_client(settings) as client:
                await client.room.remove_participant(
                    livekit_api.RoomParticipantIdentity(
                        room=room_name(call_id), identity=str(user_id)
                    )
                )
    except livekit_api.ServerError as error:
        if error.status != 404:
            logger.warning(
                "Could not remove participant %s from call %s: %s", user_id, call_id, error
            )
    except Exception as error:
        logger.warning(
            "Could not reach LiveKit to remove participant from call %s: %s", call_id, error
        )


def issue_join_token(settings: Settings, call_id: UUID, user_id: UUID, username: str) -> str:
    assert settings.livekit_api_key and settings.livekit_api_secret
    return (
        livekit_api.AccessToken(
            settings.livekit_api_key, settings.livekit_api_secret.get_secret_value()
        )
        .with_identity(str(user_id))
        .with_name(username)
        .with_grants(
            livekit_api.VideoGrants(
                room_join=True,
                room=room_name(call_id),
                can_publish=True,
                can_subscribe=True,
                can_update_own_metadata=True,
            )
        )
        .with_ttl(timedelta(minutes=2))
        .to_jwt()
    )
