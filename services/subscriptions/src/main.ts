import { bootstrap } from './bootstrap.js';

bootstrap({
  serviceName: 'subscriptions',
  schema: 'subscriptions',
  defaultPort: 3001,
  databaseUrlVariable: 'SUBSCRIPTIONS_DATABASE_URL',
  swaggerTitle: 'Сервис абонементов',
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
