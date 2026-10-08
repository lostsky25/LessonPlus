import { bootstrap } from './bootstrap.js';

bootstrap({
  serviceName: 'attendance',
  schema: 'attendance',
  defaultPort: 3003,
  databaseUrlVariable: 'ATTENDANCE_DATABASE_URL',
  swaggerTitle: 'Сервис посещений',
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
