import { CommandPermissionLevel, Player, system } from '@minecraft/server';
import { ActionFormData, FormCancelationReason } from '@minecraft/server-ui';
import { Color, formatCoords, formatDimension, formatMinutes } from '../core/format.js';
import { defer, fail, ok, playerFrom, type MechanicCommand } from '../core/commands.js';
import { defineMechanic, type MechanicContext } from '../core/mechanic.js';
import type { Logger } from '../core/logger.js';
import { getRuntime, type EngineRuntime } from '../core/runtime.js';
import { readNumber, readString, readVector } from '../core/storage.js';

/**
 * Клиент отвечает `UserBusy`, пока у игрока открыт другой интерфейс — а после
 * ввода слэш-команды чат ещё закрывается. Ждём освобождения UI, но не вечно.
 */
const BUSY_RETRY_ATTEMPTS = 10;
const BUSY_RETRY_TICKS = 10;

async function showWhenReady(form: ActionFormData, player: Player, log: Logger) {
    for (let attempt = 0; attempt < BUSY_RETRY_ATTEMPTS; attempt++) {
        if (!player.isValid) return undefined;
        const response = await form.show(player);
        if (response.cancelationReason !== FormCancelationReason.UserBusy) {
            return response;
        }
        await system.waitTicks(BUSY_RETRY_TICKS);
    }
    log.warn(`Не удалось открыть панель для ${player.name}: интерфейс занят.`);
    return undefined;
}

function playerSummary(player: Player): string {
    const minutes = readNumber(player, 'mc:playtime_minutes', 0);
    const deaths = readNumber(player, 'mc:death_count', 0);
    const joins = readNumber(player, 'mc:join_count', 0);
    const deathPos = readVector(player, 'mc:death_pos');
    const deathDim = readString(player, 'mc:death_dim', '');

    const lines = [
        `${Color.gray}Игрок: ${Color.yellow}${player.name}${Color.reset}`,
        `${Color.gray}В игре: ${Color.yellow}${formatMinutes(minutes)}${Color.reset}`,
        `${Color.gray}Входов: ${Color.yellow}${joins}${Color.gray}, смертей: ${Color.yellow}${deaths}${Color.reset}`,
    ];
    if (deathPos && deathDim !== '') {
        lines.push(
            `${Color.gray}Точка смерти: ${Color.yellow}${formatCoords(deathPos)}${Color.gray} (${formatDimension(deathDim)})${Color.reset}`,
        );
    }
    return lines.join('\n');
}

async function showMechanicsMenu(player: Player, runtime: EngineRuntime): Promise<void> {
    const entries = runtime.registry.status();
    const form = new ActionFormData()
        .title('Механики сервера')
        .body(`${Color.gray}Выберите механику, чтобы переключить её состояние.${Color.reset}`);

    for (const entry of entries) {
        const state = entry.active ? `${Color.green}вкл` : `${Color.red}выкл`;
        form.button(`${entry.id}\n${state}${Color.reset}`);
    }
    form.button(`${Color.gray}Назад${Color.reset}`);

    const response = await showWhenReady(form, player, runtime.log);
    if (!response || response.canceled || response.selection === undefined) return;

    const selected = entries[response.selection];
    if (!selected) {
        await showMainMenu(player, runtime);
        return;
    }

    runtime.registry.setEnabled(selected.id, !selected.active);
    player.sendMessage(
        `${Color.gray}Механика ${Color.yellow}${selected.id}${Color.gray} теперь ` +
            `${selected.active ? `${Color.red}выключена` : `${Color.green}включена`}${Color.reset}`,
    );
    await showMechanicsMenu(player, runtime);
}

async function showMainMenu(player: Player, runtime: EngineRuntime): Promise<void> {
    const isAdmin = player.commandPermissionLevel >= CommandPermissionLevel.Admin;

    const form = new ActionFormData()
        .title('Панель сервера')
        .body(playerSummary(player))
        .button(`${Color.yellow}Список команд${Color.reset}`);

    if (isAdmin) {
        form.button(`${Color.aqua}Механики${Color.reset}`);
    }
    form.button(`${Color.gray}Закрыть${Color.reset}`);

    const response = await showWhenReady(form, player, runtime.log);
    if (!response || response.canceled || response.selection === undefined) return;

    if (response.selection === 0) {
        player.sendMessage(
            `${Color.aqua}Команды:${Color.reset}\n` +
                `${Color.yellow}/mc:panel${Color.gray} — эта панель\n` +
                `${Color.yellow}/mc:stats${Color.gray} — ваша статистика\n` +
                `${Color.yellow}/mc:kit${Color.gray} — стартовый набор\n` +
                `${Color.yellow}/mc:deathpoint${Color.gray} — координаты смерти\n` +
                `${Color.yellow}/mc:back${Color.gray} — возврат к месту смерти${Color.reset}`,
        );
        return;
    }
    if (isAdmin && response.selection === 1) {
        await showMechanicsMenu(player, runtime);
    }
}

const panelCommand: MechanicCommand = {
    definition: {
        name: 'mc:panel',
        description: 'Открыть панель сервера (интерфейс, удобный для геймпада).',
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
    },
    handler: (origin) => {
        const player = playerFrom(origin);
        if (!player) return fail('Команда доступна только игроку.');

        const runtime = getRuntime();
        if (!runtime) return fail('Движок механик ещё не запущен.');

        // Показ формы нельзя выполнять в read-only обработчике команды.
        defer(runtime.log, 'adminPanel:open', () => {
            void showMainMenu(player, runtime).catch((error: unknown) => {
                runtime.log.error('Ошибка панели сервера:', error);
            });
        });
        return ok();
    },
};

/**
 * Панель управления на `@minecraft/server-ui`.
 *
 * Ключевая механика для консолей: Switch и PS5 неудобно набирать команды
 * с геймпада, а форма управляется стиками и крестовиной.
 */
export const adminPanelMechanic = defineMechanic({
    id: 'admin_panel',
    description: 'Экранная панель /mc:panel: статистика и управление механиками.',
    enabledByDefault: true,
    commands: [panelCommand],

    activate(ctx: MechanicContext): void {
        ctx.log.debug('Панель сервера доступна по команде /mc:panel.');
    },
});
