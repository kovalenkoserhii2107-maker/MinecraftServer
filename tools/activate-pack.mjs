#!/usr/bin/env node
/**
 * Активирует behavior pack в мире сервера.
 *
 * BDS находит паки в `development_behavior_packs`, но НЕ включает их сам:
 * список активных паков мира хранится в
 * `worlds/<LEVEL_NAME>/world_behavior_packs.json`. Скрипт добавляет туда
 * запись с UUID и версией из addon/manifest.json, не трогая остальные паки.
 *
 * Запуск: npm run pack:activate       (мир из .env, по умолчанию Bedrock level)
 *         LEVEL_NAME=my_world npm run pack:activate
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PROJECT_ROOT, readEnv } from './env.mjs';

const projectRoot = PROJECT_ROOT;

const levelName = await readEnv('LEVEL_NAME', 'Bedrock level');
const dataDir = await readEnv('SERVER_DATA_DIR', join(projectRoot, 'server-data'));
const worldDir = resolve(dataDir, 'worlds', levelName);
const packsFile = join(worldDir, 'world_behavior_packs.json');

const manifest = JSON.parse(await readFile(join(projectRoot, 'addon', 'manifest.json'), 'utf8'));
const packId = manifest.header?.uuid;
const version = manifest.header?.version;

if (typeof packId !== 'string' || !Array.isArray(version)) {
    console.error('activate-pack: в addon/manifest.json нет header.uuid или header.version.');
    process.exit(1);
}

await mkdir(worldDir, { recursive: true });

let packs = [];
if (existsSync(packsFile)) {
    try {
        const parsed = JSON.parse(await readFile(packsFile, 'utf8'));
        if (Array.isArray(parsed)) packs = parsed;
    } catch {
        console.warn(`activate-pack: ${packsFile} повреждён — файл будет перезаписан.`);
    }
}

const existing = packs.find((pack) => pack.pack_id === packId);
if (existing) {
    existing.version = version;
    console.log(`activate-pack: версия пака обновлена до ${version.join('.')}.`);
} else {
    packs.push({ pack_id: packId, version });
    console.log(`activate-pack: пак ${packId} добавлен в мир «${levelName}».`);
}

await writeFile(packsFile, `${JSON.stringify(packs, null, 2)}\n`, 'utf8');
console.log(`activate-pack: записан ${packsFile}`);
console.log('activate-pack: перезапустите сервер — npm run server:restart');
