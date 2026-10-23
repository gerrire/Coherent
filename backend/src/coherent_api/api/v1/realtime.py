"""Authenticated WebSocket for message, call, friend and presence events."""

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from coherent_api.core.security import decode_access_token
from coherent_api.models.user import User

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
    identity = decode_access_token(token, settings) if token else None
    if identity is None:
        await websocket.close(code=1008)
        return

    session_factory = websocket.app.state.session_factory
    async with session_factory() as session:
        user = await session.get(User, identity[0])
    if user is None or user.session_version != identity[1]:
        await websocket.close(code=1008)
        return
    user_id = user.id

    await websocket.accept()
    events = websocket.app.state.message_events
    if events.add(user_id, websocket):
        await events.publish_all({"type": "presence"})
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        if events.remove(user_id, websocket):
            await events.publish_all({"type": "presence"})
