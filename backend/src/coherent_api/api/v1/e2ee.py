"""Device-local recovery bootstrap. This never converts cloud chats to MLS."""

import base64
import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from coherent_api.api.dependencies import CurrentUser, SessionDep
from coherent_api.core.security import verify_password
from coherent_api.models.e2ee import DeviceChallenge, E2eeAccount, E2eeDevice
from coherent_api.models.user import User
from coherent_api.schemas.e2ee import BootstrapRequest, ChallengeRequest, DeviceProofRequest
from coherent_api.services.email_verification import send_recovery_notice

router = APIRouter(prefix="/security", tags=["Устройства и восстановление"])


def require_available(request: Request) -> None:
    if not request.app.state.settings.e2ee_setup_enabled:
        raise HTTPException(
            status_code=409, detail="Настройка новой защищённой переписки ещё не включена"
        )


@router.get("/status")
async def security_status(request: Request, user: CurrentUser, session: SessionDep) -> dict:
    account = await session.get(E2eeAccount, user.id)
    devices = list(
        await session.scalars(
            select(E2eeDevice).where(E2eeDevice.user_id == user.id, E2eeDevice.revoked_at.is_(None))
        )
    )
    return {
        "setup_available": request.app.state.settings.e2ee_setup_enabled,
        "configured": account is not None,
        "recovery_confirmed": bool(account and account.recovery_confirmed_at),
        "chat_encryption": "legacy_cloud",
        "devices": [
            {
                "id": str(d.id),
                "label": d.label,
                "platform": d.platform,
                "approved_at": d.approved_at.isoformat(),
            }
            for d in devices
        ],
    }


@router.post("/challenges")
async def device_challenge(
    body: ChallengeRequest, request: Request, user: CurrentUser, session: SessionDep
) -> dict:
    require_available(request)
    await session.scalar(select(User).where(User.id == user.id).with_for_update())
    old = await session.scalar(
        select(DeviceChallenge).where(
            DeviceChallenge.user_id == user.id, DeviceChallenge.purpose == body.purpose
        )
    )
    now = datetime.now(UTC)
    if old and old.created_at.replace(tzinfo=UTC) > now - timedelta(seconds=2):
        raise HTTPException(
            status_code=429, detail="Повтори через несколько секунд", headers={"Retry-After": "2"}
        )
    await session.execute(
        delete(DeviceChallenge).where(
            DeviceChallenge.user_id == user.id, DeviceChallenge.purpose == body.purpose
        )
    )
    challenge = DeviceChallenge(
        id=uuid4(),
        user_id=user.id,
        purpose=body.purpose,
        nonce=base64.b64encode(secrets.token_bytes(32)).decode(),
        session_version=user.session_version,
        attempts=0,
        created_at=now,
        expires_at=now + timedelta(minutes=5),
    )
    session.add(challenge)
    await session.commit()
    return {"challenge_id": str(challenge.id), "nonce": challenge.nonce}


async def verify_device_request(
    session,
    user,
    identity: UUID,
    device_id: UUID,
    public: str,
    proof: str,
    password: str,
    purpose: str,
    payload_hash: bytes = bytes(32),
) -> None:
    await session.scalar(
        select(User)
        .where(User.id == user.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    challenge = await session.scalar(
        select(DeviceChallenge)
        .where(
            DeviceChallenge.id == identity,
            DeviceChallenge.user_id == user.id,
            DeviceChallenge.purpose == purpose,
        )
        .with_for_update()
    )
    now = datetime.now(UTC)
    if (
        challenge is None
        or challenge.consumed_at is not None
        or challenge.expires_at.replace(tzinfo=UTC) <= now
        or challenge.session_version != user.session_version
        or challenge.attempts >= 5
    ):
        raise HTTPException(
            status_code=403, detail="Подтверждение устройства истекло. Повтори действие"
        )
    challenge.attempts += 1
    valid = False
    try:
        public_bytes = base64.b64decode(public, validate=True)
        signed = (
            b"coherent/device-proof/v1\0"
            + purpose.encode()
            + b"\0"
            + user.id.bytes
            + device_id.bytes
            + public_bytes
            + base64.b64decode(challenge.nonce, validate=True)
            + payload_hash
        )
        Ed25519PublicKey.from_public_bytes(public_bytes).verify(
            base64.b64decode(proof, validate=True), signed
        )
        valid = verify_password(password, user.password_hash)
    except (ValueError, InvalidSignature):
        pass
    if not valid:
        await session.commit()
        raise HTTPException(
            status_code=403, detail="Не удалось подтвердить пароль и доверенное устройство"
        )
    challenge.consumed_at = now


@router.post("/bootstrap", status_code=201)
async def bootstrap_recovery(
    body: BootstrapRequest, request: Request, user: CurrentUser, session: SessionDep
) -> dict:
    require_available(request)
    if not user.email_verified or body.device.account_id != user.id:
        raise HTTPException(status_code=403, detail="Сначала подтверди почту этого аккаунта")
    digest = hashlib.sha256(
        b"coherent/bootstrap-backup/v1\0"
        + base64.b64decode(body.backup.nonce)
        + base64.b64decode(body.backup.ciphertext)
        + base64.b64decode(body.recovery_public_key)
    ).digest()
    await verify_device_request(
        session,
        user,
        body.challenge_id,
        body.device.device_id,
        body.device.signature_key,
        body.proof,
        body.current_password.get_secret_value(),
        "bootstrap",
        digest,
    )
    account = await session.get(E2eeAccount, user.id)
    if account is not None:
        # Network retries may repeat exactly the first device's existing setup.
        device = await session.get(E2eeDevice, body.device.device_id)
        if (
            account.first_device_id == body.device.device_id
            and device
            and device.user_id == user.id
            and device.signature_key == body.device.signature_key
            and device.revoked_at is None
            and account.recovery_backup == body.backup.model_dump_json()
            and account.recovery_public_key == body.recovery_public_key
        ):
            await session.commit()
            return {"configured": True}
        raise HTTPException(
            status_code=409,
            detail="Аккаунт уже настроен. Новое устройство нужно подтвердить с доверенного",
        )
    if await session.get(E2eeDevice, body.device.device_id) is not None:
        raise HTTPException(status_code=409, detail="Идентификатор устройства уже используется")
    session.add(
        E2eeAccount(
            user_id=user.id,
            first_device_id=body.device.device_id,
            recovery_backup=body.backup.model_dump_json(),
            recovery_public_key=body.recovery_public_key,
            revision=1,
        )
    )
    session.add(
        E2eeDevice(
            id=body.device.device_id,
            user_id=user.id,
            signature_key=body.device.signature_key,
            label=body.label,
            platform=body.platform,
            approved_at=datetime.now(UTC),
        )
    )
    try:
        await session.commit()
    except IntegrityError as error:
        await session.rollback()
        raise HTTPException(
            status_code=409, detail="Данные устройства изменились, повтори настройку"
        ) from error
    return {"configured": True}


async def authorize_trusted(
    body: DeviceProofRequest, request, user, session, purpose: str
) -> E2eeDevice:
    require_available(request)
    device = await session.get(E2eeDevice, body.device_id)
    if device is None or device.user_id != user.id or device.revoked_at is not None:
        raise HTTPException(status_code=403, detail="Это устройство ещё не подтверждено")
    await verify_device_request(
        session,
        user,
        body.challenge_id,
        device.id,
        device.signature_key,
        body.proof,
        body.current_password.get_secret_value(),
        purpose,
    )
    return device


@router.post("/recovery/authorize")
async def authorize_recovery_view(
    body: DeviceProofRequest, request: Request, user: CurrentUser, session: SessionDep
) -> dict:
    await authorize_trusted(body, request, user, session, "recovery_view")
    await session.commit()
    return {"authorized": True, "account_id": str(user.id), "device_id": str(body.device_id)}


@router.post("/recovery/confirm")
async def confirm_recovery_saved(
    body: DeviceProofRequest,
    request: Request,
    user: CurrentUser,
    session: SessionDep,
    background: BackgroundTasks,
) -> dict:
    await authorize_trusted(body, request, user, session, "confirm_recovery")
    account = await session.get(E2eeAccount, user.id)
    if account is None:
        raise HTTPException(status_code=409, detail="Настройка восстановления не завершена")
    first_confirmation = account.recovery_confirmed_at is None
    account.recovery_confirmed_at = datetime.now(UTC)
    await session.commit()
    if first_confirmation and user.email and user.email_verified:
        background.add_task(send_recovery_notice, request.app.state.settings, user.email)
    return {"confirmed": True}
