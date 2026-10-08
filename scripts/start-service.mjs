import { spawn } from 'node:child_process';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} завершился с кодом ${code}`));
      }
    });
  });
}

await run('pnpm', ['exec', 'prisma', 'migrate', 'deploy']);

const app = spawn(process.execPath, ['dist/main.js'], { stdio: 'inherit' });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => app.kill(signal));
}

app.on('exit', (code) => {
  process.exit(code ?? 0);
});
