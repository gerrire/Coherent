from fastapi import APIRouter

from coherent_api.api.v1 import auth, friends, health, messages

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(friends.router)
api_router.include_router(messages.router)
