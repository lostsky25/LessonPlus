/**
 * Общий конверт интеграционного события.
 * Имена полей совпадают с JSON Schema в packages/contracts/events/.
 * Тип — event_type, версия формата — целое schema_version (поддерживается только 1).
 * Поля source в конверте нет: издателя выводят eventCatalog и catalog.json.
 * Форма payload задана схемой; в TypeScript остаётся unknown до сценариев.
 * Идентификаторы — UUID, время — ISO 8601.
 */
export interface EventEnvelope<TPayload = unknown> {
  event_id: string;
  event_type: EventName;
  schema_version: number;
  occurred_at: string;
  correlation_id: string;
  payload: TPayload;
}

export const subscriptionEventNames = [
  'SubscriptionActivated',
  'SubscriptionExpired',
  'LessonRightReserved',
  'LessonRightReleased',
  'LessonRightConsumed',
  'LessonRightRestored',
  'LessonRightTransferred',
] as const;

export const scheduleEventNames = [
  'LessonScheduled',
  'LessonCanceledBySchool',
  'BookingConfirmed',
  'BookingCanceled',
  'TransferSeatReserved',
] as const;

export const attendanceEventNames = [
  'AttendanceRegistrationRequested',
  'AttendanceRecorded',
  'AbsenceRecorded',
] as const;

export const transferEventNames = [
  'TransferRequested',
  'TransferCompleted',
  'TransferRejected',
] as const;

export const notificationEventNames = [
  'NotificationDelivered',
  'NotificationDeliveryFailed',
] as const;

export const eventCatalog = {
  subscriptions: subscriptionEventNames,
  schedule: scheduleEventNames,
  attendance: attendanceEventNames,
  transfers: transferEventNames,
  notifications: notificationEventNames,
} as const;

export type SubscriptionEventName = (typeof subscriptionEventNames)[number];
export type ScheduleEventName = (typeof scheduleEventNames)[number];
export type AttendanceEventName = (typeof attendanceEventNames)[number];
export type TransferEventName = (typeof transferEventNames)[number];
export type NotificationEventName = (typeof notificationEventNames)[number];

export type EventName =
  | SubscriptionEventName
  | ScheduleEventName
  | AttendanceEventName
  | TransferEventName
  | NotificationEventName;

const eventNameSet = new Set<string>([
  ...subscriptionEventNames,
  ...scheduleEventNames,
  ...attendanceEventNames,
  ...transferEventNames,
  ...notificationEventNames,
]);

export function isEventName(value: string): value is EventName {
  return eventNameSet.has(value);
}
