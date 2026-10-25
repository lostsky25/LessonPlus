# Запросы и индексы

Шаг 6.4 архитектуры хранения. Обзор пакета — [storage-architecture.md](../storage-architecture.md). Таблицы и имена колонок — [03-data-model.md](03-data-model.md) и [ddl/](ddl/). Владение — [01-data-ownership.md](01-data-ownership.md). Транзакции и блокировки записи — [05-transactions-and-consistency.md](05-transactions-and-consistency.md). Списки API — [openapi/README.md](../../../packages/contracts/openapi/README.md). Карта вызовов — [interactions.md](../interactions.md).

Пометки: **существует** — `outbox_events`, `processed_events` в рабочей базе; **проектируется** — бизнес-таблицы 6.3, пять SELECT и индексы этого документа. SQL **не** выполнять на рабочей базе. Prisma-миграций нет. Планы и время **не измерены**.

Ровно **пять** показательных `SELECT`. `JOIN` только внутри схемы владельца. Чужие данные — HTTP **того** владельца. Если нужного HTTP нет — это открытый контракт, не существующий маршрут и не приглашение клиенту исполнять чужой SQL.

Курсор — keyset, не `OFFSET`. Составной курсор: оба компонента `NULL` (первая страница) либо оба заданы. `limit` — `integer` от 1 до 100 включительно.

Индексы — проект. PK и UNIQUE из `ddl/*.sql` не дублировать.

## Снимок свободных мест

`freeSeatCount` = `lessons.capacity − confirmed_booking_count − active_reserve_count` на **строке занятия в момент чтения**. Это не удержание места и не успешная конкурентная запись. OpenAPI: прочитанный `freeSeatCount` гонку не закрывает (`409 capacity_exceeded`). Защита записи — [05-transactions-and-consistency.md](05-transactions-and-consistency.md).

Чтение права `available` (запрос 1) тоже не резервирует его.

## Общие правила входов

Перед подстановкой в SQL владелец проверяет:

| Параметр | Тип PostgreSQL | Правило |
| -------- | -------------- | ------- |
| `limit` | `integer` | 1…100 |
| одиночный курсор `after_id` | `uuid` | `NULL` на первой странице |
| парный курсор | `timestamptz` и `uuid` | оба `NULL` (начало обхода) или оба `NOT NULL` (продолжение того же обхода). Смесь NULL и значения недопустима |
| `from`, `to` | `timestamptz` | оба заданы, `from <= to` |
| `as_of` | `timestamptz` | обязателен там, где указан в запросе |
| `backoff` | `interval` | обязателен в запросе 5, `>= 0` |
| `max_attempts` | `integer` | обязателен в запросе 5, `>= 1` |
| enum-статусы | `text` | только значения CHECK/OpenAPI |

Плейсхолдеры `$1`, `$2`, … в канонических SELECT — параметры `PREPARE`. Имена вроде `student_id` — смысл аргумента, не SQL-переменная.

## 1. Доступные для выбора права ученика

| | |
| --- | --- |
| Бизнес-цель | Права, которые можно выбрать для **нового** бронирования |
| Владелец | `subscriptions` |
| Контракт | Списка прав **по ученику** в OpenAPI нет. Есть `GET /v1/subscriptions?studentId` и `GET /v1/subscriptions/{subscriptionId}/rights?status=available`. Собрать выборку по ученику через эти пути владельца; отдельного маршрута нет (открытый контракт). Клиент чужой SQL не выполняет |
| Вход | `$1 student_id uuid` NOT NULL; `$2 as_of timestamptz` NOT NULL; `$3 after_id uuid` NULL \| uuid; `$4 limit integer` 1…100 |
| Поля | `lesson_rights.id`, `subscription_id`, `student_id`, `status` (= `available`), `booking_id`, `transfer_id` (оба NULL по CHECK) |
| Фильтр | `r.status = 'available'`; абонемент `s.status = 'active'` **и** `s.activated_at <= as_of` **и** `s.expires_at > as_of`. Таймер `expired` открыт: одного `status` недостаточно |
| Сортировка | `r.id` (как `IdSort` прав) |
| Лимит | `LIMIT $4`; далее `r.id > $3` |

`Subscription.balance` — другое: `COUNT` прав `available|reserved|bound`. `reserved` и `bound` в остаток входят, но **не** доступны для нового бронирования (уже удержаны или привязаны). Этот SELECT их не возвращает.

```sql
SELECT r.id,
       r.subscription_id,
       r.student_id,
       r.status,
       r.booking_id,
       r.transfer_id
FROM subscriptions.lesson_rights AS r
INNER JOIN subscriptions.subscriptions AS s
        ON s.id = r.subscription_id
       AND s.student_id = r.student_id
WHERE r.student_id = $1
  AND r.status = 'available'
  AND s.status = 'active'
  AND s.activated_at <= $2
  AND s.expires_at > $2
  AND ($3::uuid IS NULL OR r.id > $3)
ORDER BY r.id
LIMIT $4;
```

Индекс: `CREATE INDEX lesson_rights_student_available_id ON subscriptions.lesson_rights (student_id, id) WHERE status = 'available';`

Равенство `student_id`, частичный устойчивый `available` (не `now()` / не `as_of`), `ORDER BY id`. Окно абонемента — параметры запроса; индекс по `activated_at`/`expires_at` под `as_of` не строится. JOIN по PK `subscriptions.id`; поля `status`/`activated_at`/`expires_at` читаются из кучи (Index Only Scan по одному `id` их **не** проверяет).

Этот SELECT не гарантирует, что последующий `POST` записи или резерва права успеет захватить строку.

Альтернатива без второго SELECT: остаток `balance` считают другим запросом/агрегатом; список прав абонемента — существующий `GET .../rights`.

## 2. Занятия группы за период с занятостью и действующими резервами

| | |
| --- | --- |
| Бизнес-цель | Расписание группы; снимок вместимости; действующие резервы мест |
| Владелец | `schedule` |
| Контракт | `GET /v1/lessons?groupId&from&to&status=scheduled&sort=startsAt`. Резервы в теле `Lesson` нет — тот же сервис читает их локально. Право ученика не JOIN |
| Вход | `$1 group_id uuid`; `$2 from timestamptz`; `$3 to timestamptz`; `$2 <= $3`; `$4 after_starts timestamptz`; `$5 after_id uuid` (пара: оба NULL или оба заданы); `$6 limit integer` 1…100 |
| Поля | занятие: `id`, `group_id`, `teacher_id`, `starts_at`, `ends_at`, `capacity`, `status`, счётчики, выражение `free_seat_count`; резерв: `id`, `transfer_id`, `target_booking_id`, `expires_at`, `status` |
| Фильтр | `group_id`; `l.status = 'scheduled'`; `starts_at` в `[$2,$3]`. Не `expires_at > now()` |
| Сортировка | страница: `starts_at`, `id`; затем `sr.id` |
| Лимит | `LIMIT` **только** на CTE страницы занятий, иначе резервы сломают пагинацию |

```sql
WITH page AS (
    SELECT l.id,
           l.group_id,
           l.teacher_id,
           l.starts_at,
           l.ends_at,
           l.capacity,
           l.status,
           l.confirmed_booking_count,
           l.active_reserve_count,
           (l.capacity - l.confirmed_booking_count - l.active_reserve_count) AS free_seat_count
    FROM schedule.lessons AS l
    WHERE l.group_id = $1
      AND l.status = 'scheduled'
      AND l.starts_at >= $2
      AND l.starts_at <= $3
      AND (
            $4::timestamptz IS NULL
            OR (l.starts_at, l.id) > ($4, $5)
          )
    ORDER BY l.starts_at, l.id
    LIMIT $6
)
SELECT p.*,
       sr.id AS seat_reservation_id,
       sr.transfer_id,
       sr.target_booking_id,
       sr.expires_at,
       sr.status AS reserve_status
FROM page AS p
LEFT JOIN schedule.seat_reservations AS sr
       ON sr.lesson_id = p.id
      AND sr.status = 'active'
ORDER BY p.starts_at, p.id, sr.id;
```

`free_seat_count` — снимок счётчиков. Успешный `POST .../bookings` не следует из этого чтения.

```sql
CREATE INDEX lessons_group_scheduled_starts_id
    ON schedule.lessons (group_id, starts_at, id)
    WHERE status = 'scheduled';

CREATE INDEX seat_reservations_lesson_active
    ON schedule.seat_reservations (lesson_id, id)
    WHERE status = 'active';
```

Частичные предикаты устойчивы. `$2`/`$3` — параметры, не `now()` в индексе. UNIQUE active по `transfer_id` / `target_booking_id` поиск по `lesson_id` не заменяют.

Список с `canceled_by_school` этим частичным индексом не покрыт — другой сценарий, не шестой SELECT.

## 3. Записи конкретного занятия

Канон: `schedule.bookings`. Список посещений занятия — **не** этот запрос.

| | |
| --- | --- |
| Бизнес-цель | Состав мест на занятии |
| Владелец | `schedule` |
| Контракт | `GET /v1/lessons/{lessonId}/bookings?seatStatus&sort=id` |
| Вход | `$1 lesson_id uuid`; `$2 seat_status text` NULL = все, иначе одно из `pending\|confirmed\|canceled\|rejected`; `$3 after_id uuid`; `$4 limit integer` 1…100 |
| Поля | `id`, `lesson_id`, `student_id`, `right_id`, `seat_status` (схема `Booking`) |
| Фильтр | `lesson_id`; опционально `seat_status` |
| Сортировка | `id` |
| Лимит | `LIMIT $4` |

```sql
SELECT b.id,
       b.lesson_id,
       b.student_id,
       b.right_id,
       b.seat_status
FROM schedule.bookings AS b
WHERE b.lesson_id = $1
  AND ($2::text IS NULL OR b.seat_status = $2)
  AND ($3::uuid IS NULL OR b.id > $3)
ORDER BY b.id
LIMIT $4;
```

Индекс: `CREATE INDEX bookings_lesson_id ON schedule.bookings (lesson_id, id);`

FK `lesson_id` индекса не создаёт. UNIQUE `(id, lesson_id, …)` начинается с `id`, список по занятию не ускоряет. Привязка права — `GET /v1/rights/{rightId}` у subscriptions.

Альтернатива словами, без второго SELECT: окончательные отметки принадлежат `attendance`; списка `GET /v1/lessons/{lessonId}/attendances` **нет** (открытый контракт). Клиент не читает схему attendance. Gateway записи и отметки не склеивает.

## 4. Процессы переноса, которым нужно продолжение

Канон: незавершённые заявки координатора и сохранённая строка текущего исходящего шага. Публичный список `GET /v1/transfers` — другой сценарий (словами ниже), не второй SELECT.

Значения `current_step` — имена шагов 6.3 (`right_reserve`, `seat_reserve`, `rebind`, `confirm_target`, `release_source`, `compensate_seat`, `compensate_right`). Терминала `'done'` **нет**.

| | |
| --- | --- |
| Бизнес-цель | Кандидаты на восстановление после сбоя: `accepted` или `in_progress` |
| Владелец | `transfers` |
| Контракт | Внутренний опрос координатора. Публичного «очереди воркера» нет (открыто). `GET /v1/transfers` **не** этот запрос: в `Transfer` нет шага и знания commit |
| Вход | `$1 after_created timestamptz`; `$2 after_id uuid` (пара); `$3 limit integer` 1…100 |
| Поля | заявка: `id`, `status`, `current_step`, `binding_knowledge`, id резервов, `target_booking_id`, `created_at`; шаг: `s.id`, `step`, `owner_service`, `method`, `path_template`, `path_params`, `request_body`, `actor_kind`, `actor_id`, `idempotency_key`, `fingerprint`; последняя попытка: `attempt_no`, `outcome` |
| Фильтр | `t.status IN ('accepted','in_progress')`. Не `completed`/`rejected` |
| Сортировка | `created_at`, `id` (старые сначала) |
| Лимит | `LIMIT $3` |

Как читать последнюю попытку (решение после SELECT, не в `WHERE`). `a.outcome` — CHECK 6.3: `not_sent`, `in_flight`, `succeeded`, `owner_rejected`, `transport_unknown`.

| `a.outcome` / строка | Действие |
| -------------------- | -------- |
| нет **попытки**, строка шага есть (`s.id` задан), в том числе `not_sent` | сеть ещё не уходила. Сначала по 6.3 в одной TX: новая попытка `in_flight`; для исходящего `rebind` в той же TX `binding_knowledge = outcome_unknown` **только если** ещё не `committed` (не понижать). Commit этой TX, **затем** вызов сохранёнными actor/key/path/`path_params`/`request_body`/`fingerprint`. Не слать до этой фиксации. Новую identity не создавать |
| нет **строки шага** (`s.id` NULL) | входы не потеряны: identity исходящего caller неизменна (`actor_kind = 'service'`, `actor_id = 'transfers'`), ключ и тело стабильны для `(transfer_id, current_step)`. Сначала TX 6.3: вставить строку шага, если её нет (UNIQUE не перезаписывает), и попытку `in_flight`; для `rebind` — `outcome_unknown` только пока не `committed`. Затем сеть. Новый ключ на опрос и вызов до фиксации запрещены |
| `succeeded` | шаг выполнен. Перейти к **следующему незавершённому** имени из модели шагов. После последнего шага счастливого пути (`release_source`) или компенсации (`compensate_right`, только если commit не установлен) — завершить процесс по **всем** оставшимся эффектам (`completed` либо `rejected` до commit) |
| `in_flight` или `transport_unknown` | исход **этого** вызова неизвестен: повторить **те же** входы сохранённой строки. Компенсация по этому шагу запрещена, пока исход неизвестен. `binding_knowledge = outcome_unknown` — **только** для исходящего шага `rebind` и **только** пока `committed` не установлен. Неизвестный исход `right_reserve`, `seat_reserve` и прочих шагов сам по себе не есть неизвестный commit привязки. Уже подтверждённое `committed` не понижается |
| `owner_rejected` | подтверждённый отказ **исходного** запроса, только если знание ещё не `committed`. После commit компенсация и `rejected` **запрещены** независимо от позднего `owner_rejected` |

После `committed` поздняя неотвеченная попытка привязку не откатывает.

Выборка **не** захватывает строку (нет claim/lease), не даёт fairness и не делает переход шага атомарным. Это 6.5.

**Цикл проходов keyset.** `$1`/`$2` — курсор **страницы внутри одного обхода**: его берут с **последней возвращённой** строки. Строки за `LIMIT` текущей страницы **не** позади курсора — их читает **следующая страница** того же обхода, пока выборка не пуста. Новый обход с обоими `NULL` нужен для **уже пройденных или отфильтрованных** строк, которые станут готовыми позже, а не для хвоста за `LIMIT`. Claim/lease/fairness SELECT не реализует.

```sql
SELECT t.id,
       t.status,
       t.current_step,
       t.binding_knowledge,
       t.right_reservation_id,
       t.seat_reservation_id,
       t.target_booking_id,
       t.created_at,
       s.id AS step_id,
       s.step,
       s.owner_service,
       s.method,
       s.path_template,
       s.path_params,
       s.request_body,
       s.actor_kind,
       s.actor_id,
       s.idempotency_key,
       s.fingerprint,
       a.attempt_no,
       a.outcome
FROM transfers.transfers AS t
LEFT JOIN transfers.transfer_outbound_steps AS s
       ON s.transfer_id = t.id
      AND s.step = t.current_step
LEFT JOIN LATERAL (
    SELECT att.attempt_no, att.outcome
    FROM transfers.transfer_outbound_attempts AS att
    WHERE att.step_id = s.id
    ORDER BY att.attempt_no DESC
    LIMIT 1
) AS a ON true
WHERE t.status IN ('accepted', 'in_progress')
  AND (
        $1::timestamptz IS NULL
        OR (t.created_at, t.id) > ($1, $2)
      )
ORDER BY t.created_at, t.id
LIMIT $3;
```

Колонки шага достаточны для воспроизведения вызова. Эквивалент: взять `s.id` и прочитать ту же строку целиком (`SELECT * FROM transfer_outbound_steps WHERE id = s.id`) — UNIQUE не перезаписывает actor/key/path/body/fingerprint.

```sql
CREATE INDEX transfers_open_created_id
    ON transfers.transfers (created_at, id)
    WHERE status IN ('accepted', 'in_progress');
```

JOIN шага покрыт UNIQUE `(transfer_id, step)`; попытки — UNIQUE `(step_id, attempt_no)`.

Альтернатива словами: родительский `GET /v1/transfers?studentId&status=` сортирует по `requestedAt` ↔ `created_at` и не возвращает поля процесса.

## 5. Уведомления, готовые к очередной попытке имитации

| | |
| --- | --- |
| Бизнес-цель | Пачка поручений, которые ещё можно слать: не `delivered`, лимит попыток не исчерпан, пауза после последней неудачи вышла |
| Владелец | `notifications` |
| Контракт | `GET /v1/notifications` — чтение состояния, не очередь воркера. Отдельного HTTP воркера нет (открыто). Политика ниже **проектная**, не в API v1 и не реализована |
| Вход | `$1 as_of timestamptz` NOT NULL; `$2 backoff interval` NOT NULL, `>= 0`; `$3 max_attempts integer` NOT NULL, `>= 1`; `$4 after_recorded timestamptz`; `$5 after_id uuid` (пара); `$6 limit integer` 1…100 |
| Поля | поручение; `last.attempt_no`, `last.result`, `last.recorded_at` |
| Фильтр | `status IN ('pending','failed')`; `COALESCE(last.attempt_no, 0) < max_attempts`; нет попыток **или** `last.recorded_at <= as_of - backoff` |
| Сортировка | `recorded_at`, `id` |
| Лимит | `LIMIT $6` |

Исчерпавшие `max_attempts` остаются `failed` для разбора и **не** попадают в выборку. Пример проектного значения `max_attempts = 3` — **не** пятиступенчатый TTL RabbitMQ из [events README](../../../packages/contracts/events/README.md): то политика доставки **событий** (`event_id`, DLQ), этот SELECT про имитацию канала `imitation`.

Алгоритм `attempt_no` (единственный, 6.5 §5.4): после `FOR UPDATE` строки notification проверить `next_attempt_no <= max_attempts` и backoff; `attempt_no := next_attempt_no`; imitation in-process; в одной TX — INSERT attempt (`delivered`|`failed`) + `next_attempt_no = attempt_no + 1` + `notifications.status` (+ outbox). Инвариант: `next_attempt_no = COALESCE(MAX(attempt_no),0)+1`; rollback номер не сжигает. Альтернатив MAX+1 без колонки / `in_progress` нет. Реальная внешняя доставка не выполняется; exactly-once канала не утверждается.

Колонки `next_attempt_at` в 6.3 нет. `$1`/`$2` — параметры запроса, не предикат индекса и не `now()`.

**Цикл проходов keyset.** `$4`/`$5` — курсор **страницы внутри одного обхода**; его берут с последней возвращённой строки. Строки за `LIMIT` читает следующая страница того же обхода, они не позади курсора. Новый обход с обоими `NULL` нужен для **уже пройденных или отфильтрованных** строк (например ещё не вышел backoff): в этом обходе они не попали в результат, курсор их не вернёт. `as_of` (`$1`) **фиксирован на один обход**; на следующий обход передают **новый** `as_of`. Иначе отфильтрованные по паузе поручения можно пропустить навсегда. Claim/lease/fairness SELECT не реализует; два воркера могут прочитать одну строку (6.5).

```sql
SELECT n.id,
       n.student_id,
       n.subject_type,
       n.subject_id,
       n.source_event_id,
       n.status,
       n.channel,
       n.recorded_at,
       last.attempt_no,
       last.result AS last_result,
       last.recorded_at AS last_attempt_at
FROM notifications.notifications AS n
LEFT JOIN LATERAL (
    SELECT a.attempt_no, a.result, a.recorded_at
    FROM notifications.notification_delivery_attempts AS a
    WHERE a.notification_id = n.id
    ORDER BY a.attempt_no DESC
    LIMIT 1
) AS last ON true
WHERE n.status IN ('pending', 'failed')
  AND COALESCE(last.attempt_no, 0) < $3
  AND (
        last.recorded_at IS NULL
        OR last.recorded_at <= $1 - $2
      )
  AND (
        $4::timestamptz IS NULL
        OR (n.recorded_at, n.id) > ($4, $5)
      )
ORDER BY n.recorded_at, n.id
LIMIT $6;
```

Индекс: `CREATE INDEX notifications_retry_recorded_id ON notifications.notifications (recorded_at, id) WHERE status IN ('pending', 'failed');`

Лимит попыток — Filter после LATERAL, не часть индекса (иначе `max_attempts` зашили бы в схему). UNIQUE `(notification_id, attempt_no)` закрывает «последнюю попытку».

Контакт родителя: GET ученика в v1 нет (открытый контракт). Не копировать каталог и не читать схему subscriptions.

## Сводка индексов

Уже есть: PK; UNIQUE `(subscriptions.id, student_id)`; частичные UNIQUE bound/reserved права и active резервов; UNIQUE consume/restore; UNIQUE записи `(id, lesson_id, student_id, right_id)`; UNIQUE отметки `booking_id` / `registration_id`; UNIQUE `(transfer_id, step)` и ключа шага; UNIQUE попыток; UNIQUE поручения `(source_event_id, student_id, channel)`; UNIQUE HTTP-ключей.

Только под пять канонических SELECT:

| Индекс | Колонки | WHERE | Запрос |
| ------ | ------- | ----- | ------ |
| `lesson_rights_student_available_id` | `(student_id, id)` | `status = 'available'` | 1 |
| `lessons_group_scheduled_starts_id` | `(group_id, starts_at, id)` | `status = 'scheduled'` | 2 |
| `seat_reservations_lesson_active` | `(lesson_id, id)` | `status = 'active'` | 2 |
| `bookings_lesson_id` | `(lesson_id, id)` | — | 3 |
| `transfers_open_created_id` | `(created_at, id)` | `status IN ('accepted','in_progress')` | 4 |
| `notifications_retry_recorded_id` | `(recorded_at, id)` | `status IN ('pending','failed')` | 5 |

Частичные индексы обновляются при смене `status`. Не предлагать: `free_seat_count`; `expires_at > now()`; дубль PK; `channel`; индекс посещений по `lesson_id` (нет канонического SELECT); индекс переносов с ведущим `student_id` (канон — воркер, не публичный список).

## EXPLAIN на отдельной тестовой базе

Таблицы и индексы **проектируются**. На рабочей базе их нет: команды ниже **не исполнять сейчас**. Когда появится **отдельная тестовая** база с проектным DDL, гонять только эти пять `SELECT` через `PREPARE` / `EXPLAIN EXECUTE`. `EXPLAIN ANALYZE` для INSERT/UPDATE/DELETE **запрещён**, в том числе в транзакции с `ROLLBACK`.

Оценки `EXPLAIN` (rows, cost) ≠ измерение `EXPLAIN ANALYZE` (actual rows, loops, buffers, время). Пока ANALYZE на SELECT не запускали, actual нет.

Не требовать отсутствия Seq Scan, Bitmap Heap Scan или обязательного Nested Loop: план зависит от объёма и селективности.

Смотреть, когда оценка или ANALYZE SELECT будут: совпадение Index Cond с WHERE/курсором; Filter (окно абонемента, `seat_status`, `max_attempts`, backoff); где стоит Limit — у запроса 2 сначала CTE `page` по занятиям, затем JOIN резервов; rows estimate vs actual; сортировки и отброшенные строки; buffers/loops при ANALYZE; корректность keyset (нет `OFFSET`).

Подстановка — позиционные параметры `PREPARE`. Схема `SET` / `search_path` роли сервиса.

```sql
-- 1. Доступные права. $3 NULL — первая страница.
PREPARE q1(uuid, timestamptz, uuid, integer) AS
SELECT r.id, r.subscription_id, r.student_id, r.status, r.booking_id, r.transfer_id
FROM subscriptions.lesson_rights AS r
INNER JOIN subscriptions.subscriptions AS s
        ON s.id = r.subscription_id AND s.student_id = r.student_id
WHERE r.student_id = $1
  AND r.status = 'available'
  AND s.status = 'active'
  AND s.activated_at <= $2
  AND s.expires_at > $2
  AND ($3::uuid IS NULL OR r.id > $3)
ORDER BY r.id
LIMIT $4;

EXPLAIN (FORMAT TEXT)
EXECUTE q1(
  '11111111-1111-4111-8111-111111111111'::uuid,
  TIMESTAMPTZ '2026-10-24 15:00:00+03',
  NULL::uuid,
  20
);

-- 2. Страница занятий, затем резервы. Курсор: оба NULL.
PREPARE q2(uuid, timestamptz, timestamptz, timestamptz, uuid, integer) AS
WITH page AS (
    SELECT l.id, l.group_id, l.teacher_id, l.starts_at, l.ends_at, l.capacity, l.status,
           l.confirmed_booking_count, l.active_reserve_count,
           (l.capacity - l.confirmed_booking_count - l.active_reserve_count) AS free_seat_count
    FROM schedule.lessons AS l
    WHERE l.group_id = $1
      AND l.status = 'scheduled'
      AND l.starts_at >= $2
      AND l.starts_at <= $3
      AND ($4::timestamptz IS NULL OR (l.starts_at, l.id) > ($4, $5))
    ORDER BY l.starts_at, l.id
    LIMIT $6
)
SELECT p.*, sr.id AS seat_reservation_id, sr.transfer_id, sr.target_booking_id,
       sr.expires_at, sr.status AS reserve_status
FROM page AS p
LEFT JOIN schedule.seat_reservations AS sr
       ON sr.lesson_id = p.id AND sr.status = 'active'
ORDER BY p.starts_at, p.id, sr.id;

EXPLAIN (FORMAT TEXT)
EXECUTE q2(
  '55555555-5555-4555-8555-555555555555'::uuid,
  TIMESTAMPTZ '2026-10-01 00:00:00+03',
  TIMESTAMPTZ '2026-10-31 23:59:59+03',
  NULL::timestamptz,
  NULL::uuid,
  20
);

-- 3. Записи занятия.
PREPARE q3(uuid, text, uuid, integer) AS
SELECT b.id, b.lesson_id, b.student_id, b.right_id, b.seat_status
FROM schedule.bookings AS b
WHERE b.lesson_id = $1
  AND ($2::text IS NULL OR b.seat_status = $2)
  AND ($3::uuid IS NULL OR b.id > $3)
ORDER BY b.id
LIMIT $4;

EXPLAIN (FORMAT TEXT)
EXECUTE q3(
  '77777777-7777-4777-8777-777777777777'::uuid,
  NULL::text,
  NULL::uuid,
  20
);

-- 4. Продолжение переноса.
PREPARE q4(timestamptz, uuid, integer) AS
SELECT t.id, t.status, t.current_step, t.binding_knowledge,
       t.right_reservation_id, t.seat_reservation_id, t.target_booking_id, t.created_at,
       s.id AS step_id, s.step, s.owner_service, s.method, s.path_template,
       s.path_params, s.request_body, s.actor_kind, s.actor_id,
       s.idempotency_key, s.fingerprint, a.attempt_no, a.outcome
FROM transfers.transfers AS t
LEFT JOIN transfers.transfer_outbound_steps AS s
       ON s.transfer_id = t.id AND s.step = t.current_step
LEFT JOIN LATERAL (
    SELECT att.attempt_no, att.outcome
    FROM transfers.transfer_outbound_attempts AS att
    WHERE att.step_id = s.id
    ORDER BY att.attempt_no DESC
    LIMIT 1
) AS a ON true
WHERE t.status IN ('accepted', 'in_progress')
  AND ($1::timestamptz IS NULL OR (t.created_at, t.id) > ($1, $2))
ORDER BY t.created_at, t.id
LIMIT $3;

EXPLAIN (FORMAT TEXT)
EXECUTE q4(NULL::timestamptz, NULL::uuid, 20);

-- 5. Имитация уведомлений. backoff и max_attempts — проектные параметры, не API и не retry событий.
PREPARE q5(timestamptz, interval, integer, timestamptz, uuid, integer) AS
SELECT n.id, n.student_id, n.subject_type, n.subject_id, n.source_event_id,
       n.status, n.channel, n.recorded_at,
       last.attempt_no, last.result AS last_result, last.recorded_at AS last_attempt_at
FROM notifications.notifications AS n
LEFT JOIN LATERAL (
    SELECT a.attempt_no, a.result, a.recorded_at
    FROM notifications.notification_delivery_attempts AS a
    WHERE a.notification_id = n.id
    ORDER BY a.attempt_no DESC
    LIMIT 1
) AS last ON true
WHERE n.status IN ('pending', 'failed')
  AND COALESCE(last.attempt_no, 0) < $3
  AND (last.recorded_at IS NULL OR last.recorded_at <= $1 - $2)
  AND ($4::timestamptz IS NULL OR (n.recorded_at, n.id) > ($4, $5))
ORDER BY n.recorded_at, n.id
LIMIT $6;

EXPLAIN (FORMAT TEXT)
EXECUTE q5(
  TIMESTAMPTZ '2026-10-24 15:00:00+03',
  INTERVAL '30 seconds',
  3,
  NULL::timestamptz,
  NULL::uuid,
  20
);
```

После сессии: `DEALLOCATE q1;` … `q5`.

## Согласованность с ER и DDL

| SQL | ddl / ER | Тип |
| --- | -------- | --- |
| `lesson_rights.status = 'available'` | CHECK enum | text |
| `subscriptions.status`, `activated_at`, `expires_at` | ddl NOT NULL | text, `timestamptz(6)` |
| `lessons.starts_at`, счётчики | ER schedule | `timestamptz(6)`, int |
| `seat_reservations.status = 'active'` | active/released | частичный индекс |
| `bookings.seat_status` | pending…rejected | не `hold_kind` в API |
| `transfers.current_step` | text NOT NULL, без `'done'` | имена шагов outbound |
| `transfer_outbound_steps.path_params`, `request_body` | jsonb NOT NULL | воспроизведение |
| `binding_knowledge` | enum 6.3 | не в публичном Transfer |
| `notifications.recorded_at` | ER | `timestamptz(6)` |
| `attempt_no` | int ≥ 1, UNIQUE с родителем | LATERAL |

Вымышленных таблиц и `current_step = 'done'` нет. `free_seat_count` — выражение.

## Точечные поправки к 6.3

6.3 сверх ссылки на 6.4 не переписывался.

1. Sort `requestedAt` в OpenAPI — колонка `transfers.created_at`; имени `requestedAt` в ddl нет.
2. Списка прав по `studentId` нет; канон 6.4 фильтрует `available`, не `balance`.
3. Нет вторичного индекса `bookings(lesson_id)` — FK его не создаёт.
4. Нет индекса `lessons(group_id, starts_at)` под список занятий.
5. Нет `next_attempt_at`; очередь имитации — `status` + попытки + параметры `as_of`/`backoff`/`max_attempts` (проект 6.4, не API).
6. Списка посещений по занятию в v1 нет — открытый контракт, не канонический SELECT.
7. Сортировка прав и записей по `id` при `created_at` у строки — открытый пункт 6.3; индексы следуют контракту.
8. `current_step` в ddl без CHECK по именам шагов и без значения `done`; 6.4 на `done` не опирается.

Транзакции, захват воркерами и блокировки записи — [05-transactions-and-consistency.md](05-transactions-and-consistency.md).
