import asyncio
from uuid import uuid4

from fastapi import WebSocketDisconnect

from coherent_api.services.events import MessageEvents


def test_a_closing_tab_does_not_break_committed_updates_for_other_devices():
    class Socket:
        def __init__(self, closing=False):
            self.closing = closing
            self.received = []

        async def send_json(self, payload):
            if self.closing:
                raise WebSocketDisconnect(1006)
            self.received.append(payload)

    async def check():
        events = MessageEvents()
        user = uuid4()
        closing, active = Socket(True), Socket()
        events.add(user, closing)
        events.add(user, active)
        await events.publish((user,), {"type": "security"})
        assert active.received == [{"type": "security"}]
        assert events.connections[user] == {active}

    asyncio.run(check())
