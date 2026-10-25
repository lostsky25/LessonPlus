# Архитектура хранения LessonPlus

Единый документ пакета **Storage architecture** (шаги 6.1–6.8). Объясняет, как система хранит данные, кто ими владеет и какие решения зафиксированы до реализации бизнес-сценариев.

Подробные SQL, алгоритмы TX и drill-шаблоны остаются в приложениях `storage/01`…`07`. Здесь — согласованные решения и границы «что уже в каркасе / что только спроектировано».

**Связанные приложения**

| Шаг | Документ |
| --- | -------- |
| 6.1 | [Владение данными](storage/01-data-ownership.md) |
| 6.2 | [Хранение и изоляция](storage/02-storage-and-isolation.md) |
| 6.3 | [Модель данных](storage/03-data-model.md), [ddl/](storage/ddl/), ER ниже |
| 6.4 | [Запросы и индексы](storage/04-queries-and-indexes.md) |
| 6.5 | [Транзакции и согласованность](storage/05-transactions-and-consistency.md) |
| 6.6 | [Резервное копирование и восстановление](storage/06-backup-and-recovery.md) |
| 6.7 | [Масштабирование](storage/07-scaling.md) |
| 6.8 | этот обзор; ручная матрица [08-cross-check-matrix.md](storage/08-cross-check-matrix.md) |

Контекст сервисов: [architecture.md](../architecture.md), [domain.md](domain.md), [glossary.md](glossary.md), [event-catalog.md](event-catalog.md), [c4.md](c4.md), [interactions.md](interactions.md). Контракты: [OpenAPI](../../packages/contracts/openapi/README.md), [события](../../packages/contracts/events/README.md).

---

## 1. Границы сервисов и владельцы данных

Пять бизнес-сервисов и gateway — **раздельные процессы**. Сервис не импортирует внутренности другого, не читает чужую схему и не пишет чужие таблицы. Gateway **не** получает `DATABASE_URL`. Браузер ходит только на `/api` (proxy Vite).

| Сервис | Схема / роль | Владеет (источник истины) | Не владеет |
| ------ | ------------ | ------------------------- | ---------- |
| `subscriptions` | `subscriptions` / `subscriptions_user` | ученик и контакт, тариф, абонемент, право, резерв права, журнал операций права | место, отметка, заявка, доставка |
| `schedule` | `schedule` / `schedule_user` | преподаватель, группа, занятие, запись, резерв места, операции отмены | остаток права, отметка, заявка |
| `attendance` | `attendance` / `attendance_user` | регистрация, окончательная отметка, исправление | остаток, место |
| `transfers` | `transfers` / `transfers_user` | заявка, правило переноса, координаторское состояние шагов | остаток, вместимость |
| `notifications` | `notifications` / `notifications_user` | поручение и попытки имитации доставки | бизнес-агрегаты |
| `api-gateway` | нет роли PG | вход HTTP, сбор статусов | любые таблицы |

**Межсервисная ссылка** — UUID владельца в поле потребителя. Это **не** `REFERENCES` чужой схемы и **не** право читать чужую строку. Согласование — HTTP владельца или факт каталога (`event_id` → `processed_events` получателя).

Запрещены: SQL `JOIN` двух сервисных схем; FK через границу схем; `GRANT USAGE` на чужую схему «чтобы JOIN заработал»; второй справочник той же сущности у потребителя.

Справочники ученика/тарифа живут у `subscriptions`, преподавателя/группы — у `schedule`. OpenAPI v1 их **не** создаёт: активация и занятие ссылаются на уже известные UUID (открытый срез — откуда они появляются до первого POST).

Полные карточки сущностей и UUID-матрица — [01-data-ownership.md](storage/01-data-ownership.md). Сопоставление колонок API/событий — [03-data-model.md](storage/03-data-model.md) §«Соответствие API и событиям».

---

## 2. PostgreSQL и модель изоляции

**Выбрано:** один экземпляр `postgres:17.11`, одна логическая база (обычно `lessonplus`), **пять схем** и пять ролей `*_user` без `SUPERUSER` ([infra/postgres/init/001-roles.sh](../../infra/postgres/init/001-roles.sh)). Это топология «схемы одной базы» (логическая изоляция), не пять кластеров.

Почему PostgreSQL: локальные транзакции (агрегат + `outbox_events`), UNIQUE/CHECK внутри схемы, FK **внутри** владельца, конкуренция через `FOR UPDATE` / advisory locks — без отдельного document-store контура.

| Решение | Смысл |
| ------- | ----- |
| Одна роль на сервис | И migrate, и runtime — компромисс прототипа; DDL только своей схемы |
| Init ролей | Только на **пустом** томе |
| Gateway / web | Без подключений к PG |
| Имя базы | `POSTGRES_DB` параметризует init/healthcheck; Compose URL сервисов зашивают `lessonplus` (расхождение конфигурации, см. 6.2) |

Матрица `USAGE` и каталожные SQL-проверки (как отчёт шага 6.2 **не** снимались с живой базы) — [02-storage-and-isolation.md](storage/02-storage-and-isolation.md).

RabbitMQ — транспорт фактов, **не** источник истины остатка и мест.

---

## 3. Бизнес-таблицы и ER

### Технические таблицы каркаса (код и миграции)

В каждой сервисной схеме Prisma-модель и SQL-миграция `20261007120000_init` описывают:

| Таблица | Назначение |
| ------- | ---------- |
| `outbox_events` | Строка факта до публикации; диспетчер **не** запущен |
| `processed_events` | Учёт обработанного входящего `event_id` в **этой** схеме |

Подтверждение — файлы схемы и миграции (§9). **Каталог живой БД в шаге 6.8 не читался:** применение миграций к стенду здесь не проверялось. Не утверждать «уже в рабочей базе» без текущего каталожного запроса.

Бизнес-CRUD, saga и потребители **отсутствуют**.

### Спроектированы (миграций нет)

DDL: [subscriptions.sql](storage/ddl/subscriptions.sql), [schedule.sql](storage/ddl/schedule.sql), [attendance.sql](storage/ddl/attendance.sql), [transfers.sql](storage/ddl/transfers.sql), [notifications.sql](storage/ddl/notifications.sql).

ER (сокращённый набор тех же имён/связей):

- [er-subscriptions.mmd](diagrams/er-subscriptions.mmd) — student/tariff → subscription → rights; reservation и operations на right; UNIQUE consume `(right_id, booking_id)`; lifetime UNIQUE `right_reservations.transfer_id`; проекция `canceled_lessons`
- [er-schedule.mmd](diagrams/er-schedule.mmd) — teacher/group → lesson → bookings / seat_reservations; CHECK вместимости на строке lesson; `compensated_right_releases`; school/booking cancellations
- [er-attendance.mmd](diagrams/er-attendance.mmd) — registration → attendance (UNIQUE `booking_id`); corrections на attendance
- [er-transfers.mmd](diagrams/er-transfers.mmd) — rules → transfers; outbound steps/attempts; claim-колонки; CHECK `rejected` vs `binding_knowledge`
- [er-notifications.mmd](diagrams/er-notifications.mmd) — notification → attempts; UNIQUE `(source_event_id, student_id, channel)`

Кратко по владельцам:

| Схема | Таблицы (проект) |
| ----- | ---------------- |
| subscriptions | `students`, `tariffs`, `subscriptions`, `lesson_rights`, `right_reservations`, `right_operations`, `canceled_lessons`, `http_idempotency_keys` |
| schedule | `teachers`, `groups`, `lessons`, `bookings`, `seat_reservations`, `compensated_right_releases`, `school_cancellations`, `booking_cancellations`, `http_idempotency_keys` |
| attendance | `attendance_registrations`, `attendances`, `attendance_corrections`, `http_idempotency_keys` |
| transfers | `transfer_rules`, `transfers` (вкл. `claim_*`), `transfer_outbound_steps`, `transfer_outbound_attempts`, `http_idempotency_keys` (только входящий `POST /v1/transfers`) |
| notifications | `notifications`, `notification_delivery_attempts` |

Ключевые состояния (не смешивать сущности):

| Сущность | Поле статуса | Значения / переходы |
| -------- | ------------ | ------------------- |
| Право | `lesson_rights.status` | `available` → `bound` → `reserved` или `consumed`; rebind commit: `reserved` → `bound` на target; компенсация до commit: Released → снова `bound` к source |
| Запись (место ученика) | `bookings.seat_status` | `pending` / `confirmed` / `canceled` / `rejected` |
| Учёт счётчика hold | `bookings.hold_kind` | `ordinary_pending` / `covered_by_seat_reservation` / `none` |
| Резерв места переноса | `seat_reservations.status` | `active` / `released` (+ `ttl_action=wake_recovery`) |
| Заявка | `transfers.status` + `binding_knowledge` | `accepted` → `in_progress` → `completed` \| `rejected`; `rejected` запрещён при `outcome_unknown` / `committed` |

**Hold до commit vs после commit (раздельно):**

1. **До commit привязки** допустима компенсация: right release → факт `LessonRightReleased` → durable проекция `compensated_right_releases` у schedule → seat release (−1 reserve, booking `rejected`). Авто-TTL **не** −1.
2. **После commit** (`binding_knowledge=committed` / `LessonRightTransferred`) путь Released **невозможен**; компенсация и `rejected` запрещены. Recovery **доводит** штатный confirm target (−1 reserve / +1 confirmed, **без** доп. проверки `< capacity`) и release source. Проекция Released для штатного confirm **не** нужна.
3. При `outcome_unknown` или `committed` hold **не** освобождают ни TTL, ни school cancel / cleanup — только предикаты §4 в [05](storage/05-transactions-and-consistency.md).

Детали колонок, CHECK/UNIQUE — [03-data-model.md](storage/03-data-model.md).

---

## 4. Пять показательных запросов и индексы

Проект чтения из [04-queries-and-indexes.md](storage/04-queries-and-indexes.md). SQL **не** измерялся; миграций этих индексов нет. JOIN только внутри схемы владельца. Keyset-курсор; `limit` 1…100; `freeSeatCount` / чтение `available` **не** резервируют.

| # | Каноническая цель | Владелец | Не путать с |
| - | ----------------- | -------- | ----------- |
| 1 | Доступные права ученика (`available` + абонемент active на `as_of`) | subscriptions | остаток `balance` (COUNT available\|reserved\|bound) |
| 2 | Занятия группы за период + active seat reservations (CTE page, затем JOIN) | schedule | список `canceled_by_school` |
| 3 | Записи конкретного занятия (`bookings` по `lesson_id`) | schedule | список посещений занятия (такого GET нет) |
| 4 | **Recovery-выборка** незавершённых transfers: `status IN ('accepted','in_progress')` + sticky outbound step (`current_step`) + последняя попытка | transfers | публичный `GET /v1/transfers` (другой сценарий; без шага/knowledge) |
| 5 | **Имитация доставки:** notifications `pending`/`failed`, `backoff`/`max_attempts`, последняя попытка, `as_of` | notifications | outbox/recovery queue; пятиступенчатый TTL RabbitMQ (это политика событий) |

**Индексы только под пять SELECT** (частичные — обновляются при смене `status`):

| Индекс | Колонки | WHERE | Запрос |
| ------ | ------- | ----- | ------ |
| `lesson_rights_student_available_id` | `(student_id, id)` | `status = 'available'` | 1 |
| `lessons_group_scheduled_starts_id` | `(group_id, starts_at, id)` | `status = 'scheduled'` | 2 |
| `seat_reservations_lesson_active` | `(lesson_id, id)` | `status = 'active'` | 2 |
| `bookings_lesson_id` | `(lesson_id, id)` | — | 3 |
| `transfers_open_created_id` | `(created_at, id)` | `status IN ('accepted','in_progress')` | 4 |
| `notifications_retry_recorded_id` | `(recorded_at, id)` | `status IN ('pending','failed')` | 5 |

Для Q2 JOIN шага резерва опирается на partial active; UNIQUE active по `transfer_id`/`target_booking_id` поиск по `lesson_id` не заменяет. Для Q4 JOIN шага — UNIQUE `(transfer_id, step)`; последняя попытка — UNIQUE `(step_id, attempt_no)`. Для Q5 лимит попыток и backoff — Filter после LATERAL, не часть индекса; UNIQUE `(notification_id, attempt_no)` для «последней попытки».

**Q4/Q5 — не claim:** SELECT **не** захватывает строку, не даёт lease/fairness и не делает переход шага атомарным (это 6.5). Два воркера могут прочитать одну строку.

**Цикл keyset:** курсор страницы берут с **последней возвращённой** строки того же обхода; хвост за `LIMIT` — следующая страница. **Новый** обход с обоими курсорными `NULL` нужен для уже пройденных/отфильтрованных строк, которые станут готовыми позже — не для хвоста за `LIMIT`. У Q5 параметр `as_of` **фиксирован на один обход**; на следующий обход передают **новый** `as_of`, иначе отфильтрованные по backoff поручения можно пропустить навсегда.

Полные SQL и EXPLAIN-заготовки — [04](storage/04-queries-and-indexes.md).

---

## 5. Локальные транзакции и межсервисные операции

### Локально (одна схема)

1. Изменение агрегата / журнала + INSERT `outbox_events` — **одна** TX.
2. Входящий факт: INSERT `processed_events` + эффект + исходящий outbox (если нужен) — **одна** TX; ack брокеру только после commit.
3. Изоляция: `READ COMMITTED` + `FOR UPDATE` / условный UPDATE / UNIQUE / transaction advisory locks.
4. Чужие схемы в TX не входят.

### Межсервисно

Единой распределённой TX нет. Координатор — `transfers` (HTTP `/internal/v1` к владельцам). Посещения инициируют списание **событием** `AttendanceRegistrationRequested`, не HTTP-клиентом к subscriptions.

| Сценарий | Кто пишет что |
| -------- | ------------- |
| Активация | только subscriptions |
| Обычная запись | schedule (`bookings.seat_status` / счётчики); subscriptions — привязка только по ordinary `BookingConfirmed`. **Confirmed место ≠ успешный bind** |
| Посещение | attendance (регистрация → отметка после Consumed) + subscriptions (consume) |
| Перенос | transfers (заявка/шаги) + subscriptions (reserve/rebind/release) + schedule (seat/confirm/source-release) |
| Отмена школой | schedule пишет урок/операцию и публикует факт; transfers **не** тратят user limit. Эффект «право сохранено» у subscriptions — **после** обработки факта, не мгновенная глобальная гарантия |

**School cancel ↔ consume (точно по 05 §6):** общий локальный `pg_advisory_xact_lock(lessonId)` сериализует INSERT `canceled_lessons`+processed и consume в **subscriptions**. Commit отмены в **schedule** ≠ локальный commit проекции. **Пока** `LessonCanceledBySchool` не доставлен и не обработан subscriptions, consume **ещё может** пройти. После уже прошедшего consume **нет** auto-restore от school cancel; `right_effect=preserved` / `school_cancellations.completed` **нельзя** заявлять без сигнала чужого эффекта (открытая граница контракта).

**Идемпотентность `event_id`:** повтор не даёт второй эффект **только если** `processed_events` сохранён и эффект был в **той же** TX. После rollback БД на старый snapshot processed/idempotency/journal/outbox после cutoff **теряются** — прежний `event_id` no-op **не** обещать (06 §5.3).

**Unknown HTTP и fencing координатора (05 §5.3):**

- До сети: sticky `actor` / `Idempotency-Key` / path / body / fingerprint в `transfer_outbound_steps`; попытка `in_flight`; для rebind — `binding_knowledge=outcome_unknown`, если ещё не `committed`.
- При unknown: **повтор тех же** входов; **не** новый ключ; **запрет compensation** при `outcome_unknown` или `committed`.
- Durable claim: `claim_owner` / `claim_until` / `claim_generation`; после `FOR UPDATE` строки transfer проверка на `clock_timestamp()`; все локальные записи воркера — в fenced TX с предикатами owner/generation/lease. Поздний HTTP старого владельца без актуального lease — rollback локальной TX; безопасность — sticky replay + предикаты owners, не «магия generation».

Инварианты при появлении таблиц/кода: одна действующая привязка; consume присутствия UNIQUE `(rightId, bookingId)`; остаток ≥ 0; вместимость confirmed + active reserves ≤ capacity; после commit — нет compensate/`rejected`.

Полная таблица операций и протокол hold — [05-transactions-and-consistency.md](storage/05-transactions-and-consistency.md), карта — [interactions.md](interactions.md).

---

## 6. Резервирование, RPO/RTO и восстановление

**Статус:** проект плана. Backup/restore/SQL drill в шаге 6.6 и 6.8 **не выполнялись**. Ориентиры ниже — **не** измерения и **не** SLA.

| Решение | Содержание |
| ------- | ---------- |
| Снимок | `pg_dump -Fc` **всей** логической базы (пять схем одним snapshot) |
| Независимая копия | физически **другой** диск / хост / удалённое хранилище; недостаточно другого раздела того же диска данных PG |
| Роли / owners / ACL | отдельно от data-dump; drill — воспроизводимый bootstrap ролей; не вслепую поверх superuser restore-кластера (см. 06) |
| Drill-контур | изолированный PostgreSQL **17.11** + отдельный брокер/vhost; **не** том `lessonplus-postgres`; приложения не против зашитого Compose URL |
| **RPO** | проектная цель **≤ 24 ч**: верхняя оценка `T_incident − SNAP_STARTED_AT` выбранной успешно проверенной **внешней** копии (`SNAP_STARTED_AT` — консервативная метка **до** `pg_dump`, не MVCC/LSN) |
| **RTO** | проектная цель **≤ 2 ч**: `T_ready − T_restore_start`, где `T_ready ≥ T_broker_reconciled` (готовность **после** broker reconciliation). Длительность создания backup в RTO **не** входит |
| Rollback снимка | теряются `processed_events`, HTTP idempotency, journal, outbox **после** cutoff; события от потерянных TX — в **карантин**, не слепой effect |
| Retained republish | выборочно, **тем же** `event_id`, включая уже `published` при потере брокера; `published_at` ≠ «все получили» |
| Sticky replay | **запрещён** до reconciliation; недостаточно доказательств → стоп / ручной разбор. Запрет compensate для unknown/committed сохраняется |

Шаблоны Bash и критерии приёмки — [06-backup-and-recovery.md](storage/06-backup-and-recovery.md).

---

## 7. Масштабирование

| Сейчас | Почему | Когда пересматривать |
| ------ | ------ | -------------------- |
| Один primary PostgreSQL (принять SPOF) | учебный прототип; CRUD/dispatcher ещё нет | измеренный потолок узла; продуктовый HA |
| Backup ≠ HA; replica ≠ backup | ошибки реплицируются на standby | появление standby не отменяет 6.6 |
| Всё чтение/запись с primary | нет контракта stale/lag | только обзорные SELECT после контракта; hot-path всегда primary |
| **Шардирование не принимать**, если ломает атомарность owner TX / locks 05 | один центр; нет измерений; `student_id` как shard key развёл бы урок | модель, сохраняющая business+outbox и processed+effect |
| Обычные (не partitioned) таблицы | UNIQUE/PK + partition key в PG17 ломают глобальную дедуп без нового дизайна | доказанный дизайн ключей/retention |
| **Бюджет соединений:** `Σ(instances × pools × pool_max) + workers + migrate + admin` ≤ лимит PG с запасом; gateway/web **без** DB | defaults `pg` не выдавать за факт | измеренный `pool_max` |
| **Failover (будущий async):** lag, fencing старого primary, возможная потеря commit не дошедших до standby; согласование по 6.6 до replay | sync replication — отдельный tradeoff, не обещание RPO=0 | drill failover+fencing+6.6 |
| **Нет auto-delete** correctness / **recovery keys** по возрасту | горизонт DLQ / recovery / restore не доказан | доказанный lifecycle + online защита |
| Публичные idempotency **≥ 72 ч** | это **минимум** + доказуемый terminal + cleanup advisory scope → row lock (05 §5.2); **не** TTL «можно удалить unknown» | forget API (открыто) |

Порядок: наблюдение → индексы/запросы → пулы → ресурсы узла → реплика/пересмотр. Подробности — [07-scaling.md](storage/07-scaling.md).

---

## 8. Соответствие OpenAPI, событий и C4

**Ручная семантическая матрица** (все схемы `components.yaml`, 20 событий с ветками `BookingCanceled`, logical vs FK, пробелы): [storage/08-cross-check-matrix.md](storage/08-cross-check-matrix.md). Краткая UUID-матрица владения — [01](storage/01-data-ownership.md); колонки API↔ddl — [03](storage/03-data-model.md). Они **не** заменяют §08.

Сжатая сводка владельцев: Subscription/LessonRight/RightReservation → subscriptions; Lesson/Booking/SeatReservation/SchoolCancellation/BookingCancellation → schedule; Attendance* → attendance; Transfer → transfers; Notification → notifications; `AcceptedOperation.resourceId` — id ресурса владельца 202; Health/`SystemStatus` — каркас.

Сжатая сводка ID: два разных `reservationId` (право vs место); `registrationId` ≠ ключ списания `(rightId,bookingId)`; `attendanceId` в RegistrationRequested = null; `event_id` ≠ `correlation_id` ≠ HTTP Idempotency-Key ≠ опц. `Error.correlationId`; `subjectType`+`subjectId` у Notification; `studentId`/`tariffId`/`groupId`/`teacherId` без OpenAPI-ресурсов справочников.

20 имён + условные recipients — catalog/schema; `LessonRightReleased` → transfers **и** schedule. C4 ↔ [c4-container-designed.mmd](diagrams/c4-container-designed.mmd) синхронизированы (компенсации HTTP, Released→schedule).

---

## 9. Статусы: каркас / проект / нужна реализация или проверка

| Тема | Статус | Подтверждение (конкретные пути) |
| ---- | ------ | ------------------------------- |
| Compose-процессы | **Реализовано в каркасе** | [compose.yaml](../../compose.yaml); [apps/web](../../apps/web); [apps/api-gateway](../../apps/api-gateway); сервисы [subscriptions](../../services/subscriptions), [schedule](../../services/schedule), [attendance](../../services/attendance), [transfers](../../services/transfers), [notifications](../../services/notifications) |
| Роли и схемы PG | **Реализовано в каркасе** | [infra/postgres/init/001-roles.sh](../../infra/postgres/init/001-roles.sh) |
| Prisma + init-миграция outbox/processed | **Код и миграции есть; живой каталог здесь не проверялся** | схемы: [subscriptions/prisma/schema.prisma](../../services/subscriptions/prisma/schema.prisma), [schedule/…](../../services/schedule/prisma/schema.prisma), [attendance/…](../../services/attendance/prisma/schema.prisma), [transfers/…](../../services/transfers/prisma/schema.prisma), [notifications/…](../../services/notifications/prisma/schema.prisma); миграции: [subscriptions/…/migration.sql](../../services/subscriptions/prisma/migrations/20261007120000_init/migration.sql), [schedule/…](../../services/schedule/prisma/migrations/20261007120000_init/migration.sql), [attendance/…](../../services/attendance/prisma/migrations/20261007120000_init/migration.sql), [transfers/…](../../services/transfers/prisma/migrations/20261007120000_init/migration.sql), [notifications/…](../../services/notifications/prisma/migrations/20261007120000_init/migration.sql) |
| Порты Outbox/Processed | **Реализовано в каркасе** | [subscriptions/…/ports.ts](../../services/subscriptions/src/application/ports.ts) (и аналоги в schedule, attendance, transfers, notifications) |
| Prisma stores | **Реализовано в каркасе** | напр. [prisma-outbox-event.store.ts](../../services/subscriptions/src/infrastructure/prisma/prisma-outbox-event.store.ts), [prisma-processed-event.store.ts](../../services/subscriptions/src/infrastructure/prisma/prisma-processed-event.store.ts) — те же имена в каждом сервисе |
| Readiness | **Реализовано в каркасе** | [check-readiness.ts](../../services/subscriptions/src/application/check-readiness.ts) (+ аналоги); [rabbitmq.service.ts](../../services/subscriptions/src/infrastructure/messaging/rabbitmq.service.ts) — connect/readiness, **не** publish |
| Health сервисов | **Реализовано в каркасе** | [health.controller.ts](../../services/subscriptions/src/presentation/health.controller.ts) (+ аналоги четырёх сервисов) |
| Gateway статусы | **Реализовано в каркасе** | [system-status.controller.ts](../../apps/api-gateway/src/presentation/system-status.controller.ts), [health.controller.ts](../../apps/api-gateway/src/presentation/health.controller.ts), [service-status.client.ts](../../apps/api-gateway/src/infrastructure/service-status.client.ts) |
| Контракты | **Спеки в репозитории** | [openapi/](../../packages/contracts/openapi/), [events/catalog.json](../../packages/contracts/events/catalog.json), [events/schema/events.schema.json](../../packages/contracts/events/schema/events.schema.json), [events/examples/](../../packages/contracts/events/examples/), [src/events.ts](../../packages/contracts/src/events.ts) |
| Domain / CRUD / saga / dispatcher / consumers | **Требует реализации** | напр. [subscriptions/src/domain/README.md](../../services/subscriptions/src/domain/README.md); [AGENTS.md](../../AGENTS.md) |
| Бизнес-DDL / ER / индексы 6.4 | **Спроектировано** | [storage/ddl/](storage/ddl/), ER §3, [04](storage/04-queries-and-indexes.md) |
| Алгоритмы TX / hold / claim | **Спроектировано** | [05](storage/05-transactions-and-consistency.md) |
| Backup/restore drill, измеренные RPO/RTO | **Требует проверки** | план [06](storage/06-backup-and-recovery.md); команды не выполнялись |
| Реплики / pooler / шарды / partitioning | **Не развёрнуты** | решение [07](storage/07-scaling.md) |
| Полная матрица ACL на живой базе | **Требует проверки** | SQL в [02](storage/02-storage-and-isolation.md); [scripts/smoke.mjs](../../scripts/smoke.mjs) — узкая операционная проверка |
| JWT, платежи, CRM, реальная доставка | **Вне этапа** | AGENTS.md / C4 |

Не называть «готовыми» бизнес-обработчики, бизнес-миграции, измерения производительности и drill восстановления — их в репозитории нет.

---

## 10. Перекрёстная проверка (шаг 6.8)

### Что выполнено инструментально (честно)

Прогон одноразовым скриптом **вне** репозитория (`%TEMP%`, удалён после выполнения). Пакеты: `js-yaml@5.4.2`, `ajv@8.20.0` из `node_modules/.pnpm` (не добавлялись в зависимости проекта).

| Проверка | Инструмент / метод | Результат | Ограничение |
| -------- | ------------------ | --------- | ----------- |
| Парсинг 7 OpenAPI YAML | `js-yaml@5.4.2` | 7/7 без ошибок: `components`, `gateway`, `subscriptions`, `schedule`, `attendance`, `transfers`, `notifications` | парсинг ≠ полная OpenAPI 3 Validator / Spectral |
| Локальные `$ref` | обход дерева + resolve `file#/pointer` | **123** уникальных локальных `$ref` разрешены; отсутствующих целей 0; внешних URL `$ref` 0 | не доказывает semantic completeness; не swagger-parser bundle |
| JSON Schema + examples | `ajv@8.20.0` compile `events.schema.json`; 21 example | schema compile ok; **21/21** examples valid | **format** `uuid` / `date-time` Ajv **игнорировал** (нет `ajv-formats` в прогоне) — форматная строгость UUID/даты не доказана |
| 20 имён + recipients | `catalog.json` ↔ `events.ts` ↔ examples | 20/20; `LessonRightReleased` → `transfers`,`schedule` | равенство имён ≠ семантика; семантика — [08](storage/08-cross-check-matrix.md) |
| Ручная матрица объектов/событий | чтение schema/catalog/`components.yaml`/ddl/03/05 | [08-cross-check-matrix.md](storage/08-cross-check-matrix.md): схемы OpenAPI + 20 фактов (Canceled ×2) + ID mapping + пробелы | не автотест; не закрывает открытые контракты изобретением API |
| DDL FK через схемы | поиск REFERENCES/JOIN чужих схем в `storage/ddl/*.sql` | не найдено | не formal SQL parser |
| Markdown-ссылки обзора + `c4.md` | existsSync целей | битых 0 | внешние URL не проверялись |
| Mermaid render | `C:/Users/User/AppData/Local/Temp/check-mermaid/.../mermaid.core.mjs` | **файл отсутствует** — render недоступен | — |
| Синтаксис `.mmd` | баланс `[]` и чётность `"` по 15 файлам `diagrams/*.mmd` | 15/15 ok | эвристика, не парсер Mermaid |
| Inline C4 designed ↔ `.mmd` | 12 рёбер `A-.->\|label\|B` | diff пуст (включая HTTP компенсаций и Released→schedule) | не layout/render |

**Не выдавалось за выполненное:** живой каталог PostgreSQL; backup/restore; EXPLAIN; полная semantic matrix «каждое поле каждого payload ↔ каждая колонка» автотестом; format-валидация UUID/date-time.

### Результаты по шести пунктам задания

| # | Проверка | Итог |
| - | -------- | ---- |
| 1 | OpenAPI-объекты/ID ↔ владельцы | Ручная матрица [08](storage/08-cross-check-matrix.md) §1 + 01/03. **Пробелы:** Student/Tariff/Teacher/Group; сигналы cancel; forget; маршрутизация Notification без studentId |
| 2 | События ↔ данные/статусы | Ajv examples + ручная матрица [08](storage/08-cross-check-matrix.md) §2 (required ID/status, ветки Canceled, условные recipients). Пробелы — в §08.3 / §11 |
| 3 | C4 ↔ interactions ↔ stores | Сервисы/PG/MQ совпадают; Released→schedule; HTTP компенсаций в inline **и** `.mmd` |
| 4 | Нет JOIN/FK/записи чужих таблиц | В ddl только внутрисхемные FK; документы запрещают |
| 5 | Перенос/consume/school-cancel/redelivery ↔ БД | Согласовано с 05 при честных пределах async school-cancel и processed-after-rollback. Пробелы: сигнал completed; HTTP restore; consume-rejected; absence |
| 6 | Retention | Согласовано 05/06/07: нет auto-delete correctness/recovery keys по возрасту; публичные ≥72h = минимум+terminal+advisory cleanup, не TTL unknown |

### Пробелы, явно не закрытые проверкой

1. Сигналы `completed` school/ordinary cancel.
2. Ordinary confirmed без успешного bind — освобождение места.
3. Absence / consume-rejected / HTTP restore.
4. Таймер `SubscriptionExpired`; лимит тарифа для transfers без чужого SQL.
5. Forget внутренних ключей; адресаты Notification без `studentId`; Student GET.
6. Полная автосверка каждого required поля payload со всеми CHECK 03.

---

## 11. Открытые вопросы (не закрыты пакетом)

1. Сигналы для `completed` у school/ordinary cancel (`rightEffect`, `transferLimitEffect`, `rightBindingEffect`).
2. Ordinary: место confirmed, bind отклонён — протокол освобождения места.
3. Списание / restore при `absence`.
4. Кто будит `SubscriptionExpired`.
5. Лимит и notice тарифа для transfers без чужого SQL и без нового payload v1.
6. Forget внутренних Idempotency-Key (OpenAPI).
7. Адресаты Notification для фактов без `studentId`.
8. Подтверждение существования карточки ученика без Student GET/события.
9. Транспорт correction → restore права (нет HTTP restore в v1).
10. Факт / сигнал `consume-rejected` для permanent отказа списания.

---

## 12. Как объяснить преподавателю (2–3 минуты)

1. **Один Postgres, пять схем и ролей** — логическая изоляция владельцев; gateway без базы; браузер только `/api`.
2. **В каркасе** в коде есть технические outbox/processed, health и контракты; бизнес-таблиц и saga ещё нет — они в DDL и шагах 6.3–6.5 (живой каталог БД этим обзором не снимался).
3. **Право** пишет только subscriptions, **место** (`bookings` / `seat_reservations`) — только schedule; transfers **координирует** HTTP-шагами; посещение списывает через **событие**.
4. **До commit** переноса: компенсация right release → проекция Released → seat release. **После commit:** Released нет; доводят confirm target и release source; TTL/school cleanup hold при unknown/committed не снимают.
5. **Backup** — dump всей базы на независимый носитель и drill на отдельном PG 17.11; RPO≤24ч / RTO≤2ч — проектные ориентиры после reconciliation, не SLA. Масштабирование — сначала измерения, **без** шардов, ломающих 05.
