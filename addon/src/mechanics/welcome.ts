import {
    CommandPermissionLevel,
    EntityComponentTypes,
    ItemStack,
    Player,
    world,
} from '@minecraft/server';
import { Color, info, success } from '../core/format.js';
import { defer, fail, ok, playerFrom, type MechanicCommand } from '../core/commands.js';
import { defineMechanic, type MechanicContext } from '../core/mechanic.js';
import { getRuntime } from '../core/runtime.js';
import { readBoolean, readNumber, write } from '../core/storage.js';

const KEY_FIRST_JOIN = 'mc:first_join_done';
const KEY_KIT_TAKEN = 'mc:starter_kit_taken';
const KEY_JOIN_COUNT = 'mc:join_count';

/**
 * Выдаёт стартовый набор в инвентарь игрока.
 * Возвращает `false`, если инвентарь недоступен или полностью заполнен.
 */
function giveStarterKit(player: Player, kit: ReadonlyArray<{ item: string; amount: number }>): boolean {
    const inventory = player.getComponent(EntityComponentTypes.Inventory);
    const container = inventory?.container;
    if (!container) return false;

    let given = false;
    for (const entry of kit) {
        if (container.emptySlotsCount === 0) break;
        try {
            container.addItem(new ItemStack(entry.item, entry.amount));
            given = true;
        } catch {
            // Неизвестный идентификатор предмета не должен ломать вход на сервер.
            player.sendMessage(info(`Не удалось выдать предмет ${entry.item}.`));
        }
    }
    return given;
}

const kitCommand: MechanicCommand = {
    definition: {
        name: 'mc:kit',
        description: 'Получить стартовый набор (один раз на игрока).',
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
    },
    handler: (origin) => {
        const player = playerFrom(origin);
        if (!player) return fail('Команда доступна только игроку.');

        const runtime = getRuntime();
        if (!runtime) return fail('Движок механик ещё не запущен.');
        if (readBoolean(player, KEY_KIT_TAKEN, false)) {
            return fail('Стартовый набор уже был получен.');
        }

        // Изменение инвентаря — мутация мира, в read-only обработчике команды запрещена.
        defer(runtime.log, 'welcome:kit', () => {
            if (!player.isValid) return;
            if (giveStarterKit(player, runtime.config.welcome.starterKit)) {
                write(player, KEY_KIT_TAKEN, true);
                player.sendMessage(success('Стартовый набор выдан.'));
            } else {
                player.sendMessage(info('Освободите место в инвентаре и повторите /mc:kit.'));
            }
        });
        return ok('Выдаём стартовый набор...');
    },
};

/**
 * Приветствие: заголовок при входе, MOTD, стартовый набор при первом заходе
 * и объявление о новом игроке в чат.
 */
export const welcomeMechanic = defineMechanic({
    id: 'welcome',
    description: 'Приветствие, MOTD и стартовый набор для новых игроков.',
    enabledByDefault: true,
    commands: [kitCommand],

    activate(ctx: MechanicContext): void {
        const { welcome } = ctx.config;

        ctx.store.subscribe(world.afterEvents.playerSpawn, 'playerSpawn', (event) => {
            // Событие срабатывает и при возрождении после смерти — нас интересует только вход.
            if (!event.initialSpawn) return;

            const player = event.player;
            const joins = readNumber(player, KEY_JOIN_COUNT, 0) + 1;
            write(player, KEY_JOIN_COUNT, joins);

            const isFirstJoin = !readBoolean(player, KEY_FIRST_JOIN, false);
            if (isFirstJoin) {
                write(player, KEY_FIRST_JOIN, true);
                world.sendMessage(
                    `${Color.gold}★ ${Color.yellow}${player.name}${Color.gold} впервые заходит на сервер!${Color.reset}`,
                );
            }

            player.sendMessage(info(welcome.motd));

            // Клиенту консоли нужно время на загрузку мира, иначе заголовок не увидят.
            ctx.store.runTimeout('welcomeTitle', welcome.titleDelayTicks, () => {
                if (!player.isValid) return;
                player.onScreenDisplay.setTitle(`${Color.aqua}Добро пожаловать`, {
                    subtitle: `${Color.gray}${player.name}${Color.reset}`,
                    fadeInDuration: 10,
                    stayDuration: 40,
                    fadeOutDuration: 20,
                });

                if (isFirstJoin && welcome.giveStarterKit && giveStarterKit(player, welcome.starterKit)) {
                    write(player, KEY_KIT_TAKEN, true);
                    player.sendMessage(success('Вам выдан стартовый набор.'));
                }
            });

            ctx.log.debug(`${player.name} вошёл на сервер (вход №${joins}).`);
        });

        ctx.store.subscribe(world.afterEvents.playerLeave, 'playerLeave', (event) => {
            ctx.log.debug(`${event.playerName} покинул сервер.`);
        });
    },
});
