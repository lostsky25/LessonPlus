---
name: run
description: Собирает и запускает стек LessonPlus в Docker Compose, дожидается миграций и проверяет health и статусы сервисов. Используй только при явном вызове команды /run.
disable-model-invocation: true
---

# /run

Подними учебный каркас LessonPlus и проверь, что он отвечает. Работай из корня репозитория. Commit и push не выполняй. Не удаляй тома и не вызывай `docker compose down -v`, `--renew-anon-volumes` или `docker volume rm`.

Стек: PostgreSQL 17.11, RabbitMQ 4.2.9, сервисы `subscriptions` (3001), `schedule` (3002), `attendance` (3003), `transfers` (3004), `notifications` (3005), `api-gateway` (3000) и React `web` (5173). Миграции применяет `scripts/start-service.mjs` через `prisma migrate deploy` до прослушивания порта. Начальные таблицы — только `outbox_events` и `processed_events`. Инициализация ролей в `infra/postgres/init` выполняется лишь на пустом томе `lessonplus-postgres`.

## Шаги

1. Проверь Docker и Compose. `docker info` и `docker compose version` должны завершиться с кодом 0. Если демон недоступен, остановись и напиши, что нужно запустить Docker. Не подменяй проверку фиктивным статусом.

2. Если `.env` отсутствует, создай его копированием `.env.example`. Существующий `.env` не перезаписывай и не выводи секреты в ответ.

3. Запусти весь проект командой `pnpm run run`. Она вызывает `scripts/run.mjs`: переходит в корень репозитория, выполняет `docker compose up --build --wait` с ожиданием готовности до 600 секунд и общим пределом 20 минут, сохраняет тома и затем запрашивает статусы. Повторный запуск должен оставлять данные PostgreSQL на месте. Одноразовый контейнер миграций с кодом выхода 0 не считается ошибкой. Не публикуй порты шире, чем в `compose.yaml`: наружу только `127.0.0.1`.

4. Дождись завершения этой команды. Если порт 5432 на хосте занят чужим PostgreSQL, не останавливай его. Задай в локальном `.env` другой `POSTGRES_PORT` (в документации пример — `5436`) и повтори запуск. Внутри сети Docker PostgreSQL остаётся на 5432. Файл `.env` не коммить.

5. Проверь готовность. `pnpm smoke` запрашивает `/health/live` и `/health/ready` у gateway и пяти сервисов, главную страницу и `GET /api/system/status` напрямую и через интерфейс. У бизнес-сервиса `/health/ready` обязан вернуть 503, если PostgreSQL или RabbitMQ недоступны; успешный ответ без живой зависимости недопустим. В статусе у `subscriptions`, `schedule`, `attendance`, `transfers` и `notifications` поля `live` и `ready` равны `up`.

6. При ошибке открой `docker compose logs` соответствующего сервиса и `docker compose ps --all`. Исправь дефект каркаса: конфигурацию, миграцию, порт, proxy или health. Границы этапа — в `AGENTS.md`: не добавляй CRUD, списание занятий, saga, JWT, платежи и отправку сообщений, чтобы «починить» отсутствующую функцию. После исправления снова запусти `pnpm run run` и `pnpm smoke`.

7. Сообщи результат и адреса:
   - интерфейс: http://localhost:5173
   - Swagger gateway: http://localhost:3000/docs
   - RabbitMQ Management: http://localhost:15672
   - статусы: http://localhost:3000/api/system/status

   Логин RabbitMQ берётся из `RABBITMQ_USER` и `RABBITMQ_PASSWORD` в `.env`; сами значения не цитируй. Если проверка не прошла, так и напиши: какой шаг упал и что осталось неработающим.
