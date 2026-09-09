#!/usr/bin/env node
/**
 * Установка мира из файла `.mcworld` в каталог сервера.
 *
 *   node tools/install-world.mjs <файл.mcworld>            # показать план
 *   node tools/install-world.mjs <файл.mcworld> --yes      # выполнить
 *   node tools/install-world.mjs <файл.mcworld> --yes --name "Earth Map"
 *
 * `.mcworld` — обычный ZIP с папкой мира. Распаковка сделана средствами Node
 * (`zlib`), чтобы скрипт одинаково работал на macOS и на Ubuntu-дроплете и не
 * зависел от того, установлен ли `unzip`.
 *
 * Существующий мир не удаляется, а переименовывается в резервную копию: замена
 * мира стирает весь прогресс, включая балансы, участки и чертежи — они хранятся
 * в dynamic properties этого мира.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { loadEnv, PROJECT_ROOT } from './env.mjs';
import { planExtraction, readEntryData, readZipEntries, writeExtraction } from './zip.mjs';

// ------------------------------------------------------------- чтение level.dat

/** Минимальный разбор NBT (little-endian) — нужны лишь несколько полей. */
function readLevelDat(buf) {
    let off = 8; // заголовок: версия (4) + длина (4)
    const str = () => {
        const len = buf.readUInt16LE(off);
        off += 2;
        const value = buf.toString('utf8', off, off + len);
        off += len;
        return value;
    };
    const value = (type) => {
        switch (type) {
            case 1: return buf.readInt8(off++);
            case 2: { const v = buf.readInt16LE(off); off += 2; return v; }
            case 3: { const v = buf.readInt32LE(off); off += 4; return v; }
            case 4: { const v = buf.readBigInt64LE(off); off += 8; return v.toString(); }
            case 5: { const v = buf.readFloatLE(off); off += 4; return v; }
            case 6: { const v = buf.readDoubleLE(off); off += 8; return v; }
            case 7: { const n = buf.readInt32LE(off); off += 4; off += n; return null; }
            case 8: return str();
            case 9: {
                const t = buf.readUInt8(off++);
                const n = buf.readInt32LE(off);
                off += 4;
                const list = [];
                for (let i = 0; i < n; i++) list.push(value(t));
                return list;
            }
            case 10: {
                const obj = {};
                for (;;) {
                    const t = buf.readUInt8(off++);
                    if (t === 0) break;
                    obj[str()] = value(t);
                }
                return obj;
            }
            case 11: { const n = buf.readInt32LE(off); off += 4; off += n * 4; return null; }
            case 12: { const n = buf.readInt32LE(off); off += 4; off += n * 8; return null; }
            default: throw new Error(`неизвестный тег NBT ${type}`);
        }
    };

    const rootType = buf.readUInt8(off++);
    str();
    return value(rootType);
}

const GAME_TYPE = { 0: 'выживание', 1: 'творческий', 2: 'приключение' };
const GENERATOR = { 0: 'старый (ограниченный)', 1: 'бесконечный', 2: 'плоский' };

// ------------------------------------------------------------------------ план

const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith('--'));
const confirmed = args.includes('--yes');
const nameFlag = args.indexOf('--name');
const nameOverride = nameFlag === -1 ? undefined : args[nameFlag + 1];

if (!source) {
    console.error('Использование: node tools/install-world.mjs <файл.mcworld> [--yes] [--name "Имя мира"]');
    process.exit(1);
}
if (!existsSync(source)) {
    console.error(`Файл не найден: ${source}`);
    process.exit(1);
}

const archive = readFileSync(source);
const entries = readZipEntries(archive);

// Мир может лежать в корне архива или внутри одной папки — находим уровень level.dat.
const levelEntry = entries.find((e) => e.name === 'level.dat' || e.name.endsWith('/level.dat'));
if (!levelEntry) {
    console.error('В архиве нет level.dat — это не мир Minecraft Bedrock.');
    process.exit(1);
}
const prefix = levelEntry.name.slice(0, levelEntry.name.length - 'level.dat'.length);

let level = {};
try {
    level = readLevelDat(readEntryData(archive, levelEntry));
} catch (error) {
    console.warn(`Не удалось разобрать level.dat (${error.message}) — продолжаем без сводки.`);
}

const nameEntry = entries.find((e) => e.name === `${prefix}levelname.txt`);
const levelName =
    nameOverride ??
    (nameEntry ? readEntryData(archive, nameEntry).toString('utf8').trim() : undefined) ??
    level.LevelName ??
    basename(source).replace(/\.mcworld$/i, '');

const env = await loadEnv();
const dataDir = resolve(PROJECT_ROOT, env.SERVER_DATA_DIR ?? './server-data');
const worldsDir = join(dataDir, 'worlds');
const target = join(worldsDir, levelName);
const envLevelName = env.LEVEL_NAME;

const version = Array.isArray(level.lastOpenedWithVersion) ? level.lastOpenedWithVersion.slice(0, 3).join('.') : '—';

console.log('');
console.log('  Мир из архива');
console.log(`    файл           ${source}`);
console.log(`    название       ${levelName}`);
console.log(`    сохранён в     Minecraft ${version}`);
console.log(`    режим          ${GAME_TYPE[level.GameType] ?? level.GameType ?? '—'}`);
console.log(`    генератор      ${GENERATOR[level.Generator] ?? level.Generator ?? '—'}`);
console.log(`    читы           ${level.commandsEnabled ? 'включены' : 'выключены'}`);
console.log(`    файлов         ${entries.filter((e) => !e.name.endsWith('/')).length}`);
console.log('');
console.log('  Куда');
console.log(`    ${target}`);
console.log('');

const warnings = [];
if (envLevelName && envLevelName !== levelName) {
    warnings.push(
        `LEVEL_NAME в .env равен «${envLevelName}», а мир ставится как «${levelName}».\n` +
            `      После установки поменяйте LEVEL_NAME на «${levelName}», иначе сервер создаст пустой мир.`,
    );
}
if (level.Generator === 2) {
    warnings.push('Генератор мира — плоский: за границами карты будет бесконечная равнина, а не обычный рельеф.');
}
if (existsSync(target)) {
    warnings.push('Мир с таким именем уже есть. Он будет переименован в резервную копию, а не удалён.');
}
warnings.push(
    'Замена мира стирает весь прогресс движка: балансы, участки и чертежи хранятся\n' +
        '      в dynamic properties этого мира и в новый не переносятся.',
);

try {
    const running = execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', 'bds'], {
        stdio: ['ignore', 'pipe', 'ignore'],
    })
        .toString()
        .trim();
    if (running === 'true') {
        warnings.push('Контейнер bds сейчас запущен. Остановите его: docker compose down — иначе база мира повредится.');
    }
} catch {
    // Docker недоступен или контейнера нет — проверка необязательная.
}

console.log('  Учтите');
for (const warning of warnings) console.log(`    • ${warning}`);
console.log('');

if (!confirmed) {
    console.log('  Ничего не изменено. Чтобы выполнить, добавьте --yes');
    console.log('');
    process.exit(0);
}

// --------------------------------------------------------------------- запись

// Пути проверяем ДО первой записи: иначе архив с выходом за каталог успел бы
// переименовать существующий мир и оборваться, оставив сервер без мира.
let planned;
try {
    planned = planExtraction(entries, prefix, target);
} catch (error) {
    console.error(`  Архив отклонён: ${error.message}`);
    process.exit(1);
}

mkdirSync(worldsDir, { recursive: true });

if (existsSync(target)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backup = `${target}.backup-${stamp}`;
    renameSync(target, backup);
    console.log(`  Прежний мир сохранён: ${backup}`);
}

const written = writeExtraction(archive, planned);

console.log(`  Установлено файлов: ${written}`);
console.log('');
console.log('  Дальше');
if (envLevelName !== levelName) console.log(`    1. В .env укажите LEVEL_NAME=${levelName}`);
console.log('    2. npm run pack:activate   — включить behavior pack в новом мире');
console.log('    3. docker compose up -d    — поднять сервер');
console.log('');
