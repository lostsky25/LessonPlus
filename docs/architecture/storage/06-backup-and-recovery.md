# Резервное копирование и восстановление

Шаг 6.6 архитектуры хранения. Факты топологии — [02-storage-and-isolation.md](02-storage-and-isolation.md), `compose.yaml`, `infra/postgres/init/001-roles.sh`. Модель — [03-data-model.md](03-data-model.md) / [ddl/](ddl/). Согласованность — [05-transactions-and-consistency.md](05-transactions-and-consistency.md), [interactions.md](../interactions.md).

Клиентские утилиты: [pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html), [pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html), [pg_dumpall](https://www.postgresql.org/docs/17/app-pg-dumpall.html) (PostgreSQL 17). RabbitMQ: [Docker Official Image](https://hub.docker.com/_/rabbitmq/), [Backup](https://www.rabbitmq.com/docs/backup).

Пометки: **существует** — Compose, init, миграции `outbox_events`/`processed_events`; **проектируется** — бизнес-таблицы ddl, диспетчер outbox, потребители. Документ — **проект плана**. Команды backup/restore/SQL/создания БД/ролей/очистки брокера в шаге 6.6 **не выполнялись**. План **не** подтверждает RPO/RTO. Exactly-once доставки/эффектов не обещается.

Пароли и URL с секретами в текст не входят.

**Среда шаблонов:** Bash или WSL с клиентами PostgreSQL **17.x** (`pg_dump`/`pg_restore`/`psql`/`sha256sum`). Это не PowerShell. На Windows-репозитории оператор запускает шаблоны из WSL/Git Bash с клиентом 17.

---

## 0. Единственный путь drill (законченный)

| Контур | Что |
| ------ | --- |
| Источник | Рабочий стенд Compose: `SOURCE_HOST` / `SOURCE_PORT` / `SOURCE_DB` / `SOURCE_ADMIN` (имя роли `${POSTGRES_USER}`) |
| Восстановление | **Отдельный изолированный** кластер PostgreSQL **17.11**, не том `lessonplus-postgres` рабочей среды |
| База restore | Новая пустая `TEST_DB` вида `lessonplus_restore_<метка>` на restore-кластере |
| Брокер | **Отдельный** брокер или **отдельный vhost**, без подключения старых воркеров / Compose-сервисов |
| Приложения | **Не** запускать текущий `compose` / `scripts/start-service.mjs` против restore: скрипт делает `prisma migrate deploy` и в Compose `DATABASE_URL` **зашит** на хост `postgres` и БД `lessonplus`. Нужны отдельные процессы/параметры тестового контура; сначала **только проверки чтения/доступов без потребителей и dispatcher** |

Переменные **разведены**: `SOURCE_*` только для dump; `RESTORE_HOST` / `RESTORE_PORT` / `RESTORE_ADMIN` / `TEST_DB` только для restore. Смешивать хосты в одной команде запрещено.

---

## 1. Состав резервной копии

### 1.1. Снимок PostgreSQL

Один экземпляр рабочей среды `postgres:17.11`, одна логическая база (`SOURCE_DB`, обычно `POSTGRES_DB`; URL сервисов Compose зашивают `lessonplus` — 6.2). Пять схем:

| Схема | Роль приложения | Сейчас (**существует**) | Далее (**проектируется**) |
| ----- | --------------- | ----------------------- | ------------------------- |
| `subscriptions` | `subscriptions_user` | `outbox_events`, `processed_events`, `_prisma_migrations` | бизнес-таблицы 6.3 |
| `schedule` | `schedule_user` | то же | то же |
| `attendance` | `attendance_user` | то же | то же |
| `transfers` | `transfers_user` | то же | то же |
| `notifications` | `notifications_user` | то же | то же |

**В data-копии:** все объекты пяти схем (включая outbox/processed/migrations) одним `pg_dump` **базы целиком** — единый snapshot БД для логических связей переноса. Это **не** снимок брокера и **не** доказательство завершённости saga.

**Роли кластера** в обычный `pg_dump` базы **не** входят:

| Артефакт | Назначение | Обращение |
| -------- | ---------- | --------- |
| Секретный `roles_*.sql` (`pg_dumpall --roles-only`) | Архив хешей/ролей источника | **Не** импортировать вслепую поверх bootstrap-superuser restore-кластера |
| Воспроизводимый roles-only bootstrap (§4.3) | Пять `LOGIN`-ролей + `search_path` **без** `CREATE SCHEMA` | Выбранный путь drill |

### 1.2. Отдельно от SQL-дампа

| Класс | Источник | Секреты |
| ----- | -------- | ------- |
| Пароли PG/Rabbit, URL | `.env` оператора | Не в git; `.env.example` — только учебные значения |
| Образ / git commit | Dockerfile, compose, тег | Согласовать с `_prisma_migrations` |
| Том `lessonplus-postgres` | Docker | Не бэкап: потеря диска/хоста уничтожает том |
| RabbitMQ | отдельный контур drill | Definitions export — topology/users, **не** сообщения; может содержать password hashes — вне git ([Backup](https://www.rabbitmq.com/docs/backup)) |

---

## 2. Копирование, расписание, хранение

### 2.1. Зачем dump базы целиком

Пять схем в одном WAL. Независимые schema-dump по времени рассинхронизируют перенос. `pg_dump -Fc` всей `SOURCE_DB` от `SOURCE_ADMIN`.

### 2.2. Расписание (проект)

| Параметр | Значение |
| -------- | -------- |
| Номинальная частота | 1×/сутки + ручной pre-drill |
| Формат | `lessonplus_${UTC}.dump` (`-Fc`) |
| Удержание внешних копий | 7 суточных + 1 ручной; FIFO |

Одного cron «раз в сутки» **недостаточно**, чтобы доказать RPO ≤ 24 ч: учитываются `SNAP_STARTED_AT`, длительность dump, доставка на защищённый носитель, сорванные задания. Цель ≤ 24 ч относится к **возрасту снимка** (`T_incident − SNAP_STARTED_AT` выбранной успешно проверенной внешней копии), а не к моменту checksum. Мониторинг/алерт по snapshot age либо более частое расписание с запасом.

### 2.3. Место хранения

- **Недостаточно:** другой раздел/том **того же физического диска**, что данные Postgres.
- **Минимум:** физически другой носитель, другой хост или защищённое удалённое хранилище.
- Отдельно: успешная **доставка** туда, проверка checksum **именно защищённой** копии, политика удержания, доступ оператора, шифрование at-rest (уточнить до drill).
- `BACKUP_ROOT` — путь на защищённом носителе (не в git).

### 2.4. Шаблон снятия копии (Bash, fail-fast)

`POSTGRES_PASSWORD` **не** переменная пароля libpq для `pg_dump`. Использовать `PGPASSFILE` (`0600`) или интерактив. Секреты **не** в argv/истории shell ([psql](https://www.postgresql.org/docs/17/app-psql.html)).

Checksum — **относительно каталога артефакта** (только имя файла в манифесте). После переноса на другой хост проверка: `cd` в каталог **полученной** копии и `sha256sum -c`. TOC/`sha256` подтверждают целостность **файла**, не полноценное восстановление в БД.

`SNAP_STARTED_AT` фиксируется **перед** `pg_dump` как **нижняя временная оценка** (консервативная граница для RPO-журнала), **не** точный MVCC snapshot и **не** LSN. `SNAP_FINISHED_AT` — конец dump, **не** cutoff согласованности. Точный snapshot LSN из этих shell-меток **не** выводится.

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${SOURCE_HOST:?}"
: "${SOURCE_PORT:?}"
: "${SOURCE_DB:?}"
: "${SOURCE_ADMIN:?}"
: "${BACKUP_ROOT:?}"
: "${PGPASSFILE:?}"

command -v pg_dump >/dev/null
command -v pg_restore >/dev/null
command -v sha256sum >/dev/null
pg_dump --version | grep -E -q '[[:space:]]17\.'
pg_restore --version | grep -E -q '[[:space:]]17\.'

umask 077
mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DUMP_BASENAME="lessonplus_${STAMP}.dump"
DUMP="${BACKUP_ROOT}/${DUMP_BASENAME}"
MANIFEST="${BACKUP_ROOT}/${DUMP_BASENAME}.sha256"
SNAP_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

export PGHOST="$SOURCE_HOST" PGPORT="$SOURCE_PORT" PGUSER="$SOURCE_ADMIN" PGDATABASE="$SOURCE_DB"
export PGPASSFILE

pg_dump -Fc -f "$DUMP"
pg_restore -l "$DUMP" >/dev/null
# манифест: «hash  basename» из каталога артефакта (без абсолютного пути)
(
  cd "$BACKUP_ROOT"
  sha256sum "$DUMP_BASENAME" > "${DUMP_BASENAME}.sha256"
)

SNAP_FINISHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# журнал §6: SNAP_*, size, hash, git commit/image; TOC+sha256 ≠ restore-test
```

Опциональный **секретный** архив ролей источника (не bootstrap restore; не лить вслепую):

```bash
pg_dumpall -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$SOURCE_ADMIN" \
  --roles-only -f "${BACKUP_ROOT}/roles_source_${STAMP}.sql"
chmod 600 "${BACKUP_ROOT}/roles_source_${STAMP}.sql"
```

---

## 3. RPO и RTO (проектные ориентиры)

| Показатель | Ориентир | Смысл | Статус |
| ---------- | -------- | ----- | ------ |
| **RPO** | **≤ 24 ч** | Потеря уже **committed** изменений **после** консервативной границы снимка. Верхняя оценка вклада: **`T_incident − SNAP_STARTED_AT`** выбранной успешно проверенной внешней копии (или подтверждённый точный snapshot timestamp, если когда-либо получен). Включает задержку dump/доставки. **`verified_external_copy_at` не** cutoff и **не** начало возраста: проверка сегодня старой копии лишь подтверждает доступность/целостность файла | **Не подтверждено** |
| **RTO** | **≤ 2 ч** | `T_ready − T_restore_start`, где **`T_ready ≥ T_broker_reconciled`**: единый момент общей готовности тестового контура **включая** broker reconciliation (§5). Длительность создания backup **не** входит | **Не подтверждено** |
| Переключение рабочей БД Compose | вне scope 6.6 | Запрет перезаписи основной базы | — |

---

## 4. Restore на изолированный кластер

Ссылки: [CREATE DATABASE](https://www.postgresql.org/docs/17/sql-createdatabase.html), [psql](https://www.postgresql.org/docs/17/app-psql.html), [pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html). Шаблоны — справочные; **не запускать** в рамках правки документа.

### 4.1. Переменные

| Переменная | Контур |
| ---------- | ------ |
| `SOURCE_HOST` `SOURCE_PORT` `SOURCE_DB` `SOURCE_ADMIN` | dump / сверка изоляции (все **обязательны**, без `:-`) |
| `SOURCE_DUMP` | абсолютный путь к `.dump`; соседний манифест — тот же каталог, `$(basename).sha256` |
| `RESTORE_HOST` `RESTORE_PORT` `RESTORE_ADMIN` | изолированный PG 17.11 |
| `TEST_DB` | `^lessonplus_restore_[A-Za-z0-9_]+$`, длина **≤ 63 байт**, ≠ `SOURCE_DB`, ≠ `lessonplus` |
| `PGPASSFILE` | строки для restore-admin (и позже `*_user` после `\password`) |

**`RESTORE_ADMIN`:** то же **имя**, что `SOURCE_ADMIN` (воспроизводимый путь), но **отдельный тестовый пароль** на другом кластере. Роль — **superuser только для администрирования drill** (create DB/roles, restore ownership), **не** для приложений.

Пароли пяти `*_user` на restore: оператор задаёт **интерактивно** (`\password`) после `CREATE ROLE … LOGIN` без `PASSWORD` в SQL/argv — см. §4.3. Рабочие секреты source **не** менять.

### 4.2. Запрет флагов restore

- `--create` — имя БД из архива (`lessonplus`) — **запрещён**.
- `--clean` — не нужен на пустой цели.
- `--no-owner` — таблицы у админа; OWNER схемы недостаточен — **запрещён** на выбранном пути.

### 4.3. Preflight → роли → БД → restore

Полный `001-roles.sh` до restore **запрещён** (`CREATE SCHEMA` ломает последующий restore).

**Fail-fast и частичные объекты:** при обрыве после создания ролей/БД **не** перезапускать bootstrap вслепую и **не** предлагать автоматический `DROP`. Нужен **ручной разбор** оператором вне этого шага документации.

#### Preflight (до любых CREATE на restore)

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${SOURCE_HOST:?}" "${SOURCE_PORT:?}" "${SOURCE_DB:?}" "${SOURCE_ADMIN:?}"
: "${SOURCE_DUMP:?}"
: "${RESTORE_HOST:?}" "${RESTORE_PORT:?}" "${RESTORE_ADMIN:?}"
: "${TEST_DB:?}" "${PGPASSFILE:?}"

command -v pg_restore >/dev/null
command -v psql >/dev/null
command -v sha256sum >/dev/null
command -v realpath >/dev/null
pg_restore --version | grep -E -q '[[:space:]]17\.'
psql --version | grep -E -q '[[:space:]]17\.'

[[ "$SOURCE_ADMIN" == "$RESTORE_ADMIN" ]] \
  || { echo "на выбранном пути имя RESTORE_ADMIN должно совпадать с SOURCE_ADMIN"; exit 1; }

[[ "$TEST_DB" =~ ^lessonplus_restore_[A-Za-z0-9_]+$ ]] \
  || { echo "TEST_DB: шаблон имени"; exit 1; }
(( ${#TEST_DB} <= 63 )) || { echo "TEST_DB: длина > 63 байт (лимит PostgreSQL)"; exit 1; }
[[ "$TEST_DB" != "$SOURCE_DB" && "$TEST_DB" != "lessonplus" ]] \
  || { echo "TEST_DB совпал с SOURCE_DB/lessonplus"; exit 1; }

# Явный запрет совпадения endpoint со source (различие строк само по себе ≠ доказательство разных кластеров):
if [[ "$RESTORE_HOST" == "$SOURCE_HOST" && "$RESTORE_PORT" == "$SOURCE_PORT" ]]; then
  echo "RESTORE host:port совпал с SOURCE — отказ. Изоляцию кластера подтверждает оператор отдельно."
  exit 1
fi
# Оператор до продолжения письменно подтверждает: restore — другой кластер/том, не lessonplus-postgres.

# Один канонический dump + соседний manifest (без SOURCE_MANIFEST_DIR / копирований по догадке):
SOURCE_DUMP=$(realpath "$SOURCE_DUMP")
DUMP_DIR=$(dirname "$SOURCE_DUMP")
DUMP_BASENAME=$(basename "$SOURCE_DUMP")
MANIFEST="${DUMP_DIR}/${DUMP_BASENAME}.sha256"
test -f "$SOURCE_DUMP" && test -r "$SOURCE_DUMP"
test -f "$MANIFEST" && test -r "$MANIFEST"

(
  cd "$DUMP_DIR"
  sha256sum -c "${DUMP_BASENAME}.sha256"
)
pg_restore -l "$SOURCE_DUMP" >/dev/null
# далее restore только этого же SOURCE_DUMP; TOC+sha256 ≠ полноценное восстановление
```

Перед CREATE: сверить, что **все роли архива** (owners, ACL grantee, grantors) есть на restore. Пяти `*_user` **недостаточно**, если в дампе есть иные. На выбранном пути: `RESTORE_ADMIN` ≡ имя `SOURCE_ADMIN` + пять сервисных. Неизвестная role → **стоп**; **не** импортировать `roles_source_*.sql` вслепую.

**Инвентаризация ролей (ручной preflight; шаблон сейчас не выполнять):** `pg_restore -l` — лишь обзор TOC и **не** извлекает полный список referenced roles (owner обычно последний столбец строки без слова `OWNER`; grantee/grantor — в теле ACL-записи).

```bash
# SCHEMA_SQL — защищённый локальный путь вне git (umask 077). Без -d: SQL не применяется к БД.
pg_restore --schema-only --file="$SCHEMA_SQL" "$SOURCE_DUMP"
# Оператор читает ALTER … OWNER TO / GRANT / REVOKE / ALTER DEFAULT PRIVILEGES,
# собирает полный список ролей (включая grantors), сопоставляет с pg_roles restore.
# Файл не исполнять через psql и не коммитить. При неопределённости — стоп.
# Все CREATE — только после этого подтверждения.
```

#### Bootstrap ролей и БД (после успешного preflight)

Секреты **не** в argv: роли без `PASSWORD`; пароли — только интерактивно.

```bash
#!/usr/bin/env bash
set -euo pipefail
# те же обязательные переменные, что preflight; SOURCE_DUMP уже проверен

export PGHOST="$RESTORE_HOST" PGPORT="$RESTORE_PORT" PGUSER="$RESTORE_ADMIN" PGPASSFILE

# 1) Пять LOGIN без пароля, без схем; search_path:
psql -X -d postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE subscriptions_user LOGIN;
CREATE ROLE schedule_user LOGIN;
CREATE ROLE attendance_user LOGIN;
CREATE ROLE transfers_user LOGIN;
CREATE ROLE notifications_user LOGIN;
ALTER ROLE subscriptions_user SET search_path TO subscriptions;
ALTER ROLE schedule_user SET search_path TO schedule;
ALTER ROLE attendance_user SET search_path TO attendance;
ALTER ROLE transfers_user SET search_path TO transfers;
ALTER ROLE notifications_user SET search_path TO notifications;
SQL

# 2) Оператор (интерактив, без истории SQL-паролей в argv скрипта), до любых app-подключений:
#   psql -X -d postgres
#   \password subscriptions_user
#   … для каждой из пяти; только тестовые пароли изолированного кластера.

# 3) Пустая БД из template0 ([CREATE DATABASE](https://www.postgresql.org/docs/17/sql-createdatabase.html)):
psql -X -d postgres -v ON_ERROR_STOP=1 -v db="$TEST_DB" <<'SQL'
CREATE DATABASE :"db" OWNER CURRENT_USER TEMPLATE template0;
SQL

# 4) Сразу закрыть PUBLIC на БД (CONNECT пяти — только после успешного restore + проверки ACL объектов):
psql -X -d postgres -v ON_ERROR_STOP=1 -v db="$TEST_DB" <<'SQL'
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
SQL

# 5) Restore с сохранением owner/ACL; без --no-owner/--clean/--create:
pg_restore -d "$TEST_DB" --exit-on-error "$SOURCE_DUMP"

# 6) После успешного restore и проверки owners/ACL таблиц — CONNECT сервисным ролям:
psql -X -d postgres -v ON_ERROR_STOP=1 -v db="$TEST_DB" <<'SQL'
GRANT CONNECT ON DATABASE :"db" TO subscriptions_user, schedule_user,
  attendance_user, transfers_user, notifications_user;
SQL
```

**Секретный `roles_source_*.sql`:** архив отдельно; не применять автоматически.

### 4.4. Проверки после restore (без потребителей)

**Owners / ACL (admin):**

```sql
SELECT n.nspname, r.rolname AS schema_owner
FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
WHERE n.nspname IN ('subscriptions','schedule','attendance','transfers','notifications');

SELECT schemaname, tablename, tableowner
FROM pg_tables
WHERE schemaname IN ('subscriptions','schedule','attendance','transfers','notifications')
ORDER BY 1, 2;
```

**Доступ `*_user`:** `SHOW search_path`; чтение своих `outbox_events`/`processed_events`; чужая схема → denied.

**Данные (обязательно, не только owners):**

- Состав таблиц в пяти схемах vs ожидаемый набор init (`outbox_events`, `processed_events`, `_prisma_migrations`) и TOC обзор.
- **Row counts:** один согласованный способ учебного drill (только в **отдельно разрешённом** drill, не в правке документа): на интервале эталона **остановить все записи и миграции на source** (включая будущих workers; саму PG не останавливать) → снять counts эталона → сразу полный `pg_dump` → завершить окно тишины. Эталон и dump — один согласованный момент; **два независимых снимка** (отчёт pre-drill + поздний dump при параллельных записях) **не** считать согласованными. Если согласованного эталона нет — критерий counts **незакрыт**, проверка **не** считается пройденной. Не сверять counts с продолжающей изменяться живой `SOURCE_DB` после окна.
- Альтернатива тому же окну тишины: один общий экспортированный snapshot (если когда-либо появится) — не два независимых артефакта.
- `_prisma_migrations` vs git commit / image tag пары dump↔restore.
- Бизнес-инварианты / transfers — **только если** таблицы реально есть в копии; иначе N/A.

**Не** вызывать `start-service.mjs` / `migrate deploy` автоматически.

### 4.5. Критерии полного прохода и старт компонентов

Полный проход drill требует: preflight+restore+доступы+сверка данных эталона; §5 freeze/карантин; **нет нерешённых** сообщений/эффектов в журнале reconciliation; `T_broker_reconciled` выставлен; затем `T_ready`. Контролируемый старт — **только фактически реализованных** компонентов (сейчас: нет бизнес-consumers/outbox-dispatcher в коде — не имитировать их «успешный старт»). Когда появятся — отдельные процессы тестового контура + отдельный брокер/vhost, без Compose workers.

---

## 5. PostgreSQL ↔ RabbitMQ после отката БД

### 5.1. Факты о брокере (Compose)

В `compose.yaml` у `rabbitmq` **нет явного** именованного тома и **нет** стабильного node name в конфигурации репозитория. Утверждение «нет volume в compose ⇒ при recreate очереди **обязательно** пусты» — **неверно**: [официальный образ](https://hub.docker.com/_/rabbitmq/) объявляет `/var/lib/rabbitmq` как volume; фактическая сохранность зависит от mounts, node name, типа/долговечности очередей и операции recreate и **здесь не проверялась**.

[Definitions export](https://www.rabbitmq.com/docs/backup) восстанавливает topology/users (и может содержать password hashes), **не** тела сообщений.

**Инвентаризация до любых действий (без purge):** queues, depths, unacked, vhost, node name, mounts контейнера — зафиксировать в журнале drill.

### 5.2. Что откатывается вместе с PG

В **проектной** общей PG-топологии (одна база, пять схем) локальные эффекты будущих HTTP-шагов у пяти владельцев и imitation-attempts, когда соответствующие таблицы появятся, лежат в **той же** PostgreSQL и при restore снимка откатываются вместе с агрегатами. Сейчас в живых схемах — technical `outbox`/`processed`/migrations; бизнес-таблицы ddl **не** объявлять уже реализованными. Пережить снимок БД могут: сеть/ответы старых воркеров, сообщения брокера, будущие реальные внешние каналы. Полный dump ≠ снимок брокера ≠ завершённость saga.

### 5.3. processed / idempotency после rollback

После отката БД на старый snapshot **теряются** строки `processed_events`, HTTP idempotency, journal, outbox **после** cutoff снимка. Прежний `event_id` **не** гарантирует no-op, если processed уже откатился. Живой брокер может нести события «из будущего», чьих породивших TX в восстановленной БД уже нет.

### 5.4. Порядок reconciliation (проект)

1. **Заморозить** потребителей, outbox-dispatcher и старые saga-workers **до** возобновления на restore-контуре.
2. Зафиксировать **консервативную границу** снимка для журнала (`SNAP_STARTED_AT` / эталон копии) и инвентаризацию брокера. Shell-метки **не** заменяют точный MVCC/LSN snapshot.
3. **Карантин** неподтверждённых сообщений (отдельная очередь/vhost/удержание unacked без hot requeue); **не** purge.
4. Сверка по cutoff: поштучное решение replay / не replay по владельцу, инвариантам 6.3–6.5 и **имеющимся свидетельствам**. Недостаточно доказательств → **стоп**, ручной разбор — **не** автоматический sticky replay.
5. Запрет compensate для `binding_knowledge ∈ {outcome_unknown, committed}` сохраняется; recovery 6.5 — **только после** reconciliation.
6. Эффекты школьной отмены / посещения, ещё открытые в 6.3–6.5 (`right_effect` pending и т.п.), **не** объявлять `completed` по факту restore.

### 5.5. Кейсы

| Кейс | Риск | Действие |
| ---- | ---- | -------- |
| Сообщение в брокере есть, `processed` утрачен | Повторный эффект | Карантин; ручное решение по агрегату/UNIQUE; не слепой ack+effect |
| Producer TX потеряна (события «из будущего» без строк в БД) | Ложный мир | Не применять эффект; карантин/DLQ-разбор |
| Брокер потерян, в БД `published_at` уже выставлен | Consumers могли не получить | `published_at IS NOT NULL` **не** доказывает приём всеми; не считать доставку завершённой |
| Утрачен ключ/ответ внешней операции (idempotency row после snapshot) | Повтор с тем же ключом у владельца **не** исключён автоматически, если строка ключа откатилась | Сверка с фактическим состоянием владельца; новый ключ не выдумывать для старого шага без процедуры |

### 5.6. Outbox republish

Нельзя восстанавливать доступность **только** выбором `published_at IS NULL` при потере брокера. Не массово сбрасывать `published_at`. Не создавать новые `event_id`.

**Проверенный набор retained outbox** для выборочного republish: строки, которые (a) есть в восстановленной БД; (b) решение оператора «нужны получателям» после сверки; (c) публикуются **тем же** `event_id` / конвертом. Неподтверждённое восстановление сообщений/эффектов — **блокирующий** пункт drill. Exactly-once не обещается.

### 5.7. Незавершённые transfers

Если таблица `transfers` **есть** в копии: читать `status IN ('accepted','in_progress')` и `binding_knowledge`, `current_step`, сохранённые inputs (6.4). Дальше — только после §5.4; запрет compensate для unknown/committed — 05. Если таблицы нет — N/A.

---

## 6. Журнал drill (поля; факты пустые)

| Поле | Значение |
| ---- | -------- |
| `SNAP_STARTED_AT` / `SNAP_FINISHED_AT` (UTC) | нижняя оценка / конец dump; не LSN |
| `verified_external_copy_at` (UTC) | успешный `sha256sum -c` той же пары dump+manifest; **не** cutoff RPO |
| `T_incident` (UTC) | объявленный момент «аварии» |
| `dump_basename` / `size_bytes` / `sha256` | |
| `git_commit` / `image_tag` | |
| `T_restore_start` (UTC) | |
| `T_broker_reconciled` (UTC) | |
| `T_ready` (UTC) | **≥ `T_broker_reconciled`**; общая готовность |
| RPO-вклад (верхняя оценка) | **`T_incident − SNAP_STARTED_AT`** выбранной успешно проверенной копии (или точный snapshot timestamp, если есть) |
| **RTO** | **`T_ready − T_restore_start`** |
| Нерешённые сообщения/эффекты | список или «нет» |
| Итог / ошибки | |
| Ориентиры §3 подтверждены? | **нет**, пока поля пусты |

| # | Шаг | Критерий | Факт |
| - | --- | -------- | ---- |
| 1 | Preflight: архив+manifest+`sha256sum -c`+TOC+client 17+изоляция | файл ок; restore≠source endpoint; оператор подтвердил другой кластер | |
| 2 | Роли LOGIN без пароля; `\password` интерактивно | без argv-секретов | |
| 3 | `TEST_DB` `TEMPLATE template0`; сразу `REVOKE` PUBLIC | | |
| 4 | `pg_restore` без `--no-owner/--create`; затем `GRANT CONNECT` | owners = сервисные роли | |
| 5 | Доступы search_path / своё / чужой отказ | | |
| 6 | Данные: состав таблиц; counts vs эталон **того же** окна тишины dump (иначе counts незакрыты); migrations vs git | | |
| 7 | Бизнес/transfers | только если таблицы есть; иначе N/A | |
| 8 | Брокер inventory **без** purge | | |
| 9 | Freeze; карантин; поштучный разбор | нет авто-replay; нет нерешённых | |
| 10 | Retained outbox decision | без mass reset `published_at` | |
| 11 | `T_broker_reconciled` → `T_ready`; старт только реализованных компонентов | RTO записан | |

---

## 7. Запрещено в 6.6

- Backup/restore/SQL/создание БД/ролей/очистка брокера **как выполнение** этого шага в живой среде без отдельного разрешения drill.
- `DROP`/`pg_restore` в рабочую `SOURCE_DB` / `lessonplus`; wipe `lessonplus-postgres`.
- `pg_restore --create` / `--clean` / `--no-owner` на выбранном пути.
- Полный `001-roles.sh` до restore на restore-кластере.
- Purge очередей; mass `published_at = NULL`; новые `event_id` для старых фактов.
- Автозапуск Compose / `start-service.mjs` против restore.
- Пароли в `psql -v` / argv; повтор bootstrap вслепую и авто-`DROP` после fail-fast.
- Commit секретов / `roles_*.sql` / `.env` в git.

---

## 8. Уточнить перед испытанием

1. Хост/порт изолированного PG 17.11 и отдельного брокера/vhost.
2. `BACKUP_ROOT` на другом физическом носителе; шифрование; кто проверяет доставку.
3. Мониторинг **snapshot age** (`T_incident − SNAP_STARTED_AT`), не возраста checksum.
4. `PGPASSFILE`; `\password` пяти тестовых ролей.
5. Подтверждение изоляции кластера сверх host:port.
6. Разрешение на окно тишины source для согласованного эталона counts↔dump.
7. Путь `SCHEMA_SQL` вне git для role inventory.
8. Mounts/node name RabbitMQ (без изменения Docker в 6.6).
9. Feature-flag dispatcher до reconciliation.
10. Git commit / image tag; журнал §6; измеренные RPO/RTO.

---

## 9. Навигация

- [05-transactions-and-consistency.md](05-transactions-and-consistency.md), [02-storage-and-isolation.md](02-storage-and-isolation.md)
- [interactions.md](../interactions.md)
- [architecture.md](../../architecture.md)
