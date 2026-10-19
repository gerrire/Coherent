from uuid import UUID

from fastapi import WebSocket


class MessageEvents:
    """Connections for one API process; clients also refresh after reconnecting."""

    def __init__(self) -> None:
        self.connections: dict[UUID, set[WebSocket]] = {}

    def add(self, user_id: UUID, websocket: WebSocket) -> None:
        self.connections.setdefault(user_id, set()).add(websocket)

    def remove(self, user_id: UUID, websocket: WebSocket) -> None:
        sockets = self.connections.get(user_id)
        if sockets is None:
            return
        sockets.discard(websocket)
        if not sockets:
            self.connections.pop(user_id, None)

    async def publish(self, user_ids: tuple[UUID, UUID], payload: dict) -> None:
        for user_id in user_ids:
            for websocket in tuple(self.connections.get(user_id, ())):
                try:
                    await websocket.send_json(payload)
                except (OSError, RuntimeError):
                    self.remove(user_id, websocket)
