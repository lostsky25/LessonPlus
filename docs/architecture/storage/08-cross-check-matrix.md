# Перекрёстная матрица: OpenAPI, события, модель (шаг 6.8)

Ручная **семантическая** сверка. Источники: `packages/contracts/openapi/components.yaml`, `packages/contracts/openapi/schedule.yaml` (path params), `packages/contracts/events/schema/events.schema.json`, `packages/contracts/events/catalog.json`, [03-data-model.md](03-data-model.md), [ddl/](ddl/), [05-transactions-and-consistency.md](05-transactions-and-consistency.md). Обзор — [storage-architecture.md](../storage-architecture.md).

**Не путать** с инструментальным парсингом YAML / Ajv examples (§10 обзора). Новых API и событий **не** вводится.

Обозначения: **local FK** — `REFERENCES` внутри схемы владельца; **logical** — UUID без FK; **DTO/derived** — нет собственной таблицы / вычисляемое; **tech** — outbox/processed / health; **path** — параметр пути; **body** — поле тела; **response** — поле ответа.

Envelope факта: `event_id`, `event_type`, `schema_version=1`, `occurred_at`, `correlation_id`, `payload`. `event_id` ≠ `correlation_id` ≠ HTTP `Idempotency-Key`.

---

## 1. Схемы OpenAPI (`components.yaml`)

### 1.1. Примитивы и технические

| Схема / параметр | Владелец смысла | Mapping ID / роль | Хранилище |
| ---------------- | --------------- | ----------------- | --------- |
| `Uuid`, `NullableUuid`, `DateTime` | общее | формат полей | нет таблицы |
| `Error` | ответ владельца endpoint | опц. `correlationId` (трассировка HTTP, **не** `event_id`); `code`/`reason` | DTO |
| `FieldError` | валидация тела | `pointer` | DTO |
| `IdempotencyKey` (header) | область: caller + method + path template **владельца** | UUID ключа; отпечаток не в ключе | проект: `http_idempotency_keys` у владельца endpoint |
| `Limit`, `Cursor` | списки | `cursor` ↔ `nextCursor`; не entity id | DTO |
| `*Sort`, query-фильтры | GET владельца списка | UUID фильтров — по смыслу владельца списка | нет |
| Path params (`SubscriptionId`, `RightId`, `ReservationId`, `LessonId`, `BookingId`, …) | владелец ресурса | PK в path; **не** подменять ими поля body | см. §1.2 |
| `LiveStatus`, `ReadinessStatus`, `SystemStatus` | health / gateway | | tech |

### 1.2. Ресурсы и операции (body / response / path раздельно)

| Схема / операция | Владелец | ID в контракте (где) | Хранилище |
| ---------------- | -------- | -------------------- | --------- |
| `ActivateSubscriptionRequest` | subscriptions | body: `studentId`, `tariffId` → **local FK** на `students`/`tariffs` той же схемы | нет Student/Tariff OpenAPI |
| `Subscription` | subscriptions | response: `id`, `studentId`, `tariffId`; `balance` **derived** | `subscriptions` |
| `SubscriptionList` | subscriptions | `items`, `nextCursor` | DTO |
| `LessonRight` / `LessonRightList` | subscriptions | response: `id`, `subscriptionId`, `studentId`; `bookingId`/`transferId` optional | `lesson_rights` |
| `ReserveRightRequest` | subscriptions | body: `transferId`, `sourceBookingId`; path: `rightId` | → `right_reservations` |
| `RightReservation` | subscriptions | response: `id`, `rightId`, `transferId`, `sourceBookingId`, `status` | `right_reservations` |
| `ReleaseRightReservationRequest` | subscriptions | body: `transferId`; path: `rightId`, `reservationId` | release TX |
| `RebindRightRequest` | subscriptions | body: `transferId`, `reservationId`, `targetBookingId`; path: `rightId` | rebind TX |
| `CreateLessonRequest` / `UpdateLessonRequest` / `Lesson` | schedule | body/response: `groupId`, `teacherId` **local FK**; `freeSeatCount` **derived** | `lessons` |
| `LessonList` | schedule | | DTO |
| `SchoolCancellationRequest` / `SchoolCancellation` | schedule | response: `id`, `lessonId`; эффекты pending… | `school_cancellations`; сигнал чужих эффектов **открыт** |
| `CreateBookingRequest` / `Booking` | schedule | body: `studentId`, `rightId` **logical**; response: `id`, `seatStatus` | `bookings` |
| `BookingList` / `BookingCancellation` | schedule | cancellation: `id`, `bookingId`; `rightBindingEffect` | `booking_cancellations`; сигнал **открыт** |
| `ReserveSeatRequest` | schedule | body: `transferId`, `studentId`, `rightId`; path: `lessonId` | |
| `SeatReservation` | schedule | response: `id`, `lessonId`, `transferId`, `studentId`, `rightId`, `targetBookingId`, `status` | `seat_reservations`; `expires_at` в OpenAPI **нет** |
| `ReleaseSeatReservationRequest` | schedule | body: `transferId`; path: `reservationId` (места) | |
| `ConfirmTransferBookingRequest` | schedule | **body:** `seatReservationId`, `targetBookingId`; **path:** `transferId` | confirm TX |
| `TransferReleaseBookingRequest` | schedule | **body:** `transferId`; **path:** `bookingId` (исходная запись) | source-release TX |
| `RegisterAttendanceRequest` | attendance | body: `bookingId`, `studentId`, `lessonId`, `rightId`, `mark` | |
| `AttendanceRegistration` | attendance | response: `id` (=registrationId), те же ссылки | `attendance_registrations` |
| `Attendance` | attendance | response: `id` (=attendanceId), `registrationId`; UNIQUE `bookingId` | `attendances` |
| `CorrectAttendanceRequest` / `AttendanceCorrection` | attendance | response/op id = `attendanceCorrectionId`; корреляция consume — `consumedRegistrationId` в модели/событии restore | `attendance_corrections`; HTTP restore у subscriptions **нет** |
| `RequestTransferRequest` / `Transfer` / `TransferList` | transfers | response: `id` (=transferId), `studentId`, `rightId`, `sourceBookingId`, `targetLessonId`, `targetBookingId?` | `transfers` |
| `Notification` / `NotificationList` | notifications | response: `id`, `studentId`, `subjectType`+`subjectId` (**logical**, см. §1.3) | `notifications` |
| `AcceptedOperation` | DTO 202 | `resourceId` = id ресурса владельца; `status=accepted` ≠ успех сценария | нет таблицы |

### 1.3. `Notification.subjectType` → владелец `subjectId`

| `subjectType` | `subjectId` означает | Владелец агрегата |
| ------------- | -------------------- | ----------------- |
| `subscription` | `subscriptionId` | subscriptions |
| `lesson` | `lessonId` | schedule |
| `booking` | `bookingId` | schedule |
| `attendance` | `attendanceId` | attendance |
| `transfer` | `transferId` | transfers |

В схеме notifications колонки `student_id` / `subject_id` / `source_event_id` — **logical** (нет FK на чужие схемы). Маршрутизация фактов без `studentId` в payload — **открытый** контракт.

### 1.4. Local FK vs logical (по ddl)

| Схема | Local FK (внутри схемы) | Logical UUID (без FK) |
| ----- | ----------------------- | --------------------- |
| subscriptions | `subscriptions.student_id`→`students`; `tariff_id`→`tariffs`; составной `(subscription_id,student_id)`→`subscriptions`; `right_reservations.right_id`→`lesson_rights`; `right_operations.right_id`→`lesson_rights`; `reservation_id`→`right_reservations`; `consumed_operation_id`→`right_operations` (self) | `lesson_rights.booking_id`, `transfer_id`; `right_reservations.transfer_id`, `source_booking_id`; `canceled_lessons.school_cancellation_id`; journal `attendance_correction_id` / `lesson_id` / `registration_id` где без FK |
| schedule | `groups.teacher_id`→`teachers`; `lessons.group_id`→`groups`, `teacher_id`→`teachers`; `bookings.lesson_id`→`lessons`; составной seat→booking `(target_booking_id, lesson_id, student_id, right_id)`→`bookings`; `school_cancellations.lesson_id`→`lessons`; `booking_cancellations.booking_id`→`bookings` | `bookings.student_id`, `right_id`, `transfer_id`; `seat_reservations.transfer_id` (+ student/right уже в составном FK); `compensated_right_releases`: `transfer_id`, `right_id`, `student_id`, `right_reservation_id`, `source_booking_id` |
| attendance | составной attendance→registration `(registration_id, booking_id, student_id, lesson_id, right_id)`; `attendance_registrations.attendance_id`→`attendances` (nullable reverse); correction `(attendance_id, source_registration_id)`→`attendances(id, registration_id)` | все `booking_id`/`student_id`/`lesson_id`/`right_id` на registration (чужие схемы); `consumed_registration_id` на correction |
| transfers | `transfers.rule_id`→`transfer_rules`; steps→`transfers`; attempts→`steps` | `student_id`, `right_id`, `source_booking_id`, `target_lesson_id`, `target_booking_id` |
| notifications | `notification_delivery_attempts.notification_id`→`notifications` | `student_id`, `subject_id`, `source_event_id` |

### 1.5. Корреляции и ключи

| Идентификатор | Где | Смысл |
| ------------- | --- | ----- |
| `event_id` | конверт / outbox / processed | дедуп факта |
| `correlation_id` | конверт | связь фактов операции |
| `Error.correlationId` | HTTP Error | опц. трассировка HTTP |
| HTTP `Idempotency-Key` | header | область владельца endpoint |
| `registrationId` | attendance | принятый HTTP; **не** ключ списания |
| `attendanceId` | attendance | окончательная отметка |
| `AttendanceRegistrationRequested.attendanceId` | schema: **required** + тип `nullableUuid` | допустим UUID или JSON `null`; выбранный пример/проект «ещё нет отметки» = `null`, это **не** `const: null` схемы |
| `consumedRegistrationId` | Restored / correction | registration исходного Consumed |
| `attendanceCorrectionId` | Restored / correction | операция исправления |
| `sourceBookingId` / `targetBookingId` | transfer / right / seat | logical к booking |
| `reservationId` права vs `id`/`seatReservationId` места | разные владельцы | разные пространства |
| `cursor` / `nextCursor` | списки | opaque |

---

## 2. События (полный required payload; BookingCanceled — две ветки)

Условные получатели — `recipients_when_*` в `catalog.json`. Колонка «Required» — полный список полей `required` из schema (без «+»-наследования чужого факта).

| Факт | Издатель | Получатели | Required payload (schema) | Изменение у издателя | 03 / 05 / пробел |
| ---- | -------- | ---------- | ------------------------- | -------------------- | ---------------- |
| `SubscriptionActivated` | subscriptions | notifications | `subscriptionId`, `studentId`, `tariffId`, `status`(=`active`), `activatedAt`, `expiresAt` | subscription + N rights + outbox | Student/Tariff HTTP нет |
| `SubscriptionExpired` | subscriptions | notifications, transfers | `subscriptionId`, `studentId`, `tariffId`, `status`(=`expired`), `expiredAt` | status expired | таймер — **открыто** |
| `LessonRightReserved` | subscriptions | transfers | `rightId`, `subscriptionId`, `studentId`, `transferId`, `reservationId`, `sourceBookingId`, `status`(=`reserved`) | right→reserved; reservation active | 05 |
| `LessonRightReleased` | subscriptions | transfers, schedule | `rightId`, `subscriptionId`, `studentId`, `transferId`, `reservationId`, `sourceBookingId`, `bookingId`, `status`(=`bound`), `reservationStatus`(=`released`) | compensated release | schedule projection 05 §4 |
| `LessonRightConsumed` | subscriptions | attendance, notifications | `rightId`, `subscriptionId`, `studentId`, `bookingId`, `lessonId`, `registrationId`, `status`(=`consumed`), `rightEffect`(=`consumed`) | journal consume; right consumed | UNIQUE `(right_id,booking_id)` |
| `LessonRightRestored` | subscriptions | attendance, notifications | `rightId`, `subscriptionId`, `studentId`, `bookingId`, `lessonId`, `consumedRegistrationId`, `attendanceCorrectionId`, `status`(=`bound`) — **нет** `registrationId`, **нет** `rightEffect` | journal restore | HTTP restore нет; absence **открыто** |
| `LessonRightTransferred` | subscriptions | transfers, schedule | `rightId`, `subscriptionId`, `studentId`, `transferId`, `reservationId`, `sourceBookingId`, `targetBookingId`, `status`(=`bound`) | rebind commit | Transferred ≠ барьер hold |
| `LessonScheduled` | schedule | notifications | `lessonId`, `groupId`, `teacherId`, `startsAt`, `endsAt`, `capacity`, `status`(=`scheduled`) | INSERT lesson | адресаты без studentId — **открыто** |
| `LessonCanceledBySchool` | schedule | subscriptions, transfers, attendance, notifications | `lessonId`, `groupId`, `teacherId`, `schoolCancellationId`, `status`(=`canceled_by_school`) | lesson canceled | цель: не consume / не spend limit; гонка consume до `canceled_lessons` (05 §6); нет auto-restore / сигнала `completed` — **открыто** |
| `BookingConfirmed` ordinary | schedule | transfers, subscriptions, notifications | `bookingId`, `lessonId`, `studentId`, `rightId`, `transferId`(=null), `seatStatus`(=`confirmed`) | confirm ordinary | bind асинхронно; освобождение при отказе bind — **открыто** |
| `BookingConfirmed` transfer | schedule | transfers | те же поля; `transferId` UUID | transfer confirm | 05 §4; Released не нужен |
| `BookingCanceled` ordinary | schedule | subscriptions, notifications | `bookingId`, `lessonId`, `studentId`, `rightId`, `transferId`(=null), `bookingCancellationId` (UUID), `cause`(=`ordinary`), `seatStatus`(=`canceled`) | cancel booking | `rightBindingEffect` — **открыто** |
| `BookingCanceled` transfer_source_release | schedule | transfers | `bookingId`, `lessonId`, `studentId`, `rightId`, `transferId` (UUID), `bookingCancellationId`(=null), `cause`(=`transfer_source_release`), `seatStatus`(=`canceled`) | source release | не снимает новую привязку |
| `TransferSeatReserved` | schedule | transfers | `seatReservationId`, `lessonId`, `studentId`, `rightId`, `transferId`, `targetBookingId`, `status`(=`active`) | seat+booking hold | 05 §4 проектно |
| `AttendanceRegistrationRequested` | attendance | subscriptions | `registrationId`, `bookingId`, `studentId`, `lessonId`, `rightId`, `mark`, `attendanceId` (**nullableUuid**, required) | INSERT registration | пример/проект начального `null`; schema **не** `const: null`; absence consume — **открыто** |
| `AttendanceRecorded` | attendance | notifications | `attendanceId`, `registrationId`, `bookingId`, `studentId`, `lessonId`, `rightId`, `mark`(=`presence`), `status`(=`recorded`), `rightEffect`(=`consumed`) | INSERT attendance | после Consumed |
| `AbsenceRecorded` | attendance | notifications | `attendanceId`, `registrationId`, `bookingId`, `studentId`, `lessonId`, `rightId`, `mark`(=`absence`), `status`(=`absent`), `rightEffect`(=`unspecified`) | INSERT attendance | списание не утверждается |
| `TransferRequested` | transfers | schedule, subscriptions, notifications | `transferId`, `studentId`, `rightId`, `sourceBookingId`, `targetLessonId`, `targetBookingId` (**nullableUuid**), `status`(=`accepted`) | INSERT transfer | сами не резервируют |
| `TransferCompleted` | transfers | notifications | `transferId`, `studentId`, `rightId`, `sourceBookingId`, `targetLessonId`, `targetBookingId` (**uuid**), `status`(=`completed`) | completed | лимит тарифа — **открыто** |
| `TransferRejected` | transfers | notifications | `transferId`, `studentId`, `rightId`, `sourceBookingId`, `targetLessonId`, `targetBookingId` (**nullableUuid**), `status`(=`rejected`), `rejectionReason` | rejected до commit | 05 knowledge CHECK |
| `NotificationDelivered` | notifications | _(нет)_ | `notificationId`, `studentId`, `subjectType`, `subjectId`, `status`(=`delivered`), `channel`, `recordedAt` | attempt delivered | не откатывает бизнес |
| `NotificationDeliveryFailed` | notifications | _(нет)_ | `notificationId`, `studentId`, `subjectType`, `subjectId`, `status`(=`failed`), `channel`, `recordedAt` | attempt failed | то же |

---

## 3. Итог сверки vs пробелы

**Согласовано вручную:** владельцы OpenAPI↔01; path/body/response ID без подмены; local FK vs logical по ddl (вкл. составные attendance/seat); пять `subjectType`; 20 фактов с полным required; ветки Canceled; условные recipients Confirmed; hold как проект 05.

**Открыто:** сигналы `completed` cancel; ordinary confirmed без bind; absence / consume-rejected / HTTP restore; таймер expired; лимит тарифа для transfers; forget idempotency; адресаты Notification без `studentId`; Student/Tariff/Teacher/Group API.

**Инструментально (обзор §10):** YAML/`$ref`; Ajv examples без format uuid/date-time; Mermaid Temp недоступен; равенство имён ≠ эта матрица.
