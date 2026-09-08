import { EntityComponentTypes, ItemLockMode, ItemStack, type Container, type Player } from '@minecraft/server';

/**
 * Служебные предметы движка (коммуникатор, чертёж) опознаются по dynamic
 * property на самом ItemStack.
 *
 * Название и тип подделываются наковальней, а свойство предмета — нет: копия,
 * переименованная вручную, метки не получит и работать не будет.
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

export function isMarked(item: ItemStack | undefined, key: string): boolean {
    if (!item) return false;
    try {
        return item.getDynamicProperty(key) === true;
    } catch {
        return false;
    }
}

export function createMarked(spec: MarkedItemSpec): ItemStack {
    const item = new ItemStack(spec.itemType, 1);
    item.nameTag = spec.itemName;
    item.setLore([...spec.lore]);
    item.setDynamicProperty(spec.key, true);
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
    container.addItem(createMarked(spec));
    return true;
}
