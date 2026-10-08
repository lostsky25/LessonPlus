import { spawn } from 'node:child_process';
import { access, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const waitTimeoutSeconds = 600;
const commandTimeoutMs = 20 * 60 * 1000;
const statusTimeoutMs = 60_000;
const statusUrl = 'http://127.0.0.1:3000/api/system/status';
const longRunningServices = new Set([
  'postgres',
  'rabbitmq',
  'subscriptions',
  'schedule',
  'attendance',
  'transfers',
  'notifications',
  'api-gateway',
  'web',
]);
const serviceNames = ['subscriptions', 'schedule', 'attendance', 'transfers', 'notifications'];

process.chdir(root);

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function main() {
  await ensureDocker();
  await ensureEnv();
  const startedAt = Date.now();
  console.log(
    `Запуск docker compose up --build --wait, ожидание готовности до ${waitTimeoutSeconds} с`,
  );
  const upCode = await run(
    'docker',
    ['compose', 'up', '--build', '--wait', '--wait-timeout', String(waitTimeoutSeconds)],
    commandTimeoutMs,
  );
  await assertComposeState(upCode, startedAt);
  await assertSystemStatus();
  console.log('Интерфейс: http://127.0.0.1:5173');
  console.log('Swagger: http://127.0.0.1:3000/docs');
}

async function ensureDocker() {
  const info = await capture('docker', ['info']);
  if (info.code !== 0) {
    throw new Error(
      `Docker недоступен. Запустите Docker и повторите команду.\n${tail(info.stderr || info.stdout)}`,
    );
  }
  const compose = await capture('docker', ['compose', 'version']);
  if (compose.code !== 0) {
    throw new Error(`Docker Compose недоступен.\n${tail(compose.stderr || compose.stdout)}`);
  }
  console.log(compose.stdout.trim() || 'Docker Compose доступен');
}

async function ensureEnv() {
  const envPath = resolve(root, '.env');
  const examplePath = resolve(root, '.env.example');
  try {
    await access(envPath);
    console.log('.env уже существует');
  } catch {
    try {
      await access(examplePath);
    } catch {
      throw new Error('Нет .env.example, нечего копировать в .env');
    }
    await copyFile(examplePath, envPath);
    console.log('Создан .env из .env.example');
  }
}

async function assertComposeState(upCode, startedAt) {
  const listed = await capture('docker', ['compose', 'ps', '--all', '--format', 'json']);
  if (listed.code !== 0) {
    throw new Error(
      `Не удалось прочитать состояние контейнеров.\n${tail(listed.stderr || listed.stdout)}`,
    );
  }
  const containers = parseComposePs(listed.stdout);
  const problems = [];
  const present = new Set();
  let freshOneShot = false;

  for (const container of containers) {
    const service = String(container.Service ?? '');
    present.add(service);
    const state = String(container.State ?? '');
    const health = String(container.Health ?? '');
    const exitCode = Number(container.ExitCode ?? 0);

    if (longRunningServices.has(service)) {
      if (state !== 'running' || (health !== '' && health !== 'healthy')) {
        problems.push(`${service}: ${state}${health ? `/${health}` : ''}`);
      }
      continue;
    }

    if (state === 'exited' && exitCode === 0) {
      console.log(`Одноразовый контейнер ${service} завершился успешно`);
      if (parseCreated(container.CreatedAt) >= startedAt - 5000) {
        freshOneShot = true;
      }
      continue;
    }

    problems.push(
      state === 'exited'
        ? `${service} завершился с кодом ${exitCode}`
        : `${service}: ${state}${health ? `/${health}` : ''}`,
    );
  }

  for (const service of longRunningServices) {
    if (!present.has(service)) {
      problems.push(`${service} не запущен`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Стек не готов: ${problems.join('; ')}`);
  }
  if (upCode !== 0 && !freshOneShot) {
    throw new Error(`docker compose up завершился с кодом ${upCode}`);
  }
  if (upCode !== 0) {
    console.log('Одноразовые контейнеры миграций завершились, приложения готовы');
  }
  console.log('Миграции применены вместе со стартом сервисов, тома Docker сохранены');
}

async function assertSystemStatus() {
  const started = Date.now();
  let lastError = 'нет ответа';
  while (Date.now() - started < statusTimeoutMs) {
    try {
      const response = await fetch(statusUrl);
      if (!response.ok) {
        throw new Error(`${statusUrl} вернул ${response.status}`);
      }
      const body = await response.json();
      assertStatusBody(body);
      console.log('GET /api/system/status: все сервисы готовы');
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'неизвестная ошибка';
      await delay(2000);
    }
  }
  throw new Error(`Статусы сервисов не получены: ${lastError}`);
}

function assertStatusBody(body) {
  if (!body || !Array.isArray(body.services) || body.services.length !== serviceNames.length) {
    throw new Error('неожиданный ответ /api/system/status');
  }
  for (const name of serviceNames) {
    const service = body.services.find((item) => item.name === name);
    if (!service || service.live !== 'up' || service.ready !== 'up') {
      throw new Error(`сервис ${name} не готов`);
    }
  }
}

function parseComposePs(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }
  return trimmed
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function parseCreated(value) {
  const cleaned = String(value ?? '').replace(/ [A-Za-z]{2,5}$/, '');
  const time = Date.parse(cleaned);
  return Number.isNaN(time) ? 0 : time;
}

function tail(text) {
  return text.trim().split(/\r?\n/).slice(-20).join('\n');
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function run(command, args, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error(`${command} ${args.join(' ')} превысил ограничение по времени`));
    }, timeoutMs);
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolvePromise(code ?? 1);
    });
  });
}

function capture(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}
