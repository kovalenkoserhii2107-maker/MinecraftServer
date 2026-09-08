import { world, type Player } from '@minecraft/server';
import type { DeathBeaconConfig, WelcomeConfig } from '../config.js';
import { formatCoords, formatDimension } from './format.js';
import { inventoryOf } from './markedItem.js';
import { readNumber, readString, readVector, write } from './storage.js';
import { ItemStack } from '@minecraft/server';

/**
 * Действия игрока, которые вызываются из интерфейса.
 *
 * Логика живёт здесь, а не в механиках, чтобы панель могла её вызвать без
 * обратного импорта: механики зависят от UI, обратной зависимости быть не должно.
 */

const KEY_KIT_TAKEN = 'mc:starter_kit_taken';
const KEY_DEATH_POS = 'mc:death_pos';
const KEY_DEATH_DIM = 'mc:death_dim';
const KEY_RETURNS_LEFT = 'mc:death_returns_left';

export interface ActionResult {
    readonly ok: boolean;
    readonly message: string;
}

/** Выдаёт стартовый набор один раз на игрока. */
export function giveStarterKit(player: Player, config: WelcomeConfig): ActionResult {
    if (readNumber(player, KEY_KIT_TAKEN, 0) === 1 || hasTakenKit(player)) {
        return { ok: false, message: 'Стартовый набор уже был получен.' };
    }

    const container = inventoryOf(player);
    if (!container) return { ok: false, message: 'Инвентарь недоступен.' };
    if (container.emptySlotsCount === 0) {
        return { ok: false, message: 'Освободите место в инвентаре.' };
    }

    let given = false;
    for (const entry of config.starterKit) {
        if (container.emptySlotsCount === 0) break;
        try {
            container.addItem(new ItemStack(entry.item, entry.amount));
            given = true;
        } catch {
            // Неизвестный идентификатор предмета не должен ломать выдачу остального.
        }
    }
    if (!given) return { ok: false, message: 'Не удалось выдать набор.' };

    write(player, KEY_KIT_TAKEN, true);
    return { ok: true, message: 'Стартовый набор выдан.' };
}

function hasTakenKit(player: Player): boolean {
    try {
        return player.getDynamicProperty(KEY_KIT_TAKEN) === true;
    } catch {
        return false;
    }
}

/** Телепорт к месту последней смерти, если возвраты не исчерпаны. */
export function returnToDeath(player: Player, config: DeathBeaconConfig): ActionResult {
    const location = readVector(player, KEY_DEATH_POS);
    const dimensionId = readString(player, KEY_DEATH_DIM, '');
    if (!location || dimensionId === '') {
        return { ok: false, message: 'Точка смерти не найдена — вы ещё не погибали.' };
    }

    const returnsLeft = readNumber(player, KEY_RETURNS_LEFT, 0);
    if (returnsLeft <= 0) return { ok: false, message: 'Возвраты к этой точке исчерпаны.' };

    if (config.sameDimensionOnly && player.dimension.id !== dimensionId) {
        return { ok: false, message: `Точка смерти в другом измерении: ${formatDimension(dimensionId)}.` };
    }

    try {
        player.teleport(location, { dimension: world.getDimension(dimensionId) });
    } catch {
        return { ok: false, message: 'Не удалось телепортироваться — точка недоступна.' };
    }

    write(player, KEY_RETURNS_LEFT, returnsLeft - 1);
    return { ok: true, message: `Вы вернулись к точке смерти (${formatCoords(location)}).` };
}
