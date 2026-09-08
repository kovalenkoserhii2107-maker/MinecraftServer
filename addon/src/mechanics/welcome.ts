import { Color, info, success } from '../core/format.js';
import { giveStarterKit } from '../core/playerActions.js';
import { world } from '@minecraft/server';
import { defineMechanic, type MechanicContext } from '../core/mechanic.js';
import { readBoolean, readNumber, write } from '../core/storage.js';

const KEY_FIRST_JOIN = 'mc:first_join_done';
const KEY_JOIN_COUNT = 'mc:join_count';

/**
 * Приветствие: заголовок при входе, MOTD и стартовый набор при первом заходе.
 *
 * Повторно набор выдаётся из панели коммуникатора («Игрок → Стартовый набор»).
 */
export const welcomeMechanic = defineMechanic({
    id: 'welcome',
    description: 'Приветствие, MOTD и стартовый набор для новых игроков.',
    enabledByDefault: true,

    activate(ctx: MechanicContext): void {
        const { welcome } = ctx.config;

        ctx.store.subscribe(world.afterEvents.playerSpawn, 'playerSpawn', (event) => {
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

                if (isFirstJoin && welcome.giveStarterKit) {
                    const result = giveStarterKit(player, welcome);
                    if (result.ok) player.sendMessage(success(result.message));
                }
            });

            ctx.log.debug(`${player.name} вошёл на сервер (вход №${joins}).`);
        });

        ctx.store.subscribe(world.afterEvents.playerLeave, 'playerLeave', (event) => {
            ctx.log.debug(`${event.playerName} покинул сервер.`);
        });
    },
});
