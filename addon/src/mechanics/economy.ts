import {
    CommandPermissionLevel,
    DisplaySlotId,
    ObjectiveSortOrder,
    Player,
    world,
    type ScoreboardObjective,
} from '@minecraft/server';
import { Color, info, success } from '../core/format.js';
import { fail, ok, playerFrom, type MechanicCommand } from '../core/commands.js';
import { deposit, formatMoney, getBalance, hasAccount, setBalance } from '../core/economy.js';
import { defineMechanic, type MechanicContext } from '../core/mechanic.js';
import { getRuntime } from '../core/runtime.js';

const OBJECTIVE_ID = 'mc_balance';

/**
 * Боковая панель — единственный способ держать постоянное число у правого края
 * экрана без resource pack: action bar висит внизу, заголовки — по центру.
 */
function ensureObjective(title: string): ScoreboardObjective | undefined {
    try {
        return world.scoreboard.getObjective(OBJECTIVE_ID) ?? world.scoreboard.addObjective(OBJECTIVE_ID, title);
    } catch {
        return undefined;
    }
}

/** Переносит баланс игрока в счёт на табло. */
export function refreshDisplay(player: Player): void {
    try {
        const objective = world.scoreboard.getObjective(OBJECTIVE_ID);
        if (!objective || !player.isValid) return;
        objective.setScore(player, getBalance(player));
    } catch {
        // Табло может быть ещё не создано или игрок уже вышел — не критично.
    }
}

const balanceCommand: MechanicCommand = {
    definition: {
        name: 'mc:balance',
        description: 'Показать баланс криптогривны.',
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
    },
    handler: (origin) => {
        const player = playerFrom(origin);
        if (!player) return fail('Команда доступна только игроку.');

        const runtime = getRuntime();
        if (!runtime) return fail('Движок механик ещё не запущен.');

        const { currencySymbol } = runtime.config.economy;
        return ok(
            `${Color.gray}Баланс: ${Color.gold}${formatMoney(getBalance(player), currencySymbol)}${Color.reset}`,
        );
    },
};

/**
 * Криптогривна: стартовый капитал, хранение баланса и его отображение.
 *
 * Списывать и начислять из других механик следует через `core/economy.ts`,
 * а после изменения баланса вызывать `refreshDisplay`, чтобы табло не отставало.
 */
export const economyMechanic = defineMechanic({
    id: 'economy',
    description: 'Криптогривна: баланс, стартовый капитал и табло справа.',
    enabledByDefault: true,
    commands: [balanceCommand],

    activate(ctx: MechanicContext): void {
        const config = ctx.config.economy;

        if (config.showSidebar) {
            const objective = ensureObjective(config.sidebarTitle);
            if (objective) {
                try {
                    world.scoreboard.setObjectiveAtDisplaySlot(DisplaySlotId.Sidebar, {
                        objective,
                        sortOrder: ObjectiveSortOrder.Descending,
                    });
                } catch (error) {
                    ctx.log.warn('Не удалось включить табло баланса:', error);
                }
            }
            // Снимаем табло при выключении механики, иначе останется висеть.
            ctx.store.add(() => {
                try {
                    world.scoreboard.clearObjectiveAtDisplaySlot(DisplaySlotId.Sidebar);
                } catch {
                    // Мир уже выгружен — ничего страшного.
                }
            });
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

/** Начисление с обновлением табло — для использования другими механиками. */
export function payTo(player: Player, amount: number): number {
    const balance = deposit(player, amount);
    refreshDisplay(player);
    return balance;
}

/** Сообщение об изменении баланса единым стилем. */
export function notifyBalance(player: Player, text: string, symbol: string): void {
    player.sendMessage(info(`${text} Баланс: ${formatMoney(getBalance(player), symbol)}.`));
}
