#!/usr/bin/env node
/**
 * Очищает каталог скомпилированных скриптов перед сборкой.
 *
 * Нужен потому, что `tsc` не удаляет файлы, оставшиеся от переименованных или
 * удалённых модулей: старый `.js` продолжил бы грузиться сервером.
 */
import { readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(projectRoot, 'addon', 'scripts');

if (!existsSync(outDir)) {
    console.log('clean: каталог addon/scripts отсутствует — нечего чистить.');
    process.exit(0);
}

const entries = await readdir(outDir);
let removed = 0;
for (const entry of entries) {
    if (entry === '.gitkeep') continue;
    await rm(join(outDir, entry), { recursive: true, force: true });
    removed += 1;
}
console.log(`clean: удалено записей в addon/scripts: ${removed}.`);
