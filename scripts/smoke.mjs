import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const deadlineMs = 180_000;

const endpoints = [
  ['gateway live', 'http://127.0.0.1:3000/health/live'],
  ['gateway ready', 'http://127.0.0.1:3000/health/ready'],
  ['subscriptions live', 'http://127.0.0.1:3001/health/live'],
  ['subscriptions ready', 'http://127.0.0.1:3001/health/ready'],
  ['schedule live', 'http://127.0.0.1:3002/health/live'],
  ['schedule ready', 'http://127.0.0.1:3002/health/ready'],
  ['attendance live', 'http://127.0.0.1:3003/health/live'],
  ['attendance ready', 'http://127.0.0.1:3003/health/ready'],
  ['transfers live', 'http://127.0.0.1:3004/health/live'],
  ['transfers ready', 'http://127.0.0.1:3004/health/ready'],
  ['notifications live', 'http://127.0.0.1:3005/health/live'],
  ['notifications ready', 'http://127.0.0.1:3005/health/ready'],
  ['web', 'http://127.0.0.1:5173/'],
];

await waitFor(async () => {
  for (const [name, url] of endpoints) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`${name} вернул ${response.status}`);
    }
  }
});
console.log('Health и главная страница отвечают 200');

const status = await readJson('http://127.0.0.1:3000/api/system/status');
assertSystemStatus(status, 'gateway');
const proxied = await readJson('http://127.0.0.1:5173/api/system/status');
assertSystemStatus(proxied, 'vite proxy');
console.log('Статусы сервисов получены через gateway и через интерфейс');

const page = await fetch('http://127.0.0.1:5173/');
const html = await page.text();
if (!html.includes('Система учёта абонементов и переносов занятий')) {
  throw new Error('Главная страница не содержит название проекта');
}
console.log('Интерфейс отдаёт страницу проекта');

await assertDatabaseIsolation();
console.log('Роли PostgreSQL изолированы по схемам');
console.log('Smoke-проверка пройдена');

async function waitFor(action) {
  const started = Date.now();
  let lastError = 'нет ответа';
  while (Date.now() - started < deadlineMs) {
    try {
      await action();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'неизвестная ошибка';
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw new Error(`Стек не стал готов за ${deadlineMs / 1000} с: ${lastError}`);
}

async function readJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} вернул ${response.status}`);
  }
  return response.json();
}

function assertSystemStatus(body, source) {
  const names = ['subscriptions', 'schedule', 'attendance', 'transfers', 'notifications'];
  if (!body || !Array.isArray(body.services) || body.services.length !== names.length) {
    throw new Error(`${source}: неожиданный ответ статуса`);
  }
  for (const name of names) {
    const service = body.services.find((item) => item.name === name);
    if (!service || service.live !== 'up' || service.ready !== 'up') {
      throw new Error(`${source}: сервис ${name} не готов`);
    }
  }
}

async function assertDatabaseIsolation() {
  const schemas = await psql(
    'lessonplus_admin',
    "SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = '_prisma_migrations' ORDER BY 1;",
  );
  const actual = schemas
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const expected = ['attendance', 'notifications', 'schedule', 'subscriptions', 'transfers'];
  if (actual.join(',') !== expected.join(',')) {
    throw new Error(
      `Таблица _prisma_migrations должна лежать в схемах сервисов, получено: ${actual.join(', ') || 'пусто'}`,
    );
  }

  const own = await psql('subscriptions_user', 'SELECT count(*) FROM subscriptions.outbox_events;');
  if (!own.includes('0') && !own.includes('(0 rows)') && !/\d+/.test(own)) {
    throw new Error('subscriptions_user не прочитал свою таблицу');
  }

  const foreign = await psqlAllowFailure(
    'subscriptions_user',
    'SELECT count(*) FROM schedule.outbox_events;',
  );
  if (foreign.ok) {
    throw new Error('subscriptions_user получил доступ к схеме schedule');
  }

  const reverse = await psqlAllowFailure(
    'schedule_user',
    'SELECT count(*) FROM subscriptions.outbox_events;',
  );
  if (reverse.ok) {
    throw new Error('schedule_user получил доступ к схеме subscriptions');
  }

  const superuser = await psql(
    'lessonplus_admin',
    "SELECT rolsuper::text FROM pg_roles WHERE rolname = 'subscriptions_user';",
  );
  if (!superuser.includes('false') && !superuser.includes('f')) {
    throw new Error('subscriptions_user не должен быть суперпользователем');
  }
}

async function psql(user, sql) {
  const result = await psqlAllowFailure(user, sql);
  if (!result.ok) {
    throw new Error(result.stderr || result.stdout || `psql ${user} завершился с ошибкой`);
  }
  return result.stdout;
}

async function psqlAllowFailure(user, sql) {
  try {
    const { stdout, stderr } = await execFileAsync(
      'docker',
      [
        'compose',
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        user,
        '-d',
        'lessonplus',
        '-v',
        'ON_ERROR_STOP=1',
        '-t',
        '-A',
        '-c',
        sql,
      ],
      { cwd: root },
    );
    return { ok: true, stdout, stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error === 'object' && error && 'stdout' in error ? String(error.stdout) : '',
      stderr: typeof error === 'object' && error && 'stderr' in error ? String(error.stderr) : '',
    };
  }
}
