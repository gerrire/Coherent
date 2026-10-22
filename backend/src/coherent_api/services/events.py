from collections.abc import Iterable
from uuid import UUID

from fastapi import WebSocket


class MessageEvents:
    """Connections for one API process; clients also refresh after reconnecting."""

    def __init__(self) -> None:
        self.connections: dict[UUID, set[WebSocket]] = {}

    def add(self, user_id: UUID, websocket: WebSocket) -> bool:
        first = user_id not in self.connections
        self.connections.setdefault(user_id, set()).add(websocket)
        return first

    def remove(self, user_id: UUID, websocket: WebSocket) -> bool:
        sockets = self.connections.get(user_id)
        if sockets is None:
            return False
        sockets.discard(websocket)
        if not sockets:
            self.connections.pop(user_id, None)
            return True
        return False

    async def publish_all(self, payload: dict) -> None:
        await self.publish(tuple(self.connections), payload)

    async def disconnect(self, user_id: UUID, code: int = 1008) -> None:
        for websocket in tuple(self.connections.get(user_id, ())):
            try:
                await websocket.close(code=code)
            except (OSError, RuntimeError):
                pass
            self.remove(user_id, websocket)
        await self.publish_all({"type": "presence"})

    async def publish(self, user_ids: Iterable[UUID], payload: dict) -> None:
        for user_id in set(user_ids):
            for websocket in tuple(self.connections.get(user_id, ())):
                try:
                    await websocket.send_json(payload)
                except (OSError, RuntimeError):
                    self.remove(user_id, websocket)
