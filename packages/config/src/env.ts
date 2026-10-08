import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

const postgresUrl = z
  .string()
  .refine(
    (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
    'Ожидается URL PostgreSQL',
  );

const amqpUrl = z
  .string()
  .refine(
    (value) => value.startsWith('amqp://') || value.startsWith('amqps://'),
    'Ожидается URL AMQP',
  );

const httpUrl = z
  .string()
  .refine(
    (value) => value.startsWith('http://') || value.startsWith('https://'),
    'Ожидается HTTP URL',
  );

const businessSchema = z.object({
  serviceName: z.string().min(1),
  schema: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  databaseUrl: postgresUrl,
  rabbitMqUrl: amqpUrl,
});

const gatewaySchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  services: z.array(
    z.object({
      name: z.string().min(1),
      url: httpUrl,
    }),
  ),
});

export type BusinessServiceConfig = z.infer<typeof businessSchema>;
export type GatewayConfig = z.infer<typeof gatewaySchema>;

export interface BusinessServiceOptions {
  serviceName: string;
  schema: string;
  defaultPort: number;
  databaseUrlVariable: string;
}

const gatewayTargets = [
  ['subscriptions', 'SUBSCRIPTIONS_URL'],
  ['schedule', 'SCHEDULE_URL'],
  ['attendance', 'ATTENDANCE_URL'],
  ['transfers', 'TRANSFERS_URL'],
  ['notifications', 'NOTIFICATIONS_URL'],
] as const;

/**
 * Подхватывает .env сервиса и корневой .env.
 * Уже заданные переменные не перезаписываются, поэтому Docker-адреса остаются в силе.
 */
export function loadLocalEnv(cwd = process.cwd()): void {
  loadDotenv({ path: resolve(cwd, '.env') });
  loadDotenv({ path: resolve(cwd, '../../.env') });
}

export function loadBusinessServiceConfig(
  env: NodeJS.ProcessEnv,
  options: BusinessServiceOptions,
): BusinessServiceConfig {
  const parsed = businessSchema.safeParse({
    serviceName: options.serviceName,
    schema: options.schema,
    host: env.HOST && env.HOST.length > 0 ? env.HOST : '0.0.0.0',
    port: readPort(env, options.defaultPort),
    databaseUrl: env.DATABASE_URL ?? env[options.databaseUrlVariable],
    rabbitMqUrl: env.RABBITMQ_URL,
  });

  if (!parsed.success) {
    throw new Error(
      `Некорректная конфигурация сервиса ${options.serviceName}. Проверьте ${options.databaseUrlVariable} или DATABASE_URL и RABBITMQ_URL. ${formatIssues(parsed.error)}`,
    );
  }

  return parsed.data;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const parsed = gatewaySchema.safeParse({
    host: env.HOST && env.HOST.length > 0 ? env.HOST : '0.0.0.0',
    port: readPort(env, 3000),
    services: gatewayTargets.map(([name, variable]) => ({
      name,
      url: env[variable],
    })),
  });

  if (!parsed.success) {
    throw new Error(
      `Некорректная конфигурация API gateway. Проверьте SUBSCRIPTIONS_URL, SCHEDULE_URL, ATTENDANCE_URL, TRANSFERS_URL и NOTIFICATIONS_URL. ${formatIssues(parsed.error)}`,
    );
  }

  return parsed.data;
}

function readPort(env: NodeJS.ProcessEnv, fallback: number): number {
  const raw = env.PORT;
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT должен быть целым числом от 1 до 65535');
  }

  return port;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`)
    .join('; ');
}
