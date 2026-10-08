import type { ServiceName } from '@lessonplus/contracts';

export interface Section {
  name: ServiceName;
  path: string;
  title: string;
}

export const sections: readonly Section[] = [
  { name: 'subscriptions', path: '/subscriptions', title: 'Абонементы' },
  { name: 'schedule', path: '/schedule', title: 'Расписание' },
  { name: 'attendance', path: '/attendance', title: 'Посещения' },
  { name: 'transfers', path: '/transfers', title: 'Переносы' },
  { name: 'notifications', path: '/notifications', title: 'Уведомления' },
];

export function sectionTitle(name: ServiceName): string {
  return sections.find((section) => section.name === name)?.title ?? name;
}
