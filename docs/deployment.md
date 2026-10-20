# Развёртывание Coherent на VPS

## Адреса и схема

```text
https://31.76.77.197       ──► Caddy ──► интерфейс и /api/* ──► FastAPI ──► PostgreSQL
wss://31.76.77.197:8443    ──► Caddy ──► LiveKit
браузеры ──WebRTC/UDP или TCP────────► LiveKit ──► Redis
```

Все сервисы работают на финском VPS. Собственный домен пока не требуется. Для браузерного доступа к камере и микрофону сайт открывается по HTTPS с сертификатом Let's Encrypt для публичного IP. Он действует около шести дней, поэтому автоматическое продление обязательно. Домен `coherent-web.ru` пока не меняем.

В production используются отдельные случайные ключи LiveKit и Redis. Локальный `compose.yaml` запускает LiveKit в режиме разработки с известными ключами; его нельзя выставлять в интернет. API пока запускается одним процессом Uvicorn, поскольку уведомления чата хранятся в памяти процесса.

## Первый запуск

1. Установить Docker Engine и Compose plugin, настроить SSH и брандмауэр. Открыть 80, 443 и 8443 TCP, 7881 TCP, 7882–7883 UDP. Порты PostgreSQL, Redis, API и LiveKit 7880 публично не открывать.
2. Клонировать репозиторий на VPS, создать закрытый `deploy/.env` по образцу `deploy/.env.example` со случайными `SECRET_KEY`, паролем PostgreSQL и ключами LiveKit. Никогда не добавлять этот файл в Git.
3. Установить Certbot версии 5.4 или новее, например официальным snap-пакетом. Создать `/var/www/certbot/.well-known/acme-challenge` и обеспечить выдачу файлов из этого каталога по `http://31.76.77.197/.well-known/acme-challenge/`.
4. Получить сертификат:

   ```sh
   certbot certonly --non-interactive --agree-tos --register-unsafely-without-email \
     --preferred-profile shortlived --webroot --webroot-path /var/www/certbot \
     --cert-name coherent-ip --ip-address 31.76.77.197
   ```

5. Подключить `deploy/reload-caddy-after-cert-renewal.sh` как deploy hook Certbot, чтобы Caddy перечитывал сертификат после успешного продления:

   ```sh
   ln -s /opt/coherent/deploy/reload-caddy-after-cert-renewal.sh \
     /etc/letsencrypt/renewal-hooks/deploy/coherent-caddy.sh
   ```

   Проверить, что таймер `snap.certbot.renew.timer` включён.
6. Запустить контейнеры из корня проекта:

   ```sh
   docker compose --env-file deploy/.env -f deploy/compose.prod.yaml up -d database redis
   docker compose --env-file deploy/.env -f deploy/compose.prod.yaml build api web
   docker compose --env-file deploy/.env -f deploy/compose.prod.yaml run --rm api alembic upgrade head
   docker compose --env-file deploy/.env -f deploy/compose.prod.yaml up -d
   ```

## Обновления и резервные копии

Получить новый код через SSH и `git pull --ff-only`, собрать образы, выполнить миграции и повторить `up -d`. Скрипт `deploy/backup.sh` делает локальный дамп PostgreSQL с хранением семь дней. Дополнительно нужны копии за пределами VPS и периодическая проверка восстановления.

LiveKit использует только публичный интерфейс `ens3`, чтобы не передавать клиентам внутренние адреса Docker. UDP mux использует порты 7882–7883. Если у пользователей со строгой сетью WebRTC не соединяется, потребуется отдельная настройка TURN/TLS. Docker может обходить обычные правила UFW для опубликованных контейнерных портов; внутренние сервисы нельзя публиковать на `0.0.0.0`.

Источники: [Let's Encrypt: сертификаты для IP](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability/), [Certbot: поддержка IP](https://letsencrypt.org/2026/03/11/shorter-certs-certbot/), [LiveKit: развёртывание](https://docs.livekit.io/transport/self-hosting/deployment/), [LiveKit: порты](https://docs.livekit.io/transport/self-hosting/ports-firewall/), [Docker: установка](https://docs.docker.com/engine/install/ubuntu/).
