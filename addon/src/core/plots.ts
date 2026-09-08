import { world } from '@minecraft/server';
import { clear, readString, write } from './storage.js';

/**
 * Частная собственность на участки.
 *
 * Участок привязан к сетке чанков Minecraft: 16×16 блоков — ровно один чанк,
 * 32×32 — квадрат 2×2 чанка, выровненный по чётным координатам. Благодаря
 * этому границы никогда не пересекаются и не требуют хранения прямоугольников.
 *
 * Хранилище — dynamic properties мира, по одному свойству на чанк. Единый JSON
 * был бы компактнее, но при повреждении терялись бы все участки сразу, а тут
 * запись независима и читается одним обращением.
 */

export interface PlotOwner {
    readonly id: string;
    readonly name: string;
}

export interface ChunkRef {
    readonly dimensionId: string;
    readonly cx: number;
    readonly cz: number;
}

const KEY_PREFIX = 'mc:plot.';

/** Короткий код измерения — ключи не должны разрастаться. */
function dimensionCode(dimensionId: string): string {
    switch (dimensionId) {
        case 'minecraft:overworld':
            return 'o';
        case 'minecraft:nether':
            return 'n';
        case 'minecraft:the_end':
            return 'e';
        default:
            return dimensionId.replace('minecraft:', '');
    }
}

function keyOf(ref: ChunkRef): string {
    return `${KEY_PREFIX}${dimensionCode(ref.dimensionId)}.${ref.cx}.${ref.cz}`;
}

/** Координата блока -> координата чанка. Работает и для отрицательных. */
export function toChunk(coordinate: number): number {
    return Math.floor(coordinate / 16);
}

export function chunkAt(dimensionId: string, x: number, z: number): ChunkRef {
    return { dimensionId, cx: toChunk(x), cz: toChunk(z) };
}

/**
 * Чанки, которые займёт участок заданного размера.
 *
 * Для 32×32 квадрат выравнивается по чётной сетке чанков, иначе два игрока
 * рядом получили бы пересекающиеся владения.
 */
export function chunksForSize(ref: ChunkRef, size: 16 | 32): ChunkRef[] {
    if (size === 16) return [ref];
    const baseX = Math.floor(ref.cx / 2) * 2;
    const baseZ = Math.floor(ref.cz / 2) * 2;
    const result: ChunkRef[] = [];
    for (let dx = 0; dx < 2; dx++) {
        for (let dz = 0; dz < 2; dz++) {
            result.push({ dimensionId: ref.dimensionId, cx: baseX + dx, cz: baseZ + dz });
        }
    }
    return result;
}

/**
 * Кэш владельцев: обращение к dynamic properties идёт на каждый сломанный и
 * поставленный блок, а это горячий путь тика. `null` — «точно ничей».
 */
const cache = new Map<string, PlotOwner | null>();

export function invalidateCache(): void {
    cache.clear();
}

export function getOwner(ref: ChunkRef): PlotOwner | undefined {
    const key = keyOf(ref);
    const cached = cache.get(key);
    if (cached !== undefined) return cached ?? undefined;

    const raw = readString(world, key, '');
    if (raw === '') {
        cache.set(key, null);
        return undefined;
    }
    const separator = raw.indexOf('|');
    const owner: PlotOwner =
        separator === -1
            ? { id: raw, name: raw }
            : { id: raw.slice(0, separator), name: raw.slice(separator + 1) };
    cache.set(key, owner);
    return owner;
}

export function setOwner(ref: ChunkRef, owner: PlotOwner): boolean {
    const key = keyOf(ref);
    if (!write(world, key, `${owner.id}|${owner.name}`)) return false;
    cache.set(key, owner);
    return true;
}

export function clearOwner(ref: ChunkRef): void {
    const key = keyOf(ref);
    clear(world, key);
    cache.set(key, null);
}

/** Свободны ли все чанки будущего участка. Возвращает первый занятый. */
export function firstTakenChunk(chunks: readonly ChunkRef[]): ChunkRef | undefined {
    return chunks.find((chunk) => getOwner(chunk) !== undefined);
}

/**
 * Все участки игрока. Обходит идентификаторы свойств мира, поэтому вызывать
 * только по запросу (панель, карта, налоги), а не в обработчиках блоков.
 */
export function listOwnedChunks(ownerId: string): ChunkRef[] {
    const result: ChunkRef[] = [];
    let ids: string[];
    try {
        ids = world.getDynamicPropertyIds();
    } catch {
        return result;
    }

    for (const id of ids) {
        if (!id.startsWith(KEY_PREFIX)) continue;
        const parts = id.slice(KEY_PREFIX.length).split('.');
        if (parts.length !== 3) continue;

        const [code, cxRaw, czRaw] = parts;
        const cx = Number(cxRaw);
        const cz = Number(czRaw);
        if (!Number.isInteger(cx) || !Number.isInteger(cz)) continue;

        const dimensionId =
            code === 'o'
                ? 'minecraft:overworld'
                : code === 'n'
                  ? 'minecraft:nether'
                  : code === 'e'
                    ? 'minecraft:the_end'
                    : `minecraft:${code}`;

        const ref: ChunkRef = { dimensionId, cx, cz };
        if (getOwner(ref)?.id === ownerId) result.push(ref);
    }
    return result;
}

/** Границы чанка в блоках — для сообщений и карты. */
export function chunkBounds(ref: ChunkRef): { minX: number; minZ: number; maxX: number; maxZ: number } {
    return {
        minX: ref.cx * 16,
        minZ: ref.cz * 16,
        maxX: ref.cx * 16 + 15,
        maxZ: ref.cz * 16 + 15,
    };
}
