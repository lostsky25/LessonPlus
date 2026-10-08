export const serviceNames = [
  'subscriptions',
  'schedule',
  'attendance',
  'transfers',
  'notifications',
] as const;

export type ServiceName = (typeof serviceNames)[number];

export type ProbeStatus = 'up' | 'down';

export interface ServiceStatus {
  name: ServiceName;
  live: ProbeStatus;
  ready: ProbeStatus;
}

export interface SystemStatus {
  services: ServiceStatus[];
}
