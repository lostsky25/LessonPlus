import { access, copyFile } from 'node:fs/promises';

try {
  await access('.env');
  console.log('.env уже существует');
} catch {
  await copyFile('.env.example', '.env');
  console.log('Создан .env из .env.example');
}
