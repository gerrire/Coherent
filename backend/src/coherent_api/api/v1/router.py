from fastapi import APIRouter

from coherent_api.api.v1 import (
    admin,
    auth,
    calls,
    friends,
    health,
    messages,
    push,
    realtime,
    servers,
)

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(admin.router)
api_router.include_router(friends.router)
api_router.include_router(messages.router)
api_router.include_router(realtime.router)
api_router.include_router(push.router)
api_router.include_router(calls.router)
api_router.include_router(servers.router)
