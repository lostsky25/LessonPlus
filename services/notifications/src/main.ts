import { bootstrap } from './bootstrap.js';

bootstrap({
  serviceName: 'notifications',
  schema: 'notifications',
  defaultPort: 3005,
  databaseUrlVariable: 'NOTIFICATIONS_DATABASE_URL',
  swaggerTitle: 'Сервис уведомлений',
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
