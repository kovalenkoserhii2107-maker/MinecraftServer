#!/usr/bin/env node
/**
 * Установка стороннего аддона (`.mcaddon` / `.mcpack`) на сервер.
 *
 *   node tools/install-addon.mjs <файл>          # разбор и предупреждения
 *   node tools/install-addon.mjs <файл> --yes    # установить и включить в мире
 *
 * Перед установкой печатает то, что нельзя увидеть, не вскрыв архив: версии
 * объявленных модулей Script API, capabilities, зависимости и совпадения UUID
 * с нашим паком. Именно эти поля решают, заработает ли аддон рядом с движком.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadEnv, PROJECT_ROOT } from './env.mjs';
import { parseManifest, planExtraction, readEntryData, readZipEntries, writeExtraction } from './zip.mjs';

const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith('--'));
const confirmed = args.includes('--yes');

if (!source) {
    console.error('Использование: node tools/install-addon.mjs <файл.mcaddon|.mcpack> [--yes]');
    process.exit(1);
}
if (!existsSync(source)) {
    console.error(`Файл не найден: ${source}`);
    process.exit(1);
}

const archive = readFileSync(source);
const entries = readZipEntries(archive);

// В .mcaddon паков может быть несколько, каждый — со своим manifest.json.
const manifests = entries.filter((e) => e.name.endsWith('manifest.json'));
if (manifests.length === 0) {
    console.error('В архиве нет manifest.json — это не аддон Minecraft Bedrock.');
    process.exit(1);
}

const ourManifest = parseManifest(readFileSync(join(PROJECT_ROOT, 'addon', 'manifest.json'), 'utf8'));
const ourUuids = new Set([ourManifest.header.uuid, ...ourManifest.modules.map((m) => m.uuid)]);
const ourServerVersion = (ourManifest.dependencies ?? []).find((d) => d.module_name === '@minecraft/server')?.version;

const packs = [];
for (const entry of manifests) {
    const prefix = entry.name.slice(0, entry.name.length - 'manifest.json'.length);
    let manifest;
    try {
        manifest = parseManifest(readEntryData(archive, entry).toString('utf8'));
    } catch (error) {
        console.error(`Не удалось разобрать ${entry.name}: ${error.message}`);
        process.exit(1);
    }

    const types = (manifest.modules ?? []).map((m) => m.type);
    const kind = types.includes('resources') ? 'resources' : 'behavior';
    const files = entries.filter((e) => e.name.startsWith(prefix) && !e.name.endsWith('/'));
    const bytes = files.reduce((sum, e) => sum + e.size, 0);

    packs.push({ prefix, manifest, kind, types, files, bytes });
}

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} МБ`;

console.log('');
console.log(`  Аддон: ${source}`);
console.log('');

const warnings = [];

for (const pack of packs) {
    const h = pack.manifest.header;
    const label = pack.kind === 'resources' ? 'ресурс-пак' : 'behavior-пак';
    console.log(`  ${label}  ${h.name}`);
    console.log(`    uuid           ${h.uuid}`);
    console.log(`    версия         ${(h.version ?? []).join('.')}`);
    console.log(`    min_engine     ${(h.min_engine_version ?? []).join('.') || '—'}`);
    console.log(`    модули         ${pack.types.join(', ') || '—'}`);
    console.log(`    файлов         ${pack.files.length}, ${megabytes(pack.bytes)}`);

    const modules = (pack.manifest.dependencies ?? []).filter((d) => d.module_name);
    if (modules.length > 0) {
        console.log(`    Script API     ${modules.map((d) => `${d.module_name} ${d.version}`).join(', ')}`);
    }
    if (pack.manifest.capabilities?.length) {
        console.log(`    capabilities   ${pack.manifest.capabilities.join(', ')}`);
    }
    if (pack.manifest.subpacks?.length) {
        console.log(`    subpacks       ${pack.manifest.subpacks.map((s) => s.folder_name).join(', ')}`);
    }
    console.log('');

    // --- проверки совместимости ---

    for (const uuid of [h.uuid, ...(pack.manifest.modules ?? []).map((m) => m.uuid)]) {
        if (ourUuids.has(uuid)) warnings.push(`UUID ${uuid} совпадает с нашим паком — Minecraft загрузит только один.`);
    }

    const server = modules.find((d) => d.module_name === '@minecraft/server');
    if (server && ourServerVersion) {
        const theirMajor = String(server.version).split('.')[0];
        const ourMajor = String(ourServerVersion).split('.')[0];
        if (theirMajor !== ourMajor) {
            warnings.push(
                `Аддон объявляет @minecraft/server ${server.version}, наш движок — ${ourServerVersion}.\n` +
                    `      Разные основные версии сосуществуют, только пока сервер отдаёт обе.\n` +
                    `      Ветку 1.x постепенно убирают, поэтому это первое, что стоит проверить в логе.`,
            );
        }
    }

    if (pack.manifest.capabilities?.includes('script_eval')) {
        warnings.push(
            'Пак запрашивает capability script_eval — исполнение динамически собранного кода.\n' +
                '      Проверить статически, что он делает, нельзя.',
        );
    }

    if (pack.files.some((e) => /entities\/player(\/|\.json)/.test(e.name))) {
        warnings.push(
            'Пак заменяет player.json. С нашим движком это не конфликтует (мы его не трогаем),\n' +
                '      но любой другой аддон, меняющий игрока (анимации, скины), поставить уже не выйдет.',
        );
    }

    // Обфускация: строки из тысяч символов — статический разбор невозможен.
    const scripts = pack.files.filter((e) => e.name.endsWith('.js'));
    const obfuscated = scripts.some((e) => {
        const text = readEntryData(archive, e).toString('utf8');
        return text.length > 2000 && !text.slice(0, 4000).includes('\n');
    });
    if (obfuscated) {
        warnings.push('Скрипты аддона обфусцированы: что именно они делают, проверить заранее нельзя.');
    }

    if (pack.kind === 'resources' && pack.bytes > 8 * 1024 * 1024) {
        warnings.push(
            `Ресурс-пак весит ${megabytes(pack.bytes)} — его скачивает каждый клиент при входе.\n` +
                '      На консолях первый вход после установки будет заметно дольше.',
        );
    }
}

if (warnings.length > 0) {
    console.log('  Учтите');
    for (const warning of [...new Set(warnings)]) console.log(`    • ${warning}`);
    console.log('');
}

const env = await loadEnv();
const dataDir = resolve(PROJECT_ROOT, env.SERVER_DATA_DIR ?? './server-data');
const levelName = env.LEVEL_NAME ?? 'Bedrock level';
const worldDir = join(dataDir, 'worlds', levelName);

console.log('  Куда');
for (const pack of packs) {
    const dir = pack.kind === 'resources' ? 'resource_packs' : 'behavior_packs';
    console.log(`    ${join(dataDir, dir, pack.manifest.header.name)}`);
}
console.log(`    и включение в мире «${levelName}»`);
console.log('');

if (!confirmed) {
    console.log('  Ничего не изменено. Чтобы выполнить, добавьте --yes');
    console.log('');
    process.exit(0);
}

// --------------------------------------------------------------------- запись

// Пути проверяем до первой записи, иначе архив с выходом за каталог успел бы
// переименовать соседний пак в резервную копию и оборваться.
const plans = [];
for (const pack of packs) {
    const dir = pack.kind === 'resources' ? 'resource_packs' : 'behavior_packs';
    const target = join(dataDir, dir, pack.manifest.header.name);
    try {
        plans.push({ pack, target, planned: planExtraction(entries, pack.prefix, target) });
    } catch (error) {
        console.error(`  Архив отклонён: ${error.message}`);
        process.exit(1);
    }
}

for (const { pack, target, planned } of plans) {
    if (existsSync(target)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        renameSync(target, `${target}.backup-${stamp}`);
        console.log(`  Прежняя версия сохранена: ${target}.backup-${stamp}`);
    }
    mkdirSync(target, { recursive: true });
    const written = writeExtraction(archive, planned);
    console.log(`  ${pack.manifest.header.name}: файлов ${written}`);
}

/** Дописывает пак в список мира, не затирая уже включённые. */
function activate(file, header) {
    const path = join(worldDir, file);
    let list = [];
    if (existsSync(path)) {
        try {
            const parsed = JSON.parse(readFileSync(path, 'utf8'));
            if (Array.isArray(parsed)) list = parsed;
        } catch {
            console.warn(`  ${file} повреждён — файл будет перезаписан.`);
        }
    }
    const existing = list.find((p) => p.pack_id === header.uuid);
    if (existing) existing.version = header.version;
    else list.push({ pack_id: header.uuid, version: header.version });

    mkdirSync(worldDir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
}

if (!existsSync(worldDir)) {
    console.log('');
    console.log(`  Мир «${levelName}» ещё не создан — включить паки в нём пока не в чем.`);
    console.log('  Запустите сервер один раз, затем повторите установку.');
    process.exit(0);
}

for (const { pack } of plans) {
    activate(
        pack.kind === 'resources' ? 'world_resource_packs.json' : 'world_behavior_packs.json',
        pack.manifest.header,
    );
}

console.log('');
console.log(`  Паки включены в мире «${levelName}».`);
console.log('');
console.log('  Дальше');
console.log('    docker compose up -d');
console.log('    npm run server:logs   — убедиться, что оба пака загрузились без ошибок');
console.log('');

