import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tscPath = require.resolve('typescript/lib/tsc.js');
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

const tsc = start([tscPath, '--watch', '--preserveWatchOutput']);
tsc.on('exit', (code) => {
  if (code && code !== 0) {
    stopAll();
    process.exit(code);
  }
});

const entry = 'dist/main.js';
const started = Date.now();
while (!existsSync(entry)) {
  if (Date.now() - started > 90_000) {
    console.error('Сборка не создала dist/main.js');
    stopAll();
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}

const app = start(['--watch', entry]);
app.on('exit', (code) => {
  stopAll();
  process.exit(code ?? 0);
});
