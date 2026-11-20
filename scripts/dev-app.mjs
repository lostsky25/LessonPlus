import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import { gatewayTargets } from '../packages/config/dist/index.js';
import { loadLocalEnv } from '../packages/config/src/local-env.js';

const name = basename(process.cwd());
const variables =
  name === 'api-gateway'
    ? gatewayTargets.map(([, variable]) => variable)
    : ['DATABASE_URL', name.toUpperCase() + '_DATABASE_URL', 'RABBITMQ_URL'];
loadLocalEnv(['HOST', 'PORT', ...variables]);

const children = [];

function start(args) {
  const child = spawn(process.execPath, args, { stdio: 'inherit' });
  children.push(child);
  return child;
}

function stopAll() {
  for (const child of children) {
    child.kill();
  }
}

process.on('SIGINT', () => {
  stopAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopAll();
  process.exit(0);
});

const entry = 'dist/main.js';
const watch = !process.argv.includes('--start');
if (watch) {
  const require = createRequire(import.meta.url);
  const tsc = start([require.resolve('typescript/lib/tsc.js'), '--watch', '--preserveWatchOutput']);
  tsc.on('exit', (code) => {
    if (code && code !== 0) {
      stopAll();
      process.exit(code);
    }
  });

  const started = Date.now();
  while (!existsSync(entry)) {
    if (Date.now() - started > 90_000) {
      console.error('Сборка не создала dist/main.js');
      stopAll();
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const app = start(watch ? ['--watch', entry] : [entry]);
app.on('exit', (code) => {
  stopAll();
  process.exit(code ?? 0);
});
