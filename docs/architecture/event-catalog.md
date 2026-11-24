# Каталог событий

Имена взяты из `packages/contracts/src/events.ts`. Расхождения с согласованным списком нет: в каталоге те же 20 имён, без переименований и без дополнительных бизнес-событий.

Машиночитаемые контракты: [packages/contracts/events/README.md](../../packages/contracts/events/README.md), схема [events.schema.json](../../packages/contracts/events/schema/events.schema.json), индекс [catalog.json](../../packages/contracts/events/catalog.json), примеры в [examples](../../packages/contracts/events/examples/).

**Существует:** тип конверта `EventEnvelope` с полями `event_id`, `event_type`, `schema_version`, `occurred_at`, `correlation_id`, `payload`. Идентификатор — UUID, время — ISO 8601. Имя события проверяет `isEventName`. В конверте нет `type`, `version` и `source`: тип — `event_type`, поддерживаемая версия — целое `schema_version = 1`, издателя выводят `eventCatalog` и `catalog.json`.

**Существует:** в каждом сервисе таблицы `outbox_events` и `processed_events` и порты `OutboxEventStore` и `ProcessedEventStore`.

**Не существует:** публикация этих 20 событий, диспетчер outbox, потребители и saga. Получатели ниже — проектируемая связь, а не работающий код.

Карточки ниже используют общий конверт v1. Все перечисленные поля `payload` обязательны, включая поля, которые допускают `null`. Идентификаторы имеют формат UUID, дата и время — ISO 8601.

HTTP-команды OpenAPI в этот список не входят. Соответствие команд и фактов — в README контрактов событий.

## Абонементы публикуют

| Событие | Проектируемые получатели | Смысл | Пример |
| ------- | ------------------------ | ----- | ------ |
| `SubscriptionActivated` | Уведомления | Абонемент стал действующим | [SubscriptionActivated.json](../../packages/contracts/events/examples/SubscriptionActivated.json) |
| `SubscriptionExpired` | Уведомления, Переносы | Абонемент завершён; новую заявку на его права принимать нельзя | [SubscriptionExpired.json](../../packages/contracts/events/examples/SubscriptionExpired.json) |
| `LessonRightReserved` | Переносы | Блокировка неиспользованного права. В переносе это первый шаг; «Расписание» получателем блокировки права не является. До новой привязки блокировку можно снять | [LessonRightReserved.json](../../packages/contracts/events/examples/LessonRightReserved.json) |
| `LessonRightReleased` | Переносы, Расписание | Снятие блокировки права при компенсации; у schedule — проекция `compensated_right_releases` для безопасного release hold | [LessonRightReleased.json](../../packages/contracts/events/examples/LessonRightReleased.json) |
| `LessonRightConsumed` | Посещения, Уведомления | Списание подтверждено. Посещения после этого фиксируют окончательный результат | [LessonRightConsumed.json](../../packages/contracts/events/examples/LessonRightConsumed.json) |
| `LessonRightRestored` | Посещения, Уведомления | Списанное право возвращено в остаток | [LessonRightRestored.json](../../packages/contracts/events/examples/LessonRightRestored.json) |
| `LessonRightTransferred` | Переносы, Расписание | Новая привязка права зафиксирована (commit у абонементов). Перенос доводят до конца, компенсация запрещена. Событие само по себе не защищает целевой резерв от TTL | [LessonRightTransferred.json](../../packages/contracts/events/examples/LessonRightTransferred.json) |

Только «Абонементы» выпускают события резерва, списания, восстановления и перепривязки права.

## Расписание публикует

Издатель всех пяти типов — `schedule`. Факт записывается в outbox в транзакции изменения занятия, записи или резерва.

### `LessonScheduled`

- **Факт и момент записи.** `POST /v1/lessons` создал занятие в статусе `scheduled`.
- **Payload.** `lessonId`, `groupId`, `teacherId`, `startsAt`, `endsAt`, `capacity` (целое ≥ 1), `status=scheduled`.
- **Подписчики и последствия.** `notifications` сохраняет поручение на имитацию уведомления о занятии и дедуплицирует его по исходному `event_id`.
- **Порядок.** Создание занятия предшествует записи и отмене этого занятия. Уведомления могут принять самостоятельный факт создания из payload, порядок доставки связанных фактов брокером не гарантирован.
- **Ошибки.** Подтверждённый отказ команды (`400`/`409`) не порождает факт. При `503` или таймауте вызывающая сторона повторяет HTTP с тем же `Idempotency-Key`. Временный сбой сохранения поручения повторяется по правилам очереди.
- **Пример.** [LessonScheduled.json](../../packages/contracts/events/examples/LessonScheduled.json)

### `LessonCanceledBySchool`

- **Факт и момент записи.** Команда `POST /v1/lessons/{lessonId}/school-cancellations` зафиксировала отмену занятия школой. Операция может оставаться `in_progress`, пока эффекты для права и лимита не подтверждены.
- **Payload.** `lessonId`, `groupId`, `teacherId`, `schoolCancellationId`, `status=canceled_by_school`.
- **Подписчики и последствия.** `subscriptions` фиксирует отмену в `canceled_lessons`, чтобы блокировать дальнейшее списание за занятие. `transfers` учитывает отмену без расходования пользовательского лимита. `attendance` учитывает отмену занятия при обработке отметок. `notifications` сохраняет поручение об отмене.
- **Порядок.** После фиксации отмены `schedule` отклоняет новые записи и резервы. Пока `subscriptions` не записал отмену в своей схеме, списание ещё может пройти. Активный резерв переноса обрабатывается по протоколу защиты места. [Транзакции и согласованность, § 2.4, 4 и 6](storage/05-transactions-and-consistency.md)
- **Ошибки.** Сбой обработки проекции требует повтора. Если списание уже зафиксировано, автоматического восстановления права нет. Сигнал для `school_cancellations.completed` / `rightEffect=preserved` в v1 не определён.
- **Пример.** [LessonCanceledBySchool.json](../../packages/contracts/events/examples/LessonCanceledBySchool.json)

### `BookingConfirmed`

- **Факт и момент записи.** Запись перешла в `confirmed`. В той же транзакции единица уже учтённого резерва переходит в счётчик подтверждённых мест.
- **Payload.** `bookingId`, `lessonId`, `studentId`, `rightId`, `transferId` (UUID или `null`), `seatStatus=confirmed`.
- **Подписчики и последствия.** `transfers` получает оба варианта, а шаг переноса учитывает только при заданном `transferId`. При `transferId=null` `subscriptions` связывает право с `bookingId`, а `notifications` сохраняет поручение о подтверждении места.
- **Порядок.** В обычной записи подтверждение места предшествует асинхронной привязке права. При переносе подтверждение целевого места следует за commit `LessonRightTransferred` у `subscriptions` и предшествует освобождению исходного места. Привязка права уже зафиксирована до подтверждения целевой записи.
- **Ошибки.** При `409 capacity_exceeded` на приёме обычной записи факт не возникает. Постоянный отказ в привязке права после подтверждения места остаётся открытой границей v1. При временном сбое подтверждения целевой записи после commit координатор повторяет тот же HTTP-шаг с исходным ключом.
- **Пример.** [BookingConfirmed.json](../../packages/contracts/events/examples/BookingConfirmed.json) (`transferId=null`).

### `BookingCanceled`

- **Факт и момент записи.** `schedule` перевёл запись в `canceled` и освободил учтённое место. Счётчик уменьшается только при переходе из ожидаемого состояния записи.
- **Payload.** `bookingId`, `lessonId`, `studentId`, `rightId`, `transferId`, `bookingCancellationId`, `cause`, `seatStatus=canceled`. Типы идентификаторов и последствия зависят от `cause`.

| Причина и команда | Идентификаторы | Подписчики и последствия |
| ----------------- | -------------- | ----------------------- |
| `ordinary` · `POST /v1/bookings/{bookingId}/cancellations` | `bookingCancellationId` — UUID, `transferId=null` | `subscriptions` снимает привязку только к указанному `bookingId`. `notifications` сохраняет поручение об обычной отмене. |
| `transfer_source_release` · `POST /internal/v1/bookings/{bookingId}/transfer-releases` | `transferId` — UUID, `bookingCancellationId=null` | `transfers` учитывает освобождение **исходного** подтверждённого места. Право остаётся привязано к целевой записи. Уведомление об итоге идёт по `TransferCompleted`. |

- **Порядок.** При обычной отмене операция ждёт подтверждения эффекта для привязки, контракт этого сигнала открыт. При переносе освобождение источника следует за commit новой привязки и подтверждением целевой записи. Доставка `BookingCanceled` может обогнать доставку `LessonRightTransferred`, поэтому координатор сверяет зафиксированные шаги по `transferId`.
- **Ошибки.** Повтор команды не уменьшает счётчик второй раз. Поздняя обычная отмена не снимает привязку к другому `bookingId`. Некорректная пара `cause` и идентификаторов отправляется в DLQ как ошибка схемы. Неопределённый результат освобождения источника требует повтора того же HTTP-шага.
- **Примеры.** [Обычная отмена](../../packages/contracts/events/examples/BookingCanceled.json), [освобождение исходного места](../../packages/contracts/events/examples/BookingCanceled.transfer-source-release.json).

### `TransferSeatReserved`

- **Факт и момент записи.** `POST /internal/v1/lessons/{lessonId}/seat-reservations` зафиксировал активный резерв целевого места и выдал `targetBookingId`. Резерв уже учитывается во вместимости занятия.
- **Payload.** `seatReservationId`, `lessonId`, `studentId`, `rightId`, `transferId`, `targetBookingId`, `status=active`.
- **Подписчики и последствия.** `transfers` учитывает целевой резерв в заявке и может перейти к HTTP-шагу новой привязки права.
- **Порядок.** Резерв места следует за блокировкой права и предшествует commit новой привязки. Истечение `expires_at` служит сигналом для диагностики. Для освобождения целевого резерва до commit требуется подтверждённая компенсация права и проекция `LessonRightReleased` у `schedule`. [Транзакции и согласованность, § 4](storage/05-transactions-and-consistency.md)
- **Ошибки.** При подтверждённом `409 no_free_seat` резерва и события нет. При `503` или таймауте `transfers` выясняет исход повтором того же шага и `Idempotency-Key`.
- **Пример.** [TransferSeatReserved.json](../../packages/contracts/events/examples/TransferSeatReserved.json)

## Посещения публикуют

| Событие | Проектируемые получатели | Смысл | Пример |
| ------- | ------------------------ | ----- | ------ |
| `AttendanceRegistrationRequested` | Абонементы | Запрос списания. Это инициация, ещё не окончательная отметка | [AttendanceRegistrationRequested.json](../../packages/contracts/events/examples/AttendanceRegistrationRequested.json) |
| `AttendanceRecorded` | Уведомления | Окончательное посещение после `LessonRightConsumed` | [AttendanceRecorded.json](../../packages/contracts/events/examples/AttendanceRecorded.json) |
| `AbsenceRecorded` | Уведомления | Окончательное отсутствие. Правило списания для отсутствия не задано | [AbsenceRecorded.json](../../packages/contracts/events/examples/AbsenceRecorded.json) |

## Переносы публикуют

Издатель всех трёх типов — `transfers`. Факт записывается в outbox вместе с переходом состояния заявки.

### `TransferRequested`

- **Факт и момент записи.** `POST /v1/transfers` сохранил заявку в состоянии `accepted`. Обработка продолжится асинхронно.
- **Payload.** `transferId`, `studentId`, `rightId`, `sourceBookingId`, `targetLessonId`, `targetBookingId` (UUID или `null`, при приёме ещё `null`), `status=accepted`.
- **Подписчики и последствия.** `schedule` и `subscriptions` получают факт о принятой заявке. Блокировка права и резерв места выполняются по отдельным HTTP-командам координатора. `notifications` сохраняет поручение об этапе приёма заявки.
- **Порядок.** Сначала фиксируется заявка, затем координатор блокирует право и резервирует место. Подписчики могут получить терминальный факт раньше `TransferRequested`; поздний факт приёма не меняет терминальный статус и не запускает повторный перенос.
- **Ошибки.** При `503` или таймауте приёма клиент повторяет запрос с тем же публичным `Idempotency-Key`. Если заявка уже сохранена, тот же ключ возвращает исходный результат. Ошибка подписчика обрабатывается в его очереди.
- **Пример.** [TransferRequested.json](../../packages/contracts/events/examples/TransferRequested.json)

### `TransferCompleted`

- **Факт и момент записи.** Координатор сохранил итог `completed`, когда новая привязка права, целевая запись и освобождение исходного места подтверждены.
- **Payload.** `transferId`, `studentId`, `rightId`, `sourceBookingId`, `targetLessonId`, `targetBookingId` (UUID), `status=completed`.
- **Подписчики и последствия.** `notifications` сохраняет поручение об успешном переносе. Право и вместимость уже изменены у своих владельцев.
- **Порядок.** `LessonRightTransferred` → `BookingConfirmed` с `transferId` → `BookingCanceled` с `cause=transfer_source_release` → `TransferCompleted`. Это порядок фиксации эффектов. Координатор опирается на сохранённые результаты шагов по `transferId` даже при доставке фактов в другом порядке.
- **Ошибки.** После commit привязки временный сбой подтверждения или освобождения требует доведения того же HTTP-шага с исходным ключом. Публикация результата повторяется из outbox с тем же `event_id`. `TransferRejected` после commit не выпускается.
- **Пример.** [TransferCompleted.json](../../packages/contracts/events/examples/TransferCompleted.json)

### `TransferRejected`

- **Факт и момент записи.** Координатор сохранил итог `rejected` при подтверждённом отказе до commit новой привязки. Если успели создать резервы, применимая компенсация завершена. Исходная привязка при снятии резерва права сохраняется. Если право уже было использовано, отказ не меняет его состояние.
- **Payload.** `transferId`, `studentId`, `rightId`, `sourceBookingId`, `targetLessonId`, `targetBookingId` (UUID или `null`), `status=rejected`, `rejectionReason` (`right_consumed`, `right_not_available`, `no_free_seat`, `notice_period`, `transfer_limit`, `subscription_expired`, `lesson_canceled`, `target_is_source`).
- **Подписчики и последствия.** `notifications` сохраняет поручение об отказе с указанной причиной. Сохранённый факт не запускает компенсацию у владельцев.
- **Порядок.** При наличии обоих резервов сначала снимают право (`LessonRightReleased`), затем после проекции этого факта у `schedule` освобождают целевой резерв. После этого публикуется отказ. При подтверждённом `no_free_seat` целевого резерва нет, освобождать требуется только резерв права. [Транзакции и согласованность, § 4](storage/05-transactions-and-consistency.md)
- **Ошибки.** При таймауте или неизвестном результате резерва/rebind координатор выясняет результат с тем же ключом шага. При `outcome_unknown` на rebind отклонять заявку или освобождать резервы запрещено. Подтверждённая причина отказа — бизнес-результат; техническая ошибка у подписчика идёт по правилам очереди.
- **Пример.** [TransferRejected.json](../../packages/contracts/events/examples/TransferRejected.json)

## Уведомления публикуют

Издатель обоих типов — `notifications`. Допустимые значения `subjectType` в обеих карточках: `subscription`, `lesson`, `booking`, `attendance`, `transfer`. Одна зафиксированная попытка имитации даёт один факт в outbox.

### `NotificationDelivered`

- **Факт и момент записи.** Имитация завершилась успешно. В одной транзакции сохраняются попытка, новый статус `delivered`, следующий номер попытки и факт для аудита.
- **Payload.** `notificationId`, `studentId`, `subjectType`, `subjectId`, `status=delivered`, `channel=imitation`, `recordedAt`.
- **Подписчики и последствия.** Бизнес-подписчиков нет. Аудит по `notificationId` и `recordedAt` сверяет результат с журналом `notification_delivery_attempts`, а по `correlation_id` связывает его с исходной операцией. Передачи сообщения внешнему адресату канал имитации не подтверждает.
- **Порядок.** Сначала входящее событие сохраняет поручение, затем воркер фиксирует попытку. Успех может последовать за одной или несколькими неудачами. После `delivered` воркер прекращает попытки по этому поручению.
- **Ошибки.** Откат локальной транзакции не расходует номер попытки. Сбой публикации после commit обрабатывает outbox с исходным `event_id`, без повторной имитации доставки.
- **Пример.** [NotificationDelivered.json](../../packages/contracts/events/examples/NotificationDelivered.json)

### `NotificationDeliveryFailed`

- **Факт и момент записи.** Одна попытка имитации завершилась с `failed`. Попытка, статус, следующий номер попытки и факт для аудита записываются одной транзакцией.
- **Payload.** `notificationId`, `studentId`, `subjectType`, `subjectId`, `status=failed`, `channel=imitation`, `recordedAt`.
- **Подписчики и последствия.** Бизнес-подписчиков нет. По `notificationId` и `recordedAt` аудит находит неудачную попытку в локальном журнале. Факт не откатывает абонемент, запись, посещение или перенос. Номер и причина попытки в payload v1 отсутствуют.
- **Порядок.** При оставшихся попытках воркер ждёт паузу перед новой имитацией. После исчерпания лимита поручение остаётся `failed` для разбора. Номер попытки хранится в журнале, доставка её аудиторского события может запаздывать.
- **Ошибки.** Неудача имитации — результат попытки. Повторы RabbitMQ относятся к доставке событий и имеют собственный лимит. При откате транзакции номер попытки используется повторно, при проблеме публикации после commit повторяется только публикация. [Транзакции и согласованность, § 5.4](storage/05-transactions-and-consistency.md)
- **Пример.** [NotificationDeliveryFailed.json](../../packages/contracts/events/examples/NotificationDeliveryFailed.json)

## Идентификаторы и дедупликация

`event_id` — ключ факта и строка `processed_events`. Технический `deliveryTag` брокера в контракт не входит и постоянным ключом не является.

`event_id`, `registrationId` операции и `attendanceId` сущности — разные понятия. `event_id` не защищает от второго списания того же посещения: новый HTTP-запрос с другим ключом идемпотентности может получить другой `registrationId` и другой `event_id`. Оба факта прошли бы `processed_events`. Устойчивый ключ посещения — `bookingId` со сверкой `studentId`, `lessonId` и `rightId`. «Абонементы» списывают присутствие один раз на `(rightId, bookingId)`. Окончательная отметка одна на `bookingId`. Возврат права при исправлении один раз на исходное списание: `LessonRightRestored` несёт `consumedRegistrationId` исходного `LessonRightConsumed` и ту же пару `(rightId, bookingId)`; другой `event_id` исправления повторно право не возвращает. Правило списания отсутствия не задано.

`operation_id` HTTP-операции в payload назван полями OpenAPI: `schoolCancellationId`, `bookingCancellationId`, `registrationId`, `attendanceCorrectionId`, `transferId`. Это не `attendanceId` и не `event_id`.

Область дедупликации обработчика и план повторов RabbitMQ — в README контрактов событий. В Compose очередей и DLX сейчас нет.

## Согласованный поток

Проектируется, не реализовано.

1. Посещение: «Посещения» публикуют `AttendanceRegistrationRequested`. «Абонементы» списывают право и публикуют `LessonRightConsumed`. Только затем «Посещения» публикуют `AttendanceRecorded`.
2. Перенос, только как проект и без алгоритма в коде. Счастливый путь: `LessonRightReserved` → `TransferSeatReserved` → commit (`LessonRightTransferred`) → confirm (`BookingConfirmed`) → source-release (`BookingCanceled` `transfer_source_release`) → `TransferCompleted`. **Компенсация до commit** (порядок 05 §4): сначала release права (`LessonRightReleased`) → durable проекция у schedule → затем release места; итог `TransferRejected`. **После commit:** компенсация запрещена; доводят confirm target и source-release. Защита hold — [storage/05-transactions-and-consistency.md](storage/05-transactions-and-consistency.md) §4; доставка Transferred **сама** не барьер. Карта — [interactions.md](interactions.md).
3. Отмена школой: источник — `LessonCanceledBySchool`. Цель — сохранить право и не тратить user limit; пределы async/consume и отсутствие auto-restore/`completed` — см. строку каталога выше и 05 §6.

Повтор события с тем же `event_id` проектируется как уже обработанный через `processed_events`. Сейчас потребитель, который это делает, не запущен.

## Проверка списка

В документе, в `eventCatalog` и в JSON Schema по двадцать имён, по одному разу:

`SubscriptionActivated`, `SubscriptionExpired`, `LessonRightReserved`, `LessonRightReleased`, `LessonRightConsumed`, `LessonRightRestored`, `LessonRightTransferred`, `LessonScheduled`, `LessonCanceledBySchool`, `BookingConfirmed`, `BookingCanceled`, `TransferSeatReserved`, `AttendanceRegistrationRequested`, `AttendanceRecorded`, `AbsenceRecorded`, `TransferRequested`, `TransferCompleted`, `TransferRejected`, `NotificationDelivered`, `NotificationDeliveryFailed`.
