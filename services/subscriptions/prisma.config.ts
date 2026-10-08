import { config as loadDotenv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, env } from 'prisma/config';

const serviceRoot = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(serviceRoot, '.env') });
loadDotenv({ path: resolve(serviceRoot, '../../.env') });

const databaseUrl = process.env.DATABASE_URL ?? process.env.SUBSCRIPTIONS_DATABASE_URL;
if (!databaseUrl) {
  throw new Error('Задайте DATABASE_URL или SUBSCRIPTIONS_DATABASE_URL');
}

process.env.DATABASE_URL = databaseUrl;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
