import {
    CommandPermissionLevel,
    EntityComponentTypes,
    ItemLockMode,
    ItemStack,
    Player,
    world,
    type Container,
} from '@minecraft/server';
import { failure, info, success } from '../core/format.js';
import { defer, fail, ok, playerFrom, type MechanicCommand } from '../core/commands.js';
import { defineMechanic, type MechanicContext } from '../core/mechanic.js';
import type { DeviceConfig } from '../config.js';
import { getRuntime } from '../core/runtime.js';
import { openPanel } from '../ui/panel.js';

/**
 * Маркер на предмете. Название и тип игрок может подделать (наковальня,
 * переименование), а dynamic property на ItemStack — нет, поэтому опознаём
 * коммуникатор именно по нему.
 */
const KEY_DEVICE = 'mc:device';

function isDevice(item: ItemStack | undefined): boolean {
    if (!item) return false;
    try {
        return item.getDynamicProperty(KEY_DEVICE) === true;
    } catch {
        return false;
    }
}

/** Собирает новый экземпляр коммуникатора по конфигурации. */
function createDevice(config: DeviceConfig): ItemStack {
    const item = new ItemStack(config.itemType, 1);
    item.nameTag = config.itemName;
    item.setLore([...config.lore]);
    item.setDynamicProperty(KEY_DEVICE, true);
    // Коммуникатор — служебный предмет: терять его при смерти незачем.
    item.keepOnDeath = true;
    if (config.lockInInventory) {
        // Нельзя выбросить или убрать в сундук — иначе он расходится по миру
        // и игроки остаются без управления.
        item.lockMode = ItemLockMode.inventory;
    }
    return item;
}

function inventoryOf(player: Player): Container | undefined {
    return player.getComponent(EntityComponentTypes.Inventory)?.container;
}

function hasDevice(container: Container): boolean {
    for (let slot = 0; slot < container.size; slot++) {
        if (isDevice(container.getItem(slot))) return true;
    }
    return false;
}

/**
 * Выдаёт коммуникатор, если его нет.
 * Возвращает `false`, если инвентарь недоступен или полностью занят.
 */
function ensureDevice(player: Player, config: DeviceConfig): boolean {
    const container = inventoryOf(player);
    if (!container) return false;
    if (hasDevice(container)) return true;
    if (container.emptySlotsCount === 0) return false;

    container.addItem(createDevice(config));
    return true;
}

const deviceCommand: MechanicCommand = {
    definition: {
        name: 'mc:device',
        description: 'Получить коммуникатор, если он потерялся.',
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
    },
    handler: (origin) => {
        const player = playerFrom(origin);
        if (!player) return fail('Команда доступна только игроку.');

        const runtime = getRuntime();
        if (!runtime) return fail('Движок механик ещё не запущен.');

        // Выдача предмета — мутация мира, в read-only обработчике запрещена.
        defer(runtime.log, 'device:give', () => {
            if (!player.isValid) return;
            const container = inventoryOf(player);
            if (container && hasDevice(container)) {
                player.sendMessage(info('Коммуникатор уже у вас в инвентаре.'));
                return;
            }
            if (ensureDevice(player, runtime.config.device)) {
                player.sendMessage(success('Коммуникатор выдан.'));
            } else {
                player.sendMessage(failure('Освободите слот в инвентаре и повторите /mc:device.'));
            }
        });
        return ok();
    },
};

/**
 * Коммуникатор — предмет, через который игроки управляют механиками сервера.
 *
 * Выдаётся каждому при входе и открывает панель по использованию. Это основной
 * способ управления на консолях: набирать команды с геймпада неудобно, а
 * предмет достаточно взять в руку и нажать «Использовать».
 */
export const deviceMechanic = defineMechanic({
    id: 'device',
    description: 'Коммуникатор: предмет, открывающий панель управления сервером.',
    enabledByDefault: true,
    commands: [deviceCommand],

    activate(ctx: MechanicContext): void {
        const config = ctx.config.device;

        ctx.store.subscribe(world.afterEvents.itemUse, 'itemUse', (event) => {
            if (!isDevice(event.itemStack)) return;
            const runtime = getRuntime();
            if (!runtime) return;
            openPanel(event.source, runtime);
        });

        if (config.giveOnJoin) {
            ctx.store.subscribe(world.afterEvents.playerSpawn, 'playerSpawn', (event) => {
                if (!event.initialSpawn) return;
                const player = event.player;

                // Инвентарь на момент входа может быть ещё не готов — даём тик.
                ctx.store.runTimeout('giveDevice', 20, () => {
                    if (!player.isValid) return;
                    if (!ensureDevice(player, config)) {
                        player.sendMessage(
                            info('Не удалось выдать коммуникатор — освободите слот и наберите /mc:device.'),
                        );
                        return;
                    }
                    ctx.log.debug(`Коммуникатор у ${player.name}.`);
                });
            });
        }
    },
});
