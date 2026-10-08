import { bootstrap } from './bootstrap.js';

bootstrap({
  serviceName: 'schedule',
  schema: 'schedule',
  defaultPort: 3002,
  databaseUrlVariable: 'SCHEDULE_DATABASE_URL',
  swaggerTitle: 'Сервис расписания',
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
