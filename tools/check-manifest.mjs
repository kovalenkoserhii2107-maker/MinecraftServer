#!/usr/bin/env node
/**
 * Проверяет, что версии модулей в addon/manifest.json совпадают с версиями
 * пакетов, установленных в node_modules.
 *
 * Расхождение — самая частая причина «пак установлен, но скрипты не работают»:
 * код собран под один API, а сервер загружает другой. Ошибка компиляции здесь
 * дешевле, чем отладка молчащего сервера с консоли.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const manifest = JSON.parse(await readFile(join(projectRoot, 'addon', 'manifest.json'), 'utf8'));
const problems = [];

const entry = manifest.modules?.find((module) => module.type === 'script')?.entry;
if (entry !== 'scripts/index.js') {
    problems.push(`Точка входа script-модуля должна быть "scripts/index.js", найдено: "${entry}".`);
}

for (const dependency of manifest.dependencies ?? []) {
    const name = dependency.module_name;
    if (typeof name !== 'string' || !name.startsWith('@minecraft/')) continue;

    let installed;
    try {
        const pkg = JSON.parse(await readFile(join(projectRoot, 'node_modules', name, 'package.json'), 'utf8'));
        installed = pkg.version;
    } catch {
        problems.push(`Пакет ${name} не установлен. Выполните: npm install`);
        continue;
    }

    if (installed !== dependency.version) {
        problems.push(
            `${name}: манифест объявляет ${dependency.version}, установлено ${installed}. ` +
                `Приведите к одной версии addon/manifest.json и package.json.`,
        );
    }
}

if (problems.length > 0) {
    console.error('check-manifest: обнаружены расхождения:');
    for (const problem of problems) console.error(`  • ${problem}`);
    process.exit(1);
}

console.log('check-manifest: манифест согласован с установленными пакетами.');
