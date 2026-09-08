import { world } from '@minecraft/server';
import { formatMoney, ensureObjective, hasAccount, hideObjectiveFromSidebar, refreshDisplay, setBalance, showObjectiveOnSidebar } from '../core/economy.js';
import { success } from '../core/format.js';
import { defineMechanic, type MechanicContext } from '../core/mechanic.js';

/**
 * Криптогривна: стартовый капитал и табло справа.
 *
 * Баланс показывается в панели коммуникатора; табло — постоянная строка у
 * правого края экрана, единственный способ без resource pack.
 */
export const economyMechanic = defineMechanic({
    id: 'economy',
    description: 'Криптогривна: баланс, стартовый капитал и табло справа.',
    enabledByDefault: true,

    activate(ctx: MechanicContext): void {
        const config = ctx.config.economy;

        if (config.showSidebar) {
            if (ensureObjective(config.sidebarTitle)) {
                try {
                    showObjectiveOnSidebar();
                } catch (error) {
                    ctx.log.warn('Не удалось включить табло баланса:', error);
                }
            }
            // Снимаем табло при выключении механики, иначе останется висеть.
            ctx.store.add(hideObjectiveFromSidebar);
        }

        ctx.store.subscribe(world.afterEvents.playerSpawn, 'playerSpawn', (event) => {
            const player = event.player;
            if (!hasAccount(player)) {
                setBalance(player, config.startingBalance);
                player.sendMessage(
                    success(
                        `Вам начислен стартовый капитал: ${formatMoney(config.startingBalance, config.currencySymbol)}.`,
                    ),
                );
                ctx.log.info(`${player.name} получил стартовый капитал.`);
            }
            refreshDisplay(player);
        });

        // Страховка: баланс могли изменить в обход refreshDisplay.
        ctx.store.runInterval('sidebarSync', config.sidebarRefreshTicks, () => {
            for (const player of world.getAllPlayers()) refreshDisplay(player);
        });
    },
});
