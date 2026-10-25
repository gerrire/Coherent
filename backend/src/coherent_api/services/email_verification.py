import asyncio
import hashlib
import hmac
import secrets
import smtplib
import ssl
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from coherent_api.core.config import Settings
from coherent_api.models.email_verification import EmailVerification
from coherent_api.models.user import User


class EmailRateError(Exception):
    pass


class EmailCodeError(Exception):
    pass


def digest(settings: Settings, user: User, email: str, code: str) -> str:
    return hmac.new(
        settings.secret_key.get_secret_value().encode(),
        b"coherent/email/v1:" + user.id.bytes + email.encode() + b":" + code.encode(),
        hashlib.sha256,
    ).hexdigest()


def send_code(settings: Settings, email: str, code: str) -> None:
    if not settings.smtp_host:
        raise RuntimeError("Email delivery is not configured")
    message = EmailMessage()
    message["Subject"] = "Код подтверждения Когерента"
    message["From"] = settings.smtp_from
    message["To"] = email
    message["Date"] = formatdate(localtime=False)
    message["Message-ID"] = make_msgid(domain=settings.smtp_from.rsplit("@", 1)[-1])
    message.set_content(
        f"Код подтверждения: {code}\n\nОн действует 10 минут. Никому не сообщай этот код. "
        "Если ты не запрашивал подтверждение, просто проигнорируй письмо."
    )
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as smtp:
        smtp.ehlo()
        if settings.smtp_starttls:
            smtp.starttls(context=ssl.create_default_context())
            smtp.ehlo()
        if settings.smtp_username:
            if not settings.smtp_starttls:
                raise RuntimeError("SMTP credentials require TLS")
            smtp.login(
                settings.smtp_username,
                settings.smtp_password.get_secret_value() if settings.smtp_password else "",
            )
        smtp.send_message(message)


async def request_code(session: AsyncSession, settings: Settings, user: User, email: str) -> None:
    await session.execute(select(User.id).where(User.id == user.id).with_for_update())
    if session.get_bind().dialect.name == "postgresql":
        from sqlalchemy import text

        lock_id = int.from_bytes(hashlib.sha256(email.encode()).digest()[:8], "big", signed=True)
        await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": lock_id})
    now = datetime.now(UTC)
    challenge = await session.get(EmailVerification, user.id)
    if (
        challenge is not None
        and (now - challenge.created_at.replace(tzinfo=UTC)).total_seconds() < 60
    ):
        raise EmailRateError
    if (
        challenge is not None
        and challenge.window_start.replace(tzinfo=UTC) > now - timedelta(hours=1)
        and challenge.sent_count >= 5
    ):
        raise EmailRateError
    deliveries = (
        await session.scalar(
            select(func.sum(EmailVerification.sent_count)).where(
                EmailVerification.email == email,
                EmailVerification.window_start > now - timedelta(hours=1),
            )
        )
        or 0
    )
    if deliveries >= 5:
        raise EmailRateError
    code = f"{secrets.randbelow(1_000_000):06d}"
    if challenge is None:
        challenge = EmailVerification(user_id=user.id, window_start=now, sent_count=0)
        session.add(challenge)
    elif challenge.window_start.replace(tzinfo=UTC) <= now - timedelta(hours=1):
        challenge.window_start = now
        challenge.sent_count = 0
    challenge.email = email
    challenge.code_digest = digest(settings, user, email, code)
    challenge.created_at = now
    challenge.expires_at = now + timedelta(minutes=10)
    challenge.attempts = 0
    challenge.consumed_at = None
    challenge.session_version = user.session_version
    challenge.sent_count += 1
    await session.flush()
    await asyncio.to_thread(send_code, settings, email, code)
    await session.commit()


async def confirm_code(session: AsyncSession, settings: Settings, user: User, code: str) -> None:
    await session.scalar(
        select(User)
        .where(User.id == user.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    challenge = await session.scalar(
        select(EmailVerification).where(EmailVerification.user_id == user.id).with_for_update()
    )
    now = datetime.now(UTC)
    if (
        challenge is None
        or challenge.consumed_at is not None
        or challenge.expires_at.replace(tzinfo=UTC) <= now
        or challenge.attempts >= 5
        or challenge.session_version != user.session_version
    ):
        raise EmailCodeError
    challenge.attempts += 1
    if not hmac.compare_digest(
        challenge.code_digest, digest(settings, user, challenge.email, code)
    ):
        await session.commit()
        raise EmailCodeError
    existing = await session.scalar(
        select(User.id).where(User.email == challenge.email, User.id != user.id)
    )
    if existing is not None:
        await session.commit()
        raise EmailCodeError
    user.email = challenge.email
    user.email_verified_at = now
    challenge.consumed_at = now
    challenge.code_digest = ""
    try:
        await session.commit()
    except IntegrityError as error:
        await session.rollback()
        raise EmailCodeError from error
