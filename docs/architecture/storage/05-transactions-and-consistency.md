# Транзакции и согласованность

Шаг 6.5 архитектуры хранения. Модель — [03-data-model.md](03-data-model.md) / [ddl/](ddl/), запросы — [04-queries-and-indexes.md](04-queries-and-indexes.md), карта — [interactions.md](../interactions.md). Резервное копирование — [06-backup-and-recovery.md](06-backup-and-recovery.md).

Пометки: **существует** — `outbox_events` / `processed_events`; **проектируется** — алгоритмы и отмеченные расширения модели/контрактов. Код, исполняемые миграции и живая БД не меняются этим шагом. Проверки ниже — **пошаговый анализ**, не интеграционные тесты и не прогон SQL.

Общие правила локальной TX:

1. Агрегат / журнал + исходящий `outbox_events` — одна TX.
2. Входящее событие: `processed_events` + локальный эффект + исходящий outbox (если нужен) — одна TX; ack только после commit; повтор — пять TTL, затем DLQ; без `nack(requeue=true)`.
3. Чужие схемы не читать. HTTP только к владельцу endpoint / факты каталога (плюс **проектные** расширения, явно помеченные ниже).
4. `READ COMMITTED` + `SELECT … FOR UPDATE`, условный `UPDATE`, UNIQUE 6.3, transaction advisory locks где указано.
5. Порядок блокировок: для HTTP — §5.1 (scope advisory → SELECT idempotency → при miss business locks); для событий/агрегатов — advisory предметной области (lesson/transfer/booking) → агрегат → дети → journal/outbox/processed. Deadlock / serialization: до **3** повторов TX, затем 503 или TTL события.

---

## 1. Таблица операций

| Операция | Владелец | Читает | Изменяет | Порядок блокировок | Критерий успеха | Факт / ответ |
| -------- | -------- | ------ | -------- | ----------------- | --------------- | ------------ |
| Активация абонемента | subscriptions | tariff, student | `subscriptions` active+окно; N×`lesson_rights` `available`; outbox | subscription → rights → outbox | N прав созданы; outbox `SubscriptionActivated` в той же TX | `SubscriptionActivated` |
| Ordinary accept | schedule | lesson | booking `pending`/`ordinary_pending`; `active_reserve +1` | lesson FOR UPDATE → booking | `status=scheduled`; `confirmed+reserve < capacity` до +1; строка booking | HTTP 2xx; факта нет |
| Ordinary confirm | schedule | lesson, booking | −1 reserve +1 confirmed; `hold_kind=none`; outbox | lesson → booking | booking был `pending`+`ordinary_pending`; без `< capacity` | `BookingConfirmed` |
| Ordinary bind | subscriptions | right, subscription | право `available→bound`, `booking_id`:=факт, `transfer_id` NULL; processed (kind ordinary-bind в 6.3 **нет** — не выдумывать) | right FOR UPDATE → processed | §3.2; CHECK статус↔поля | — (consumer `BookingConfirmed`) |
| Right reserve | subscriptions | right | reservation `active`; право `bound→reserved`, `booking_id` NULL, `transfer_id`:=transfer; journal `kind=reserved`; outbox | right → reservation → journal → outbox + idempotency | §3.3; UNIQUE active на right; **UNIQUE lifetime `transfer_id`** на `right_reservations` | `LessonRightReserved` |
| Right release (compensate) | subscriptions | right, reservation | reservation `released`/`compensated`; право `reserved→bound`, `booking_id`:=source, `transfer_id` NULL; journal `kind=released`; outbox Released | right → reservation → journal → outbox + idempotency | active reservation; не после `converted` | `LessonRightReleased` |
| Rebind (commit привязки) | subscriptions | right, reservation | reservation `released`/`converted`; право `reserved→bound`, `booking_id`:=target, `transfer_id` NULL; journal `kind=rebound`; outbox Transferred | right → reservation → journal → outbox + idempotency | active reservation; targetBookingId | `LessonRightTransferred` |
| Seat reserve | schedule | lesson, проекция | booking pending+`covered_by_seat_reservation`; seat `active`; +1 reserve; outbox | **advisory(`transferId`)** → lesson → booking/seat → outbox + idempotency | lesson scheduled; `< capacity`; нет `compensated_right_releases` (§4.3) | `TransferSeatReserved` |
| Seat release (все пути §4) | schedule | lesson, seat, проекция | −1 reserve; booking `rejected` (compensate) или запрет; seat `released` | **advisory(`transferId`)** → lesson → seat → проекция | §4.3–4.5; **одна** защита для всех release | HTTP; имени факта нет |
| Transfer confirm | schedule | lesson, seat, booking | −1 reserve +1 confirmed; seat released; `hold_kind=none`; outbox | advisory(`transferId`) → lesson → booking/seat | hold учтён; без `< capacity` | `BookingConfirmed` |
| Source transfer-release | schedule | lesson, source booking | −1 confirmed; booking canceled; outbox | lesson → booking | source был confirmed | `BookingCanceled` `transfer_source_release` |
| Registration | attendance | attendance canonical | registration accepted (несколько pending на booking **допустимы**); outbox request | advisory(`bookingId`) → read `attendances` → INSERT registration → outbox + idempotency | §3.6; если canonical attendance уже есть → 409 `attendance_exists` | 202; `AttendanceRegistrationRequested` |
| Consume | subscriptions | right, canceled_lessons | journal `kind=consumed`; право `bound→consumed`, `booking_id`/`transfer_id` NULL; outbox | advisory(`lessonId`) → right → journal → processed/outbox | §3.1 + §6 | `LessonRightConsumed` |
| Attendance finalize (после Consumed) | attendance | registration | attendance; registration status/right_effect; outbox | advisory(`bookingId`) → registration → attendance → processed | полный кортеж; UNIQUE `attendances.booking_id` | `AttendanceRecorded` / `AbsenceRecorded` |
| Correction (приём) | attendance | attendance | correction `accepted`/`in_progress`; **не** `completed`/снимки | advisory/attendance locks | HTTP 202; снимки применения — только после подтверждённого результата (§3.7) | — |
| Restore (локальный алгоритм subscriptions) | subscriptions | right, consume journal | journal `kind=restored`; право `consumed→bound`, `booking_id`:=исходный; outbox Restored | right → consume-row → restore UNIQUE → outbox | сверка correlation; UNIQUE restore. **Межсервисный транспорт команды от correction в OpenAPI v1 не задан** (нет HTTP restore / `RestoreRightRequest`) | `LessonRightRestored` |
| Consumer `LessonRightReleased` | schedule | payload | INSERT `compensated_right_releases` + `processed_events` | **advisory(`transferId`)** → проекция + processed | UNIQUE event_id / transfer_id; ack после commit | — |
| Ordinary cancel | schedule | lesson, booking | booking `canceled`; −1 по статусу; cancellation `in_progress`/`pending` right effect | lesson → booking → cancellation | seat canceled; **не** `completed` без `right_binding_effect` | `BookingCanceled` ordinary |
| School cancel (lesson) | schedule | lesson | lesson `canceled_by_school`; school_cancellation; outbox | lesson → cancellation | урок canceled; эффекты права/лимита — pending без сигнала | `LessonCanceledBySchool` |
| School/ordinary: дочерние записи | schedule | lesson, bookings, seats | см. §2.2; transfer hold — **только** через §4 | advisory(`transferId`) при работе с transfer seat → lesson → booking/seat | новые accept/reserve запрещены; post-commit hold не «молча −1» | по пути |
| Transfer accept | transfers | rules | transfer accepted; outbox Requested; inbound idempotency | transfer → outbox + idempotency | заявка создана | `TransferRequested` |
| Transfer worker step | transfers | transfer, outbound step | claim/fencing §5.3; attempt; knowledge; outbox Completed/Rejected | claim UPDATE → step/attempt/transfer | sticky committed; sticky keys | Completed / Rejected |
| Notification deliver (imitation) | notifications | notification | attempt; `next_attempt_no`; status; outbox | notification FOR UPDATE → attempt | §5.4 | Delivered / Failed |

---

## 2. Конкуренция и вместимость

### 2.1. Списание vs перенос

`FOR UPDATE` строки `lesson_rights`. Предикаты — §3. UNIQUE consume; UNIQUE active `right_reservations`.

### 2.2. Вместимость — единый механизм

Все пути изменения счётчиков: **сначала** `SELECT lessons … FOR UPDATE`, затем дочерние строки. Перед каждым −1: проверить **ожидаемый** `seat_status` / `hold_kind` / `seat_reservations.status` этой строки; иначе no-op / conflict, без повторного decrement. После confirm всегда `hold_kind=none`.

| Путь | Условие до изменения | Δ confirmed | Δ active_reserve | Статусы / hold_kind |
| ---- | ------------------- | ----------- | ---------------- | ------------------- |
| Ordinary accept | lesson `scheduled`; `confirmed+reserve < capacity` | 0 | +1 | booking `pending`, `ordinary_pending` |
| Ordinary confirm | booking `pending`+`ordinary_pending`; **без** `< capacity` | +1 | −1 | `confirmed`, **`hold_kind=none`** |
| Ordinary cancel (`pending`+`ordinary_pending`) | ожидаемые статусы | 0 | −1 | booking **`canceled`** (не `rejected`); `hold_kind=none`. `rejected` зарезервирован за компенсацией/отказом доведения переноса (6.3) |
| Ordinary cancel (`confirmed`) | seat `confirmed` | −1 | 0 | `canceled`; `hold_kind` уже `none` |
| Transfer seat reserve | lesson `scheduled`; `< capacity`; нет строки запрета §4.5 | 0 | +1 | pending + `covered_by_seat_reservation`; seat `active`; `ttl_action=wake_recovery` |
| Transfer confirm | booking pending+covered; seat `active`; **без** `< capacity` | +1 | −1 | `confirmed`; seat `released`; **`hold_kind=none`** |
| Transfer compensate seat | **только** §4.3 (проекция Released + сверка кортежа) | 0 | −1 | booking **`rejected`**; seat `released`; `hold_kind=none` |
| Transfer TTL / recovery wake | — | **0** | **0** | статусы без изменения; диагностика / обход transfers 6.4 |
| Source transfer-release | source `confirmed` | −1 | 0 | source `canceled` |
| School cancel (урок) | — | 0 | 0 | lesson `canceled_by_school`; **новые** accept/reserve → conflict |
| School/ordinary: ordinary pending booking | как ordinary cancel pending | 0 | −1 | `canceled`, `none` |
| School/ordinary: confirmed booking | как ordinary cancel confirmed | −1 | 0 | `canceled` |
| School/ordinary/cleanup/recovery: **transfer active seat** | **те же предикаты §4.3**, что compensate | 0 или запрет | −1 только если §4.3 | **запрещено** освобождать при unknown/совершённом rebind; без проекции Released — **не** −1 |

Confirm при `confirmed+reserve = capacity` **обязан** проходить: сумма не растёт.

`freeSeatCount` без FOR UPDATE не резервирует.

### 2.3. Ordinary cancellation и right_binding_effect

По 6.3 `completed` только при `seat_effect=canceled` **и** `right_binding_effect ∈ {released, not_applicable}`. Пока сигнала от subscriptions нет — `right_binding_effect=pending`, статус операции `in_progress` / не `completed`.

### 2.4. Post-commit hold на отменённом занятии

Если rebind уже committed, а lesson затем `canceled_by_school`:

1. Целевой hold **не** снимать молча (§4).
2. Координатор **доводит** confirm (перевод hold→confirmed, `hold_kind=none`) и source-release по sticky шагам.
3. Отмена уже confirmed записи / согласование right_effect — **отдельный** путь school/ordinary cancel записи; операция cancel остаётся `in_progress` по эффектам без сигнала.
4. Нельзя ни «зависнуть навсегда» из‑за `canceled` lesson на шаге confirm (confirm существующего hold **не** требует lesson=`scheduled` для −1/+1 уже учтённого места — достаточно FOR UPDATE строки и предикатов hold), ни выкинуть hold без §4.

---

## 3. Предикаты идентичности

### 3.1. Consume (`AttendanceRegistrationRequested`, presence)

В одной TX: `pg_advisory_xact_lock(lessonId)` (§6) → `FOR UPDATE` права → journal + processed + outbox **только при успехе consume или при permanent (§ ниже)**.

Успех consume:

1. Нет строки `canceled_lessons` с `lesson_id = payload.lessonId`.
2. `status = 'bound'`.
3. `lesson_rights.booking_id = payload.bookingId` (текущая привязка).
4. `lesson_rights.student_id = payload.studentId`.
5. Journal `kind=consumed`: `lesson_id`, `registration_id`, `booking_id` = payload; право → `consumed`, `booking_id`/`transfer_id` NULL.
6. INSERT UNIQUE `(right_id, booking_id) WHERE consumed`.

**Permanent** (processed+ack **без** consume; attendance **не** узнаёт это по тишине и **не** читает чужую DLQ — registration остаётся pending; открытая граница без auto-reject, см. §10):

- право `bound` к **другому** `booking_id` (доказанно старая привязка после rebind / иной bind);
- право уже `consumed` на эту или иную пару с конфликтом UNIQUE `(right_id, booking_id)` для данного booking;
- урок в `canceled_lessons`;
- student_id не совпадает с правом.

`NULL booking_id` при `available` / `reserved` **сам по себе не** доказывает permanent mismatch: `AttendanceRegistrationRequested` может опередить ordinary `BookingConfirmed` (`available→bound`).

**Retryable** (rollback **всей** TX, включая отсутствие `processed`; повтор TTL → DLQ; **не** processed+ack):

- право `available` (ожидается bind);
- право `reserved` (перенос);
- строка права временно не найдена / не готова без permanent-предиката выше.

### 3.2. Ordinary bind (`BookingConfirmed`, transferId null)

`FOR UPDATE` права: `available`; student; абонемент active и окно `as_of=occurred_at`. Иначе: **постоянный** отказ bind (processed без bind) только при явных предикатах (`consumed`, чужой student, expired окно). Согласование уже confirmed места — открыто.

### 3.3. Right reserve

`bound`; `booking_id = sourceBookingId`; student; нет active reservation; UNIQUE `transfer_id` reserved. Иначе 409 business (`right_consumed` / `right_not_available`) — **сохраняется** в idempotency.

### 3.4. Rebind / right release

Оба: `FOR UPDATE` права и **той же** active reservation (`id`, `transfer_id`, `right_id`, `status=active`).

- Release → `compensated`; не оживлять `released`. После `converted` → **окончательный** 409 `binding_fixed` (сохраняется).
- Rebind → `converted`; bound к target. Не после `compensated`.

### 3.5. Период абонемента

Окно — для **новых** bind/reserve/заявок. Уже `reserved` / post-commit — доводят или компенсируют по переносу.

### 3.6. Registration и attendance

У `attendance_registrations.booking_id` **нет** UNIQUE (несколько pending registrations на один booking допустимы). UNIQUE `booking_id` есть только у `attendances`.

**Регистрация (точный порядок):**

1. `pg_advisory_xact_lock(bookingId)`.
2. SELECT canonical `attendances` по `booking_id`.
3. Если attendance уже есть → вернуть 409 `attendance_exists` (сохраняется в idempotency) и **не** создавать registration.
4. Иначе INSERT registration (pending) + outbox `AttendanceRegistrationRequested` + полный idempotency row.
5. Несколько pending на booking остаются; конфликт между ними **не** решается UNIQUE на registrations.

**Finalize после Consumed (сериализация тем же advisory):**  
advisory(`bookingId`) → FOR UPDATE выбранной registration → сверка кортежа → INSERT attendance (UNIQUE `attendances.booking_id`) → UPDATE **этой** registration (`attendance_id`, status, `right_effect`) → прочие pending того же booking → `rejected`/`attendance_exists` в той же или последующей TX под тем же advisory → processed + outbox Recorded.

**Тишина Consumed / таймаут / DLQ subscriptions:** registration остаётся pending; **не** auto-reject. Нет факта consume-rejected: attendance **не** выводит permanent из тишины и **не** читает чужую DLQ (открытая граница §10).

### 3.7. Correction / restore

**Приём correction (attendance):** HTTP создаёт/принимает correction в `accepted`/`in_progress`. `completed`, снимки применения и финальные поля — **только после** подтверждённого результата restore/отказа, не в TX приёма.

**Локальный алгоритм restore (subscriptions, проектируется):** `FOR UPDATE` right + consume-строки; correlation (`right_id`/`booking_id`/`lesson_id`/`registration_id`); UNIQUE restore; journal `kind=restored`; право `consumed→bound`; outbox `LessonRightRestored`.

**Транспорт** команды correction→subscriptions в OpenAPI v1 **отсутствует** (нет HTTP restore / `RestoreRightRequest`) — открытая граница; не выдавать за существующий endpoint. Не auto-restore от school cancel.

---

## 4. Перенос: commit, компенсация, защита hold

### 4.1. Порядок шагов

reserve right → reserve seat → **rebind (commit)** → confirm target → release source → `TransferCompleted`.  
До commit: right release → (после проекции) seat release → `TransferRejected`.  
После commit / `outcome_unknown` на rebind: **никакой** компенсации.

### 4.2. Консервативный hold

`ttl_action='wake_recovery'` только. Авто-TTL **никогда** не −1. `expires_at` — сигнал **диагностики** и повод для периодического обхода незавершённых transfers (канон SELECT 6.4), **не** новый outbox-факт и не HTTP-канал «wake».

`LessonRightTransferred` **не** барьер освобождения.

### 4.3. Проекция `compensated_right_releases` (schedule)

`processed_events` хранит только `id`/`processed_at` — **недостаточен** для поиска по `transferId`.

**Проектная таблица** `schedule.compensated_right_releases` (ddl/ER/03):

| Колонка | Смысл |
| ------- | ----- |
| `event_id` PK | = `processed_events.id` того же Released |
| `transfer_id` NOT NULL | UNIQUE |
| `right_id` NOT NULL | |
| `student_id` NOT NULL | |
| `right_reservation_id` NOT NULL | UNIQUE |
| `source_booking_id` NOT NULL | |
| `processed_at` NOT NULL | |

**Сериализация по `transferId` (schedule):** один `pg_advisory_xact_lock(transferId)` для consumer Released, seat_reserve, seat release/compensate/cancel/cleanup **и** штатного transfer confirm. Затем: `lessons` FOR UPDATE → дочерние booking/seat. Чужую БД transfers **не** читать.

Consumer Released (`transferId` в v1 обязателен; recipients += schedule уже есть):

1. Advisory(`transferId`).
2. INSERT проекции (все поля payload — **аудит факта владельца**) + INSERT `processed_events` в одной TX.
3. Ack после commit. Повтор `event_id` — PK/processed → no-op.

**Доказательство безопасности seat↔проекция** сверяет **только реально доступный** кортеж hold/booking: `seat.transfer_id`, `seat.right_id`, `seat.student_id`, связь seat→`target_booking_id` (тот же student/right/lesson). Поля проекции `right_reservation_id` / `source_booking_id` в hold **отсутствуют** (`ReserveSeatRequest` / `seat_reservations` их не содержат) — хранятся как аудит, **не** как условие сверки. Недостаточно одного `transferId` без right/student.

Неизменность identity: **один жизненный** `right_reservations` на `transfer_id` (проектный UNIQUE в subscriptions, §9) — Released нельзя «переиспользовать» для нового reserve/rebind того же transfer. Расширение входного контракта seat **не** вводится.

**Освобождение места** (компенсация / cancel / cleanup / recovery −1 reserve **без** перехода в confirmed) — только если: есть проекция; сверка кортежа выше; `seat.status='active'`; booking ещё не `confirmed`. Тогда один раз: −1; booking `rejected`; seat `released`; `hold_kind=none`.

**Исключение — штатный transfer confirm** после commit: атомарно −1 reserve / +1 confirmed при предикатах §2.2 (booking pending+`covered_by_seat_reservation`, seat `active`; **без** `< capacity`; затем `hold_kind=none`). Проекция Released **не** требуется. Тот же advisory(`transferId`).

| Порядок гонки | Поведение |
| ------------- | --------- |
| Reserve **первый**, затем terminal Released | Hold существует; после проекции безопасно компенсируется (−1). Периодический recovery **обязан** довести compensate, даже если поздний HTTP 201 reserve ещё придёт (идемпотентный повтор ключа / уже есть active) |
| Terminal **первый**, затем seat_reserve | Проекция есть → новый hold **не** создаётся (409, сохраняется) |
| Replay Released | Проекция/processed идемпотентны |
| Seat release без проекции | **503** без INSERT ключа (или ожидание + повтор ключа без business-result). Нет Released ≠ commit |
| Right release после `converted` | Окончательный 409 `binding_fixed` — сохраняется |
| Confirm после commit | Штатный −1/+1; проекция Released не нужна |

Координатор: сначала right release; seat release после готовности проекции. Sticky `committed` / `outcome_unknown` запрещают compensate-ветки.

### 4.4. Confirm и Transferred

Transferred: маркеры наблюдаемости (`binding_protected`) у schedule; не единственная защита. Confirm идемпотентен; `hold_kind=none`.

### 4.5. Запрет нового hold после компенсации

UNIQUE/предикат: если существует `compensated_right_releases` для `transfer_id` — новый seat_reserve этого transfer → 409. Терминальная проекция не удаляется.

---

## 5. Идемпотентность HTTP, claim, notifications

### 5.1. Сериализация области ключа

DDL: `status_code`/`response_body` NOT NULL — неполная строка недопустима.

**Канонизация scope (без fingerprint) — ровно одна, только в PostgreSQL:**

```sql
scope_canonical := jsonb_build_array(
  actor_kind::text, actor_id::text, method::text,
  path_template::text, idempotency_key::text
)::text;
lock_key := hashtextextended(scope_canonical, 0);
```

Request и cleanup используют **это же** выражение (включая пробелы, которые выдаёт PostgreSQL в `::text`). Самостоятельная сериализация scope в приложении для hash **запрещена**. Коллизия hash → только лишняя сериализация чужих scope; UNIQUE scope отдельно.

**Единый порядок request:**  
1) `pg_advisory_xact_lock(lock_key)`  
2) `SELECT` idempotency по UNIQUE scope  
3) если готовый результат есть — вернуть его (**без** business locks/effects)  
4) иначе business locks → эффект + outbox → **INSERT** полной строки ключа  

Алгоритм:

1. Scope + fingerprint (fingerprint **не** в scope).
2. Advisory lock scope.
3. SELECT ключа.
4. Есть + тот же fingerprint → вернуть сохранённые code/body **без изменения строки**.
5. Есть + другой fingerprint → 409 `idempotency_key_reused`: исходные fingerprint/code/body **не** перезаписывать; **второй строки нет**. Это не «новый сохраняемый business-result».
6. Нет строки → бизнес; transient (503, lock timeout, deadlock исчерпан) → **ROLLBACK**, ключ не писать.
7. Definitive business success/4xx из §5.1.1 → INSERT полной строки в **пустую** область → commit → ответ.
8. UNIQUE conflict на INSERT → rollback, один retry с шага 2; иначе 503 без ключа.

#### 5.1.1. Что писать в **новую** пустую область ключа

| Исход | INSERT строки ключа |
| ----- | ------------------- |
| 2xx бизнес-успех | да |
| 409 business (`no_free_seat`, `right_consumed`, `binding_fixed` после Converted, `attendance_exists`, …) | да |
| 409 `idempotency_key_reused` | **нет** (область уже занята исходным definitive результатом) |
| 503 / lock timeout / serialization exhausted / «Released ещё нет» | **нет** |
| 401/403 | по политике платформы; **не** downgrade `committed` |

### 5.2. Срок хранения ключей

| Класс | Политика |
| ----- | -------- |
| Публичные | Минимальное окно **72h** с `created_at`. После 72h reuse того же ключа **может** считаться новым намерением **только если** локально нет строки **или** cleanup уже удалил по правилам ниже. |
| Внутренние recovery-ключи (reserve/rebind/confirm/release у owners; outbound steps) | **Не удаляются автоматически вообще**, пока не реализован подтверждённый forget/lifecycle (проект: `POST /internal/v1/idempotency-forget` после terminal transfer). **30d недостаточно** и **не** используется как TTL удаления. |
| Ключ с неизвестным исходом / незавершённым transfer | Не чистить, пока нет локального terminal доказательства + forget |

**Cleanup (только публичные):**

1. Тот же `pg_advisory_xact_lock(lock_key)`, что request (не взаимозаменяем с `FOR UPDATE SKIP LOCKED`).
2. `SELECT … FOR UPDATE` строки ключа.
3. Eligible **только если** из **текущей** модели можно доказать terminal публичной операции **и** `created_at < now()-72h`. Если terminal **не** доказуем (в т.ч. неизвестный исход) — **не eligible**, удалять **нельзя**. Фраза «если признак хранится» права на удаление unknown **не** даёт.
4. Иначе DELETE в этой TX → commit.

`FOR UPDATE SKIP LOCKED` — только выбор кандидатов; удаление после advisory того же scope.

### 5.3. Durable claim и fencing координатора

Колонки (ddl + CHECK): как в §9 (`claim_owner`/`claim_until`/`claim_generation≥0`, парность owner/until).

У `transfer_outbound_attempts` / `outbox_events` **нет** колонок claim — нельзя писать `WHERE claim_owner=…` по ним.

**Единый шаблон fenced TX (подготовка до сети, сохранение результата, продление):**

1. `BEGIN`.
2. `SELECT … FOR UPDATE` строки `transfers` по `id`.
3. После получения row lock проверить на **свежих** часах: `claim_owner=$w AND claim_generation=$g AND claim_until > clock_timestamp()` (не `now()` момента старта TX после ожидания lock — иначе просроченный lease может пройти).
4. Если проверка ложна → `ROLLBACK` / no-op **всей** TX; **никаких** побочных INSERT attempt/outbox/step.
5. Если истинна → атомарно в этой же TX: нужные UPDATE `transfers` / step / attempt и при необходимости INSERT outbox / INSERT attempt; `COMMIT`.

**Claim TX:** UPDATE owner/until/generation+1 при `(claim_until IS NULL OR claim_until < clock_timestamp())`, status open.

**До сети:** fenced TX: sticky step (actor/key/path/body не менять при conflict UNIQUE step); INSERT attempt `in_flight`; для rebind `binding_knowledge=outcome_unknown` если ещё не `committed`; затем HTTP сохранёнными входами.

**После ответа:** новая fenced TX по шаблону выше — зафиксировать outcome attempt / knowledge / current_step / outbox Completed|Rejected. Fencing=0 → полный rollback, без INSERT.

**Продление:** тот же шаблон; `SET claim_until = clock_timestamp()+lease` только при успешной проверке. Expired worker lease не оживляет.

**Важно:** generation не отменяет уже ушедший HTTP. Безопасность поздней сети — предикаты owners + sticky replay. Новый владелец: сначала replay тех же actor/key/path/body; не compensate при `outcome_unknown`/`committed`.

**Обработчик `LessonRightTransferred` (отдельная TX, без lease):** `processed_events` + монотонно `binding_knowledge → committed` + `binding_committed_at` в одной TX (`WHERE binding_knowledge <> 'committed'` / эквивалент); **никогда** не понижать. Прочие запреты по knowledge (не reject / не compensate) остаются. HTTP 2xx того же rebind-ключа также может установить committed в fenced TX воркера.

Потеря lease/ответа = unknown; не compensate.

### 5.4. Notifications — один алгоритм `next_attempt_no`

Имитация **без** реальной внешней отправки. Exactly-once канала не утверждается.

Инвариант: `notifications.next_attempt_no = COALESCE(MAX(attempts.attempt_no),0) + 1` для committed строк. Rollback TX **не** сжигает номер.

Алгоритм (единственный):

1. `SELECT … FOR UPDATE` notification (из SKIP LOCKED списка — после захвата строки).
2. После блокировки: `status IN ('pending','failed')`; `next_attempt_no <= max_attempts`; backoff по last attempt / `as_of`.
3. `attempt_no := next_attempt_no`.
4. Локальная imitation (in-process, до commit).
5. В **одной** TX: INSERT attempt (`delivered`|`failed`); `next_attempt_no = attempt_no + 1`; UPDATE `notifications.status`; outbox **ровно** `NotificationDelivered` или `NotificationDeliveryFailed` по фактическому result attempt (не «если нужно»).
6. Commit. Crash до commit → rollback, номер свободен. Второй воркер ждёт FOR UPDATE.

Альтернатив MAX+1 без колонки / `in_progress` attempt **нет** (в DDL attempts только delivered/failed).

---

## 6. Отмена школой vs списание

### 6.1. Сериализация в subscriptions

Общий `pg_advisory_xact_lock(hashtextextended('lesson:'||lessonId, 0))` для:

- обработки `LessonCanceledBySchool` (INSERT `canceled_lessons` + processed);
- consume по этому `lessonId`.

Затем: FOR UPDATE права / journal как обычно. Порядок: **advisory lesson → right → journal/projection**.

Это закрывает гонку READ COMMITTED «consume не увидел tombstone → cancel projection commit → consume commit».

### 6.2. Честный предел доставки

Commit отмены в **schedule** ≠ локальный commit проекции в **subscriptions**. Пока `LessonCanceledBySchool` не обработан subscriptions, consume **ещё может** пройти. Это предел асинхронности, не баг сериализации. Не заявлять `right_effect=preserved` / `school_cancellations.completed` без сигнала. Уже прошедший consume — только локальный restore (§3.7) после подтверждённого результата; транспорт correction→subscriptions в v1 не задан; не «успешное сохранение» отмены через restore.

`canceled_lessons` живёт в схеме **subscriptions** (не notifications) — 03/ddl/ER.

---

## 7. Матрица сбоев

| Сценарий | Сохраняется | Повтор | Восстановление |
| -------- | ------------ | ------ | -------------- |
| Rollback TX до commit | ничего | тот же запрос/событие | полный повтор |
| Commit эффекта, HTTP-ответ потерян | эффект + idempotency row | тот же ключ | вернуть сохранённый code/body |
| Commit outbox, publish/confirm брокер ещё нет | outbox row | outbox dispatcher | publish; не дублировать бизнес |
| Commit processed, ack брокеру потерян | processed + эффект | redelivery | PK processed → no-op + ack |
| Publish failure / retry / DLQ | outbox row; **исходная доставка остаётся unacked**, пока копия в retry/TTL или DLQ не подтверждена publisher confirm / маршрутизацией | тот же `event_id` по ступеням; **без** hot `nack(requeue=true)` | после confirm копии — ack исходной; DLQ — ручной разбор |
| Deadlock / serialization | rollback | до 3 раз TX; иначе 503 / TTL события | повтор |
| Reserve/rebind исход unknown | `in_flight` / `outcome_unknown` | тот же actor/key/path/body | не compensate |
| Commit rebind, ответ потерян, expires_at | converted; seat active; Released нет | rebind key | confirm; не TTL-free; не compensate |
| Два воркера; поздний HTTP старого | sticky step; возможно удалённый эффект | новый: replay того же step | fencing 0 rows локально; owners предикаты; committed монотонен |
| Ключ, другой fingerprint | исходный эффект | — | 409 reused |
| Confirm при полной сумме | counters | тот же confirm key | −1/+1 OK |
| Старая привязка / available до bind | permanent ack без consume / retryable rollback | TTL или — | registration pending; не auto-reject по тишине/DLQ |
| Cancel projection затем consume | canceled_lessons | ack | нет списания (advisory) |
| Consume затем cancel projection | consumed | ack | без auto-restore |
| Released до hold; поздний seat_reserve | проекция | — | 409 no new hold |
| Seat release без проекции | hold active | тот же ключ | 503 без записи ключа |
| School cancel «хочет» снять transfer hold | hold | — | отказ без §4.3 |
| Два notification worker | один attempt | — | второй ждёт |
| Crash notification mid-TX | ничего | очередь 6.4 | тот же next_attempt_no |
| Right release после converted | converted | — | 409 binding_fixed |

---

## 8. Пошаговый АНАЛИЗ

Не тесты, не SQL execute.

**A. Commit rebind → потеря ответа → expires_at**  
Subscriptions: `converted`+Transferred в outbox. Schedule: счётчик занят; проекции Released нет. TTL job не −1. Seat release → 503 (нет проекции) без idempotent 409. Transfers: unknown → replay rebind → committed → confirm (−1/+1, `hold_kind=none`).

**B. Два воркера, реальный поздний HTTP**  
W1: claim gen=5; fenced TX (FOR UPDATE transfer + `clock_timestamp()`): step+`in_flight`+unknown; HTTP rebind ушёл; commit у subscriptions. Lease W1 истёк. W2: claim gen=6; replay того же rebind key. Поздний HTTP 200 W1: fenced TX W1 — проверка owner/gen/until на transfer после FOR UPDATE → false → rollback всей TX, без INSERT/UPDATE attempt. Transferred: отдельная TX processed+монотонный committed без lease. Seat не released.

**C. Ключ, другое тело**  
Advisory → row → fingerprint≠ → 409.

**D. Confirm при полной вместимости**  
Hold учтён; −1/+1; CHECK ≤ capacity; `hold_kind=none`.

**E. Available опережает bind; старая привязка**  
Consume при `available`: rollback всей TX (без processed) → TTL/DLQ. После rebind `bound` к другому booking: permanent processed+ack без consume; attendance остаётся pending (нет consume-rejected).

**F. Cancel/consume**  
Оба берут advisory(`lessonId`). Порядок commit проекции vs consume сериализован локально. Недоставленное событие из schedule — честный предел (§6.2).

**G. Notification + crash**  
FOR UPDATE → imitation → INSERT attempt + next+=1 + status в одной TX; rollback не сжигает номер.

**H. Rollback / outbox / processed-without-ack / DLQ / deadlock / unknown reserve**  
Строки матрицы §7: эффект только после commit; ответ восстанавливается ключом; outbox/processed идемпотентны; DLQ без requeue; unknown без compensate.

**I. Гонки Released ↔ seat_reserve (общий advisory transferId)**  
Terminal первый → reserve 409. Reserve первый → hold есть; после проекции compensate; recovery доводит, даже если поздний 201 reserve.

**J. School cancel vs transfer hold**  
−1 active seat без проекции запрещён; post-commit — confirm/source-release (§2.4).

---

## 9. Согласование документов и DDL

**Проектный ddl (согласовано с 6.3):**

- `schedule.seat_reservations.ttl_action = wake_recovery`
- `schedule.compensated_right_releases` (§4.3)
- `transfers.claim_*` + CHECK целостности / `generation >= 0`
- `notifications.next_attempt_no`
- `subscriptions.canceled_lessons` (не в notifications)
- `subscriptions.right_reservations`: UNIQUE (`transfer_id`) — не более одного жизненного резерва права на transfer

**Контракты:** recipients Released += schedule; `transferId` обязателен; **без** расширения `ReserveSeatRequest` полями sourceBookingId/rightReservationId. HTTP restore / `RestoreRightRequest` в OpenAPI **нет**.

**interactions / 6.4:** протокол §4 + advisory transferId; recovery обходом transfers; attempt_no §5.4; ordinary pending → `canceled`.

---

## 10. Честно открытые границы

- Сигналы для `school_cancellations` / `booking_cancellations` `completed` (`rightEffect`, `rightBindingEffect`, `transferLimitEffect`).
- Ordinary: confirmed seat + отказ bind — освобождение места.
- Consume-rejected как факт каталога; attendance не выводит permanent из тишины/чужой DLQ.
- Межсервисный транспорт correction→restore (нет HTTP restore в OpenAPI v1).
- Реальная доставка уведомлений.
- Кто будит `SubscriptionExpired`.
- Forget-idempotency в OpenAPI v1 отсутствует — до него внутренние ключи не удаляются.
- Confirm на `canceled_by_school` lesson: доведение hold→confirmed разрешено алгоритмом §2.4; продуктовый UX отмены после confirm — отдельное согласование сигналов.
