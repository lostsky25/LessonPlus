# Система учёта абонементов и переносов занятий

Учебный каркас: React-интерфейс, API gateway и пять сервисов NestJS. У каждого сервиса своя схема PostgreSQL и общее подключение к RabbitMQ. Бизнес-сценарии абонементов, посещений и переносов на этом этапе ещё не реализованы.

Границы сервисов, глоссарий, каталог событий, схемы C4, взаимодействия, владение данными, изоляция хранения, модель данных, запросы и индексы, транзакции и согласованность, резервное копирование и восстановление, масштабирование хранения, контракты операций и событий: [docs/architecture.md](docs/architecture.md).

Среда выполнения — Node.js 24 LTS. Образ приложений: `node:24.20.0-bookworm-slim`. Менеджер пакетов зафиксирован в `packageManager`: pnpm `10.34.5`.

## Первый запуск

Короткий запуск из любой директории: `pnpm run run`. На Windows из корня проекта также работают `run` и `.\run.cmd`. Команда сама создаёт `.env`, поднимает стек и проверяет статусы. Подробности — в разделе «Команды run и push».

Ручной запуск из корня репозитория:

```text
node scripts/init-env.mjs
docker compose up --build
```

`init-env` создаёт `.env` из `.env.example`, если файла ещё нет. Compose поднимает PostgreSQL, RabbitMQ, пять сервисов, gateway и интерфейс. При старте каждый сервис применяет свои миграции.

Проверка после запуска:

```text
node scripts/smoke.mjs
```

Та же команда доступна как `pnpm smoke` после `pnpm install`.

Остановка:

```text
docker compose down
```

Полный сброс базы, включая роли и схемы:

```text
docker compose down -v
```

Скрипт инициализации PostgreSQL выполняется только на пустом томе.

## Команды run и push

```text
pnpm run run
pnpm run push "Описание изменений"
```

Из корня проекта в CMD: `run` и `push "Описание изменений"`. В PowerShell: `.\run.cmd` и `.\push.cmd "Описание изменений"`.

`pnpm run run` переходит в корень репозитория, проверяет Docker и Compose, создаёт `.env` из `.env.example`, если файла нет, и запускает `docker compose up --build --wait`. Ожидание готовности ограничено 600 секундами, весь запуск — 20 минутами. Команда не удаляет тома: повторный запуск сохраняет данные PostgreSQL. Одноразовый контейнер миграций, завершившийся с кодом 0, не считается сбоем. После готовности запрашивается `http://127.0.0.1:3000/api/system/status`.

`pnpm run push` сначала выполняет `typecheck`, `lint` и `build`. При ошибке commit и push не начинаются. Затем создаётся commit с текстом из аргумента. Без аргумента сообщение — `chore: update LessonPlus`. Если изменений нет, пустой commit не создаётся, но уже существующие локальные коммиты отправляются. Отправка идёт обычным push в `git@github.com:lostsky25/LessonPlus.git`. Если upstream ещё нет, он назначается при первой отправке. Force push и переписывание истории не используются.

В чате Cursor Agent:

```text
/run
/push
/push feat: add subscriptions page
```

`/run` собирает стек, ждёт миграции и проверяет health и статусы. `/push` проверяет проект, создаёт commit и отправляет текущую ветку. Текст после `/push` становится сообщением commit; без текста агент составляет его по изменениям.

## Адреса

| Что                  | URL                                     |
| -------------------- | --------------------------------------- |
| Интерфейс            | http://localhost:5173                   |
| Gateway, Swagger     | http://localhost:3000/docs              |
| Статусы сервисов     | http://localhost:3000/api/system/status |
| Абонементы, Swagger  | http://localhost:3001/docs              |
| Расписание, Swagger  | http://localhost:3002/docs              |
| Посещения, Swagger   | http://localhost:3003/docs              |
| Переносы, Swagger    | http://localhost:3004/docs              |
| Уведомления, Swagger | http://localhost:3005/docs              |
| RabbitMQ Management  | http://localhost:15672                  |

Логин RabbitMQ берётся из `RABBITMQ_USER` и `RABBITMQ_PASSWORD`.

## Локальная разработка без контейнеров приложений

Нужны установленные Node.js 24 и pnpm 10.34.5. Базу и брокер можно оставить в Docker:

```text
node scripts/init-env.mjs
pnpm install
docker compose up postgres rabbitmq
pnpm db:migrate
pnpm dev
```

`pnpm db:generate` создаёт Prisma Client каждого сервиса в его `src/generated`. `pnpm build` и `pnpm typecheck` вызывают генерацию сами. `pnpm dev` тоже сначала генерирует клиент и собирает общие пакеты.

Другие команды:

```text
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

`pnpm test` запускает Jest. Тестов бизнес-логики на этом этапе нет, поэтому команда завершается успешно без проверок.

## Переменные окружения

Файл `.env.example` содержит локальные учебные значения.

Приложения на хосте читают адреса `localhost`:

- `SUBSCRIPTIONS_DATABASE_URL`, `SCHEDULE_DATABASE_URL`, `ATTENDANCE_DATABASE_URL`, `TRANSFERS_DATABASE_URL`, `NOTIFICATIONS_DATABASE_URL` — строки подключения сервисных ролей;
- `RABBITMQ_URL` — брокер на `localhost:5672`;
- `SUBSCRIPTIONS_URL` … `NOTIFICATIONS_URL` — адреса сервисов для gateway;
- `API_PROXY_TARGET` — куда Vite на хосте проксирует `/api` (`http://localhost:3000`).

Docker Compose не использует эти хостовые URL для процессов в контейнерах. Он задаёт `DATABASE_URL` с хостом `postgres`, `RABBITMQ_URL` с хостом `rabbitmq`, URL сервисов по именам контейнеров и `API_PROXY_TARGET=http://api-gateway:3000`.

`POSTGRES_USER` нужен только контейнеру PostgreSQL для создания ролей и схем. Работающие сервисы подключаются ролями `subscriptions_user`, `schedule_user`, `attendance_user`, `transfers_user` и `notifications_user`.

Пароли ролей (`SUBSCRIPTIONS_DB_PASSWORD` и остальные) должны совпадать с паролями в URL. Их читает скрипт `infra/postgres/init/001-roles.sh` при первом создании тома.

## Миграции

1. Контейнер PostgreSQL создаёт базу, пять схем и пять ролей.
2. Каждый сервис выполняет `prisma migrate deploy` для своей схемы.
3. Начальная миграция создаёт только `outbox_events` и `processed_events`.

На хосте тот же шаг запускается командой `pnpm db:migrate`, когда PostgreSQL уже доступен на `localhost:5432`.

Команды Prisma нужно запускать через пакетные сценарии. Они читают корневой `.env` и переменную вида `SUBSCRIPTIONS_DATABASE_URL`, если `DATABASE_URL` не задана.

## Порты

| Процесс             | Порт  |
| ------------------- | ----- |
| web                 | 5173  |
| api-gateway         | 3000  |
| subscriptions       | 3001  |
| schedule            | 3002  |
| attendance          | 3003  |
| transfers           | 3004  |
| notifications       | 3005  |
| PostgreSQL          | 5432  |
| RabbitMQ            | 5672  |
| RabbitMQ Management | 15672 |

Наружу порты опубликованы только на `127.0.0.1`. Если на хосте уже занят порт 5432, задайте другой внешний порт: `POSTGRES_PORT=5436 docker compose up --build`. Внутри Docker-сети PostgreSQL по-прежнему слушает 5432. Для `pnpm dev` на хосте тогда нужно поменять порт и в URL баз.
