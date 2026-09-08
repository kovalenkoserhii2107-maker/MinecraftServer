import { StructureSaveMode, world, type Player, type Vector3 } from '@minecraft/server';
import type { BlueprintsConfig } from '../config.js';
import {
    deleteBlueprint,
    getBlueprint,
    saveBlueprint,
    slugify,
    structureIdFor,
    type Blueprint,
} from './blueprints.js';
import { canAfford, chargeFrom, formatMoney } from './economy.js';
import { chunkAt, getOwner } from './plots.js';
import { readString, readVector, write } from './storage.js';

/**
 * Операции строительства: геометрия габарита, проверка участка, снятие и
 * установка структур.
 *
 * Логика вынесена из механики, чтобы её мог вызывать интерфейс: иначе UI и
 * механика импортировали бы друг друга.
 */

export const KEY_SELECTED = 'mc:bp_selected';
export const KEY_CORNER_A = 'mc:bp_corner_a';
export const KEY_CORNER_B = 'mc:bp_corner_b';

export interface BoundingBox {
    readonly min: Vector3;
    readonly max: Vector3;
}

/** Габарит постройки от точки установки: структура растёт вверх и на +X/+Z. */
export function boxAt(origin: Vector3, blueprint: Blueprint): BoundingBox {
    return {
        min: origin,
        max: {
            x: origin.x + blueprint.sizeX - 1,
            y: origin.y + blueprint.sizeY - 1,
            z: origin.z + blueprint.sizeZ - 1,
        },
    };
}

/** Куда встанет постройка: блок, примыкающий к грани, по которой пришёлся луч. */
export function targetOrigin(player: Player, distance: number): Vector3 | undefined {
    const hit = player.getBlockFromViewDirection({ maxDistance: distance });
    if (!hit) return undefined;

    const block = hit.block;
    switch (hit.face) {
        case 'Up':
            return { x: block.x, y: block.y + 1, z: block.z };
        case 'Down':
            return { x: block.x, y: block.y - 1, z: block.z };
        case 'North':
            return { x: block.x, y: block.y, z: block.z - 1 };
        case 'South':
            return { x: block.x, y: block.y, z: block.z + 1 };
        case 'West':
            return { x: block.x - 1, y: block.y, z: block.z };
        case 'East':
            return { x: block.x + 1, y: block.y, z: block.z };
        default:
            return { x: block.x, y: block.y + 1, z: block.z };
    }
}

/**
 * Точки рёбер габаритного контейнера.
 *
 * Рисуем только 12 рёбер и прореживаем шаг под лимит частиц: голограмма
 * обновляется несколько раз в секунду и не должна утяжелять тик.
 */
export function boxOutline(box: BoundingBox, maxPoints: number): Vector3[] {
    const { min, max } = box;
    const edgeLength = (max.x - min.x + (max.y - min.y) + (max.z - min.z)) * 4 + 12;
    const step = Math.max(1, Math.ceil(edgeLength / Math.max(1, maxPoints)));

    const points: Vector3[] = [];
    const push = (x: number, y: number, z: number) => points.push({ x: x + 0.5, y: y + 0.5, z: z + 0.5 });

    for (const y of [min.y, max.y]) {
        for (let x = min.x; x <= max.x; x += step) {
            push(x, y, min.z);
            push(x, y, max.z);
        }
        for (let z = min.z; z <= max.z; z += step) {
            push(min.x, y, z);
            push(max.x, y, z);
        }
    }
    for (let y = min.y; y <= max.y; y += step) {
        push(min.x, y, min.z);
        push(max.x, y, min.z);
        push(min.x, y, max.z);
        push(max.x, y, max.z);
    }
    return points;
}

export interface PlotCheck {
    readonly allowed: boolean;
    readonly reason?: string;
}

/** Помещается ли габарит в собственный участок игрока — включая крайние чанки. */
export function checkPlot(player: Player, box: BoundingBox, config: BlueprintsConfig): PlotCheck {
    const dimensionId = player.dimension.id;
    const from = chunkAt(dimensionId, box.min.x, box.min.z);
    const to = chunkAt(dimensionId, box.max.x, box.max.z);

    for (let cx = from.cx; cx <= to.cx; cx++) {
        for (let cz = from.cz; cz <= to.cz; cz++) {
            const owner = getOwner({ dimensionId, cx, cz });
            if (owner && owner.id !== player.id) {
                return { allowed: false, reason: `Габарит задевает участок игрока ${owner.name}.` };
            }
            if (!owner && config.requireOwnPlot) {
                return { allowed: false, reason: 'Габарит выходит за пределы вашего участка.' };
            }
        }
    }
    return { allowed: true };
}

export function selectedBlueprint(player: Player): Blueprint | undefined {
    const id = readString(player, KEY_SELECTED, '');
    return id === '' ? undefined : getBlueprint(id);
}

export function selectBlueprint(player: Player, blueprint: Blueprint): void {
    write(player, KEY_SELECTED, blueprint.id);
}

export function corners(player: Player): { a?: Vector3; b?: Vector3 } {
    return { a: readVector(player, KEY_CORNER_A), b: readVector(player, KEY_CORNER_B) };
}

export function markCorner(player: Player, origin: Vector3): 'A' | 'B' {
    const { a } = corners(player);
    if (!a) {
        write(player, KEY_CORNER_A, origin);
        return 'A';
    }
    write(player, KEY_CORNER_B, origin);
    return 'B';
}

/** Сбрасывает разметку, чтобы следующее сохранение начиналось с чистого листа. */
export function clearCorners(player: Player): void {
    write(player, KEY_CORNER_A, undefined);
    write(player, KEY_CORNER_B, undefined);
}

export interface BuildingResult {
    readonly ok: boolean;
    readonly message: string;
}

/** Снимает структуру между отмеченными углами и регистрирует чертёж. */
export function saveFromSelection(
    player: Player,
    name: string,
    price: number,
    config: BlueprintsConfig,
): BuildingResult {
    const trimmed = name.trim();
    if (trimmed === '') return { ok: false, message: 'Укажите название постройки.' };
    if (!Number.isFinite(price) || price < 0) return { ok: false, message: 'Стоимость должна быть числом от нуля.' };

    const { a, b } = corners(player);
    if (!a || !b) {
        return { ok: false, message: 'Сначала отметьте два угла: присядьте и используйте чертёж по двум блокам.' };
    }

    const min = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) };
    const max = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) };
    const size = { x: max.x - min.x + 1, y: max.y - min.y + 1, z: max.z - min.z + 1 };

    if (size.x > config.maxSize || size.y > config.maxSize || size.z > config.maxSize) {
        return { ok: false, message: `Сторона области не должна превышать ${config.maxSize} блоков.` };
    }

    const id = slugify(trimmed);
    if (getBlueprint(id)) return { ok: false, message: `Чертёж «${trimmed}» уже существует.` };

    const structureId = structureIdFor(id);
    try {
        world.structureManager.createFromWorld(structureId, player.dimension, min, max, {
            saveMode: StructureSaveMode.World,
            includeEntities: false,
        });
    } catch {
        return { ok: false, message: 'Не удалось снять структуру — подробности в логе сервера.' };
    }

    const blueprint: Blueprint = {
        id,
        name: trimmed,
        structureId,
        sizeX: size.x,
        sizeY: size.y,
        sizeZ: size.z,
        price: Math.floor(price),
    };
    if (!saveBlueprint(blueprint)) {
        world.structureManager.delete(structureId);
        return { ok: false, message: 'Хранилище мира отказало в записи чертежа.' };
    }

    clearCorners(player);
    return {
        ok: true,
        message: `Чертёж «${trimmed}» сохранён: ${size.x}×${size.y}×${size.z}, цена ${blueprint.price}.`,
    };
}

export function removeBlueprint(blueprint: Blueprint): void {
    try {
        world.structureManager.delete(blueprint.structureId);
    } catch {
        // Структуры могло уже не быть — карточку всё равно убираем.
    }
    deleteBlueprint(blueprint.id);
}

/**
 * Ставит здание и списывает цену.
 *
 * Проверки повторяются здесь, а не только в интерфейсе: между открытием формы
 * и подтверждением мир мог измениться. Деньги берутся после успешной установки.
 */
export function placeBlueprint(
    player: Player,
    blueprint: Blueprint,
    origin: Vector3,
    config: BlueprintsConfig,
    symbol: string,
): BuildingResult {
    const plot = checkPlot(player, boxAt(origin, blueprint), config);
    if (!plot.allowed) return { ok: false, message: plot.reason ?? 'Место не подходит.' };
    if (!canAfford(player, blueprint.price)) return { ok: false, message: 'Не хватает средств.' };

    try {
        world.structureManager.place(blueprint.structureId, player.dimension, origin);
    } catch {
        return { ok: false, message: 'Постройка не удалась — подробности в логе сервера.' };
    }

    chargeFrom(player, blueprint.price);
    return {
        ok: true,
        message: `«${blueprint.name}» построено за ${formatMoney(blueprint.price, symbol)}.`,
    };
}
