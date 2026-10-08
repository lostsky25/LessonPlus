import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { isAbsolute, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const targetUrl = 'git@github.com:lostsky25/LessonPlus.git';
const checks = ['typecheck', 'lint', 'build'];

class ExitError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

process.chdir(root);

try {
  await main();
} catch (error) {
  const code = error instanceof ExitError ? error.exitCode : 1;
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(code);
}

async function main() {
  for (const script of checks) {
    const code = await runPnpm(script);
    if (code !== 0) {
      throw new ExitError(`pnpm run ${script} завершился с кодом ${code}`, code);
    }
  }

  await assertGitState();
  const remote = await resolveRemote();
  const added = await git(['add', '-A']);
  if (added.code !== 0) {
    throw new Error(added.stderr.trim() || 'git add завершился с ошибкой');
  }
  await assertStagedFiles();

  const staged = await git(['diff', '--cached', '--quiet']);
  if (staged.code === 0) {
    console.log('Новых изменений нет, пустой коммит не создаётся');
  } else {
    await requireIdentity();
    const message = commitMessage();
    const committed = await git(['commit', '-m', message], { inherit: true });
    if (committed.code !== 0) {
      throw new ExitError(`git commit завершился с кодом ${committed.code}`, committed.code || 1);
    }
  }

  const head = await git(['rev-parse', 'HEAD']);
  if (head.code !== 0) {
    console.log('Локальных коммитов нет, отправлять нечего');
    return;
  }

  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const pushArgs =
    upstream.code === 0 ? ['push', remote, branch] : ['push', '--set-upstream', remote, 'HEAD'];
  const pushed = await git(pushArgs);
  const hash = head.stdout.trim();
  console.log(`Ветка: ${branch}`);
  console.log(`Коммит: ${hash}`);
  const report = `${pushed.stdout}${pushed.stderr}`.trim();
  console.log(report || 'git push не вывел результат');
  if (pushed.code !== 0) {
    if (/non-fast-forward|fetch first|rejected/i.test(report)) {
      console.error(
        'Push отклонён: удалённая ветка содержит коммиты, которых нет локально. Force push не выполняется.',
      );
    }
    throw new ExitError(`git push завершился с кодом ${pushed.code}`, pushed.code || 1);
  }
}

function commitMessage() {
  const parts = process.argv.slice(2);
  if (parts[0] === '--') {
    parts.shift();
  }
  const message = parts.join(' ').trim();
  return message || 'chore: update LessonPlus';
}

async function assertGitState() {
  const attached = await git(['symbolic-ref', '--quiet', 'HEAD']);
  if (attached.code !== 0) {
    throw new Error('HEAD не привязан к ветке. Перейдите на ветку и повторите push.');
  }

  for (const marker of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply']) {
    const located = await git(['rev-parse', '--git-path', marker]);
    if (located.code !== 0) {
      continue;
    }
    const gitPath = located.stdout.trim();
    const fullPath = isAbsolute(gitPath) ? gitPath : resolve(root, gitPath);
    try {
      await access(fullPath);
    } catch {
      continue;
    }
    throw new Error(`Незавершена операция Git (${marker}). Завершите её и повторите push.`);
  }

  const conflicts = await git(['diff', '--name-only', '--diff-filter=U']);
  if (conflicts.stdout.trim()) {
    throw new Error(`Есть конфликты:\n${conflicts.stdout.trim()}`);
  }
}

async function resolveRemote() {
  const remotes = await readRemotes();
  const matches = [...remotes.entries()]
    .filter(([, urls]) => urls.some((url) => sameRemote(url, targetUrl)))
    .map(([name]) => name);
  if (matches.includes('origin')) {
    return 'origin';
  }
  if (matches.includes('lessonplus')) {
    return 'lessonplus';
  }
  if (matches.length > 0) {
    return matches[0];
  }

  const origin = remotes.get('origin');
  if (!origin) {
    const added = await git(['remote', 'add', 'origin', targetUrl]);
    if (added.code !== 0) {
      throw new Error(added.stderr.trim() || 'Не удалось добавить origin');
    }
    console.log(`Добавлен origin ${targetUrl}`);
    return 'origin';
  }

  const lessonplus = remotes.get('lessonplus');
  if (lessonplus && !lessonplus.some((url) => sameRemote(url, targetUrl))) {
    throw new Error(
      `Remote lessonplus уже указывает на ${lessonplus.join(', ')}, а не на ${targetUrl}. Укажите другой remote вручную.`,
    );
  }
  if (!lessonplus) {
    const added = await git(['remote', 'add', 'lessonplus', targetUrl]);
    if (added.code !== 0) {
      throw new Error(added.stderr.trim() || 'Не удалось добавить remote lessonplus');
    }
    console.log(`Добавлен remote lessonplus ${targetUrl}`);
  }
  return 'lessonplus';
}

async function readRemotes() {
  const remotes = new Map();
  for (const key of ['url', 'pushurl']) {
    const listed = await git(['config', '--get-regexp', `^remote\\.[^.]+\\.${key}$`]);
    if (listed.code !== 0) {
      continue;
    }
    for (const line of listed.stdout.split(/\r?\n/)) {
      const match = line.match(/^remote\.([^.]+)\.[^ ]+\s+(.+)$/);
      if (!match) {
        continue;
      }
      const urls = remotes.get(match[1]) ?? [];
      urls.push(match[2].trim());
      remotes.set(match[1], urls);
    }
  }
  return remotes;
}

function sameRemote(left, right) {
  return normalizeRemote(left) === normalizeRemote(right);
}

function normalizeRemote(url) {
  return url
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

async function assertStagedFiles() {
  const names = await git(['diff', '--cached', '--name-only', '-z']);
  const files = names.stdout.split('\0').filter(Boolean);
  const forbidden = files.filter(isForbiddenPath);
  const diff = await git(['diff', '--cached', '--no-ext-diff', '-U0', '--no-color']);
  const secretFiles = filesWithSecrets(diff.stdout);
  const blocked = [...new Set([...forbidden, ...secretFiles])];
  if (blocked.length === 0) {
    return;
  }
  await unstageAll();
  throw new Error(
    `В индексе есть закрытые файлы или секреты, commit остановлен:\n${blocked.join('\n')}`,
  );
}

function isForbiddenPath(file) {
  const normalized = file.replaceAll('\\', '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
  if (base === '.env.example') {
    return false;
  }
  if (base === '.env' || base.startsWith('.env.')) {
    return true;
  }
  if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(base)) {
    return true;
  }
  if (/\.(pem|p12|pfx|key)$/.test(base)) {
    return true;
  }
  return base === 'credentials.json' || base === 'secrets.json';
}

function filesWithSecrets(diff) {
  const found = new Set();
  let file = '';
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ b/')) {
      file = line.slice(6);
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) {
      continue;
    }
    const added = line.slice(1);
    if (containsPrivateMaterial(added) || containsLiteralPassword(file, added)) {
      found.add(file || 'индекс');
    }
  }
  return [...found];
}

function containsPrivateMaterial(line) {
  const privateKey = `-----${'BEGIN'} ${'PRIVATE'} ${'KEY'}-----`;
  const rsaKey = `-----${'BEGIN'} RSA ${'PRIVATE'} ${'KEY'}-----`;
  const opensshKey = `-----${'BEGIN'} OPENSSH ${'PRIVATE'} ${'KEY'}-----`;
  if (line.includes(privateKey) || line.includes(rsaKey) || line.includes(opensshKey)) {
    return true;
  }
  const patterns = [
    new RegExp(`${'ghp'}_${'[A-Za-z0-9]{20,}'}`),
    new RegExp(`${'github'}_pat_${'[A-Za-z0-9_]{20,}'}`),
    new RegExp(`${'glpat'}-${'[A-Za-z0-9-]{20,}'}`),
    new RegExp(`xox${'[baprs]'}-${'[A-Za-z0-9-]{10,}'}`),
    new RegExp(`${'sk'}_live_${'[A-Za-z0-9]{8,}'}`),
    new RegExp(`AKIA${'[0-9A-Z]{16}'}`),
  ];
  return patterns.some((pattern) => pattern.test(line));
}

function containsLiteralPassword(file, line) {
  if (file.replaceAll('\\', '/').endsWith('.env.example')) {
    return false;
  }
  const assignment = line.match(
    /([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY))\s*[:=]\s*(.+)$/i,
  );
  if (assignment && !isPlaceholder(assignment[2])) {
    return true;
  }
  return /:\/\/[^/\s:]+:(?!\$)[^@\s]+@/.test(line);
}

function isPlaceholder(value) {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed || trimmed.includes('${') || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    return true;
  }
  return /^(changeme|example|placeholder|your-[a-z0-9-]*|<.*>)$/i.test(trimmed);
}

async function requireIdentity() {
  const name = await git(['config', '--get', 'user.name']);
  const email = await git(['config', '--get', 'user.email']);
  if (name.code !== 0 || !name.stdout.trim() || email.code !== 0 || !email.stdout.trim()) {
    throw new Error(
      'Git user.name или user.email не настроены. Задайте их самостоятельно: скрипт не записывает identity.',
    );
  }
}

async function unstageAll() {
  const head = await git(['rev-parse', '--verify', 'HEAD']);
  if (head.code === 0) {
    await git(['restore', '--staged', '.']);
    return;
  }
  await git(['rm', '-r', '--cached', '-q', '--', '.']);
}

async function runPnpm(script) {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, ['run', script], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('exit', (code) => resolvePromise(code ?? 1));
  });
}

function git(args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, {
      cwd: root,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    if (!options.inherit) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
    }
    child.on('error', reject);
    child.on('exit', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}
