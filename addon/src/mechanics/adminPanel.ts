import { CommandPermissionLevel } from '@minecraft/server';
import { defer, fail, ok, playerFrom, type MechanicCommand } from '../core/commands.js';
import { defineMechanic, type MechanicContext } from '../core/mechanic.js';
import { getRuntime } from '../core/runtime.js';
import { openPanel } from '../ui/panel.js';

const panelCommand: MechanicCommand = {
    definition: {
        name: 'mc:panel',
        description: 'Открыть панель сервера.',
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
    },
    handler: (origin) => {
        const player = playerFrom(origin);
        if (!player) return fail('Команда доступна только игроку.');

        const runtime = getRuntime();
        if (!runtime) return fail('Движок механик ещё не запущен.');

        // Показ формы нельзя выполнять в read-only обработчике команды.
        defer(runtime.log, 'adminPanel:open', () => openPanel(player, runtime));
        return ok();
    },
};

/**
 * Доступ к панели сервера по команде.
 *
 * Основной способ открыть её — коммуникатор из механики `device`; команда
 * остаётся запасным вариантом, если предмет потерян или механика выключена.
 */
export const adminPanelMechanic = defineMechanic({
    id: 'admin_panel',
    description: 'Команда /mc:panel — панель сервера, если нет коммуникатора.',
    enabledByDefault: true,
    commands: [panelCommand],

    activate(ctx: MechanicContext): void {
        ctx.log.debug('Панель сервера доступна по команде /mc:panel.');
    },
});
