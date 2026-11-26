import type { SubscriptionActivation } from '../../application/subscription-activation.js';

export const SUBSCRIPTION_ACTIVATED = 'SubscriptionActivated';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
}

function isDateTime(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function parseSubscriptionActivation(body: Buffer): SubscriptionActivation | null {
  let event: unknown;
  try {
    event = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  if (
    !isRecord(event) ||
    Object.keys(event).length !== 6 ||
    event.event_type !== SUBSCRIPTION_ACTIVATED ||
    event.schema_version !== 1 ||
    !isUuid(event.event_id) ||
    !isUuid(event.correlation_id) ||
    !isDateTime(event.occurred_at) ||
    !isRecord(event.payload)
  ) {
    return null;
  }
  const payload = event.payload;
  if (
    Object.keys(payload).length !== 6 ||
    !isUuid(payload.subscriptionId) ||
    !isUuid(payload.studentId) ||
    !isUuid(payload.tariffId) ||
    payload.status !== 'active' ||
    !isDateTime(payload.activatedAt) ||
    !isDateTime(payload.expiresAt)
  ) {
    return null;
  }
  return {
    eventId: event.event_id,
    subscriptionId: payload.subscriptionId,
    studentId: payload.studentId,
  };
}
