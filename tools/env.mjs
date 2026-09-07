/**
 * Чтение .env без внешних зависимостей.
 *
 * Хостовые скрипты (`tools/`) должны работать сразу после `git clone`, до
 * `npm install`, поэтому dotenv здесь не используется.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Разбирает содержимое .env в объект. Комментарии и пустые строки пропускаются. */
export function parseEnv(content) {
    const result = {};
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;
        const separator = trimmed.indexOf('=');
        if (separator === -1) continue;
        const key = trimmed.slice(0, separator).trim();
        const value = trimmed
            .slice(separator + 1)
            .trim()
            .replace(/^["']|["']$/g, '');
        result[key] = value;
    }
    return result;
}

/**
 * Значения из .env. Переменные окружения имеют приоритет — как и в
 * docker compose, где `SERVER_PORT=... docker compose up` перебивает файл.
 */
export async function loadEnv(root = PROJECT_ROOT) {
    const envPath = join(root, '.env');
    const fromFile = existsSync(envPath) ? parseEnv(await readFile(envPath, 'utf8')) : {};
    return { ...fromFile, ...process.env, __hasFile: existsSync(envPath) };
}

/** Одно значение с запасным вариантом. */
export async function readEnv(key, fallback, root = PROJECT_ROOT) {
    const env = await loadEnv(root);
    return env[key] ?? fallback;
}
