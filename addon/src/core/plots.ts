import { world, type Player, type Vector3 } from '@minecraft/server';
import type { PlotsConfig } from '../config.js';
import { canAfford, chargeFrom, formatMoney, payTo } from './economy.js';
import { Color } from './format.js';
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

export interface EdgeFlags {
    north: boolean; // z = minZ
    south: boolean; // z = maxZ
    east: boolean;  // x = maxX
    west: boolean;  // x = minX
}

/** Возвращает точки по периметру чанка на заданной высоте (Y) с заданным шагом. */
export function chunkOutline(ref: ChunkRef, y: number, step: number = 2, edges: EdgeFlags = { north: true, south: true, east: true, west: true }): Vector3[] {
    const bounds = chunkBounds(ref);
    const points: Vector3[] = [];
    
    if (edges.north) {
        for (let x = bounds.minX; x <= bounds.maxX + 1; x += step) {
            points.push({ x, y, z: bounds.minZ });
        }
    }
    if (edges.south) {
        for (let x = bounds.minX; x <= bounds.maxX + 1; x += step) {
            points.push({ x, y, z: bounds.maxZ + 1 });
        }
    }
    if (edges.west) {
        for (let z = bounds.minZ; z <= bounds.maxZ + 1; z += step) {
            points.push({ x: bounds.minX, y, z });
        }
    }
    if (edges.east) {
        for (let z = bounds.minZ; z <= bounds.maxZ + 1; z += step) {
            points.push({ x: bounds.maxX + 1, y, z });
        }
    }
    return points;
}

export interface PlotActionResult {
    readonly ok: boolean;
    readonly message: string;
}

/**
 * Покупка участка под игроком.
 *
 * Деньги списываются до записи владельца, а при сорвавшейся записи возвращаются
 * целиком: половина участка бесполезна.
 */
export function claimPlot(
    player: Player,
    size: 16 | 32,
    config: PlotsConfig,
    symbol: string,
): PlotActionResult {
    const here = chunkAt(player.dimension.id, player.location.x, player.location.z);
    const chunks = chunksForSize(here, size);

    const taken = firstTakenChunk(chunks);
    if (taken) {
        const owner = getOwner(taken);
        return {
            ok: false,
            message:
                owner?.id === player.id
                    ? 'Этот участок уже ваш.'
                    : `Участок уже принадлежит игроку ${owner?.name ?? '—'}.`,
        };
    }

    if (config.maxChunksPerPlayer > 0) {
        const owned = listOwnedChunks(player.id).length;
        if (owned + chunks.length > config.maxChunksPerPlayer) {
            return { ok: false, message: `Превышен лимит: не больше ${config.maxChunksPerPlayer} чанков.` };
        }
    }

    const cost = size === 32 ? config.cost32 : config.cost16;
    if (!canAfford(player, cost)) {
        return { ok: false, message: `Не хватает средств: нужно ${formatMoney(cost, symbol)}.` };
    }
    if (!chargeFrom(player, cost)) {
        return { ok: false, message: 'Не удалось списать средства.' };
    }

    const claimed: ChunkRef[] = [];
    for (const chunk of chunks) {
        if (setOwner(chunk, { id: player.id, name: player.name })) {
            claimed.push(chunk);
        } else {
            for (const done of claimed) clearOwner(done);
            payTo(player, cost);
            return { ok: false, message: 'Хранилище мира отказало в записи, средства возвращены.' };
        }
    }

    const bounds = chunkBounds(chunks[0]!);
    const area = size === 32 ? '32×32' : '16×16';
    return {
        ok: true,
        message:
            `Участок ${area} куплен за ${formatMoney(cost, symbol)}. ` +
            `Границы: ${bounds.minX}..${bounds.maxX} X, ${bounds.minZ}..${bounds.maxZ} Z.`,
    };
}

/** Отказ от участка под игроком с частичным возвратом. */
export function unclaimPlot(player: Player, config: PlotsConfig, symbol: string): PlotActionResult {
    const here = chunkAt(player.dimension.id, player.location.x, player.location.z);
    const owner = getOwner(here);
    if (!owner) return { ok: false, message: 'Здесь нет участка.' };
    if (owner.id !== player.id) return { ok: false, message: `Участок принадлежит игроку ${owner.name}.` };

    const refund = Math.floor(config.cost16 * config.refundRatio);
    clearOwner(here);
    payTo(player, refund);
    return { ok: true, message: `Участок продан. Возвращено ${formatMoney(refund, symbol)}.` };
}

/**
 * Текстовая карта участков вокруг игрока.
 * Символы одинаковой ширины, иначе сетка «поплывёт» в шрифте Minecraft.
 */
export function renderPlotMap(player: Player, radius: number): string {
    const centerX = toChunk(player.location.x);
    const centerZ = toChunk(player.location.z);
    const dimensionId = player.dimension.id;
    const rows: string[] = [];

    for (let dz = -radius; dz <= radius; dz++) {
        let row = '';
        for (let dx = -radius; dx <= radius; dx++) {
            const owner = getOwner({ dimensionId, cx: centerX + dx, cz: centerZ + dz });
            if (dx === 0 && dz === 0) {
                row += owner?.id === player.id ? `${Color.green}▣` : owner ? `${Color.red}▣` : `${Color.yellow}▣`;
            } else if (!owner) {
                row += `${Color.darkGray}░`;
            } else if (owner.id === player.id) {
                row += `${Color.green}█`;
            } else {
                row += `${Color.red}█`;
            }
        }
        rows.push(row + Color.reset);
    }
    return rows.join('\n');
}
