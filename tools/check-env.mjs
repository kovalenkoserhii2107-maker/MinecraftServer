#!/usr/bin/env node
/**
 * Предстартовая проверка портов в .env.
 *
 * Ловит ситуацию, которая иначе проявляется не там, где причина: контейнер
 * стартует успешно, забирает UDP 19132, и падает уже Phantom — с невнятным
 * "address already in use". Здесь это видно до запуска и с готовым решением.
 *
 * Проверка предупреждает, но не блокирует: сервер может быть нужен и без
 * Phantom (например, чтобы проверить подключение со Switch).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnv, PROJECT_ROOT } from './env.mjs';

/** Достаёт значения по умолчанию прямо из docker-compose.yml, чтобы они не разъехались. */
async function composeDefaults() {
    const compose = await readFile(join(PROJECT_ROOT, 'docker-compose.yml'), 'utf8');
    const pick = (name) => compose.match(new RegExp(`\\$\\{${name}:-(\\d+)\\}`))?.[1];
    return { SERVER_PORT: pick('SERVER_PORT'), SERVER_PORT_V6: pick('SERVER_PORT_V6') };
}

const env = await loadEnv();
const defaults = await composeDefaults();

const serverPort = env.SERVER_PORT ?? defaults.SERVER_PORT;
const serverPortV6 = env.SERVER_PORT_V6 ?? defaults.SERVER_PORT_V6;
const phantomServer = env.PHANTOM_SERVER ?? '';
const phantomIsLocal = /^(127\.0\.0\.1|localhost)(:|$)/.test(phantomServer);
const phantomPort = phantomServer.includes(':') ? phantomServer.split(':').pop() : undefined;

const problems = [];

if (!env.__hasFile) {
    problems.push([
        'Файла .env нет — применяются значения по умолчанию из docker-compose.yml.',
        'Создайте его: cp .env.example .env',
    ]);
}

if (serverPort === serverPortV6) {
    problems.push([
        `SERVER_PORT и SERVER_PORT_V6 совпадают (${serverPort}).`,
        'Docker откажется поднимать контейнер: один хост-порт нельзя занять дважды.',
        'Задайте разные значения, например SERVER_PORT=19133 и SERVER_PORT_V6=19134.',
    ]);
}

if (phantomIsLocal) {
    // Фаза 1: Phantom и BDS живут на одной машине и делят пространство портов.
    if (serverPort === '19132') {
        problems.push([
            `SERVER_PORT=${serverPort}, но локально этот порт обязан занимать Phantom —`,
            'иначе он не получит broadcast-запросы консолей и упадёт с',
            '"listen udp4 :19132: bind: address already in use".',
            '',
            'Добавьте в .env:',
            '  SERVER_PORT=19133',
            '  PHANTOM_SERVER=127.0.0.1:19133',
        ]);
    } else if (phantomPort && phantomPort !== serverPort) {
        problems.push([
            `PHANTOM_SERVER указывает на порт ${phantomPort}, а BDS слушает ${serverPort}.`,
            'Phantom будет проксировать в пустоту — консоли увидят сервер, но не войдут.',
            `Приведите к одному значению: PHANTOM_SERVER=127.0.0.1:${serverPort}`,
        ]);
    }
} else if (phantomServer !== '' && serverPort !== '19132') {
    // Фаза 2: Phantom смотрит на удалённый хост, значит здесь продакшн-сервер.
    problems.push([
        `PHANTOM_SERVER указывает на удалённый хост, но SERVER_PORT=${serverPort}.`,
        'На VPS Phantom не запускается и порт свободен — консоли ждут стандартный 19132.',
        'Поставьте SERVER_PORT=19132.',
    ]);
}

if (problems.length === 0) {
    console.log(`check-env: порты согласованы (BDS ${serverPort}/udp, IPv6 ${serverPortV6}/udp).`);
    process.exit(0);
}

console.warn('');
console.warn('  ┌─ check-env: проверьте конфигурацию портов ────────────────');
for (const [index, lines] of problems.entries()) {
    if (index > 0) console.warn('  │');
    for (const line of lines) console.warn(line === '' ? '  │' : `  │ ${line}`);
}
console.warn('  └───────────────────────────────────────────────────────────');
console.warn('');
// Не блокируем: сервер может быть нужен и без Phantom.
process.exit(0);
