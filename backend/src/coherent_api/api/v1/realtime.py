"""Authenticated WebSocket for message, call, friend and presence events."""

import asyncio
from datetime import UTC, datetime

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from coherent_api.core.security import access_token_expiry
from coherent_api.models.user import User
from coherent_api.services.auth_security import token_digest, valid_session

# Keep the existing URL because clients already connect here.
router = APIRouter(prefix="/conversations")


@router.websocket("/events")
async def realtime_events(websocket: WebSocket) -> None:
    settings = websocket.app.state.settings
    origin = websocket.headers.get("origin")
    if origin is None or origin not in settings.cors_origins:
        await websocket.close(code=1008)
        return

    token = websocket.cookies.get("coherent_session")
    session_factory = websocket.app.state.session_factory
    async with session_factory() as session:
        identity = await valid_session(session, token, settings) if token else None
        if identity is None:
            await websocket.close(code=1008)
            return
        user = await session.get(User, identity[0])
    if user is None or user.session_version != identity[1]:
        await websocket.close(code=1008)
        return
    user_id = user.id

    await websocket.accept()
    events = websocket.app.state.message_events
    first = events.add(user_id, websocket, token_digest(token))
    expires = access_token_expiry(token, settings)
    try:
        # Logout can finish between the first DB read and socket registration.
        # Once registered, the normal revocation path can close this socket.
        async with session_factory() as session:
            current = await valid_session(session, token, settings)
            fresh_user = await session.get(User, user_id)
        if current != identity or fresh_user is None or fresh_user.session_version != identity[1]:
            await websocket.close(code=4001)
            return
        if first:
            await events.publish_all({"type": "presence"})
        async with asyncio.timeout(max(0, (expires - datetime.now(UTC)).total_seconds())):
            while True:
                await websocket.receive_text()
    except TimeoutError:
        await websocket.close(code=4001)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        if events.remove(user_id, websocket):
            await events.publish_all({"type": "presence"})
