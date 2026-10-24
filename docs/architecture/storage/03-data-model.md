# Модель данных

Шаг 6.3 архитектуры хранения. Владение — [01-data-ownership.md](01-data-ownership.md), изоляция — [02-storage-and-isolation.md](02-storage-and-isolation.md), запросы и индексы — [04-queries-and-indexes.md](04-queries-and-indexes.md), транзакции — [05-transactions-and-consistency.md](05-transactions-and-consistency.md). Этот документ проектирует таблицы; **не** является миграцией и **не** применяется к рабочей базе.

Пометки: **существует** — уже в Prisma/`20261007120000_init`; **проектируется** — только здесь, в ER и в [ddl/](ddl/).

Единый подход: первичные ключи и межсервисные ссылки — UUID без значения по умолчанию в БД (как у существующих `outbox_events.id`); время — `timestamptz(6)`; сроки — явные `expires_at` / целые параметры тарифа, не «магические» числа требований. FK PostgreSQL только внутри своей схемы. Чужой идентификатор — колонка UUID без `REFERENCES`.

Исходники ER: [er-subscriptions.mmd](../diagrams/er-subscriptions.mmd), [er-schedule.mmd](../diagrams/er-schedule.mmd), [er-attendance.mmd](../diagrams/er-attendance.mmd), [er-transfers.mmd](../diagrams/er-transfers.mmd), [er-notifications.mmd](../diagrams/er-notifications.mmd). Набор полей на диаграммах **сокращён**; имена и связи совпадают с `ddl/*.sql`, вымышленных колонок нет. Полные ограничения — SQL.

## Существующие технические таблицы

Во всех пяти схемах одинаково, колонки не меняются.

| Таблица | Назначение | PK | Поля |
| ------- | ---------- | -- | ---- |
| `outbox_events` | Строка факта до публикации. Диспетчер ещё не запущен | `id` = `event_id` конверта | `event_type` text NOT NULL, `schema_version` int NOT NULL, `payload` jsonb NOT NULL, `created_at` timestamptz(6) NOT NULL (= `occurred_at`), `published_at` timestamptz(6) NULL, `correlation_id` uuid NOT NULL |
| `processed_events` | Учёт обработанного входящего `event_id` в **этой** схеме | `id` = `event_id` | `processed_at` timestamptz(6) NOT NULL |

Область уникальности факта: PK `outbox_events.id` у издателя; PK `processed_events.id` у получателя. Повтор доставки с тем же `event_id` не выполняет сценарий второй раз. Это не ключ списания и не HTTP-операция. `deliveryTag` брокера сюда не пишут.

`processed_events`, изменение агрегата/журнала и исходящий `outbox_events` — **одна локальная транзакция**. Ack брокеру — только после commit. Подробности — в разделе гарантий.

`published_at` ставит диспетчер после confirm брокеру (отдельный цикл, не эта TX).

## Идентификаторы и идемпотентность

| Что | Область уникальности | Повтор | Новая операция |
| --- | -------------------- | ------ | -------------- |
| `event_id` | PK outbox издателя; PK processed получателя | Тот же id — уже обработано, ack без повторного сценария | Новый id, даже если payload похож |
| HTTP `Idempotency-Key` входящий | `(actor_kind, actor_id, method, path_template, key)` в `http_idempotency_keys` **владельца endpoint** | Тот же ключ и тот же отпечаток — сохранённый ответ | Другой ключ. Другой отпечаток при том же ключе — конфликт, не вторая операция |
| Исходящий ключ координатора | область владельца: сохранённые `actor_kind`/`actor_id` + method + `path_template` + `idempotency_key`; строка шага `(transfer_id, step)` | После unknown / `in_flight` — те же actor, ключ, path, body, fingerprint; новая операция не создаётся | Другой `step` или другая заявка |
| `registrationId` / `transferId` / `schoolCancellationId` / … | PK ресурса операции | Повтор HTTP с тем же ключом возвращает тот же id | Другой ключ — другой id операции |
| Списание присутствия | UNIQUE `(right_id, booking_id)` в `right_operations` где `kind = consumed`; `booking_id` NOT NULL по CHECK | Второй `event_id` / `registrationId` не создаёт вторую строку consume | Другая пара право+запись |
| Восстановление исходного списания | UNIQUE `consumed_operation_id` где `kind = restored` | Второй `attendanceCorrectionId` / `event_id` не создаёт второй restore | Другая consume-строка |
| Окончательная отметка | `attendances.booking_id` UNIQUE | Другой `registrationId` не создаёт второй `attendanceId` | Другой `bookingId` |
| Поручение уведомления | UNIQUE `(source_event_id, student_id, channel)` | Повтор факта не создаёт второе поручение тому же ученику в том же канале | Другой `student_id` того же факта или другой `event_id` |

Таблица `http_idempotency_keys` **проектируется** у `subscriptions`, `schedule`, `attendance`, `transfers`. У `transfers` она хранит **только** входящий публичный `POST /v1/transfers`. Внутренние `reserve` / `rebind` / `confirm` / `release` принадлежат `http_idempotency_keys` **subscriptions** и **schedule** (владельцы этих endpoint), а не входящему журналу координатора. Исходящее состояние координатора — `transfer_outbound_steps` + `transfer_outbound_attempts`.

Публичных POST уведомлений нет: повторная доставка **события** — `processed_events`; дедуп **поручения** — UNIQUE `(source_event_id, student_id, channel)` при `channel = 'imitation'`.

Срок хранения входящего ключа **открыт**. `actor_id` — текст идентичности вызывающего до появления JWT. Отпечаток не входит в область ключа (как в OpenAPI).

## Состояния и события

### Право `lesson_rights.status`

| Из | В | Команда / факт | Условие |
| -- | - | -------------- | ------- |
| (нет) | `available` | активация абонемента | создаётся N прав, N = `tariffs.lesson_count` |
| `available` | `bound` | обработка ordinary `BookingConfirmed` | `booking_id` := факт, `transfer_id` NULL |
| `bound` | `reserved` | `POST .../reservations` → `LessonRightReserved` | только из `bound`; `source_booking_id` = текущий `lesson_rights.booking_id`. Перехода `available → reserved` нет |
| `reserved` | `bound` | `POST .../releases` → `LessonRightReleased` | снова `booking_id` = source, до commit |
| `reserved` | `bound` | `POST .../rebindings` → `LessonRightTransferred` | `booking_id` := `targetBookingId`, commit. Компенсация дальше запрещена |
| `bound` | `consumed` | `AttendanceRegistrationRequested` presence → `LessonRightConsumed` | ключ `(right_id, booking_id)`; `lesson_rights.booking_id` после consume NULL |
| `consumed` | `bound` | исправление → `LessonRightRestored` | один раз на конкретную consume-операцию; `booking_id` снова исходная запись |
| `bound` | `available` | ordinary `BookingCanceled`, привязка ещё на этот `booking_id` | `unbound` в журнале |

CHECK полей: `booking_id` только при `bound`; `transfer_id` только при `reserved`; при `consumed` оба NULL. Этот CHECK **не** запрещает переход `available → consumed`: он смотрит одну новую строку, а не предыдущую. Запрет перехода — алгоритм под блокировкой строки права.

`available` ↛ `consumed` напрямую. Использованное право не переносится: `reserved` с `consumed` даёт подтверждённый `409`, не строку consume.

Автоматический restore при `absence` **не** является принятым бизнес-правилом. Модель позволяет restore только как явную операцию `kind = restored` с ссылкой на consume; когда её вызывать для отсутствия — **открыто**.

### Журнал `right_operations`

После consume `lesson_rights.booking_id` очищается. Durable-журнал обязан сохранить всё, чтобы сверить исходное списание и собрать `LessonRightRestored` (`consumedRegistrationId`, `lessonId`, `attendanceCorrectionId`, `bookingId`, `status = bound`) из [действующего контракта](../../../packages/contracts/events/schema/events.schema.json).

| `kind` | Обязательные поля (CHECK) | Запрещены |
| ------ | ------------------------- | --------- |
| `consumed` | `booking_id`, `lesson_id`, `registration_id` NOT NULL | `consumed_operation_id`, `attendance_correction_id` |
| `restored` | те же плюс `consumed_operation_id` FK на строку consume и `attendance_correction_id` | — |
| прочие | `consumed_operation_id` и `attendance_correction_id` NULL | — |

UNIQUE:

- consume один раз: `(right_id, booking_id) WHERE kind = consumed`. CHECK запрещает `booking_id` NULL у consumed/restored, поэтому частичный индекс **не** обходится NULL. Ключ списания — эта пара, **не** `event_id` и **не** `registrationId`.
- restore один раз на исходное списание: `consumed_operation_id WHERE kind = restored`.

Межстрочные проверки **не** выражаются CHECK одной строки. Транзакция под `SELECT … FOR UPDATE` строки права и строки consume проверяет: целевая операция `kind = consumed`; `right_id` / `booking_id` / `lesson_id` / `registration_id` restore совпадают с consume; `attendance_correction_id` задан. Конфликт UNIQUE restore — повтор исправления, не второе восстановление.

Self-FK `consumed_operation_id` **nullable**: NULL у всех `kind`, кроме `restored`. UNIQUE where restored даёт не больше одного потомка. На ER это 0..1 — 0..1 (`|o--o|`), а не обязательный родитель у каждой операции. Обязательность только у restore — CHECK по `kind`.

### Резерв права `right_reservations`

Создание только из `bound`. `source_booking_id` в запросе должен совпасть с действующим `lesson_rights.booking_id`; после перехода `booking_id` права NULL, исходная запись живёт на резерве. `available → reserved` **нет**: у `available` нет привязки, компенсация не должна создавать `bound` «из ничего». Конфликт `right_not_available` / `right_consumed` — без строки резерва.

`status = released` **не** говорит, каким путём резерв закрыт. Источник различения — колонка `close_reason` (журнал подтверждает: `kind = released` vs `kind = rebound` с тем же `reservation_id`).

| Переход | TX | `close_reason` | Событие / HTTP |
| ------- | -- | -------------- | -------------- |
| INSERT `active` | право `bound` → `reserved`, журнал `reserved`, outbox | NULL | `LessonRightReserved` |
| Повтор HTTP того же ключа владельца | нет второй `active` | без изменения | сохранённый 201 |
| `active` → `released` компенсация до rebind | право → `bound` к `source_booking_id`, журнал `released` | `compensated` | `LessonRightReleased`; HTTP 200 |
| Повтор успешно выполненной компенсации | уже `released` + `compensated`; ответ из `http_idempotency_keys` того же ключа шага | без изменения | HTTP 200, не новый release |
| `active` → `released` в той же TX, что rebind | право → `bound` к target, журнал `rebound` | `converted` | `LessonRightTransferred`, **не** Released |
| HTTP release после rebind (`converted` или право уже на target) | без изменения агрегата | без изменения | `409 state_conflict` / `binding_fixed` по [subscriptions.yaml](../../../packages/contracts/openapi/subscriptions.yaml) |

Терминальность: `released` конечен. Вторая `active` на то же право запрещена индексом. **UNIQUE (`transfer_id`)** на всей истории: не больше одного жизненного резерва права на transfer — Released нельзя переиспользовать для нового reserve/rebind того же transfer. Идемпотентный 200 относится **только** к повтору ключа компенсации при `close_reason = compensated`, не к любому `released`.

### Запись `bookings.seat_status` и `hold_kind`

| Из | В | Факт |
| -- | - | ---- |
| (нет) | `pending` | принят POST записи (`hold_kind = ordinary_pending`) или создан `targetBookingId` при резерве места (`hold_kind = covered_by_seat_reservation`) |
| `pending` | `confirmed` | `BookingConfirmed` (ordinary или с `transferId`); `hold_kind → none` |
| `pending` | `rejected` | **только** компенсация / отказ доведения переноса до commit (seat release по §4); `hold_kind → none` |
| `pending` | `canceled` | ordinary cancel записи в `ordinary_pending` (не путать с `rejected`) |
| `confirmed` | `canceled` | `BookingCanceled` ordinary **или** `transfer_source_release` |

`ordinary_pending` занимает `active_reserve_count`. Целевой `pending`, уже покрытый `seat_reservations` `active`, **не** даёт второй +1: его `hold_kind = covered_by_seat_reservation`, счётчик увеличивает только транзакция резерва места.

### Резерв места `seat_reservations`

| Переход | TX на занятии (`FOR UPDATE`) | Timestamps | Событие |
| ------- | ---------------------------- | ---------- | ------- |
| INSERT `active` + booking `pending` | `active_reserve_count += 1` **один раз** | `expires_at` задан; `ttl_action=wake_recovery`; `binding_protected=false` | `TransferSeatReserved` |
| Повтор HTTP того же ключа владельца | нет второй `active` | без изменения | тот же `targetBookingId` |
| `active` → `released` компенсация | только при строке `compensated_right_releases` + сверка кортежа с hold (§4.3); −1; booking **`rejected`** | `released_at` | нет имени факта release |
| `expires_at` наступил | счётчики **не** менять; диагностика / обход transfers 6.4 | без `released` | — |
| `active` → `released` после confirm | −1 reserve +1 confirmed; booking `hold_kind=none` | `released_at` | `BookingConfirmed` |
| HTTP release без проекции | **503** без записи idempotency (не terminal 409) | без изменения | — |
| School/cleanup release без проекции | **запрещён** (та же защита §4) | без изменения | — |
| Seat reserve при существующей проекции того же `transfer_id` | отказ 409; новый hold не создавать | — | — |

Авто-TTL **не** освобождает место. Проекция Released — `compensated_right_releases`, не поиск по `processed_events`. `LessonRightTransferred` не барьер освобождения.

### Перенос `transfers.status` и `binding_knowledge`

| `binding_knowledge` | Смысл |
| ------------------- | ----- |
| `unattempted` | rebind ещё не вызывали; исходящая попытка шага не фиксировалась |
| `outcome_unknown` | попытка rebind зафиксирована как `in_flight` **до** сети, либо ответ не получен, либо после сбоя осталась неотвеченная `in_flight`. У subscriptions commit **мог** произойти |
| `committed` | координатор **узнал** об успешном commit (HTTP 2xx с телом **этого** ключа или факт `LessonRightTransferred`). Достоверный commit — TX subscriptions, эта колонка — знание о нём. Не понижается |
| `owner_rejected` | подтверждённый **бизнес-отказ исходного запроса** владельцем (сохранённый ответ того же actor/key/path/body с телом `Error` вроде `right_consumed` / `right_not_available`). Не любой 4xx |

| Из | В | Условие |
| -- | - | ------- |
| — | `accepted` | `POST /v1/transfers`, факт `TransferRequested` |
| `accepted` | `in_progress` | пошли внутренние шаги |
| `in_progress` | `rejected` | только при `binding_knowledge IN (unattempted, owner_rejected)`. При `outcome_unknown` и `committed` — **запрещены** `rejected` и шаги `compensate_*` |
| `in_progress` | `completed` | знание `committed` + confirm новой записи + освобождение источника, `TransferCompleted` |

CHECK: `rejected` несовместим с `outcome_unknown`/`committed`. Это **не** доказательство, что удалённый commit не случился: при `outcome_unknown` строка просто не может стать `rejected`.

После unknown повторяется **тот же** actor, ключ, path и body из строки шага (тот же `fingerprint`). Новую операцию и новую компенсацию не начинают.

`current_step` указывает, какой шаг исполняется; воспроизводимые входы и идентичность caller — в `transfer_outbound_steps`, исход каждой попытки — в `transfer_outbound_attempts`.

**Идентичность исходящего caller.** Область `Idempotency-Key` у владельца включает вызывающую сторону. В `transfer_outbound_steps` хранятся стабильные `actor_kind` и `actor_id` **без** токенов и секретов. Для всех исходящих шагов координатора это постоянная идентичность сервиса: `actor_kind = 'service'`, `actor_id = 'transfers'`. Значения не меняются при retry и совпадают с тем, что уходит владельцу как идентичность вызывающего. JWT в таблицу не пишут.

**Crash recovery (порядок записи до сети).** Иначе сбой после commit владельца, но до записи unknown оставляет `unattempted` и **ошибочно** разрешает компенсацию.

1. В одной TX координатора: вставить строку шага, если её ещё нет (actor, method, path, params, body, key, fingerprint). Конфликт UNIQUE `(transfer_id, step)` **не** перезаписывает уже сохранённые actor/key/path/body/fingerprint; повтор читает эту строку. Затем INSERT попытки `outcome = in_flight`. Для шага `rebind` в той же TX: `binding_knowledge = outcome_unknown`.
2. Commit этой TX.
3. Только после commit — HTTP-вызов **сохранёнными** actor/key/path/body.
4. По ответу — отдельная TX: попытка `succeeded` / подтверждённый бизнес-отказ / `transport_unknown`; `binding_knowledge` для rebind: `committed` при 2xx исходного ключа или при `LessonRightTransferred`; `owner_rejected` только при подтверждённом бизнес-отказе исходного запроса и только из `unattempted`/`outcome_unknown`; иначе остаётся `outcome_unknown`.
5. Старт после сбоя: любая попытка всё ещё `in_flight` трактуется как unknown (для rebind — как `outcome_unknown`, если ещё не `committed`). Повтор читает сохранённую строку шага, без нового ключа и без смены входов.

`owner_rejected` **не** ставят по 401/403, по `409 idempotency_key_reused` после таймаута и не по «любому 4xx». Такой ответ **не** доказывает отсутствие прежнего commit и **не** понижает `committed` / `outcome_unknown`. Компенсация после него запрещена, пока знание не `unattempted` или подтверждённый бизнес-отказ исходного запроса.

Защита целевого hold между commit subscriptions и ответом/событием координатору — **не** локальный флаг заявки: протокол schedule (`ttl_action=wake_recovery` + seat release только после `LessonRightReleased`) — [05](05-transactions-and-consistency.md) §4.

## Таблицы по сервисам

Колонки «логич.» — UUID без FK. Обязательность: NOT NULL, если не сказано иначе. DEFAULT — только где указано.

### subscriptions

Справочники ученика и тарифа здесь, как в 6.1. OpenAPI их не создаёт: строки должны существовать до `POST /v1/subscriptions`.

| Таблица | Назначение | PK | Главные поля | UNIQUE / CHECK / FK |
| ------- | ---------- | -- | ------------ | ------------------- |
| `students` | Карточка и контакт родителя | `id` | `display_name`; `parent_name` / `parent_email` / `parent_phone` NULL | нет второго каталога |
| `tariffs` | Параметры продукта | `id` | `lesson_count ≥ 1`, `validity_days ≥ 1`, `transfer_limit ≥ 0`, `notice_period_hours ≥ 0` | — |
| `subscriptions` | Договор | `id` | `student_id` FK, `tariff_id` FK, `status` active\|expired, `activated_at`, `expires_at` | `expires_at > activated_at`; UNIQUE `(id, student_id)` для составного FK права |
| `lesson_rights` | Единица остатка | `id` | `subscription_id`+`student_id` составной FK на абонемент, `status`, `booking_id` логич., `transfer_id` логич., `created_at` | CHECK статус↔поля; UNIQUE bound `booking_id`; UNIQUE reserved `transfer_id` |
| `right_reservations` | Резерв права под перенос | `id` | `right_id` FK, `transfer_id` логич., `source_booking_id` логич., `status` active\|released, `close_reason` compensated\|converted, `created_at`, `released_at` | один active на `right_id`; **UNIQUE lifetime `transfer_id`**; ветка `released`: `released_at` **и** `close_reason` оба NOT NULL |
| `right_operations` | Durable-журнал; публичного GET нет | `id` | `kind`, статусы, `booking_id`/`lesson_id`/`registration_id`, `consumed_operation_id` FK, `attendance_correction_id` логич., `event_id` | CHECK обязательности по kind; UNIQUE consume `(right_id, booking_id)`; UNIQUE restore по `consumed_operation_id` |
| `canceled_lessons` | Проекция `LessonCanceledBySchool` | `lesson_id` | `school_cancellation_id`, `canceled_at` | блокирует consume; сериализация с consume — [05](05-transactions-and-consistency.md) §6 |
| `http_idempotency_keys` | Входящие POST; внутренние recovery-ключи **не** auto-delete (05 §5.2) | `id` | область + ключ + отпечаток + сохранённый ответ | UNIQUE области ключа |

`Subscription.balance` API **не** хранится: это `COUNT(*)` прав в `available|reserved|bound`. Отрицательным не бывает, потому что прав не удаляют ниже нуля и алгоритм consume только из `bound`.

Активация в одной транзакции: subscription + N rights `available` + journal `created` + outbox `SubscriptionActivated`. Истечение: `active` → `expired` у владельца, внешнего HTTP нет; кто будит таймер — **открыто**.

Составной FK `(subscription_id, student_id)` сверяет `lesson_rights.student_id` с `subscriptions.student_id`. Одиночный FK только на `subscription_id` эту сверку **не** даёт.

### schedule

| Таблица | Назначение | PK | Главные поля | UNIQUE / CHECK / FK |
| ------- | ---------- | -- | ------------ | ------------------- |
| `teachers` | Справочник | `id` | `display_name` | — |
| `groups` | Группа | `id` | `teacher_id` FK, `name` | — |
| `lessons` | Проведение и вместимость | `id` | `group_id` FK, `teacher_id` FK, `starts_at`/`ends_at`, `capacity ≥ 1`, счётчики, `status` | `ends_at > starts_at`; CHECK **на той же строке** `confirmed + active_reserve <= capacity` |
| `bookings` | Место ученика | `id` | `lesson_id` FK, `student_id`/`right_id` логич., `transfer_id` логич. NULL, `seat_status`, `hold_kind`, `created_at` | UNIQUE `(id, lesson_id, student_id, right_id)` для составного FK резерва |
| `seat_reservations` | Резерв места переноса | `id` | составной FK на booking, `transfer_id` логич., `expires_at`, `ttl_action='wake_recovery'`, `binding_protected`, `status`, timestamps | один active на `transfer_id` / `target_booking_id`; release — [05](05-transactions-and-consistency.md) §4 |
| `compensated_right_releases` | Durable проекция `LessonRightReleased` | `event_id` | `transfer_id` UK, `right_id`, `student_id`, `right_reservation_id` UK, `source_booking_id`, `processed_at` | атомарно с `processed_events` под advisory(`transferId`); сверка hold по transfer/right/student/target booking; reservation/source — аудит |
| `school_cancellations` | Операция 202 | `id` | эффекты `pending`…, `status` | `completed` только при canceled+preserved+not_spent |
| `booking_cancellations` | Обычная отмена | `id` | `seat_effect`, `right_binding_effect` | сигнал чужой привязки **открыт** |
| `http_idempotency_keys` | входящие POST этого сервиса (занятия, записи, seat-reservations, confirm, transfer-releases) | `id` | | |

Каждая `seat_reservations` имеет ровно один `target_booking_id` (NOT NULL FK). У записи 0..N резервов за историю и **не больше одного** `active`.

`freeSeatCount` API = `capacity − confirmed − active_reserve`. Счётчики — не `COUNT` соседней таблицы в CHECK. Их меняет транзакция, которая держит строку занятия.

Обычный `pending` (`hold_kind = ordinary_pending`) занимает `active_reserve_count`. Это отображение на формулу OpenAPI без отдельного `pendingBookingCount` нужно **согласовать**.

`transfer-releases` исходного места не трогает целевой резерв.

Сверка `target_booking_id` заявки переноса с `seat_reservations.target_booking_id` — **не** FK (разные схемы): координатор записывает оба id из ответов владельцев и сверяет алгоритмом; локально у schedule составной FK уже требует совпадения урока/ученика/права записи и резерва.

### attendance

| Таблица | Назначение | PK | Главные поля | UNIQUE / CHECK / FK |
| ------- | ---------- | -- | ------------ | ------------------- |
| `attendance_registrations` | Принятый HTTP-запрос отметки | `id` = `registrationId` | логич. booking/student/lesson/right, `mark`, `status`, `right_effect`, `attendance_id` NULL | UNIQUE `(id, booking_id, student_id, lesson_id, right_id)` |
| `attendances` | Окончательная отметка | `id` = `attendanceId` | составной FK на регистрацию (тот же кортеж), UNIQUE `booking_id`, UNIQUE `registration_id` (не больше одной отметки на регистрацию), UNIQUE `(id, registration_id)` для FK исправлений, `mark`, `status`, `right_effect` | канон 0..1; кортеж не расходится с исходной регистрацией |
| `attendance_corrections` | Запрос **и** история применения | `id` | FK `(attendance_id, source_registration_id)` на отметку, `consumed_registration_id` логич. (корреляция исходного consume), `requested_mark`, `reason`, `status`, эффекты, `previous_mark`/`new_mark`/`previous_right_effect`/`new_right_effect`, `applied_at` | UNIQUE in-flight на `attendance_id`; `completed` ⇒ снимки и `applied_at` NOT NULL |
| `http_idempotency_keys` | входящие POST регистраций и исправлений | `id` | | |

Каноническая связь: `attendances.registration_id` NOT NULL → регистрация; UNIQUE `registration_id` даёт не больше одной отметки. Регистрация без отметки допустима до завершения (0..1).

`attendance_registrations.attendance_id` — **nullable обратный указатель**, не вторая кардинальность 1..N. Его нет на ER как отдельной обязательной связи. Сверка алгоритмом в той же TX, что INSERT отметки: если указатель задан, `attendances.id = registration.attendance_id` **и** `attendances.registration_id = registration.id`. Одиночный FK на `attendances.id` это не проверяет; составной FK отметки сверяет booking/student/lesson/right.

Порядок: INSERT регистрации (`attendance_id` NULL) → после `LessonRightConsumed` INSERT отметки → UPDATE указателя.

Разделение строк исправления:

| `status` | Что зафиксировано | Снимки / `applied_at` |
| -------- | ----------------- | --------------------- |
| `accepted` / `in_progress` | принятый запрос, ещё не применён | NULL |
| `rejected` | неуспешная попытка (`failure_reason`) | NULL; отметку не меняли |
| `completed` | фактически применённая корректировка | предыдущая и новая отметка и `right_effect`, `applied_at` |

`consumed_registration_id` — `registrationId` исходного `LessonRightConsumed` (если consume был), чтобы подставить `LessonRightRestored.consumedRegistrationId`. Это не ключ списания.

Конкурентные исправления одной attendance: `SELECT … FOR UPDATE` строки `attendances` плюс частичный UNIQUE одной in-flight коррекции. Вторая параллельная вставка in-flight получает конфликт.

Для `absence` `right_effect` может остаться `unspecified`. Модель **не** добавляет правил списания за отсутствие и **не** считает restore-on-absence решённым.

### transfers

| Таблица | Назначение | PK | Главные поля | UNIQUE / CHECK / FK |
| ------- | ---------- | -- | ------------ | ------------------- |
| `transfer_rules` | Параметры координатора | `id` | `notice_period_hours`; `school_cancel_spends_user_limit` DEFAULT false **и** CHECK `NOT school_cancel_spends_user_limit` | CHECK кодирует принятый инвариант; сам DEFAULT запрет траты **не** гарантирует |
| `transfers` | Заявка и знание координатора | `id` | `rule_id` FK, логич. ссылки, `binding_knowledge`, `current_step`, `status`, **`claim_owner`/`claim_until`/`claim_generation≥0`** + CHECK парности claim | `rejected` только unattempted/owner_rejected; `completed` ⇒ committed + target; fencing — [05](05-transactions-and-consistency.md) §5.3 |
| `transfer_outbound_steps` | Воспроизводимый исходящий вызов шага | `id` | `transfer_id` FK, `step`, `owner_service`, **`actor_kind`/`actor_id`**, method/path/`path_params`/`request_body`, `idempotency_key`, `fingerprint` | UNIQUE `(transfer_id, step)`; UNIQUE ключа в заявке |
| `transfer_outbound_attempts` | Исход попытки | `id` | `step_id` FK, `attempt_no ≥ 1`, `outcome`, HTTP статус/тело NULL | UNIQUE `(step_id, attempt_no)` |
| `http_idempotency_keys` | **только** входящий `POST /v1/transfers` | `id` | | |

Связь `transfer_rules → transfers` — поле `transfers.rule_id` FK. Снимка лимита тарифа в заявке нет: как получить параметры без SQL абонементов и без нового поля события версии 1 — **открыто**.

Запрет траты пользовательского лимита при отмене школой: обработчик `LessonCanceledBySchool` в transfers **не** увеличивает usage; CHECK колонки правила запрещает значение `true`. `DEFAULT false` без обработчика и без CHECK был бы только начальным значением строки.

### notifications

| Таблица | Назначение | PK | Главные поля | UNIQUE / CHECK / FK |
| ------- | ---------- | -- | ------------ | ------------------- |
| `notifications` | Поручение имитации **одному** ученику | `id` | логич. student/subject, `source_event_id`, `status`, `channel=imitation`, `recorded_at`, **`next_attempt_no`** (6.5) | UNIQUE `(source_event_id, student_id, channel)`; инвариант `next_attempt_no = MAX(attempt_no)+1` |
| `notification_delivery_attempts` | Попытки канала | `id` | `notification_id` FK, `attempt_no ≥ 1`, `result` delivered\|failed | UNIQUE `(notification_id, attempt_no)`; без `in_progress` |

Один факт на занятие без `studentId` (`LessonCanceledBySchool`, также `LessonScheduled`) порождает **несколько** поручений: по строке на каждого адресата. Дедуп поручения — тройка `(source_event_id, student_id, channel)`; канал принят только `imitation`. Повторная доставка **того же события** по-прежнему идёт через `processed_events`: один `event_id` → одна TX, в ней N INSERT поручений.

`failed` не каскадирует откат бизнеса. HTTP идемпотентности нет.

Определение получателей события без `studentId`: **открыто**. Допустимый путь без чужого SQL и без копии каталога контактов — HTTP-контракт **владельца** факта (для отмены занятия — schedule как владелец записей, например существующий GET записей урока, если он отдаёт `studentId`). Notifications не читает схемы schedule/subscriptions. Маршрутизация такого уведомления **не** полностью покрыта контрактами v1: в payload нет списка учеников, вызов notifications→schedule в [interactions](../interactions.md) не зафиксирован, состав «кто адресат, если записей ещё нет» (`LessonScheduled`) не задан.

## Инварианты: БД и алгоритм

Обычный `CHECK (SELECT COUNT(*) FROM другая_таблица)` **не используется**. Предварительный `SELECT freeSeatCount` без блокировки строки занятия **не** гарантирует запись. CHECK enum/status проверяет **новую** строку и **не** видит предыдущую: он не запрещает `available → consumed` и не проверяет, что restore ссылается на consume того же права. Boolean CHECK (`binding_protected`, `school_cancel_spends_user_limit`) не доказывает фактический удалённый commit и сам по себе не выполняет обработчик события.

### Обработка события: одна локальная TX, конфликт, ack

1. Открыть TX. Вставить `processed_events(id = event_id)` **вместе** с изменением агрегата, журнала и исходящего `outbox_events` (если факт исходящий нужен).
2. Commit. Затем ack брокеру.
3. Конфликт PK `processed_events`: эта схема уже обработала id → rollback этой попытки (если ещё не commit) и **ack без повторного сценария**.
4. Ошибка до commit → rollback всего, включая `processed_events`. Политика повтора **не** меняется и **не** обещает бесконечный немедленный `nack(requeue=true)`: как в [events README](../../../packages/contracts/events/README.md) и [interactions.md](../interactions.md) — копия с тем же `event_id`, не больше пяти TTL-ступеней, затем DLQ сервиса; `nack(requeue=true)` в проекте не используется.
5. Сбой **после** commit и **до** ack → брокер ределиверит то же сообщение с тем же `event_id`; повтор попадёт в п. 3. Потеря обработки возникает только если `processed_events` записать в **другой** TX раньше агрегата — так делать нельзя.

Исходящая публикация диспетчером (`published_at`) — отдельный цикл после commit outbox.

| Инвариант | Гарантия БД | Гарантия транзакционного алгоритма |
| --------- | ----------- | ---------------------------------- |
| Повтор `event_id` не списывает дважды | PK `processed_events` **в той же TX**, что consume | Сценарий только если INSERT processed успел; иначе ack |
| Списание присутствия один раз на пару | UNIQUE `(right_id, booking_id)` where consumed; CHECK `booking_id` NOT NULL | `FOR UPDATE` права; consume только из `bound`; сверка student/lesson/registration с фактом. Не заменять ключ на `event_id`/`registrationId` |
| Restore исходного списания один раз | UNIQUE `consumed_operation_id` where restored; CHECK полей restored | `FOR UPDATE` consume-строки; kind/right/booking/lesson/registration совпадают. Restore-on-absence не задан |
| Остаток ≥ 0 | права не удаляют «в минус» | Не consume из `available`/`reserved`; не создавать больше consume, чем прав |
| Одна действующая привязка | CHECK полей статуса; UNIQUE `booking_id` where bound | Ordinary bind и rebind меняют одну строку права в TX с outbox |
| Перенос vs списание | UNIQUE active `right_reservations` на `right_id`; статус `reserved` исключает `bound` | Блокировка строки права; `409 right_consumed` / конфликт reserve |
| Вместимость | CHECK **на строке занятия**: сумма счётчиков ≤ `capacity` | `FOR UPDATE` занятия; ±1 в той же TX. Ordinary pending и transfer hold не двойного счёта (`hold_kind`) |
| TTL / protection целевого hold | `expires_at` + `ttl_action=wake_recovery` (не −1); `binding_protected` наблюдаемость | Авто-TTL не освобождает; seat release только после локального `LessonRightReleased` или confirm — [05](05-transactions-and-consistency.md) §4. `LessonRightTransferred` не барьер освобождения |
| Commit vs rejected | CHECK `rejected` только при unattempted/owner_rejected | При `outcome_unknown` не compensate и не reject; повтор того же исходящего ключа rebind |
| Отмена школой сохраняет право и не тратит лимит | нет FK на право; CHECK `NOT school_cancel_spends_user_limit` | Обработчик `LessonCanceledBySchool` в subscriptions не consume и не delete; в transfers не увеличивает usage. DEFAULT колонки — не эта гарантия |
| Идемпотентность входящего HTTP | UNIQUE области ключа у **владельца endpoint** | Сравнение отпечатка; таймаут клиента ≠ отсутствие эффекта |
| Исходящие шаги координатора | UNIQUE шага заявки; попытки ссылаются на шаг; колонки actor | `in_flight` и для rebind `outcome_unknown` до сети; после сбоя неотвеченная `in_flight` = unknown; повтор того же actor/key/path/body; `owner_rejected` только бизнес-отказ исходного запроса |
| Уведомление без отката | нет FK на чужие агрегаты; UNIQUE поручения `(event, student, channel)` | N поручений в той же TX, что processed; failed не пишет компенсацию бизнеса |

Дублируемые локальные идентификаторы — не одиночный FK:

| Пара | Что сверяет |
| ---- | ----------- |
| `lesson_rights.student_id` и `subscriptions.student_id` | составной FK `(subscription_id, student_id)` при UNIQUE `(id, student_id)` у абонемента |
| `seat_reservations` и `bookings` (урок, ученик, право, id записи) | составной FK `(target_booking_id, lesson_id, student_id, right_id)` |
| `attendances` и `attendance_registrations` (тот же кортеж) | составной FK `(registration_id, booking_id, student_id, lesson_id, right_id)` |
| `transfers.target_booking_id` и `seat_reservations.target_booking_id` | нет FK (разные схемы); алгоритм координатора сверяет id из ответов владельцев |
| `lesson_rights.booking_id` после bind и `bookings.id` | нет FK; ordinary bind / rebind сверяют payload/HTTP |

`balance` и `freeSeatCount` — производные. Чтение `freeSeatCount` место не удерживает.

## Соответствие API и событиям

Проверяемое сопоставление нужных данных с колонками / вычислением. Это не утверждение «все 20 фактов закрыты».

| Источник | Нужные данные | Колонки / вычисление | Пробел контракта, если есть |
| -------- | ------------- | -------------------- | --------------------------- |
| `POST /v1/subscriptions`, `SubscriptionActivated` | student, tariff, N прав, balance | `subscriptions.*`; N = `tariffs.lesson_count`; journal `created`; outbox; balance = COUNT прав | Student/Tariff HTTP нет |
| `SubscriptionExpired` | status expired | `subscriptions.status` | кто будит таймер — открыто |
| GET subscription/rights | id, status, bookingId, studentId | `lesson_rights.*` | списки API сортируют по `id`, в модели есть `created_at` |
| `POST .../reservations`, `LessonRightReserved` | reservationId, transferId, source booking | `right_reservations` + статус права `reserved` | — |
| `POST .../releases`, `LessonRightReleased` | возврат bound к source | `close_reason = compensated`, `released_at` | повтор ключа компенсации → 200; после `converted` → `409 binding_fixed` |
| `POST .../rebindings`, `LessonRightTransferred` | targetBookingId, commit | журнал `rebound`; право `bound`; исходящий outbox | freeze TTL у schedule этим событием не закрыт |
| `LessonRightConsumed` | rightId, bookingId, lessonId, registrationId | `right_operations` consumed (все четыре поля); право `consumed`, `booking_id` NULL | — |
| `LessonRightRestored` | consumedRegistrationId, lessonId, attendanceCorrectionId, bookingId | restore-строка + FK на consume | когда звать при absence — не задано |
| `POST /v1/lessons`, `LessonScheduled` | урок, capacity, status | `lessons.*` | в payload нет адресатов уведомления |
| GET lesson `freeSeatCount` | capacity − занято | `capacity − confirmed − active_reserve` | ordinary pending в счётчике vs формула OpenAPI без pending |
| `POST .../seat-reservations`, `TransferSeatReserved` | в контракте v1: `seatReservationId` / `id`, `targetBookingId`, `status=active` (expiresAt **нет** ни в payload, ни в OpenAPI `SeatReservation`) | те же поля + проектная колонка `expires_at` (только внутренняя) | TTL до commit / protection после commit открыты; `expires_at` в контракт v1 не входит |
| confirm / `BookingConfirmed` | seat confirmed, transferId optional | `seat_status`, счётчики, `hold_kind none` | ordinary confirmed без привязки — протокол открыт |
| `BookingCanceled` | cause ordinary vs transfer_source_release | `booking_cancellations` / cancel source | `rightBindingEffect` без нового события — хранится pending |
| `LessonCanceledBySchool` | lessonId, schoolCancellationId, без studentId | `school_cancellations`; урок `canceled_by_school` | список адресатов Notification не в payload; GET владельца не зафиксирован как канал notifications |
| `POST /v1/attendance-registrations`, `AttendanceRegistrationRequested` | registrationId, mark, rightEffect | `attendance_registrations` | правило consume для absence не задано |
| `AttendanceRecorded` / `AbsenceRecorded` | attendanceId, mark, rightEffect | `attendances` | Absence не утверждает списание |
| `POST .../corrections` | previous/new mark, right_effect, applied_at, source registration | `attendance_corrections` completed vs rejected | restore-on-absence не задан |
| `POST /v1/transfers`, `TransferRequested` | transferId, current_step | `transfers` + inbound idempotency | процессные поля не в публичном `Transfer` |
| исходящие шаги | ключ, тело, fingerprint, outcome | `transfer_outbound_steps` / `_attempts` | нет в публичном API |
| `TransferCompleted` / `TransferRejected` | status, knowledge | CHECK knowledge; outbox | лимит тарифа координатор не читает SQL и не имеет поля v1 |
| `Notification` / Delivered / Failed | studentId, channel=imitation, source event | `notifications` + attempts | факты без studentId: маршрутизация не покрыта контрактами v1 |

Модель **не** добавляет 21-е событие и не закрывает списание отсутствия. Протокол целевого hold — [05](05-transactions-and-consistency.md) §4 (согласовано с ddl/`ttl_action`, recipients Released).

## Что существует, что проектируется, что открыто

**Существует:** `outbox_events`, `processed_events` в пяти схемах (структура init).

**Проектируется:** все таблицы `ddl/*.sql`, ER, состояния резервов, `close_reason`, журнал consume/restore, `transfer_outbound_steps`/`_attempts` с actor, `binding_knowledge`, поручения `(event, student, channel)`, снимки применённой корректировки, составные FK локальной сверки, счётчики занятия и `hold_kind`; плюс 6.5: `ttl_action`, `compensated_right_releases`, `claim_*`+CHECK, `next_attempt_no`, `canceled_lessons` в subscriptions.

**Открыто (не закрыто моделью 6.3 / частично закрыто 6.5):**

- таймер `expired` абонемента;
- канал forget внутренних Idempotency-Key (до него внутренние ключи **не** auto-delete, см. 05 §5.2);
- ordinary `BookingConfirmed` затем отказ bind и освобождение уже занятого места;
- правило списания за `absence` и restore-on-absence;
- лимит/срок тарифа для transfers без чужого SQL и без нового payload v1;
- Student GET; связь JWT с `studentId`;
- факт отказа списания (`consume-rejected`); attendance не выводит permanent из тишины;
- транспорт correction→restore (HTTP restore / `RestoreRightRequest` в OpenAPI v1 нет);
- завершение school/ordinary cancel `completed` по чужим эффектам без сигнала;
- как notifications узнаёт адресатов факта без `studentId` через HTTP владельца (контракт v1 маршрутизацию полностью не покрывает);
- сортировка списков API по `id` vs `created_at`.
