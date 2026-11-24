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
- **Подписчики и последствия.** По проекту `notifications` создаёт по одному поручению на каждого адресата. Дедупликация поручения — `(source_event_id, student_id, channel)`. В payload нет `studentId`, а выбор адресатов нового занятия в v1 открыт. [Модель уведомлений](storage/03-data-model.md#notifications)
- **Порядок.** Создание занятия предшествует записи и отмене этого занятия. Уведомления могут принять самостоятельный факт создания из payload, порядок доставки связанных фактов брокером не гарантирован.
- **Ошибки.** Подтверждённый отказ команды (`400`/`409`) не порождает факт. При `503` или таймауте вызывающая сторона повторяет HTTP с тем же `Idempotency-Key`. Временный сбой сохранения поручения повторяется по правилам очереди.
- **Пример.** [LessonScheduled.json](../../packages/contracts/events/examples/LessonScheduled.json)

### `LessonCanceledBySchool`

- **Факт и момент записи.** Команда `POST /v1/lessons/{lessonId}/school-cancellations` зафиксировала отмену занятия школой. Операция может оставаться `in_progress`, пока эффекты для права и лимита не подтверждены.
- **Payload.** `lessonId`, `groupId`, `teacherId`, `schoolCancellationId`, `status=canceled_by_school`.
- **Подписчики и последствия.** `subscriptions` фиксирует отмену в `canceled_lessons`, чтобы блокировать дальнейшее списание за занятие. `transfers` учитывает отмену без расходования пользовательского лимита. `attendance` учитывает отмену занятия при обработке отметок. По проекту `notifications` создаёт поручения для затронутых учеников. Получение их списка остаётся открытым в v1. [Модель уведомлений](storage/03-data-model.md#notifications)
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
- **Подписчики и последствия.** Получателей определяет `cause`.

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
- **Подписчики и последствия.** Бизнес-подписчиков нет. Аудит по `notificationId` и `recordedAt` сверяет результат с журналом `notification_delivery_attempts`. В поручении `source_event_id` указывает на исходный факт. Канал фиксирует результат имитации.
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

Техническая схема конверта и область дедупликации описаны в [контрактах событий](../../packages/contracts/events/README.md). Имена очередей, повторы и действия дежурного приведены ниже.

## Повторы, DLQ и восстановление RabbitMQ

Политика проектная. Текущий Compose поднимает RabbitMQ, а сервисы проверяют подключение. Очереди, диспетчер и потребители предстоит реализовать.

### Очереди и маршрутизация

Публикатор отправляет факт из outbox в `lessonplus.events` (`topic`), с ключом `event_type`. Обменники и очереди `durable`, очереди `quorum`, сообщения persistent (`delivery_mode=2`). У получателя одна входная очередь на сервис. Каждая запись в столбце задержек обозначает пять очередей с указанным префиксом и суффиксами `.1`, `.2`, `.3`, `.4`, `.5`.

| Сервис | Входная очередь | Префикс очередей задержки | DLQ |
| ------ | --------------- | ------------------------ | --- |
| Абонементы | `lessonplus.subscriptions.events` | `lessonplus.subscriptions.retry` | `lessonplus.subscriptions.events.dlq` |
| Расписание | `lessonplus.schedule.events` | `lessonplus.schedule.retry` | `lessonplus.schedule.events.dlq` |
| Посещения | `lessonplus.attendance.events` | `lessonplus.attendance.retry` | `lessonplus.attendance.events.dlq` |
| Переносы | `lessonplus.transfers.events` | `lessonplus.transfers.retry` | `lessonplus.transfers.events.dlq` |
| Уведомления | `lessonplus.notifications.events` | `lessonplus.notifications.retry` | `lessonplus.notifications.events.dlq` |

- `lessonplus.{service}.retry` (`direct`) с ключом `return` ведёт только в `lessonplus.{service}.events`. Приложение публикует задержанную копию через default exchange с именем нужной TTL-очереди в качестве ключа. После TTL брокер возвращает её через `lessonplus.{service}.retry`.
- `lessonplus.{service}.dlx` (`direct`) с ключом `failed` ведёт в `lessonplus.{service}.events.dlq`. Приложение использует этот маршрут при неисправимом сообщении или исчерпании повторов. Для брокерного DLX на входной очереди используют тот же ключ.
- `topic` маршрутизирует по `event_type`, поэтому для вариантов `BookingConfirmed` и `BookingCanceled` привязывают объединение очередей из карточек. После валидации получатель проверяет `transferId` или `cause`. Вариант вне его ответственности подтверждается без бизнес-эффекта.
- Для `NotificationDelivered` и `NotificationDeliveryFailed` проектируется техническая привязка только к `lessonplus.notifications.events`, чтобы аудиторские факты имели маршрут при `mandatory=true`. Потребитель валидирует и подтверждает их в отдельной ветке обработки без создания поручения. Источник данных аудита у владельца — журнал попыток и outbox, оба фиксируются вместе.
- Перед подключением издателя сверяют полный набор привязок с каталогом. Publisher confirm подтверждает приём брокером, а `mandatory` выявляет полное отсутствие маршрута. При наличии одной привязки пропуск другой не вызывает `basic.return`.

### Подтверждения, повторы и попадание в DLQ

1. Входной потребитель работает с ручным `ack` и `prefetch=1` на потребителя. Проверка `event_id`, запись в `processed_events`, локальный эффект и исходящий outbox при необходимости выполняются в одной транзакции. `ack` отправляют после commit. Если commit уже был, повтор с тем же `event_id` подтверждается без второго эффекта.
2. При временной ошибке, включая недоступность БД, rollback или ожидаемый факт-предпосылку, транзакцию откатывают целиком. Заголовок `x-retry-count` отсутствует при первом приёме (`n=0`). При `n<5` издатель копии увеличивает его на единицу и публикует копию в TTL-очередь соответствующей ступени. При `n=5` следующая временная ошибка направляет сообщение в DLQ с причиной `retry_exhausted`.
3. Невалидный JSON или payload, неизвестный тип, неподдерживаемая `schema_version` и некорректный служебный счётчик направляются сразу в DLQ с диагностическим кодом. Для невалидного конверта сохраняют исходное тело как есть и имеющийся `messageId`. Запись в `processed_events` в этих ветках отсутствует. Подтверждённый бизнес-результат обрабатывается по правилам конкретного события.
4. При публикации из outbox, в TTL, DLQ и при ручном возврате используют publisher confirms и `mandatory=true`. Успех — broker confirm `ack` без `basic.return` для этой публикации. Только после него диспетчер отмечает `published_at`, а потребитель при передаче копии делает `ack` исходной доставки. При `basic.return`, confirm `nack` или таймауте исходное остаётся `unacked`, публикацию копии повторяют с паузой. При закрытии канала брокер может снова доставить исходное сообщение. Горячий цикл `nack(requeue=true)` запрещён.
5. Входные очереди сохраняют брокерный `delivery-limit=20` на случай повторных падений потребителя. При его срабатывании RabbitMQ передаёт сообщение в DLQ с `x-death.reason=delivery_limit`. Это предохранитель брокера, отдельный от `x-retry-count`.

| Ступень и `x-retry-count` | Очередь | TTL |
| ------------------------- | ------- | --- |
| 1 | `lessonplus.{service}.retry.1` | 1 с |
| 2 | `lessonplus.{service}.retry.2` | 5 с |
| 3 | `lessonplus.{service}.retry.3` | 30 с |
| 4 | `lessonplus.{service}.retry.4` | 2 мин |
| 5 | `lessonplus.{service}.retry.5` | 10 мин |

TTL настраивают на уровне очереди задержки. У каждой такой очереди `dead-letter-exchange=lessonplus.{service}.retry` и `dead-letter-routing-key=return`. У входной очереди DLX — `lessonplus.{service}.dlx`, ключ `failed`. Для обоих переходов через DLX задают `dead-letter-strategy=at-least-once` и `overflow=reject-publish`. Если целевая очередь недоступна, брокер удерживает копию до её подтверждения. DLQ держит сообщения до разбора без TTL и автоматической переотправки, с отключённым `delivery-limit` (`-1`) и `overflow=reject-publish`. [Quorum queues и dead-lettering в RabbitMQ 4.2](https://www.rabbitmq.com/docs/4.2/quorum-queues#dead-lettering), [подтверждения публикации](https://www.rabbitmq.com/docs/4.2/confirms).

Тело, `event_id`, `correlation_id` и `occurred_at` сохраняют. Для валидного события AMQP `messageId` равен `event_id` на каждом переходе. Пять TTL ограничивают запланированные ступени, а фактических доставок может быть больше из-за сбоя между confirm и `ack`. Повтор может изменить порядок доставки: обработчики проверяют текущее состояние и предпосылки у владельца.

### Особенности обработки у получателей

| Сервис | Что проверить при повторе или разборе DLQ |
| ------ | ----------------------------------------- |
| Абонементы | Для `AttendanceRegistrationRequested` сверить `rightId`, `bookingId`, `studentId`, `lessonId` и журнал списаний. `available` до привязки или `reserved` при переносе ведут к повтору. Доказанный постоянный отказ (например, уже списано, привязка к другой записи или занятие в `canceled_lessons`) фиксируется как `processed` и подтверждается без нового списания. Коррекция сверяется с исходным списанием. |
| Расписание | Проверить `bookingId`/`transferId`, состояние места и счётчики под блокировкой. Целевой hold при неопределённой или совершённой перепривязке защищён. Для освобождения при компенсации требуется локальная проекция `LessonRightReleased` и сверка резерва. |
| Посещения | По `LessonRightConsumed` сверить `registrationId`, `bookingId`, `rightId`, `lessonId`, `studentId` и окончательную отметку на `bookingId`. Ожидаемая предпосылка ведёт к повтору. При отсутствии подтверждения списания регистрация остаётся pending. DLQ другого сервиса не меняет её статус. |
| Переносы | Сверить сохранённые шаги и знание о commit по `transferId`. При `outcome_unknown` повторить исходный HTTP-шаг с тем же ключом. После commit довести подтверждение целевого места и освобождение источника, без компенсации. |
| Уведомления | Сверить `processed_events` и уникальность `(source_event_id, student_id, channel)` для каждого адресата. Повторы события и попытки имитации считаются отдельно. Оба результата имитации учитываются для аудита. |

Предикаты обработки и открытые границы зафиксированы в [транзакциях и согласованности](storage/05-transactions-and-consistency.md).

### Логи, метрики и алерты

- Структурированный лог содержит `service`, `queue`, действие (`processed`, `duplicate`, `retry`, `dlq`, `publish_failed`, `redrive`), код причины, `event_type`, `event_id`, `correlation_id`, `schema_version`, `x-retry-count`, `redelivered` и длительность. Недоступные идентификаторы отмечаются пустыми. Для DLQ фиксируют источник и `x-death.reason`, если его выставил брокер. В обычный лог не пишут тело сообщения, контактные данные и секреты.
- Метрики по сервису и очереди: `ready`, `unacked`, число потребителей, глубина DLQ и прирост входа в неё, глубина каждой TTL-ступени, возраст старейшего ожидающего сообщения и неопубликованной строки outbox. Возраст на ступени считают с момента попадания в неё. Отдельно измеряют число успешных обработок, дублей, повторов по номеру ступени, ошибок валидации, `basic.return`/`nack`/таймаутов публикации и длительность обработки. Идентификаторы событий оставляют в логах, чтобы не увеличивать число временных рядов.
- Стартовые пороги подлежат калибровке: новый вход в DLQ или `basic.return` алертят дежурного сразу. Алерт также нужен, если входная очередь имеет backlog и ноль потребителей дольше 2 минут, старейшее сообщение во входной очереди или неопубликованная запись outbox старше 5 минут, либо TTL-очередь удерживает сообщения дольше своей задержки плюс 2 минуты. Повторяющиеся алерты группируют по сервису, очереди и причине.

### Действия дежурного и ручной возврат

1. Открыть инцидент по сервису и причине. Проверить доступность БД и RabbitMQ, потребителей, привязки, размер очередей и историю доставки. По `event_id` и `correlation_id` найти исходный outbox у владельца и состояние получателя через владельцев данных. Зафиксировать очередь, причину и бизнес-ключ операции для разбора.
2. Устранить причину и сверить состояние с таблицей выше. Если получатель уже зафиксировал эффект, завершить разбор без повторного эффекта и подтвердить запись DLQ после фиксации решения. Если сообщение невалидно или факт владельца нельзя подтвердить, оставить его в карантине. Старый факт не редактируют для прохождения валидации. Когда ошибка затронула восстановление БД или брокера, сначала выполнить сверку по cutoff. [Резервное копирование и восстановление](storage/06-backup-and-recovery.md)
3. Возвращать по одному сообщению в очередь **исходного получателя** через `lessonplus.{service}.retry` с ключом `return`. Сохранить исходный конверт и `messageId=event_id`. Для исправленной причины дежурный запускает один новый цикл с `x-retry-count=0` и фиксирует прежний счётчик, оператора, время и идентификатор инцидента в журнале возврата. Повторная отправка через `lessonplus.events` снова затронула бы всех подписчиков.
4. Подтвердить оригинал в DLQ только после broker confirm `ack` без `basic.return` для копии. При неоднозначном исходе сохранить оригинал и сверить логи и `processed_events` перед следующим решением. Авария между confirm и `ack` может дать дубликат. Его должны остановить исходный `event_id` и бизнес-ключ операции.
5. Проверить обработку у получателя и отсутствие повторного списания, изменения счётчиков или повторного поручения. Если сообщение вернулось в DLQ, оставить его для повторной диагностики. Массовый возврат и автоматический цикл DLQ → входная очередь не предусмотрены.

## Согласованный поток

Проектируется, не реализовано.

1. Посещение: «Посещения» публикуют `AttendanceRegistrationRequested`. «Абонементы» списывают право и публикуют `LessonRightConsumed`. Только затем «Посещения» публикуют `AttendanceRecorded`.
2. Перенос, только как проект и без алгоритма в коде. Счастливый путь: `LessonRightReserved` → `TransferSeatReserved` → commit (`LessonRightTransferred`) → confirm (`BookingConfirmed`) → source-release (`BookingCanceled` `transfer_source_release`) → `TransferCompleted`. **Компенсация до commit** (порядок 05 §4): сначала release права (`LessonRightReleased`) → durable проекция у schedule → затем release места; итог `TransferRejected`. **После commit:** компенсация запрещена; доводят confirm target и source-release. Защита hold — [storage/05-transactions-and-consistency.md](storage/05-transactions-and-consistency.md) §4; доставка Transferred **сама** не барьер. Карта — [interactions.md](interactions.md).
3. Отмена школой: источник — `LessonCanceledBySchool`. Цель — сохранить право и не тратить пользовательский лимит. Границы асинхронного списания и подтверждения результата указаны в карточке события и [разделе об отмене школой](storage/05-transactions-and-consistency.md#6-отмена-школой-vs-списание).

Повтор события с тем же `event_id` проектируется как уже обработанный через `processed_events`. Сейчас потребитель, который это делает, не запущен.

## Проверка списка

Каталог, `eventCatalog` и JSON Schema описывают один набор из двадцати типов:

`SubscriptionActivated`, `SubscriptionExpired`, `LessonRightReserved`, `LessonRightReleased`, `LessonRightConsumed`, `LessonRightRestored`, `LessonRightTransferred`, `LessonScheduled`, `LessonCanceledBySchool`, `BookingConfirmed`, `BookingCanceled`, `TransferSeatReserved`, `AttendanceRegistrationRequested`, `AttendanceRecorded`, `AbsenceRecorded`, `TransferRequested`, `TransferCompleted`, `TransferRejected`, `NotificationDelivered`, `NotificationDeliveryFailed`.
