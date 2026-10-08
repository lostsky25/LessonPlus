import { bootstrap } from './bootstrap.js';

bootstrap({
  serviceName: 'transfers',
  schema: 'transfers',
  defaultPort: 3004,
  databaseUrlVariable: 'TRANSFERS_DATABASE_URL',
  swaggerTitle: 'Сервис переносов',
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
