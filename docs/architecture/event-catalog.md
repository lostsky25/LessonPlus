# Каталог событий

Имена взяты из `packages/contracts/src/events.ts`. Расхождения с согласованным списком нет: в каталоге те же 20 имён, без переименований и без дополнительных бизнес-событий.

Машиночитаемые контракты: [packages/contracts/events/README.md](../../packages/contracts/events/README.md), схема [events.schema.json](../../packages/contracts/events/schema/events.schema.json), индекс [catalog.json](../../packages/contracts/events/catalog.json), примеры в [examples](../../packages/contracts/events/examples/).

**Существует:** тип конверта `EventEnvelope` с полями `event_id`, `event_type`, `schema_version`, `occurred_at`, `correlation_id`, `payload`. Идентификатор — UUID, время — ISO 8601. Имя события проверяет `isEventName`. В конверте нет `type`, `version` и `source`: тип — `event_type`, поддерживаемая версия — целое `schema_version = 1`, издателя выводят `eventCatalog` и `catalog.json`.

**Существует:** в каждом сервисе таблицы `outbox_events` и `processed_events` и порты `OutboxEventStore` и `ProcessedEventStore`.

**Не существует:** публикация этих 20 событий, диспетчер outbox, потребители и saga. Получатели ниже — проектируемая связь, а не работающий код.

Ошибка доставки (`NotificationDeliveryFailed`) никого не просит откатывать бизнес-операцию. У этого факта и у `NotificationDelivered` бизнес-получателя нет: они нужны для аудита имитации.

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

| Событие | Проектируемые получатели | Смысл | Пример |
| ------- | ------------------------ | ----- | ------ |
| `LessonScheduled` | Уведомления | Занятие поставлено в расписание | [LessonScheduled.json](../../packages/contracts/events/examples/LessonScheduled.json) |
| `LessonCanceledBySchool` | Абонементы, Переносы, Посещения, Уведомления | Занятие отменено школой. **Цель:** право не списывать и не уничтожать; пользовательский лимит переносов не тратить. Пока факт не обработан в subscriptions (`canceled_lessons`), consume ещё может пройти; после уже прошедшего consume **нет** auto-restore и **нет** сигнала для `school_cancellations.completed` / `rightEffect=preserved` (открыто). HTTP-операция отмены может ещё быть `in_progress` | [LessonCanceledBySchool.json](../../packages/contracts/events/examples/LessonCanceledBySchool.json) |
| `BookingConfirmed` | Переносы; вне переноса также Абонементы и Уведомления | Запись подтверждена. В переносе это шаг после `LessonRightTransferred`: привязку событие не создаёт, координатор — «Переносы». Вне переноса `transferId` равен `null`, «Абонементы» связывают право с этой записью | [BookingConfirmed.json](../../packages/contracts/events/examples/BookingConfirmed.json) |
| `BookingCanceled` | Вне переноса — Абонементы и Уведомления. Освобождение исходного места переноса — Переносы | Обычная отмена (`cause=ordinary`) требует `bookingCancellationId` и снимает привязку, только если она ещё указывает на эту запись. `cause=transfer_source_release` требует `transferId`, новую привязку не снимает | [обычная](../../packages/contracts/events/examples/BookingCanceled.json), [освобождение исходного места](../../packages/contracts/events/examples/BookingCanceled.transfer-source-release.json) |
| `TransferSeatReserved` | Переносы | Место под перенос удержано | [TransferSeatReserved.json](../../packages/contracts/events/examples/TransferSeatReserved.json) |

## Посещения публикуют

| Событие | Проектируемые получатели | Смысл | Пример |
| ------- | ------------------------ | ----- | ------ |
| `AttendanceRegistrationRequested` | Абонементы | Запрос списания. Это инициация, ещё не окончательная отметка | [AttendanceRegistrationRequested.json](../../packages/contracts/events/examples/AttendanceRegistrationRequested.json) |
| `AttendanceRecorded` | Уведомления | Окончательное посещение после `LessonRightConsumed` | [AttendanceRecorded.json](../../packages/contracts/events/examples/AttendanceRecorded.json) |
| `AbsenceRecorded` | Уведомления | Окончательное отсутствие. Правило списания для отсутствия не задано | [AbsenceRecorded.json](../../packages/contracts/events/examples/AbsenceRecorded.json) |

## Переносы публикуют

| Событие | Проектируемые получатели | Смысл | Пример |
| ------- | ------------------------ | ----- | ------ |
| `TransferRequested` | Расписание, Абонементы, Уведомления | Заявка принята координатором и ещё не выполнена | [TransferRequested.json](../../packages/contracts/events/examples/TransferRequested.json) |
| `TransferCompleted` | Уведомления | Заявка завершена после новой привязки, подтверждения новой записи и освобождения исходного места | [TransferCompleted.json](../../packages/contracts/events/examples/TransferCompleted.json) |
| `TransferRejected` | Уведомления | Заявка отклонена до фиксации новой привязки. Новая привязка ещё не создана, исходное право остаётся неиспользованным | [TransferRejected.json](../../packages/contracts/events/examples/TransferRejected.json) |

## Уведомления публикуют

| Событие | Проектируемые получатели | Смысл | Пример |
| ------- | ------------------------ | ----- | ------ |
| `NotificationDelivered` | Нет бизнес-получателя | Доставка успешна | [NotificationDelivered.json](../../packages/contracts/events/examples/NotificationDelivered.json) |
| `NotificationDeliveryFailed` | Нет бизнес-получателя | Доставка не удалась и не отменяет исходную операцию | [NotificationDeliveryFailed.json](../../packages/contracts/events/examples/NotificationDeliveryFailed.json) |

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
