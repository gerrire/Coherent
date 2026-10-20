# Развёртывание Coherent на одном VPS

## Схема первого публичного запуска

```text
31-76-77-197.sslip.io ──HTTPS──► Caddy ──► статический интерфейс
                                       └── /api/* ──► FastAPI ──► PostgreSQL
media.31-76-77-197.sslip.io ──WSS──► Caddy ──► LiveKit
браузеры ──WebRTC/UDP или TCP────────► LiveKit
LiveKit ──────────────────────────────► Redis
```

Все сервисы работают на финском VPS. Российский сервер для первого запуска не нужен. Docker Compose управляет сервисами и их перезапуском. PostgreSQL и Redis доступны только внутри сервера; порт API и сигнальный порт LiveKit также не открыты напрямую в интернет. Caddy обслуживает HTTPS и проксирует WebSocket.

Для звонков на одном VPS используем LiveKit с отдельным production-конфигом и собственными ключами. Локальный `compose.yaml` запускает его с `--dev` и известными ключами `devkey`/`secret`; этот режим нельзя выставлять в интернет. Для production LiveKit рекомендует Redis и сетевой режим host для Docker.

## До установки

1. Узнать публичный IPv4, версию Ubuntu, число vCPU, объём RAM/диска и лимит трафика VPS. Оценка для небольшого закрытого запуска: 2 vCPU и 4 ГБ RAM; при нескольких одновременных видеозвонках и демонстрациях экрана лучше начинать с 4 vCPU и 8 ГБ. Окончательный размер определим по нагрузке и использованной полосе.
2. Для временного запуска использовать адреса `31-76-77-197.sslip.io` и `media.31-76-77-197.sslip.io`: сервис sslip.io автоматически направляет их на IPv4 VPS. Домен `coherent-web.ru` пока не менять. Обычный HTTP-запрос на `31.76.77.197` перенаправлять на защищённый адрес сайта, поскольку браузеру нужен доверенный HTTPS для камеры и микрофона.
3. Настроить вход по SSH-ключу и резервный способ попасть в VPS через панель провайдера. Секреты и приватный SSH-ключ не отправлять в чат и не класть в Git.

## Порядок развёртывания

1. Обновить Ubuntu, установить Docker Engine и Compose plugin из официального репозитория Docker, настроить SSH и брандмауэр.
2. Подготовить отдельные production-файлы Compose, Caddy и LiveKit. Собрать фронтенд в статические файлы, API — в контейнер Python. Добавить постоянные тома для PostgreSQL, Redis при необходимости и сертификатов Caddy.
3. На VPS создать закрытый `deploy/.env` со случайными `SECRET_KEY`, паролем PostgreSQL, `LIVEKIT_API_KEY` и `LIVEKIT_API_SECRET`. Для API выставить `APP_ENV=production`, `COOKIE_SECURE=true`, `CORS_ORIGINS=["https://31-76-77-197.sslip.io"]` и `LIVEKIT_URL=wss://media.31-76-77-197.sslip.io`. Ключи LiveKit должны совпадать в API и LiveKit.
4. Запустить PostgreSQL и Redis, выполнить `alembic upgrade head`, затем запустить API, LiveKit и Caddy. Пока уведомления чата хранятся в памяти API, запускать один процесс Uvicorn; несколько процессов потребуют общей шины событий.
5. Проверить выдачу сертификатов, вход и регистрацию, чат, звонок между двумя разными сетями, камеру, звук и показ экрана. Смотреть качество звонка и использование CPU/памяти/сети на VPS.
6. Настроить ежедневные копии PostgreSQL вне VPS, периодически проверять восстановление, затем обновлять приложение через SSH и Git с повторной миграцией базы перед запуском новой версии API.

## Команды для первого запуска и обновлений

Файлы production-развёртывания находятся в `deploy/`. Секретный `deploy/.env` создаётся только на VPS по образцу `deploy/.env.example`. Все команды ниже выполняются из корня проекта на VPS:

```sh
docker compose --env-file deploy/.env -f deploy/compose.prod.yaml up -d database redis
docker compose --env-file deploy/.env -f deploy/compose.prod.yaml build api web
docker compose --env-file deploy/.env -f deploy/compose.prod.yaml run --rm api alembic upgrade head
docker compose --env-file deploy/.env -f deploy/compose.prod.yaml up -d
```

При обновлении сначала получить новый код через `git pull --ff-only`, собрать обновлённые образы, выполнить миграции и повторить `up -d`. Скрипт `deploy/backup.sh` делает локальный дамп PostgreSQL и хранит его семь дней. Он помогает восстановиться после ошибочного изменения, но копии вне VPS всё равно обязательны для защиты от потери сервера.

## Сеть

Для первого запуска с LiveKit UDP mux открыть 80/443 TCP для сайта и сертификатов, 7881 TCP как резервный транспорт WebRTC и 7882 UDP для медиатрафика. Порт SSH оставить открытым только для администрирования, желательно ограничить доверенными адресами через брандмауэр провайдера. Порты PostgreSQL 5432, Redis 6379, API 8000 и LiveKit 7880 публично не открывать. Правила VPS и брандмауэра провайдера должны совпадать. Docker может обходить обычные правила UFW для опубликованных контейнерных портов, поэтому внутренние сервисы не следует публиковать на `0.0.0.0`.

UDP mux позволяет использовать один порт вместо диапазона 50000–60000 UDP. Если у части пользователей соединение не установится из-за строгих корпоративных сетей, следующим шагом добавим TURN/TLS. На одном IP порт 443 уже занят HTTPS, поэтому для TURN/TLS понадобится продуманное разделение TLS-трафика или отдельный адрес; просто открыть 5349 TCP недостаточно для конфигурации LiveKit без балансировщика.

Временные адреса sslip.io зависят от стороннего DNS-сервиса. При переходе на свой домен меняем `SITE_HOST` и `MEDIA_HOST` в `deploy/.env`, обновляем Caddy и API, затем проверяем сертификаты и вход заново.

Источники: [LiveKit: production-конфигурация](https://docs.livekit.io/transport/self-hosting/deployment/), [LiveKit: порты и firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/), [Docker: установка на Ubuntu](https://docs.docker.com/engine/install/ubuntu/), [Docker: ограничения UFW](https://docs.docker.com/engine/install/ubuntu/#firewall-limitations), [Caddy: автоматический HTTPS](https://caddyserver.com/docs/automatic-https), [sslip.io: адреса с IP](https://nip.io/).
