# Контракты бизнес-событий

Машиночитаемые контракты 20 согласованных фактов. Имена совпадают с `packages/contracts/src/events.ts` и [каталогом](../../../docs/architecture/event-catalog.md). Переименований нет.

**Существует в коде:** тип `EventEnvelope`, таблицы `outbox_events` и `processed_events`, порты записи. **Не существует:** диспетчер outbox, публикация, очереди, потребители.

| Файл | Назначение |
| ---- | ---------- |
| [schema/events.schema.json](schema/events.schema.json) | Конверт и payload всех 20 событий |
| [catalog.json](catalog.json) | Источник, получатели, ожидаемые изменения |
| [examples/](examples/) | Валидные примеры: по одному файлу на имя и дополнительный `BookingCanceled.transfer-source-release.json` |

Примеры иллюстрируют отдельные сообщения и альтернативные исходы. Совпадающие идентификаторы в разных файлах не задают хронологию одного переноса.

Поле `payload` в TypeScript по-прежнему `unknown`. Этот каталог задаёт форму payload до реализации сценариев. Доменные модели сюда не переносятся.

## Конверт

Поля совпадают с `EventEnvelope` и колонками outbox:

| Конверт | Код | `outbox_events` |
| ------- | --- | --------------- |
| `event_id` | `event_id` | `id` |
| `event_type` | `event_type` | `event_type` |
| `schema_version` | `schema_version` (число) | `schema_version` |
| `occurred_at` | `occurred_at` | `created_at` |
| `correlation_id` | `correlation_id` | `correlation_id` |
| `payload` | `payload` | `payload` |

Колонка `published_at` принадлежит диспетчеру и в конверт не входит. Диспетчер, когда появится, собирает конверт из колонок: полный JSON сообщения не хранится одной строкой.

Решение о именах. В конверте нет полей `type`, `version` и `source`. Тип — `event_type`. Версия формата — целое `schema_version`, не строка SemVer. Источник не дублируется в сообщении: его выводят `eventCatalog` (владелец публикации) и [catalog.json](catalog.json). Колонка outbox для источника не нужна; поле в конверт не добавляется, пока издателя достаточно вывести из каталога.

Payload использует camelCase идентификаторов OpenAPI (`studentId`, `transferId`). Конверт остаётся snake_case, как в TypeScript.

## Идентификаторы

| Идентификатор | Где живёт | Зачем |
| ------------- | --------- | ----- |
| `event_id` | Конверт, `outbox_events.id`, `processed_events.id` | Ключ дедупликации у получателя, пока сохраняется запись, зафиксированная в одной транзакции с эффектом |
| Технический идентификатор доставки | `deliveryTag` канала AMQP, не поле контракта | Нужен только для `ack`/`nack` текущей доставки. После переподключения число другое, в `processed_events` его не пишут |
| `messageId` AMQP | Свойство брокера, когда диспетчер появится | Для валидного события равен `event_id` |
| `correlation_id` | Конверт | Связывает факты одной пользовательской операции. Дедупликацией не является |
| `operation_id` | Понятие HTTP-операции со статусом `202` | В payload конкретные поля: `schoolCancellationId`, `bookingCancellationId`, `registrationId`, `attendanceCorrectionId`, `transferId` |
| `registrationId` | Посещения | Принятый HTTP-запрос отметки. Новый запрос с другим ключом идемпотентности может получить другой `registrationId`. Списание ещё не факт |
| `attendanceId` | Посещения | Сущность окончательной отметки после подтверждения |
| `bookingId` | Расписание; в событиях посещения | Устойчивый бизнес-ключ посещения (запись ученика на занятие) |
| `transferId` | Переносы | Заявка координатора, не право и не место |
| `rightId`, `lessonId` | Владельцы сущностей | Объекты абонементов и расписания |

## Ключ сущности и маршрутизация

Ключ сущности — пара «тип сущности, её идентификатор». Для каждого типа события поле идентификатора выбирается по таблице. Значение берётся из `payload`. Ключ связывает факты об одной сущности, например активацию и истечение одного абонемента.

| События | Тип сущности | Поле ключа в `payload` |
| ------- | ------------- | --------------------- |
| `SubscriptionActivated`, `SubscriptionExpired` | Абонемент | `subscriptionId` |
| `LessonRightReserved`, `LessonRightReleased`, `LessonRightConsumed`, `LessonRightRestored`, `LessonRightTransferred` | Право на занятие | `rightId` |
| `LessonScheduled`, `LessonCanceledBySchool` | Занятие | `lessonId` |
| `BookingConfirmed`, `BookingCanceled` | Запись на занятие | `bookingId` |
| `TransferSeatReserved` | Резерв места | `seatReservationId` |
| `AttendanceRegistrationRequested` | Регистрация отметки | `registrationId` |
| `AttendanceRecorded`, `AbsenceRecorded` | Итоговая отметка | `attendanceId` |
| `TransferRequested`, `TransferCompleted`, `TransferRejected` | Заявка на перенос | `transferId` |
| `NotificationDelivered`, `NotificationDeliveryFailed` | Поручение на уведомление | `notificationId` |

Для первичной публикации в `lessonplus.events` routing key равен `event_type`. При отложенном повторе и возврате из DLQ маршрут выбирается по очереди исходного получателя. `event_id` и ключ сущности сохраняются на каждом переходе. Ключ сущности сам по себе не гарантирует порядок доставок. Область бизнес-идемпотентности определяется отдельно для каждой операции.

## Версия сущности

Конверт v1 указывает только версию формата сообщения `schema_version`. Версию состояния сущности он не передаёт. В v1 получатель проверяет состояние записи, уже зафиксированные эффекты и предпосылки из карточки события. `occurred_at` описывает время факта и не задаёт последовательный номер изменения.

Если для проекции понадобится версия состояния, владелец сущности будет увеличивать её при изменении состояния в одной транзакции с записью исходящего факта. Значение будет относиться к конкретному ключу сущности. Повтор доставки сохранит исходную версию. Передача такого поля потребует отдельной версии схемы и явных правил обработки устаревших фактов и пропусков. Пропуск сам по себе не доказывает потерю сообщения: подписчик может получать только часть типов событий о сущности.

## Дедупликация по факту и по бизнес-операции

`event_id`, `registrationId` операции и `attendanceId` сущности — разные понятия. `event_id` не заменяет защиту от повторного списания одного посещения: два HTTP-запроса с разными ключами идемпотентности порождают разные `registrationId` и разные `event_id`. Оба факта прошли бы `processed_events`.

Устойчивый ключ посещения — `bookingId` вместе с проверкой `studentId`, `lessonId` и `rightId` у записи и права. «Абонементы» списывают присутствие не чаще одного раза на пару `(rightId, bookingId)` и не уводят остаток ниже нуля. Это инвариант владельца права, не ключ доставки. Правило списания при отсутствии не задано: `AbsenceRecorded.rightEffect` остаётся `unspecified`.

Окончательная отметка в «Посещениях» одна на `bookingId`. Повтор регистрации с другим `registrationId` не создаёт вторую сущность `attendanceId` для той же записи.

Возврат права при исправлении тоже не опирается на новый `event_id`. `LessonRightRestored` ссылается на исходное списание полями `rightId`, `bookingId` и `consumedRegistrationId` (это `registrationId` из `LessonRightConsumed`). Повтор исправления с другим `attendanceCorrectionId` и другим `event_id` не возвращает право второй раз: область — то же исходное списание `(rightId, bookingId)`.

По проекту уникальный `processed_events.id` учитывает `event_id` в схеме получателя. Потребитель фиксирует запись в одной транзакции с локальным эффектом и необходимым исходящим outbox, затем посылает `ack`. Пока эта запись сохраняется, повтор подтверждается без второго эффекта.

После восстановления PostgreSQL из снимка строки `processed_events`, эффекты и outbox, зафиксированные позднее снимка, могут отсутствовать. Перед запуском потребителей сверяют сохранённые факты владельцев, состояние получателей и сообщения брокера. Факты из потерянных транзакций оставляют в карантине. Подтверждённый факт при необходимости публикуют снова с исходным `event_id`. [Сверка PostgreSQL и RabbitMQ после восстановления](../../../docs/architecture/storage/06-backup-and-recovery.md#54-порядок-reconciliation-проект)

| Получатель | Событие | `processed_events` | Дополнительный бизнес-ключ |
| ---------- | ------- | ------------------- | -------------------------- |
| notifications | входящие факты для имитации | `event_id` | Одно поручение на `(source_event_id, student_id, channel)` для каждого адресата |
| subscriptions | `AttendanceRegistrationRequested` | `event_id` | Одно списание присутствия на `(rightId, bookingId)` после сверки `studentId` и `lessonId` |
| subscriptions | `BookingConfirmed` вне переноса | `event_id` | Одна действующая привязка права; `bookingId` не привязывается повторно, если право уже на другой записи |
| subscriptions | `BookingCanceled` обычная | `event_id` | Снимать привязку, только если она ещё указывает на этот `bookingId` |
| subscriptions | `LessonCanceledBySchool` | `event_id` | Право не списывать повторно и не уничтожать |
| subscriptions | `TransferRequested` | `event_id` | Саму блокировку делает HTTP, не это событие |
| schedule | `TransferRequested` | `event_id` | Резерв места — отдельный HTTP-шаг |
| schedule | `LessonRightTransferred` | `event_id` | Узнать о commit привязки / маркеры; освобождение hold этим фактом не разрешается (см. storage/05 §4) |
| schedule | `LessonRightReleased` | `event_id` | Проекция `compensated_right_releases`; условие безопасного seat release |
| attendance | `LessonRightConsumed` | `event_id` | Одна окончательная отметка на `bookingId`; `attendanceId` выдаётся этой сущности |
| attendance | `LessonRightRestored` | `event_id` | Исправление учитывает возврат права; само восстановление не делает |
| attendance | `LessonCanceledBySchool` | `event_id` | Не проводить как пользовательский перенос |
| transfers | шаги переноса и `SubscriptionExpired` | `event_id` | Состояние заявки `transferId`; использованное право не переносится |
| notifications, технический маршрут | `NotificationDelivered`, `NotificationDeliveryFailed` | бизнес-эффекта нет | Аудит по локальным попыткам с `UNIQUE (notification_id, attempt_no)`. Доставка факта не создаёт нового поручения или попытки |

## Совместимость `schema_version`

Поддерживается только `schema_version = 1`. Схема задаёт `const: 1`: `2`, `0` и любое другое число невалидны.

Текущая схема закрытая: у конверта и каждого payload стоит `additionalProperties: false`. Добавить необязательное поле, не подняв версию, нельзя: потребитель версии 1 отвергнет лишний ключ как ошибку схемы. Любое расширение, удаление, переименование, смена типа или смысла кода — новый `schema_version` и отдельное описание. Пока описана только версия 1, неизвестный номер — неисправимое сообщение, в очередь неисправимых, не в `processed_events`.

## Повтор, порядок, неизвестный тип

В текущем Compose сервисы проверяют подключение к RabbitMQ. Входные очереди, DLQ, диспетчер outbox и потребители описаны в проекте. Имена очередей, интервалы повторов, алерты и порядок ручного возврата приведены в [регламенте RabbitMQ](../../../docs/architecture/event-catalog.md#повторы-dlq-и-восстановление-rabbitmq).

- **Маршрут.** Исходный факт публикуют в `lessonplus.events` с ключом `event_type`. У `BookingConfirmed` и `BookingCanceled` получатель после валидации проверяет вариант payload. Два аудиторских факта `NotificationDelivered` и `NotificationDeliveryFailed` имеют техническую привязку к `lessonplus.notifications.events`. После валидации потребитель подтверждает доставку. Попытка имитации и соответствующий outbox уже записаны у владельца. [Очереди и маршрутизация](../../../docs/architecture/event-catalog.md#очереди-и-маршрутизация)
- **Исход публикации.** Для outbox, отложенного повтора, DLQ и ручного возврата нужны publisher confirms и `mandatory=true`. Успех публикации подтверждает broker `ack` без `basic.return`. До этого строка outbox остаётся неопубликованной, а при передаче копии потребитель удерживает исходную доставку без `ack`. При таймауте или потере канала исход неизвестен. Копия могла попасть в очередь, поэтому повтор с прежним `event_id` может дать дубликат.
- **Отложенный повтор.** При временном сбое обработчик откатывает транзакцию. Издатель копии увеличивает `x-retry-count` и отправляет её в одну из пяти TTL-очередей исходного получателя. После исчерпания ступеней очередная временная ошибка ведёт в DLQ. Сбой между confirm и `ack` может увеличить число фактических доставок. При повторной доставке получатель сверяет локальное состояние и бизнес-ключ операции. [Подтверждения и ступени повтора](../../../docs/architecture/event-catalog.md#подтверждения-повторы-и-попадание-в-dlq)
- **Переход через DLX.** После приёма копии TTL-очередью остаётся отдельный переход через DLX в очередь сервиса. В проекте используются durable quorum-очереди, persistent-сообщения, `dead-letter-strategy=at-least-once` и `overflow=reject-publish` у очередей-источников. Брокер удерживает копию до подтверждения целевой очереди. Для брокерного перехода из входной очереди в DLQ при `delivery-limit` действуют те же условия. [Dead-lettering quorum-очередей RabbitMQ 4.2](https://www.rabbitmq.com/docs/4.2/quorum-queues#dead-lettering)
- **Невалидное сообщение.** Невалидный JSON или payload, неизвестный тип или версия и некорректный счётчик повторов направляются сразу в DLQ без записи в `processed_events`. Для невалидного конверта сохраняют исходные байты и имеющийся AMQP `messageId`. Если идентификатор отсутствовал, его оставляют отсутствующим. Для валидного события на каждом переходе сохраняют исходный конверт и свойство AMQP `messageId=event_id`. [Разбор DLQ и ручной возврат](../../../docs/architecture/event-catalog.md#действия-дежурного-и-ручной-возврат)

## Состояния payload и OpenAPI

Статусы в событиях — подмножество enum OpenAPI, не свободные строки.

`LessonRightReleased` — компенсация до новой привязки. Право не становится `available`: исходная неиспользованная привязка сохраняется, `status=bound`, `bookingId` должен совпадать с `sourceBookingId`. `reservationStatus=released` совпадает с `RightReservation`. Поле `transferId` в v1 **обязательно**. Получатели: `transfers` и `schedule`. Schedule пишет durable `compensated_right_releases` атомарно с `processed_events` и сверяет кортеж с hold перед любым −1 (storage/05 §4.3).

`LessonRightRestored` — возврат после списания присутствия. Допустимый `status` только `bound` (право снова в остатке, `bookingId` задан, как в OpenAPI). `consumed` и `reserved` противоречат возврату.

`BookingCanceled` машинно различает два payload с одним `event_type`:

| `cause` | Обязательно | Запрещено |
| ------- | ----------- | --------- |
| `ordinary` | UUID `bookingCancellationId` | любое значение `transferId`, кроме `null` |
| `transfer_source_release` | UUID `transferId` | любое значение `bookingCancellationId`, кроме `null` |

Положительный пример освобождения исходного места: [BookingCanceled.transfer-source-release.json](examples/BookingCanceled.transfer-source-release.json). Обычная отмена: [BookingCanceled.json](examples/BookingCanceled.json).

## Граница JSON Schema

Схема — JSON Schema draft-07. Она проверяет состав конверта, `schema_version = 1`, формат UUID, `additionalProperties: false`, `const`/`enum` и взаимоисключающие payload `BookingCanceled`.

Равенство двух полей схема **не** проверяет: в draft-07 нет сравнения `bookingId` с `sourceBookingId`. Сверка `studentId`, `lessonId` и `rightId` с записью и правом у владельца тоже не входит в схему. Оба инварианта — бизнес-валидация при обработке. Примеры соблюдают равенство; валидатор схемы его не обеспечивает.

## Команды отдельно от фактов

HTTP-операции OpenAPI — команды. Их нет в списке 20 имён. Факт публикуется после изменения у владельца.

| Команда | Возможный факт |
| ------- | -------------- |
| `POST /v1/subscriptions` | `SubscriptionActivated` |
| Истечение по параметрам тарифа, внешнего метода нет | `SubscriptionExpired` |
| `POST /internal/v1/rights/{rightId}/reservations` | `LessonRightReserved` |
| `POST /internal/v1/rights/{rightId}/reservations/{reservationId}/releases` | `LessonRightReleased` |
| `POST /internal/v1/rights/{rightId}/rebindings` | `LessonRightTransferred` |
| Списание по `AttendanceRegistrationRequested` | `LessonRightConsumed` |
| Восстановление при исправлении | `LessonRightRestored` |
| `POST /v1/lessons` | `LessonScheduled` |
| `POST /v1/lessons/{lessonId}/school-cancellations` | `LessonCanceledBySchool` — факт об отмене занятия, не `completed` HTTP-операции |
| Подтверждение места | `BookingConfirmed` |
| `POST /v1/bookings/{bookingId}/cancellations` | `BookingCanceled` с `cause=ordinary` |
| `POST /internal/v1/bookings/{bookingId}/transfer-releases` | `BookingCanceled` с `cause=transfer_source_release` |
| `POST /internal/v1/lessons/{lessonId}/seat-reservations` | `TransferSeatReserved` |
| `POST /v1/attendance-registrations` | `AttendanceRegistrationRequested` |
| Фиксация после списания | `AttendanceRecorded` |
| Фиксация отсутствия | `AbsenceRecorded` |
| `POST /v1/transfers` | `TransferRequested` |
| Завершение после шагов | `TransferCompleted` |
| Отказ до новой привязки | `TransferRejected` |
| Имитация канала | `NotificationDelivered` или `NotificationDeliveryFailed` |

Внутренние HTTP-шаги переноса остаются командами. `TransferRequested` их не заменяет.
