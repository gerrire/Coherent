# Развёртывание Coherent на VPS

## Адреса и схема

```text
https://coherent-web.ru        ──► Caddy ──► интерфейс и /api/* ──► FastAPI ──► PostgreSQL
wss://coherent-web.ru:8443     ──► Caddy ──► LiveKit
браузеры ──WebRTC/UDP, TCP, TURN/UDP или TURN/TLS──► LiveKit ──► Redis
```

Все сервисы работают на финском VPS через Docker Compose. Caddy обслуживает интерфейс, проксирует API и LiveKit, автоматически получает и продлевает HTTPS-сертификаты для `coherent-web.ru` и `www.coherent-web.ru`. Адрес `www` перенаправляется на основной домен. Доступ по `https://31.76.77.197` остаётся запасным вариантом: для него используется отдельный короткоживущий IP-сертификат Let's Encrypt и Certbot.

Собранные файлы `/assets/*` имеют уникальные имена и кэшируются браузером на год; HTML проверяется при каждом открытии. Сжатие Zstandard/Gzip уже включено. API и WebSocket-сигнализация не кэшируются.

В production используются отдельные случайные ключи LiveKit и Redis. Локальный `compose.yaml` запускает LiveKit в режиме разработки с известными ключами; его нельзя выставлять в интернет. API пока запускается одним процессом Uvicorn, поскольку уведомления чата хранятся в памяти процесса.

Telegram-бот мониторинга запускается отдельным контейнером без входящего порта. Он по запросу `/status` отправляет снимок CPU, памяти, диска, сетевого трафика за последние десять минут и состояния сайта, API с базой данных, LiveKit и Redis. Для него в закрытом `deploy/.env` нужны `TELEGRAM_BOT_TOKEN` и случайный `TELEGRAM_PAIR_CODE` длиной от 10 символов. Первый личный чат, отправивший `/start КОД`, становится единственным владельцем. Привязка и позиция чтения сообщений сохраняются в Docker volume `monitor_bot_state`. Бот не получает доступ к Docker socket или секретам API. При смене владельца нужно остановить бота, удалить `owner.json` из этого volume и установить новый код привязки.

## Первый запуск

1. Направить A-записи `coherent-web.ru` и `www.coherent-web.ru` на публичный IP VPS. Установить Docker Engine и Compose plugin, настроить SSH и брандмауэр. Открыть 80, 443, 8443 и 5349 TCP, 7881 TCP, 3478 и 7882–7883 UDP. Порты PostgreSQL, Redis, API и LiveKit 7880 публично не открывать.
2. Клонировать репозиторий на VPS, создать закрытый `deploy/.env` по образцу `deploy/.env.example` с `PUBLIC_DOMAIN=coherent-web.ru`, случайными `SECRET_KEY`, паролем PostgreSQL и ключами LiveKit. Никогда не добавлять этот файл в Git.
3. Для запасного доступа по IP установить Certbot версии 5.4 или новее, например официальным snap-пакетом. Создать `/var/www/certbot/.well-known/acme-challenge` и обеспечить выдачу файлов из этого каталога по `http://31.76.77.197/.well-known/acme-challenge/`.
4. Получить сертификат:

   ```sh
   certbot certonly --non-interactive --agree-tos --register-unsafely-without-email \
     --preferred-profile shortlived --webroot --webroot-path /var/www/certbot \
     --cert-name coherent-ip --ip-address 31.76.77.197
   ```

5. Подключить `deploy/reload-caddy-after-cert-renewal.sh` как deploy hook Certbot, чтобы Caddy перечитывал сертификат, а LiveKit перезапускал TURN/TLS с новым сертификатом после успешного продления:

   ```sh
   ln -s /opt/coherent/deploy/reload-caddy-after-cert-renewal.sh \
     /etc/letsencrypt/renewal-hooks/deploy/coherent-caddy.sh
   ```

   Проверить, что таймер `snap.certbot.renew.timer` включён.
6. Запустить контейнеры из корня проекта:

   ```sh
   docker compose --env-file deploy/.env -f deploy/compose.prod.yaml up -d database redis
   docker compose --env-file deploy/.env -f deploy/compose.prod.yaml build api web monitor-bot
   docker compose --env-file deploy/.env -f deploy/compose.prod.yaml run --rm api alembic upgrade head
   docker compose --env-file deploy/.env -f deploy/compose.prod.yaml up -d
   ```

## Автоматическое обновление из GitHub

Workflow `.github/workflows/build-deploy.yml` собирает API и интерфейс при каждом пуше в `main`. Сервер раз в две минуты проверяет GitHub Actions и разворачивает только текущий коммит `main` с успешной сборкой. Он сам получает код по уже настроенному SSH deploy key, собирает образы, выполняет миграции и обновляет контейнеры. После обновления проверяет сайт, API и LiveKit по домену из `PUBLIC_DOMAIN`. Новые секреты в GitHub и входящие порты для этого не требуются. Неудачная сборка не попадает на VPS; при ошибке развёртывания служба повторит попытку на следующем проходе.

На VPS установить службу один раз из клонированного репозитория:

```sh
mkdir -p /var/lib/coherent-deploy
git -C /opt/coherent rev-parse HEAD > /var/lib/coherent-deploy/deployed-sha
install -m 700 /opt/coherent/deploy/auto-deploy.py /usr/local/sbin/coherent-auto-deploy.py
install -m 644 /opt/coherent/deploy/coherent-auto-deploy.service /etc/systemd/system/
install -m 644 /opt/coherent/deploy/coherent-auto-deploy.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now coherent-auto-deploy.timer
```

Состояние: `systemctl status coherent-auto-deploy.timer`; журнал обновлений: `journalctl -u coherent-auto-deploy.service -n 100`. При изменении самого `deploy/auto-deploy.py` скопировать новую версию в `/usr/local/sbin/` вручную. Служба намеренно использует отдельную копию скрипта, чтобы изменение кода в репозитории само по себе не меняло права развёртывания.

Скрипт `deploy/backup.sh` делает локальный дамп PostgreSQL и архив ключа Web Push с хранением семь дней. Вложения не попадают в резервные архивы: API удаляет их через три дня после отправки. Дополнительно нужны копии базы и ключа за пределами VPS и периодическая проверка восстановления.

LiveKit использует только публичный интерфейс `ens3`, чтобы не передавать клиентам внутренние адреса Docker. UDP mux использует порты 7882–7883. Встроенный TURN использует UDP 3478 и TLS 5349 с сертификатом на IP. Для сетей, разрешающих исходящий TLS только на 443, понадобится отдельный IP или TLS-мультиплексор перед Caddy и LiveKit: 443 сейчас уже занят сайтом. Docker может обходить обычные правила UFW для опубликованных контейнерных портов; внутренние сервисы нельзя публиковать на `0.0.0.0`.

Файлы чата хранятся в `data/attachments`: API закрывает к ним доступ через три дня после отправки и удаляет файлы и записи о вложениях фоновым проходом раз в минуту. Текст сообщений остаётся. Приватный ключ уведомлений хранится в `data/vapid`; оба каталога исключены из Git и монтируются только в API. Push уведомления доставляются браузером через service worker при закрытой вкладке, если пользователь разрешил уведомления и браузер поддерживает Push API. Живые события чата доставляются через WebSocket; опрос API служит редкой сверкой или запасным способом при потере соединения. При запуске более одного процесса API локальный механизм WebSocket событий потребуется заменить общей шиной Redis Pub/Sub.

Хранилище вложений ограничено 15 ГиБ суммарно для всех пользователей. Когда лимит достигнут, загрузка файлов приостанавливается для всех до удаления старых вложений и освобождения места. При загрузке API сохраняет минимум 2 ГиБ свободного места на диске; временные файлы API ограничены отдельным tmpfs 256 МиБ. Общий лимит и резерв задаются в `deploy/.env` переменными `ATTACHMENT_STORAGE_LIMIT_MB` и `ATTACHMENT_MIN_FREE_MB`. Панель состояния доступна только аккаунту из `ADMIN_USERNAME` в этом же файле; имя проверяется на сервере при каждом запросе.

Источники: [Let's Encrypt: сертификаты для IP](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability/), [Certbot: поддержка IP](https://letsencrypt.org/2026/03/11/shorter-certs-certbot/), [LiveKit: развёртывание](https://docs.livekit.io/transport/self-hosting/deployment/), [LiveKit: порты](https://docs.livekit.io/transport/self-hosting/ports-firewall/), [Docker: установка](https://docs.docker.com/engine/install/ubuntu/).
