import { resolve } from 'node:path';
import process from 'node:process';
import { config as loadDotenv } from 'dotenv';

const connectionVariable =
  /^(DATABASE_URL|.*_DATABASE_URL|.*_DB_PASSWORD|POSTGRES_.*|RABBITMQ_.*)$/;

/**
 * Загружает только настройки текущего процесса. Окружение имеет приоритет
 * перед локальным .env приложения, затем используется корневой .env.
 * @param {string[]} variables
 * @param {string} [cwd]
 */
export function loadLocalEnv(variables, cwd = process.cwd()) {
  const allowed = new Set(variables);
  for (const key of Object.keys(process.env)) {
    const name = key.toUpperCase();
    if (connectionVariable.test(name) && !allowed.has(name)) {
      delete process.env[key];
    }
  }

  const local = {};
  loadDotenv({
    path: [resolve(cwd, '.env'), resolve(cwd, '../../.env')],
    processEnv: local,
    quiet: true,
  });
  for (const key of variables) {
    if (process.env[key] === undefined && local[key] !== undefined) {
      process.env[key] = local[key];
    }
  }
  return process.env;
}
