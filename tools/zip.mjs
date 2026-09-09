/**
 * Чтение ZIP средствами Node (`zlib`), без внешнего `unzip`.
 *
 * Форматы Minecraft (`.mcworld`, `.mcaddon`, `.mcpack`) — обычные ZIP-архивы.
 * Своя реализация нужна, чтобы скрипты одинаково работали на macOS и на
 * Ubuntu-дроплете и не зависели от того, установлен ли там `unzip`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/** Записи архива из центрального каталога. */
export function readZipEntries(buf) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0xffff; i--) {
        if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
            eocd = i;
            break;
        }
    }
    if (eocd === -1) throw new Error('это не ZIP-архив: не найден конец центрального каталога');

    const count = buf.readUInt16LE(eocd + 10);
    let offset = buf.readUInt32LE(eocd + 16);

    const entries = [];
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
            throw new Error('повреждён центральный каталог архива');
        }
        const method = buf.readUInt16LE(offset + 10);
        const compressedSize = buf.readUInt32LE(offset + 20);
        const size = buf.readUInt32LE(offset + 24);
        const nameLength = buf.readUInt16LE(offset + 28);
        const extraLength = buf.readUInt16LE(offset + 30);
        const commentLength = buf.readUInt16LE(offset + 32);
        const localOffset = buf.readUInt32LE(offset + 42);
        const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);

        entries.push({ name, method, compressedSize, size, localOffset });
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

export function readEntryData(buf, entry) {
    // Длины полей в локальном заголовке могут отличаться от центрального.
    const nameLength = buf.readUInt16LE(entry.localOffset + 26);
    const extraLength = buf.readUInt16LE(entry.localOffset + 28);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    const raw = buf.subarray(start, start + entry.compressedSize);

    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflateRawSync(raw);
    throw new Error(`неизвестный метод сжатия ${entry.method} для ${entry.name}`);
}

/**
 * Планирует распаковку: считает пути назначения и проверяет, что ни один не
 * выходит за целевой каталог.
 *
 * Проверка отделена от записи намеренно. Если проверять внутри цикла записи,
 * вредоносный архив успеет создать часть файлов (или переименовать соседний
 * каталог в резервную копию) и только потом оборвётся.
 */
export function planExtraction(entries, prefix, target) {
    const planned = [];
    for (const entry of entries) {
        if (!entry.name.startsWith(prefix)) continue;
        const relative = entry.name.slice(prefix.length);
        if (relative === '') continue;

        const destination = join(target, relative);
        if (destination !== target && !destination.startsWith(target + sep)) {
            throw new Error(`архив содержит путь за пределами каталога: ${entry.name}`);
        }
        planned.push({ entry, destination, isDirectory: relative.endsWith('/') });
    }
    return planned;
}

/** Записывает подготовленный план на диск. Возвращает число файлов. */
export function writeExtraction(buf, planned) {
    let written = 0;
    for (const { entry, destination, isDirectory } of planned) {
        if (isDirectory) {
            mkdirSync(destination, { recursive: true });
            continue;
        }
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, readEntryData(buf, entry));
        written += 1;
    }
    return written;
}

/**
 * Манифесты Minecraft начинаются с комментария о лицензии, а JSON комментариев
 * не допускает. Срезаем их перед разбором.
 */
export function parseManifest(text) {
    const cleaned = text.replace(/^﻿/, '').replace(/\/\*[\s\S]*?\*\//g, '');
    return JSON.parse(cleaned);
}
