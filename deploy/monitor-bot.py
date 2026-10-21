#!/usr/bin/env python3
"""Private, on-demand Telegram dashboard for the Coherent VPS."""

import hmac
import io
import json
import logging
import os
import socket
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import psutil
from PIL import Image, ImageDraw, ImageFont


LOG = logging.getLogger("coherent.monitor")
STATE_FILE = Path("/state/owner.json")
TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
PAIR_CODE = os.environ["TELEGRAM_PAIR_CODE"]
DOMAIN = os.environ.get("PUBLIC_DOMAIN", "coherent-web.ru")
NET_INTERFACE = os.environ.get("MONITOR_NET_INTERFACE", "ens3")
API_BASE = f"https://api.telegram.org/bot{TOKEN}/"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


class BotApiError(Exception):
    pass


def telegram(method: str, data: dict | None = None, photo: bytes | None = None) -> dict:
    data = data or {}
    if photo is None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        content_type = "application/json"
    else:
        boundary = uuid.uuid4().hex
        parts = []
        for key, value in data.items():
            if isinstance(value, (dict, list)):
                value = json.dumps(value, ensure_ascii=False)
            parts.append(
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n".encode("utf-8")
            )
        parts.extend([
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"coherent-status.png\"\r\nContent-Type: image/png\r\n\r\n".encode("ascii"),
            photo,
            f"\r\n--{boundary}--\r\n".encode("ascii"),
        ])
        body = b"".join(parts)
        content_type = f"multipart/form-data; boundary={boundary}"
    request = Request(API_BASE + method, data=body, headers={"Content-Type": content_type})
    try:
        with urlopen(request, timeout=40) as response:
            answer = json.load(response)
    except HTTPError as error:
        try:
            description = json.loads(error.read()).get("description", f"HTTP {error.code}")
        except (ValueError, OSError):
            description = f"HTTP {error.code}"
        raise BotApiError(f"Telegram {method}: {description}") from None
    except (URLError, TimeoutError, OSError):
        raise BotApiError(f"Telegram {method}: connection failed") from None
    if not answer.get("ok"):
        raise BotApiError(f"Telegram {method}: {answer.get('description', 'unknown error')}")
    return answer["result"]


class OwnerState:
    def __init__(self) -> None:
        try:
            self.data = json.loads(STATE_FILE.read_text())
        except FileNotFoundError:
            self.data = {"owner_user_id": None, "owner_chat_id": None, "last_update_id": -1}

    def save(self) -> None:
        temporary = STATE_FILE.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.data))
        temporary.chmod(0o600)
        temporary.replace(STATE_FILE)

    def is_owner(self, chat_id: int, user_id: int) -> bool:
        return chat_id == self.data["owner_chat_id"] and user_id == self.data["owner_user_id"]


@dataclass(frozen=True)
class Sample:
    at: float
    cpu: float
    memory: float
    disk: float
    rx_mbps: float
    tx_mbps: float


class Monitor:
    def __init__(self) -> None:
        self.history: deque[Sample] = deque(maxlen=60)
        self.lock = threading.Lock()
        self.previous_net: tuple[float, int, int] | None = None

    def collect(self) -> Sample:
        now = time.monotonic()
        interface = psutil.net_io_counters(pernic=True).get(NET_INTERFACE)
        received = interface.bytes_recv if interface else 0
        sent = interface.bytes_sent if interface else 0
        previous = self.previous_net
        elapsed = max(1.0, now - previous[0]) if previous else 1.0
        rx = max(0.0, (received - previous[1]) * 8 / elapsed / 1_000_000) if previous else 0.0
        tx = max(0.0, (sent - previous[2]) * 8 / elapsed / 1_000_000) if previous else 0.0
        self.previous_net = (now, received, sent)
        sample = Sample(
            at=now,
            cpu=psutil.cpu_percent(interval=None),
            memory=psutil.virtual_memory().percent,
            disk=psutil.disk_usage("/").percent,
            rx_mbps=rx,
            tx_mbps=tx,
        )
        with self.lock:
            self.history.append(sample)
        return sample

    def run(self) -> None:
        psutil.cpu_percent(interval=None)
        while True:
            try:
                self.collect()
            except Exception:
                LOG.exception("Could not collect server metrics")
            time.sleep(10)

    def snapshot(self) -> tuple[Sample, list[Sample]]:
        with self.lock:
            if self.history:
                return self.history[-1], list(self.history)
        sample = self.collect()
        return sample, [sample]


def url_ok(url: str) -> bool:
    try:
        with urlopen(url, timeout=3) as response:
            return response.status == 200
    except (URLError, TimeoutError, OSError):
        return False


def redis_ok() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", 6379), timeout=2) as connection:
            connection.sendall(b"*1\r\n$4\r\nPING\r\n")
            return connection.recv(16).startswith(b"+PONG")
    except OSError:
        return False


def service_status() -> dict[str, bool]:
    return {
        "Сайт": url_ok(f"https://{DOMAIN}/"),
        "API + БД": url_ok("http://127.0.0.1:8000/api/v1/health/ready"),
        "Звонки": url_ok(f"https://{DOMAIN}:8443/"),
        "Redis": redis_ok(),
    }


def uptime() -> str:
    seconds = max(0, int(time.time() - psutil.boot_time()))
    days, remainder = divmod(seconds, 86400)
    hours, _ = divmod(remainder, 3600)
    return f"{days} д. {hours} ч." if days else f"{hours} ч."


def render_card(sample: Sample, history: list[Sample], services: dict[str, bool]) -> bytes:
    image = Image.new("RGB", (960, 610), "#151120")
    draw = ImageDraw.Draw(image)
    title = ImageFont.truetype(FONT_BOLD, 31)
    label = ImageFont.truetype(FONT_BOLD, 19)
    value_font = ImageFont.truetype(FONT_BOLD, 35)
    small = ImageFont.truetype(FONT, 17)
    tiny = ImageFont.truetype(FONT, 15)
    muted, pale, purple, green, red = "#A99DB9", "#F1EAF8", "#B985F4", "#62D6A0", "#F4899A"

    draw.rounded_rectangle((22, 20, 938, 590), radius=24, fill="#21192F", outline="#584371", width=2)
    draw.text((48, 39), "COHERENT / SERVER", font=title, fill=pale)
    draw.text((725, 51), datetime.now(timezone.utc).strftime("%d.%m.%Y  %H:%M UTC"), font=tiny, fill=muted)
    draw.line((48, 92, 912, 92), fill="#493958", width=2)

    gauges = [
        ("CPU", sample.cpu, 48),
        ("RAM", sample.memory, 347),
        ("DISK", sample.disk, 646),
    ]
    for name, percent, left in gauges:
        draw.rounded_rectangle((left, 113, left + 266, 322), radius=17, fill="#2C223B")
        draw.text((left + 20, 129), name, font=label, fill=muted)
        draw.arc((left + 80, 156, left + 186, 262), 145, 395, fill="#554566", width=13)
        color = red if percent >= 90 else purple if percent >= 75 else green
        draw.arc((left + 80, 156, left + 186, 262), 145, 145 + int(250 * min(100, percent) / 100), fill=color, width=13)
        value = f"{percent:.0f}%"
        box = draw.textbbox((0, 0), value, font=value_font)
        draw.text((left + 133 - (box[2] - box[0]) / 2, 191), value, font=value_font, fill=pale)

    draw.rounded_rectangle((48, 340, 912, 456), radius=16, fill="#2C223B")
    draw.text((68, 354), "CPU / LAST 10 MIN", font=small, fill=muted)
    values = [entry.cpu for entry in history]
    if len(values) > 1:
        points = [(68 + index * 820 / (len(values) - 1), 431 - value * 0.56) for index, value in enumerate(values)]
        draw.line(points, fill=purple, width=4, joint="curve")
    draw.text((68, 470), f"NET IN   {sample.rx_mbps:.2f} Mbit/s", font=small, fill=pale)
    draw.text((353, 470), f"NET OUT   {sample.tx_mbps:.2f} Mbit/s", font=small, fill=pale)
    draw.text((673, 470), f"UPTIME   {uptime()}", font=small, fill=pale)

    draw.line((48, 515, 912, 515), fill="#493958", width=2)
    positions = [("Сайт", 48), ("API + БД", 260), ("Звонки", 494), ("Redis", 725)]
    for name, left in positions:
        good = services[name]
        draw.ellipse((left, 543, left + 15, 558), fill=green if good else red)
        draw.text((left + 25, 539), name, font=small, fill=pale if good else red)

    output = io.BytesIO()
    image.save(output, format="PNG", optimize=True)
    return output.getvalue()


def status_caption(sample: Sample, services: dict[str, bool]) -> str:
    memory = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    health = " · ".join(f"{'🟢' if good else '🔴'} {name}" for name, good in services.items())
    return (
        f"Состояние Coherent · {datetime.now(timezone.utc):%d.%m.%Y %H:%M} UTC\n"
        f"CPU {sample.cpu:.0f}% · RAM {sample.memory:.0f}% ({(memory.total - memory.available) / 2**30:.1f}/{memory.total / 2**30:.1f} ГБ)\n"
        f"Диск {sample.disk:.0f}% ({disk.used / 2**30:.1f}/{disk.total / 2**30:.1f} ГБ)\n"
        f"Сеть ↓ {sample.rx_mbps:.2f} · ↑ {sample.tx_mbps:.2f} Мбит/с · Uptime {uptime()}\n"
        f"{health}"
    )


def send_status(chat_id: int, monitor: Monitor) -> None:
    sample, history = monitor.snapshot()
    services = service_status()
    caption = status_caption(sample, services)
    try:
        photo = render_card(sample, history, services)
        telegram("sendPhoto", {
            "chat_id": chat_id,
            "caption": caption,
            "reply_markup": {"inline_keyboard": [[{"text": "Обновить", "callback_data": "status"}]]},
        }, photo=photo)
    except Exception:
        LOG.exception("Could not send status image; sending text")
        telegram("sendMessage", {"chat_id": chat_id, "text": caption})


def handle_update(update: dict, state: OwnerState, monitor: Monitor) -> None:
    callback = update.get("callback_query")
    if callback:
        chat = callback.get("message", {}).get("chat", {})
        sender = callback.get("from", {})
        authorized = state.is_owner(chat.get("id"), sender.get("id"))
        telegram("answerCallbackQuery", {"callback_query_id": callback["id"], "text": "Обновляю" if authorized else "Нет доступа"})
        if authorized and callback.get("data") == "status":
            send_status(chat["id"], monitor)
        return

    message = update.get("message")
    if not message:
        return
    chat = message.get("chat", {})
    sender = message.get("from", {})
    if chat.get("type") != "private" or sender.get("is_bot"):
        return
    chat_id, user_id = chat.get("id"), sender.get("id")
    if not isinstance(chat_id, int) or not isinstance(user_id, int):
        return
    text = (message.get("text") or "").strip()
    command, _, argument = text.partition(" ")
    command = command.split("@")[0].lower()

    if state.data["owner_user_id"] is None:
        if command == "/start" and hmac.compare_digest(argument.strip(), PAIR_CODE):
            state.data["owner_user_id"] = user_id
            state.data["owner_chat_id"] = chat_id
            state.save()
            LOG.info("Owner paired")
            telegram("sendMessage", {"chat_id": chat_id, "text": "Готово, доступ привязан к этому чату. Нажми /status для состояния сервера."})
        elif command == "/start":
            telegram("sendMessage", {"chat_id": chat_id, "text": "Для доступа отправь /start и код привязки через пробел."})
        return
    if not state.is_owner(chat_id, user_id):
        return
    if command in ("/status", "/metrics"):
        send_status(chat_id, monitor)
    elif command in ("/start", "/help"):
        telegram("sendMessage", {"chat_id": chat_id, "text": "/status — карточка состояния сервера\n/metrics — то же самое\nКнопка «Обновить» пришлёт свежие данные."})


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not TOKEN or len(PAIR_CODE) < 10:
        raise RuntimeError("Telegram token or pairing code is missing")
    state = OwnerState()
    webhook = telegram("getWebhookInfo")
    if webhook.get("url"):
        raise RuntimeError("A Telegram webhook already exists for this bot")
    identity = telegram("getMe")
    LOG.info("Connected to Telegram as @%s", identity.get("username", "unknown"))
    telegram("setMyCommands", {"commands": [
        {"command": "status", "description": "Состояние сервера"},
        {"command": "metrics", "description": "Метрики и график"},
        {"command": "help", "description": "Справка"},
    ]})
    monitor = Monitor()
    threading.Thread(target=monitor.run, daemon=True).start()
    backoff = 2
    while True:
        try:
            updates = telegram("getUpdates", {
                "offset": state.data["last_update_id"] + 1,
                "timeout": 25,
                "allowed_updates": ["message", "callback_query"],
            })
            for update in updates:
                try:
                    handle_update(update, state, monitor)
                except Exception:
                    LOG.exception("Could not handle Telegram update")
                state.data["last_update_id"] = update["update_id"]
                state.save()
            Path("/tmp/monitor-bot-heartbeat").touch()
            backoff = 2
        except Exception:
            LOG.exception("Telegram polling failed")
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)


if __name__ == "__main__":
    main()
