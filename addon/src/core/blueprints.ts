import { world } from '@minecraft/server';
import { clear, readString, write } from './storage.js';

/**
 * Реестр типовых зданий.
 *
 * Чертёж — это ссылка на структуру Minecraft плюс цена. Сама геометрия живёт в
 * структуре мира (`structureManager`), а здесь хранится только карточка:
 * имя, идентификатор структуры, габарит и цена. Габарит дублируется, чтобы
 * рисовать голограмму, не загружая структуру.
 */

export interface Blueprint {
    /** Слаг: используется в ключах и командах. */
    readonly id: string;
    readonly name: string;
    /** Идентификатор структуры для `structureManager`. */
    readonly structureId: string;
    readonly sizeX: number;
    readonly sizeY: number;
    readonly sizeZ: number;
    readonly price: number;
}

const KEY_PREFIX = 'mc:bp.';

/**
 * Разделитель полей — Unit Separator (U+001F). В названии здания, которое
 * вводит игрок, его быть не может, в отличие от запятой или вертикальной черты.
 */
const SEPARATOR = String.fromCharCode(31);

/** Имя -> слаг: только строчные буквы, цифры и подчёркивание. */
export function slugify(name: string): string {
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9а-я]+/gi, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 24);
    return slug === '' ? 'blueprint' : slug;
}

/** Идентификатор структуры мира для чертежа. */
export function structureIdFor(id: string): string {
    return `mc:bp_${id}`;
}

function serialize(blueprint: Blueprint): string {
    return [
        blueprint.name,
        blueprint.structureId,
        blueprint.sizeX,
        blueprint.sizeY,
        blueprint.sizeZ,
        blueprint.price,
    ].join(SEPARATOR);
}

function deserialize(id: string, raw: string): Blueprint | undefined {
    const parts = raw.split(SEPARATOR);
    if (parts.length !== 6) return undefined;

    const sizeX = Number(parts[2]);
    const sizeY = Number(parts[3]);
    const sizeZ = Number(parts[4]);
    const price = Number(parts[5]);
    if (![sizeX, sizeY, sizeZ, price].every(Number.isFinite)) return undefined;

    return {
        id,
        name: parts[0] ?? id,
        structureId: parts[1] ?? structureIdFor(id),
        sizeX,
        sizeY,
        sizeZ,
        price,
    };
}

export function getBlueprint(id: string): Blueprint | undefined {
    const raw = readString(world, `${KEY_PREFIX}${id}`, '');
    return raw === '' ? undefined : deserialize(id, raw);
}

export function saveBlueprint(blueprint: Blueprint): boolean {
    return write(world, `${KEY_PREFIX}${blueprint.id}`, serialize(blueprint));
}

export function deleteBlueprint(id: string): void {
    clear(world, `${KEY_PREFIX}${id}`);
}

/** Все чертежи. Обходит свойства мира — вызывать по запросу, не в тике. */
export function listBlueprints(): Blueprint[] {
    let ids: string[];
    try {
        ids = world.getDynamicPropertyIds();
    } catch {
        return [];
    }

    const result: Blueprint[] = [];
    for (const key of ids) {
        if (!key.startsWith(KEY_PREFIX)) continue;
        const blueprint = getBlueprint(key.slice(KEY_PREFIX.length));
        if (blueprint) result.push(blueprint);
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
}
