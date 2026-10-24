# Хранение и изоляция

Шаг 6.2 архитектуры хранения. Владение сущностями — [01-data-ownership.md](01-data-ownership.md). Этот документ описывает выбранное хранение и проверяемую модель доступа. Прав роли, схем и рабочих баз здесь не меняются. SQL ниже — инструкции с ожидаемым результатом, не отчёт о выполнении. Каталог живой базы в этом шаге **не читался**.

Пароли, URL с паролем и учебные значения из `.env` / `.env.example` в документ не входят. Имена ролей, схем, переменных и образов — из репозитория.

Каталога ADR в репозитории нет; отдельный файл решения не заводился. Проектируемые таблицы и ER — в [03-data-model.md](03-data-model.md); к рабочей базе они не применялись. Показательные SELECT и индексы — [04-queries-and-indexes.md](04-queries-and-indexes.md). Транзакции — [05-transactions-and-consistency.md](05-transactions-and-consistency.md).

Пометки: **существует** — есть в Compose, init, Prisma; **проектируется** — бизнес-таблицы и блокировки сценариев; **не проверено на живой базе** — ожидание по тексту скриптов.

## Зачем PostgreSQL

Прототип уже выбрал SQL-владельца на сервис, транзакцию outbox вместе с изменением агрегата, внешние ключи **внутри** схемы и запросы по UUID. PostgreSQL закрывает эту совокупность одним движком, без отдельного кластера на сервис.

| Потребность | Зачем в этом проекте | Как закрывает PostgreSQL |
| ----------- | -------------------- | ------------------------ |
| Транзакции | Право, резерв права и строка `outbox_events` фиксируются вместе. Списание присутствия — один раз на `(rightId, bookingId)` | `BEGIN`/`COMMIT` в схеме владельца. Чужую схему в ту же транзакцию не включают |
| Целостность одной таблицы | Остаток права не отрицательный; одна действующая привязка; `processed_events.id` уникален | `PRIMARY KEY`, `UNIQUE`, `CHECK` на **строке своей** таблицы, когда появятся бизнес-таблицы. Это **проектируется** |
| Вместимость | `confirmed + active reservations <= capacity` | Сумма строк **двух** таблиц. Обычные `CHECK`/`UNIQUE` её не считают. Нужна транзакция владельца места и согласованная блокировка занятия или атомарный счётчик. Детали — будущее проектирование, не реализация |
| Связи внутри сервиса | Абонемент → права; занятие → записи и резервы места; заявка → шаги координатора | FK **внутри** схемы владельца. FK на чужую схему запрещены шагом 6.1 |
| Конкуренция | Перенос и списание одного `rightId`; два резерва одного места | Транзакция владельца плюс блокировка строки или атомарный счётчик. Не `SELECT` из соседней схемы. Алгоритм замка **проектируется** |
| Предсказуемые запросы | GET по UUID, курсорные списки OpenAPI | Индексы по ключам и фильтрам владельца |

RabbitMQ — не источник истины остатка и мест. Отдельный документный движок не запрещён уникальным составным индексом (например, unique compound index в MongoDB); он просто не является выбранным SQL-контуром с FK внутри владельца и транзакцией outbox.

Масштаб — учебный прототип. Выбраны **один экземпляр** `postgres:17.11` и **логическая изоляция** пяти схем. Пять кластеров не требуются: нагрузка и отказоустойчивость боевого контура не заданы.

## Три топологии

[Managing Databases](https://www.postgresql.org/docs/17/manage-ag-overview.html): кластер — это набор баз, которыми управляет **один** экземпляр сервера. Базы одного кластера разделяют процессы, WAL и обычно диск и суперпользователя.

| Топология | Что разделяется | Что изолируется | Для LessonPlus |
| --------- | --------------- | --------------- | -------------- |
| А. Схемы одной базы | Экземпляр, WAL, диск, суперпользователь, база | Объекты по `USAGE`/`AUTHORIZATION` схемы и роли | **Выбрано.** Пять схем в одной базе |
| Б. Разные базы одного кластера | Экземпляр, процессы, WAL, диск, суперпользователь | Каталог объектов базы: суперпользователь базы A не равен «другому кластеру». Роли кластера общие | Не выбрано. Пять баз **не** дают независимых процессов, WAL, диска и суперпользователя |
| В. Разные экземпляры / кластеры | Ничего, если разнесены | Процессы и WAL каждого экземпляра | Не выбрано. Независимость отказа ещё зависит от **разных хостов и дисков**: два контейнера на одном томе падают вместе |

Выбран вариант А. Достоинства: один том и один healthcheck; миграции и `SELECT 1` просты; запрет чужого SQL проверяется привилегиями; сервисы не суперпользователи.

Ограничения А: общая точка отказа экземпляра; общая память и WAL; ошибка `GRANT` или чужая роль открывает логический доступ. Вариант В на разных хостах закрыл бы отказ экземпляра, но не нужен прототипу. Вариант Б не следует называть физической независимостью.

`POSTGRES_USER` образа — суперпользователь кластера и видит все схемы выбранной базы. Приложениям его не выдают.

## Топология в репозитории

**Существует.** Совпадает с `compose.yaml`, `infra/postgres/init/001-roles.sh` и C4.

| Элемент | Факт из репозитория |
| ------- | ------------------- |
| Экземпляр | Один сервис Compose `postgres`, образ `postgres:17.11`, том `lessonplus-postgres` |
| Имя базы | **Расхождение.** `${POSTGRES_DB}` задаёт контейнер, `001-roles.sh` и `pg_isready -d ${POSTGRES_DB}`. Пять `DATABASE_URL` в `compose.yaml` и `psql -d` в `scripts/smoke.mjs` жёстко указывают имя `lessonplus`. При другом `POSTGRES_DB` init/healthcheck и подключения приложений/smoke могут разойтись |
| Схемы | `subscriptions`, `schedule`, `attendance`, `transfers`, `notifications` |
| Роли приложений | `subscriptions_user`, `schedule_user`, `attendance_user`, `transfers_user`, `notifications_user` — `LOGIN`, без `SUPERUSER` в тексте скрипта |
| Роль инициализации | `${POSTGRES_USER}` у контейнера. Сервисам не выдаётся. Healthcheck: `pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}` |
| Prisma | Пять каталогов `services/*/prisma`, пять `prisma.config.ts`, пять клиентов в `src/generated/prisma`. В `datasource` только своя схема |
| Миграции | `20261007120000_init` создаёт в своей схеме `outbox_events` и `processed_events`. `scripts/start-service.mjs` вызывает `prisma migrate deploy` |
| Подключение в Compose | Роль сервиса, хост `postgres`, порт **внутри сети** всегда 5432. Имя базы в URL зашито как `lessonplus` (см. расхождение выше) |
| Подключение на хосте | `*_DATABASE_URL` — отдельные строки. `POSTGRES_PORT` меняет только опубликованный порт `127.0.0.1:${POSTGRES_PORT:-5432}:5432`. Автоподстановки порта в URL нет: при смене `POSTGRES_PORT` URL на хосте правят вручную, как в README |
| `search_path` | Init: `ALTER ROLE … SET search_path TO <своя схема>` (это `rolconfig`). Процесс Prisma ещё передаёт `-c search_path=${config.schema}`. `rolconfig` **не** доказывает эффективный путь всех сессий |
| Gateway | В `loadGatewayConfig` только HTTP URL. Строки подключения к базе нет |
| Браузер / React | `apps/web`, порт 5173, proxy `/api` → `API_PROXY_TARGET`. Имён контейнеров PostgreSQL в браузере нет |

Init-скрипт выполняется **только на пустом томе**. Повторный `compose up` существующий том не переигрывает.

Аутентификация внутри контейнера (`pg_hba.conf` тома) в этом шаге **не проверена**. Не утверждается trust, peer или иной метод. Инструкции SQL не обходят проверку подлинности и не содержат секретов.

## Матрица доступа

Источники: `001-roles.sh`, Prisma schema, Compose, `packages/config`. **Не проверено на живой базе.**

Скрипт на каждую сервисную роль:

1. `CREATE ROLE <role> LOGIN PASSWORD '…'` — без `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION` в тексте.
2. `CREATE SCHEMA <schema> AUTHORIZATION <role>` — роль **владелец схемы** ([Privileges](https://www.postgresql.org/docs/17/ddl-priv.html)): `USAGE` и `CREATE` на схему, право выдавать привилегии на схему. Это **не** DML на любой объект внутри: таблицу владеет роль, которая её создала.
3. `REVOKE ALL ON SCHEMA <schema> FROM PUBLIC`.
4. `GRANT CONNECT ON DATABASE "${POSTGRES_DB}" TO <role>`.
5. `ALTER ROLE <role> SET search_path TO <schema>`.

Отдельно, один раз:

- `REVOKE ALL ON DATABASE "${POSTGRES_DB}" FROM PUBLIC`
- `REVOKE ALL ON SCHEMA public FROM PUBLIC`

Других `GRANT`/`REVOKE`/`ALTER DEFAULT PRIVILEGES` в репозитории нет.

Владение таблицей возникает у **роли миграции**, которая выполнила `CREATE TABLE`. Сейчас это та же сервисная роль, поэтому после init-миграции она же владеет `outbox_events` и `processed_events`. Чужой объект в «своей» схеме без `GRANT` DML не получает.

| Субъект | Своя схема | Чужие сервисные схемы | База (имя по `POSTGRES_DB` / URL) | Схема `public` | Служебное |
| ------- | ---------- | --------------------- | --------------------------------- | -------------- | --------- |
| Пять `*_user` | Владелец схемы; DML на объекты, которые эта роль создала | Явных `GRANT` нет. `USAGE` на чужую схему — самостоятельный барьер | Только `CONNECT`. `CREATE`/`TEMP` на базу текстом не выдавались | `REVOKE ALL FROM PUBLIC`; явного `GRANT` роли нет | `prisma migrate deploy` и runtime |
| `${POSTGRES_USER}` | Суперпользователь кластера | Видит все схемы выбранной базы | Инициализация | Служебные объекты образа | Init тома, `pg_isready` |
| `PUBLIC` | Нет прав на сервисные схемы | Нет | `REVOKE ALL`: нет `CONNECT`/`TEMP`/`CREATE` | `REVOKE ALL`, в том числе `CREATE` | — |
| `api-gateway` | Нет роли PostgreSQL | Нет | Нет | Нет | HTTP к сервисам |
| `apps/web` | Нет | Нет | Нет | Нет | HTTP `/api` через proxy |

Ожидаемая матрица `USAGE` (логика скрипта, **не снято с живой базы**):

| Роль ↓ \ схема → | subscriptions | schedule | attendance | transfers | notifications | public |
| ---------------- | ------------- | -------- | ---------- | --------- | ------------- | ------ |
| `subscriptions_user` | да (владелец схемы) | нет | нет | нет | нет | нет |
| `schedule_user` | нет | да | нет | нет | нет | нет |
| `attendance_user` | нет | нет | да | нет | нет | нет |
| `transfers_user` | нет | нет | нет | да | нет | нет |
| `notifications_user` | нет | нет | нет | нет | да | нет |

Чужой `SELECT` должен получать `permission denied for schema …`, даже если `search_path` указать на чужое имя: смена пути не есть `GRANT`. Запрет `USAGE` чужой схемы — отдельный барьер, его не заменяют default ACL и права на типы/функции.

### Встроенные права PUBLIC и `pg_default_acl`

Пустой `pg_default_acl` **не** означает, что у `PUBLIC` нет встроенных прав. Каталог хранит только переопределения при **создании** объекта ([pg_default_acl](https://www.postgresql.org/docs/17/catalog-pg-default-acl.html)). Жёстко заданные умолчания PostgreSQL для уже существующих объектов живут в ACL объекта (NULL ACL = hard-wired default, не снимок `pg_default_acl`).

По [ddl-priv](https://www.postgresql.org/docs/17/ddl-priv.html) для новых функций/процедур `PUBLIC` обычно получает `EXECUTE`, для типов — `USAGE`. Таблицы по умолчанию `PUBLIC` не читает. Когда в схемах появятся функции, процедуры или типы, их ACL нужно проверить отдельно. Это не открывает чужие таблицы, пока нет `USAGE` на чужую схему.

Записи `pg_default_acl`: глобальные (`defaclnamespace = 0`) и на схему. Глобальная строка **переопределяет** hard-wired default для объектов этой роли; схема **добавляется** к глобальному или hard-wired. Запрос обязан видеть оба вида (LEFT JOIN, не отбрасывать `0`).

### Что требует проверки на живой базе

1. `rolsuper`, `rolcreatedb`, `rolcreaterole` пяти ролей (скрипт флаги не ставит; smoke при запуске стека проверяет только `subscriptions_user.rolsuper = false`).
2. Полная матрица `has_schema_privilege` 5×5 плюс `public`. Smoke — одна пара `subscriptions`/`schedule` и `SELECT` своей `outbox_events`.
3. `TEMP` после `REVOKE ALL ON DATABASE … FROM PUBLIC` и `GRANT CONNECT`: ожидание **`false`**. `true` — расхождение ACL, членства в роли с `TEMP` или старого тома, не «нормальное умолчание образа».
4. `pg_default_acl`: глобальные строки (`defaclnamespace = 0`) и строки своих схем для пяти ролей-создателей.
5. `SELECT`/`INSERT`/`UPDATE`/`DELETE` на обе технические таблицы каждой схемы для пяти ролей (`has_table_privilege` по OID вместе с `has_schema_privilege`, без изменения строк).
6. `PUBLIC`: `CONNECT`/`TEMP`/`CREATE` на базу и `USAGE`/`CREATE` на сервисные схемы и `public`.
7. Эффективный `search_path` сессии (`current_setting`, `current_schemas(true)`), отдельно от `rolconfig`.
8. `pg_hba.conf` тома — метод аутентификации **не проверен**.
9. Расхождение тома: init не повторяется.

`scripts/smoke.mjs` — узкая операционная проверка стека, не выполнение шага 6.2.

## Миграции и права приложения

Текущая модель: **одна роль на сервис** и для `prisma migrate deploy`, и для NestJS. Это осознанный компромисс прототипа, конфигурация не меняется.

| Кто | Минимальные потребности | Сейчас |
| --- | ----------------------- | ------ |
| Runtime | `CONNECT`; `USAGE` своей схемы; DML на свои таблицы; при появлении — права на свои sequences | Та же роль, потому что она создала таблицы |
| Мигратор | DDL в своей схеме (`CREATE` на схему), владение создаваемыми объектами, история `_prisma_migrations` в своей схеме | Та же роль: владелец схемы по `AUTHORIZATION` |

`AUTHORIZATION` не подменяет `GRANT` DML на объекты, которые создала другая роль. Разделение мигратор/приложение потребовало бы второй роли и `ALTER DEFAULT PRIVILEGES`; в Compose один `DATABASE_URL`. Противоречия с AGENTS.md нет: сервисы не суперпользователи и не мигрируют чужую схему.

Порядок будущих миграций (без смены ролей):

1. Меняют Prisma schema **одного** сервиса. Чужую схему в `datasource.schemas` не добавляют.
2. Каталог SQL — `services/<сервис>/prisma/migrations/`. `migration_lock.toml`: `provider = "postgresql"`.
3. На пустом томе сначала init ролей, потом deploy.
4. Deploy выполняет роль сервиса, не `${POSTGRES_USER}`.
5. FK и `UNIQUE` — внутри схемы владельца, когда появятся бизнес-таблицы (**проектируется**).

Не делать: migrate суперпользователем «на все схемы»; `GRANT USAGE` на чужую схему «чтобы JOIN заработал».

## Внешние идентификаторы без JOIN

Согласовано с 6.1. Физически таблицы в одном экземпляре; логически чужая строка недоступна без `USAGE`.

- Ссылка — UUID в поле потребителя. Это не `REFERENCES other_schema.table`.
- Согласование — HTTP владельца или факт каталога (`event_id` в `processed_events` получателя).
- Локальная проекция — идентификатор или поле процесса, не копия агрегата.
- SQL `JOIN` двух сервисных схем, представление над двумя схемами и `USAGE` на чужую схему запрещены.

Проверка формы UUID и существования карточки ученика разделены: карточку знает только `subscriptions`; Student GET в контрактах нет.

### Gateway и React

Интерфейс и gateway **не** подключаются к PostgreSQL и **не** делают SQL JOIN.

| Клиент | Как получает данные |
| ------ | ------------------- |
| Браузер | `http://127.0.0.1:5173`, страница и `/api` |
| Vite / preview | proxy `/api` → `API_PROXY_TARGET` |
| `api-gateway` | HTTP к `SUBSCRIPTIONS_URL` … `NOTIFICATIONS_URL`. Сейчас health и статусы; `/api/v1` — проект OpenAPI |
| Бизнес-сервис | Своя роль и схема. Сосед — HTTP `/internal/v1` или событие |

Чтение и композиция ответов **через API** допустимы по контрактам (отдельные ресурсы `Booking` и `LessonRight`). Gateway не выводит согласованный бизнес-успех из несогласованных снимков: подтверждённое место без подтверждённой привязки не есть успешная запись. Источник истины привязки — `subscriptions`. Запрет SQL JOIN схем этим не расширяется на любой HTTP-свод.

## Согласование с матрицей владения

| 6.1 | 6.2 |
| --- | --- |
| Владелец пишет только свою схему | Роль владеет схемой; таблицы — у роли, которая их создала |
| Нет FK/JOIN через схемы | Нет `GRANT USAGE` на чужие схемы в init |
| Gateway без базы | Compose и `loadGatewayConfig` |
| Пять Prisma-каталогов | Пять `schema.prisma` и миграций |
| Проекции — UUID | Одна физическая база это не отменяет |

## Расхождения проекта и конфигурации

Не закрываются сменой прав в этом шаге.

1. **Топология А, не кластеры.** Изоляция логическая (схемы одной базы). Пять баз одного кластера не были бы независимыми экземплярами.
2. **Имя базы.** `POSTGRES_DB` параметризует init и healthcheck; приложения Compose и smoke зашивают `lessonplus`.
3. **Порт на хосте.** `POSTGRES_PORT` не подставляется в `*_DATABASE_URL`.
4. **Объединённая роль.** Runtime имеет DDL своей схемы. Компромисс прототипа.
5. **Узкая автопроверка.** Smoke: одна пара схем, одно `rolsuper`, жёсткие `-U lessonplus_admin` и `-d lessonplus`.
6. **Init только на пустом томе.** ACL старого тома могут не совпасть со скриптом.
7. **`TEMP`.** Ожидание `false`; `true` — расхождение, не норма.
8. **Бизнес-таблиц нет.** Вместимость и гонки права **проектируются**. В БД — технические таблицы и `_prisma_migrations`.

## Инструкции SQL (не выполнялись в шаге 6.2)

Каталожные проверки (1–6, 8, 10): подключаться ролью `${POSTGRES_USER}` к **той базе, которую реально слушает экземпляр**. Если `POSTGRES_DB` и зашитое `lessonplus` разошлись, сначала выяснить имя (`SHOW data_directory` здесь не заменяет: смотреть `current_database()` после входа в предполагаемую базу). Не вставлять пароли в команды документации. Метод в `pg_hba.conf` **не проверен** — использовать штатное подключение стека, без обхода аутентификации.

Проверки текущей сервисной сессии (7, 9): отдельное подключение каждой из пяти ролей `*_user` к той же базе.

Ожидания — по тексту `001-roles.sh` и владению объектами init-миграции. Статус: **не проверено на живой базе**.

### 1. Роли не суперпользователи и без `CREATEDB`

Каталог, `${POSTGRES_USER}`, база экземпляра.

```sql
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin
FROM pg_roles
WHERE rolname IN (
  'subscriptions_user', 'schedule_user', 'attendance_user',
  'transfers_user', 'notifications_user'
)
ORDER BY 1;
```

Ожидание: `rolsuper`/`rolcreatedb`/`rolcreaterole`/`rolreplication` = `f`, `rolcanlogin` = `t`.

### 2. Владелец схемы и `rolconfig` (не эффективный path)

Каталог, `${POSTGRES_USER}`.

```sql
SELECT n.nspname, pg_get_userbyid(n.nspowner) AS owner
FROM pg_namespace n
WHERE n.nspname IN ('subscriptions', 'schedule', 'attendance', 'transfers', 'notifications')
ORDER BY 1;

SELECT rolname, rolconfig
FROM pg_roles
WHERE rolname IN (
  'subscriptions_user', 'schedule_user', 'attendance_user',
  'transfers_user', 'notifications_user'
)
ORDER BY 1;
```

Ожидание: владелец схемы = роль сервиса; в `rolconfig` есть `search_path=<своя схема>`. Это настройка роли при входе, если сессия её не переопределила. Эффективный путь — запрос 7.

### 3. Матрица `USAGE` / `CREATE` схем

Каталог, `${POSTGRES_USER}`.

```sql
SELECT r.rolname,
       n.nspname,
       has_schema_privilege(r.rolname, n.nspname, 'USAGE')  AS usage,
       has_schema_privilege(r.rolname, n.nspname, 'CREATE') AS create
FROM pg_roles r
CROSS JOIN pg_namespace n
WHERE r.rolname IN (
  'subscriptions_user', 'schedule_user', 'attendance_user',
  'transfers_user', 'notifications_user'
)
  AND n.nspname IN (
    'subscriptions', 'schedule', 'attendance', 'transfers', 'notifications', 'public'
  )
ORDER BY 1, 2;
```

Ожидание: `usage` и `create` истинны только на диагонали своей схемы; иначе ложь, включая `public`.

### 4. `CONNECT` / `TEMP` / `CREATE` на базу у ролей

Каталог, `${POSTGRES_USER}`.

```sql
SELECT r.rolname,
       has_database_privilege(r.rolname, current_database(), 'CONNECT') AS connect,
       has_database_privilege(r.rolname, current_database(), 'TEMP')    AS temp,
       has_database_privilege(r.rolname, current_database(), 'CREATE')  AS create
FROM pg_roles r
WHERE r.rolname IN (
  'subscriptions_user', 'schedule_user', 'attendance_user',
  'transfers_user', 'notifications_user'
)
ORDER BY 1;
```

Ожидание: `CONNECT` = `t`, `TEMP` = `f`, `CREATE` = `f`. Любой `TEMP = t` — расхождение ACL, членства или старого тома.

### 5. PUBLIC: база и схемы

Каталог, `${POSTGRES_USER}`.

```sql
SELECT
  has_database_privilege('public', current_database(), 'CONNECT') AS public_connect,
  has_database_privilege('public', current_database(), 'TEMP')    AS public_temp,
  has_database_privilege('public', current_database(), 'CREATE')  AS public_create;

SELECT nspname,
       has_schema_privilege('public', nspname, 'USAGE')  AS public_usage,
       has_schema_privilege('public', nspname, 'CREATE') AS public_create
FROM pg_namespace
WHERE nspname IN (
  'subscriptions', 'schedule', 'attendance', 'transfers', 'notifications', 'public'
)
ORDER BY 1;
```

Ожидание: все шесть флагов базы и схем — `f`.

### 6. `pg_default_acl`: глобальные и схемные записи

Каталог, `${POSTGRES_USER}`. `LEFT JOIN`: `defaclnamespace = 0` не отбрасывать.

```sql
SELECT pg_get_userbyid(d.defaclrole) AS role,
       d.defaclnamespace,
       n.nspname,
       d.defaclobjtype,
       d.defaclacl
FROM pg_default_acl d
LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
WHERE pg_get_userbyid(d.defaclrole) IN (
        'subscriptions_user', 'schedule_user', 'attendance_user',
        'transfers_user', 'notifications_user'
      )
   OR d.defaclnamespace = 0
   OR n.nspname IN (
        'subscriptions', 'schedule', 'attendance', 'transfers', 'notifications'
      )
ORDER BY 1, 2;
```

Ожидание по репозиторию: нет строк `ALTER DEFAULT PRIVILEGES`. Пустой результат не отменяет hard-wired `EXECUTE` функций и `USAGE` типов у `PUBLIC`. При появлении функций/типов проверить ACL объекта.

### 7. Эффективная сессия сервисной роли

Пять отдельных подключений: каждая `*_user`, та же база. [Information Functions](https://www.postgresql.org/docs/17/functions-info.html).

```sql
SELECT current_user,
       current_database(),
       current_setting('search_path') AS search_path_setting,
       current_schemas(true)          AS search_path_effective;
```

Ожидание: `current_user` = роль подключения; `current_database()` = база экземпляра (при согласованном стенде — `lessonplus`); в эффективном пути есть своя схема. `current_schemas(true)` включает неявный `pg_catalog`. Расхождение с `rolconfig` возможно из‑за `-c search_path` у Prisma.

### 8. DML-привилегии технических таблиц без изменения строк

Каталог, `${POSTGRES_USER}`. `has_table_privilege` по OID вместе с `has_schema_privilege`. Строки не трогать: не выполнять `INSERT`/`UPDATE`/`DELETE`.

```sql
SELECT r.rolname,
       n.nspname,
       c.relname,
       has_schema_privilege(r.oid, n.oid, 'USAGE') AS schema_usage,
       has_table_privilege(r.oid, c.oid, 'SELECT') AS sel,
       has_table_privilege(r.oid, c.oid, 'INSERT') AS ins,
       has_table_privilege(r.oid, c.oid, 'UPDATE') AS upd,
       has_table_privilege(r.oid, c.oid, 'DELETE') AS del
FROM pg_roles r
CROSS JOIN pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE r.rolname IN (
        'subscriptions_user', 'schedule_user', 'attendance_user',
        'transfers_user', 'notifications_user'
      )
  AND n.nspname IN (
        'subscriptions', 'schedule', 'attendance', 'transfers', 'notifications'
      )
  AND c.relname IN ('outbox_events', 'processed_events')
  AND c.relkind = 'r'
ORDER BY 1, 2, 3;
```

Ожидание: все четыре DML и `schema_usage` истинны **только** когда `rolname` владеет `nspname` (диагональ). На чужих таблицах — ложь. Без `USAGE` схемы `has_table_privilege` не заменяет барьер схемы.

### 9. Отказ в чужой схеме из сессии сервиса

Подключение `subscriptions_user` (и симметрично каждая другая роль):

```sql
SELECT count(*) FROM subscriptions.outbox_events;
SELECT count(*) FROM schedule.outbox_events;
```

Ожидание: первый запрос успешен; второй — `permission denied for schema schedule`. Это иллюстрация барьера `USAGE`; для полной матрицы достаточно запроса 8 без смены строк.

### 10. История Prisma не в `public`

Каталог, `${POSTGRES_USER}`.

```sql
SELECT n.nspname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname = '_prisma_migrations'
ORDER BY 1;
```

Ожидание: `attendance`, `notifications`, `schedule`, `subscriptions`, `transfers` — как в `scripts/smoke.mjs`.
