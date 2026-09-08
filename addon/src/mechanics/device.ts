import { CommandPermissionLevel, world } from '@minecraft/server';
import { failure, info, success } from '../core/format.js';
import { ensureMarked, hasMarked, inventoryOf, isMarked, type MarkedItemSpec } from '../core/markedItem.js';
import { defer, fail, ok, playerFrom, type MechanicCommand } from '../core/commands.js';
import { defineMechanic, type MechanicContext } from '../core/mechanic.js';
import type { DeviceConfig } from '../config.js';
import { getRuntime } from '../core/runtime.js';
import { openPanel } from '../ui/panel.js';

/**
 * Маркер коммуникатора. Название игрок может подделать наковальней,
 * а dynamic property на ItemStack — нет.
 */
const KEY_DEVICE = 'mc:device';

function specOf(config: DeviceConfig): MarkedItemSpec {
    return {
        key: KEY_DEVICE,
        itemType: config.itemType,
        itemName: config.itemName,
        lore: config.lore,
        lockInInventory: config.lockInInventory,
    };
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
            world.sendMessage(`§e[DEBUG] Executing device:give for ${player.name}`);
            if (!player.isValid) return;
            const container = inventoryOf(player);
            if (container && hasMarked(container, KEY_DEVICE)) {
                player.sendMessage(info('Коммуникатор уже у вас в инвентаре.'));
                return;
            }
            if (ensureMarked(player, specOf(runtime.config.device))) {
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
            if (!isMarked(event.itemStack, KEY_DEVICE)) return;
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
                    if (!ensureMarked(player, specOf(config))) {
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
