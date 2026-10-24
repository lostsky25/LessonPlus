# Контракты бизнес-событий

Машиночитаемые контракты 20 согласованных фактов. Имена совпадают с `packages/contracts/src/events.ts` и [каталогом](../../../docs/architecture/event-catalog.md). Переименований нет.

**Существует в коде:** тип `EventEnvelope`, таблицы `outbox_events` и `processed_events`, порты записи. **Не существует:** диспетчер outbox, публикация, очереди, потребители.

| Файл | Назначение |
| ---- | ---------- |
| [schema/events.schema.json](schema/events.schema.json) | Конверт и payload всех 20 событий |
| [catalog.json](catalog.json) | Источник, получатели, ожидаемые изменения |
| [examples/](examples/) | Валидные примеры: по одному файлу на имя и дополнительный `BookingCanceled.transfer-source-release.json` |

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
| `event_id` | Конверт, `outbox_events.id`, `processed_events.id` | Идентификатор факта. Повтор доставки с тем же значением не выполняет сценарий второй раз |
| Технический идентификатор доставки | `deliveryTag` канала AMQP, не поле контракта | Нужен только для `ack`/`nack` текущей доставки. После переподключения число другое, в `processed_events` его не пишут |
| `messageId` AMQP | Свойство брокера, когда диспетчер появится | Должен повторять `event_id`. Это не второй ключ дедупликации |
| `correlation_id` | Конверт | Связывает факты одной пользовательской операции. Дедупликацией не является |
| `operation_id` | Понятие HTTP-операции со статусом `202` | В payload конкретные поля: `schoolCancellationId`, `bookingCancellationId`, `registrationId`, `attendanceCorrectionId`, `transferId` |
| `registrationId` | Посещения | Принятый HTTP-запрос отметки. Новый запрос с другим ключом идемпотентности может получить другой `registrationId`. Списание ещё не факт |
| `attendanceId` | Посещения | Сущность окончательной отметки после подтверждения |
| `bookingId` | Расписание; в событиях посещения | Устойчивый бизнес-ключ посещения (запись ученика на занятие) |
| `transferId` | Переносы | Заявка координатора, не право и не место |
| `rightId`, `lessonId` | Владельцы сущностей | Объекты абонементов и расписания |

`event_id`, `registrationId` операции и `attendanceId` сущности — разные понятия. `event_id` не заменяет защиту от повторного списания одного посещения: два HTTP-запроса с разными ключами идемпотентности порождают разные `registrationId` и разные `event_id`. Оба факта прошли бы `processed_events`.

Устойчивый ключ посещения — `bookingId` вместе с проверкой `studentId`, `lessonId` и `rightId` у записи и права. «Абонементы» списывают присутствие не чаще одного раза на пару `(rightId, bookingId)` и не уводят остаток ниже нуля. Это инвариант владельца права, не ключ доставки. Правило списания при отсутствии не задано: `AbsenceRecorded.rightEffect` остаётся `unspecified`.

Окончательная отметка в «Посещениях» одна на `bookingId`. Повтор регистрации с другим `registrationId` не создаёт вторую сущность `attendanceId` для той же записи.

Возврат права при исправлении тоже не опирается на новый `event_id`. `LessonRightRestored` ссылается на исходное списание полями `rightId`, `bookingId` и `consumedRegistrationId` (это `registrationId` из `LessonRightConsumed`). Повтор исправления с другим `attendanceCorrectionId` и другим `event_id` не возвращает право второй раз: область — то же исходное списание `(rightId, bookingId)`.

Область `processed_events` — схема одного сервиса, колонка только `id`. Повтор считается внутри сервиса-получателя по `event_id`, без имени обработчика. Два обработчика одного процесса не имеют раздельных ключей: таблица этого не хранит.

| Получатель | Событие | `processed_events` | Дополнительный бизнес-ключ |
| ---------- | ------- | ------------------- | -------------------------- |
| notifications | входящие факты для имитации | `event_id` | Повтор поручения на тот же `event_id` не создаёт вторую доставку |
| subscriptions | `AttendanceRegistrationRequested` | `event_id` | Одно списание присутствия на `(rightId, bookingId)` после сверки `studentId` и `lessonId` |
| subscriptions | `BookingConfirmed` вне переноса | `event_id` | Одна действующая привязка права; `bookingId` не привязывается повторно, если право уже на другой записи |
| subscriptions | `BookingCanceled` обычная | `event_id` | Снимать привязку, только если она ещё указывает на этот `bookingId` |
| subscriptions | `LessonCanceledBySchool` | `event_id` | Право не списывать повторно и не уничтожать |
| subscriptions | `TransferRequested` | `event_id` | Саму блокировку делает HTTP, не это событие |
| schedule | `TransferRequested` | `event_id` | Резерв места — отдельный HTTP-шаг |
| schedule | `LessonRightTransferred` | `event_id` | Целевой резерв этой `transferId` не истекает |
| attendance | `LessonRightConsumed` | `event_id` | Одна окончательная отметка на `bookingId`; `attendanceId` выдаётся этой сущности |
| attendance | `LessonRightRestored` | `event_id` | Исправление учитывает возврат права; само восстановление не делает |
| attendance | `LessonCanceledBySchool` | `event_id` | Не проводить как пользовательский перенос |
| transfers | шаги переноса и `SubscriptionExpired` | `event_id` | Состояние заявки `transferId`; использованное право не переносится |
| нет | `NotificationDelivered`, `NotificationDeliveryFailed` | не требуется бизнесу | Только аудит имитации. Отката нет |

## Совместимость `schema_version`

Поддерживается только `schema_version = 1`. Схема задаёт `const: 1`: `2`, `0` и любое другое число невалидны.

Текущая схема закрытая: у конверта и каждого payload стоит `additionalProperties: false`. Добавить необязательное поле, не подняв версию, нельзя: потребитель версии 1 отвергнет лишний ключ как ошибку схемы. Любое расширение, удаление, переименование, смена типа или смысла кода — новый `schema_version` и отдельное описание. Пока описана только версия 1, неизвестный номер — неисправимое сообщение, в очередь неисправимых, не в `processed_events`.

## Повтор, порядок, неизвестный тип

В Compose сейчас только образ `rabbitmq:4.2.9-management` и `RABBITMQ_URL`. Очередей, обменников, DLX и политик нет, потребитель не подписан. Ниже — проект для RabbitMQ 4.2, без плагина отложенных сообщений: в образе его нет. Ссылки: [Publisher Confirms](https://www.rabbitmq.com/docs/confirms), [Reliability Guide](https://www.rabbitmq.com/docs/reliability), [DLX Safety](https://www.rabbitmq.com/docs/4.2/dlx#safety), [Quorum dead-lettering](https://www.rabbitmq.com/docs/4.2/quorum-queues#dead-lettering).

Подтверждение публикации **в TTL-очередь не защищает** следующий переход TTL/DLX → очередь сервиса. Обычный dead-lettering (по умолчанию без внутренних publisher confirms) сразу снимает сообщение с исходной очереди; если получатель недоступен, брокер может его потерять.

Выбранная топология (ещё не создана):

- Все обменники и очереди — `durable`. Принятая политика публикации — persistent (`delivery_mode=2`). Dead-lettering сохраняет исходный delivery mode и не повышает его: целевые очереди не должны на это полагаться.
- Факты: обменник `lessonplus.events`, тип `topic`, routing key = `event_type`. Очередь сервиса `lessonplus.{service}.events` — quorum, привязана только своими ключами.
- Повтор **не** публикуют снова в `lessonplus.events`: иначе факт снова разошёлся бы всем получателям. Возврат — только в очередь того сервиса, который обрабатывал доставку.
- На сервис: обменник возврата `lessonplus.{service}.retry` типа `direct`, durable; единственная привязка — routing key `return` → `lessonplus.{service}.events`.
- Пять quorum TTL-очередей `lessonplus.{service}.retry.1` … `retry.5` с per-queue TTL. У каждой: настроенный `dead-letter-exchange` = `lessonplus.{service}.retry`, `dead-letter-routing-key` = `return`, `dead-letter-strategy` = `at-least-once`, `overflow` = `reject-publish`. Без этих трёх условий quorum падает обратно в `at-most-once` (`drop-head` это делает даже без лимита длины).
- Неисправимые: обменник `lessonplus.{service}.dlx` и quorum-очередь `lessonplus.{service}.events.dlq`. Туда публикует приложение с confirms, не общий fanout.

`at-least-once` на TTL-очередях удерживает истёкшее сообщение, пока целевая очередь сервиса не подтвердит приём. Если очередь сервиса недоступна, копия остаётся в TTL-очереди, а не отбрасывается. Внутренний повтор брокера при этом может дать дубликат в очереди сервиса: его отрабатывает тот же `event_id` в `processed_events`.

Потребитель: ручной `ack`, `prefetch=1`. `deliveryTag` только для этой доставки.

`nack(requeue=true)` **не** увеличивает заголовок `x-retry-count`. Брокер кладёт то же сообщение обратно в ту же очередь, счётчик не растёт, лимит пяти повторов так не обеспечить, возможен горячий цикл. Считанный `nack` с повторной постановкой в этом проекте не используется.

Ограниченный повтор — публикация копии приложением, затем задержка брокером:

1. Тело JSON копируется без изменения `event_id`. `messageId` AMQP на каждой публикации, включая повтор и DLQ, равен `event_id`. Сообщение persistent.
2. Счётчик хранит и увеличивает **издатель копии** в заголовке **нового** сообщения `x-retry-count`. Исходная доставка заголовок не меняет. `n` — целое из заголовка текущей доставки, если заголовка нет — `0` (первая обработка, это ещё не повтор).
3. Пять повторов, не больше. При временной ошибке: если `n < 5`, публикуют копию с `x-retry-count = n + 1` в очередь `lessonplus.{service}.retry.{n+1}`; если `n = 5`, это пятый повтор исчерпан — публикуют в DLQ, шестого TTL-шага нет.

| `x-retry-count` после публикации | Очередь задержки | TTL |
| -------------------------------- | ---------------- | --- |
| 1 | `lessonplus.{service}.retry.1` | 1 с |
| 2 | `lessonplus.{service}.retry.2` | 5 с |
| 3 | `lessonplus.{service}.retry.3` | 30 с |
| 4 | `lessonplus.{service}.retry.4` | 2 мин |
| 5 | `lessonplus.{service}.retry.5` | 10 мин |

Ограничены пять ступеней запланированного отложенного повтора. Фактических доставок и вызовов обработчика может быть больше: redelivery брокера, сбой до `ack` и дубликаты publisher confirms. `processed_events` защищает только успешно зафиксированную обработку. Глобального лимита в шесть вызовов нет: без отдельного устойчивого счётчика его нельзя обещать. После исчерпания пяти ступеней копию публикуют в DLQ, без записи в `processed_events`.

4. Канал копии в режиме publisher confirms (`confirm.select`). Публикация с `mandatory=true`. Успех — `basic.ack` **и** отсутствие `basic.return`. `basic.nack` подтверждения, `basic.return` или таймаут — передачи нет. `overflow=reject-publish` на полной TTL-очереди тоже отвергает публикацию: исходное не подтверждают.
5. Исходную доставку `ack` **только после** подтверждённой передачи копии в выбранную TTL-очередь или DLQ. До этого исходное остаётся unacked. Подтверждение посадки в TTL не заменяет at-least-once на самом dead-lettering в очередь сервиса.
6. Если публикация копии не подтверждена: исходное **не** `ack`. Издатель повторяет публикацию на том же unacked delivery с паузой в процессе. Падение процесса до `ack` возвращает исходное брокером с тем же `event_id`.
7. Немаршрутизируемое (`basic.return`) не считают доставленным, даже если затем придёт confirm ack.

Повтор брокера с тем же `event_id` после успешной обработки: `ack`, сценарий не выполняется (`processed_events`). То же для дубликата, который at-least-once dead-lettering может отдать повторно.

Нарушение порядка (например `LessonRightConsumed` раньше учёта `AttendanceRegistrationRequested`): временная ошибка, те же пять отложенных повторов, затем DLQ. Это не молчаливый `ack`.

Неизвестный `event_type`, невалидный JSON, ошибка схемы, `schema_version` не равный 1: публикация в DLQ этого сервиса с confirms, затем `ack` исходного, без `processed_events`. Если публикация в DLQ не подтверждена — исходное не подтверждают.

Когда появится диспетчер outbox, публикация в `lessonplus.events` тоже идёт с publisher confirms и `mandatory`: строка outbox считается опубликованной только после confirm ack без `basic.return`.

`NotificationDeliveryFailed` никогда не ставит в очередь откат абонемента, записи, посещения или переноса.

## Состояния payload и OpenAPI

Статусы в событиях — подмножество enum OpenAPI, не свободные строки.

`LessonRightReleased` — компенсация до новой привязки. Право не становится `available`: исходная неиспользованная привязка сохраняется, `status=bound`, `bookingId` должен совпадать с `sourceBookingId`. `reservationStatus=released` совпадает с `RightReservation`. Поле `transferId` в событии — заявка переноса; у сущности `LessonRight` при `bound` поле `transferId` пусто.

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
| `POST .../reservations/{reservationId}/releases` | `LessonRightReleased` |
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
