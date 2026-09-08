import { EntityComponentTypes, ItemLockMode, ItemStack, type Container, type Player } from '@minecraft/server';

/**
 * Служебные предметы движка (коммуникатор, чертёж) опознаются по специальной
 * скрытой строке в lore (описании).
 *
 * Dynamic properties не поддерживаются для стакуемых предметов (minecraft:clock,
 * minecraft:paper). Название подделывается наковальней, но lore выживание
 * изменить не может, поэтому защита надёжна.
 */

export interface MarkedItemSpec {
    /** Ключ метки, например `mc:device`. */
    readonly key: string;
    readonly itemType: string;
    readonly itemName: string;
    readonly lore: readonly string[];
    /** Запретить выбрасывать и убирать в сундуки. */
    readonly lockInInventory: boolean;
}

/** Невидимый префикс для скрытия технических данных в lore. */
const LORE_MARKER = '§r§0§r§0§r';

export function isMarked(item: ItemStack | undefined, key: string): boolean {
    if (!item) return false;
    const lore = item.getLore();
    return lore.some((line) => line === `${LORE_MARKER}${key}`);
}

export function createMarked(spec: MarkedItemSpec): ItemStack {
    const item = new ItemStack(spec.itemType, 1);
    item.nameTag = spec.itemName;
    item.setLore([...spec.lore, `${LORE_MARKER}${spec.key}`]);
    // Служебный предмет незачем терять при смерти.
    item.keepOnDeath = true;
    if (spec.lockInInventory) item.lockMode = ItemLockMode.inventory;
    return item;
}

export function inventoryOf(player: Player): Container | undefined {
    return player.getComponent(EntityComponentTypes.Inventory)?.container;
}

export function findMarked(container: Container, key: string): ItemStack | undefined {
    for (let slot = 0; slot < container.size; slot++) {
        const item = container.getItem(slot);
        if (isMarked(item, key)) return item;
    }
    return undefined;
}

export function hasMarked(container: Container, key: string): boolean {
    return findMarked(container, key) !== undefined;
}

/** Предмет в выбранном слоте — им игрок «держит» инструмент в руке. */
export function heldItem(player: Player): ItemStack | undefined {
    try {
        return inventoryOf(player)?.getItem(player.selectedSlotIndex);
    } catch {
        return undefined;
    }
}

/**
 * Выдаёт предмет, если его ещё нет.
 * `false` — инвентарь недоступен или полностью занят.
 */
export function ensureMarked(player: Player, spec: MarkedItemSpec): boolean {
    const container = inventoryOf(player);
    if (!container) return false;
    if (hasMarked(container, spec.key)) return true;
    if (container.emptySlotsCount === 0) return false;
    const leftover = container.addItem(createMarked(spec));
    if (leftover) {
        player.sendMessage(`§c[DEBUG] addItem failed! Leftover item amount: ${leftover.amount}`);
        return false;
    }
    return true;
}
