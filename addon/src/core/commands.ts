import {
    CommandPermissionLevel,
    CustomCommandParamType,
    CustomCommandStatus,
    Player,
    system,
    type CustomCommand,
    type CustomCommandOrigin,
    type CustomCommandRegistry,
    type CustomCommandResult,
} from '@minecraft/server';
import { Color } from './format.js';
import { guard } from './lifecycle.js';
import type { Logger } from './logger.js';
import type { Mechanic } from './mechanic.js';
import { getRuntime } from './runtime.js';

/** Пространство имён всех команд движка: `/mc:help`, `/mc:back`, ... */
export const COMMAND_NAMESPACE = 'mc';

/** Имя enum-параметра со списком идентификаторов механик. */
const MECHANIC_ENUM = `${COMMAND_NAMESPACE}:mechanic_id`;

/**
 * Описание команды, принадлежащей механике.
 *
 * Команды регистрируются один раз при старте движка и живут всё время работы
 * сервера, поэтому обработчик обязан сам проверять, активна ли механика:
 * `/mc:toggle` может выключить её в любой момент.
 */
export interface MechanicCommand {
    readonly definition: CustomCommand;
    handler(origin: CustomCommandOrigin, ...args: unknown[]): CustomCommandResult;
}

export function ok(message?: string): CustomCommandResult {
    return message === undefined
        ? { status: CustomCommandStatus.Success }
        : { status: CustomCommandStatus.Success, message };
}

export function fail(message: string): CustomCommandResult {
    return { status: CustomCommandStatus.Failure, message };
}

/**
 * Обработчики кастомных команд выполняются в read-only режиме: изменять мир
 * (телепорт, выдача предметов, эффекты) прямо в них нельзя. Любую мутацию
 * откладываем на ближайший тик через `system.run`.
 */
export function defer(log: Logger, label: string, action: () => void): void {
    system.run(guard(log, label, action));
}

/** Возвращает игрока-инициатора или `undefined`, если команду ввела консоль сервера. */
export function playerFrom(origin: CustomCommandOrigin): Player | undefined {
    const source = origin.sourceEntity;
    return source instanceof Player ? source : undefined;
}

/**
 * Регистрирует ядро команд и команды всех механик.
 *
 * Вызывается строго из `system.beforeEvents.startup` — в другой фазе
 * `customCommandRegistry` недоступен.
 */
export function registerCommands(
    registry: CustomCommandRegistry,
    mechanics: readonly Mechanic[],
    log: Logger,
): void {
    const ids = mechanics.map((mechanic) => mechanic.id);
    if (ids.length > 0) {
        registry.registerEnum(MECHANIC_ENUM, ids);
    }

    for (const command of coreCommands(mechanics)) {
        register(registry, command, log);
    }

    for (const mechanic of mechanics) {
        for (const command of mechanic.commands ?? []) {
            register(registry, command, log, mechanic);
        }
    }
}

function register(
    registry: CustomCommandRegistry,
    command: MechanicCommand,
    log: Logger,
    owner?: Mechanic,
): void {
    try {
        registry.registerCommand(command.definition, (origin, ...args) => {
            try {
                const runtime = getRuntime();
                if (!runtime) {
                    return fail('Движок механик ещё не запущен. Попробуйте через пару секунд.');
                }
                if (owner && !runtime.registry.status().some((s) => s.id === owner.id && s.active)) {
                    return fail(`Механика «${owner.id}» выключена, команда недоступна.`);
                }
                return command.handler(origin, ...(args as unknown[]));
            } catch (error) {
                log.error(`Ошибка выполнения /${command.definition.name}:`, error);
                return fail('Внутренняя ошибка команды — подробности в логе сервера.');
            }
        });
        log.debug(`Команда /${command.definition.name} зарегистрирована.`);
    } catch (error) {
        // Чаще всего — конфликт имён или неверный namespace. Сервер должен подняться.
        log.error(`Не удалось зарегистрировать /${command.definition.name}:`, error);
    }
}

function coreCommands(mechanics: readonly Mechanic[]): MechanicCommand[] {
    return [
        {
            definition: {
                name: `${COMMAND_NAMESPACE}:help`,
                description: 'Список кастомных команд сервера.',
                permissionLevel: CommandPermissionLevel.Any,
                cheatsRequired: false,
            },
            handler: () => {
                const lines = [`${Color.aqua}Команды сервера:${Color.reset}`];
                for (const mechanic of mechanics) {
                    for (const command of mechanic.commands ?? []) {
                        lines.push(
                            `${Color.yellow}/${command.definition.name}${Color.gray} — ${command.definition.description}${Color.reset}`,
                        );
                    }
                }
                lines.push(
                    `${Color.yellow}/${COMMAND_NAMESPACE}:mechanics${Color.gray} — состояние механик.${Color.reset}`,
                );
                return ok(lines.join('\n'));
            },
        },
        {
            definition: {
                name: `${COMMAND_NAMESPACE}:mechanics`,
                description: 'Показать зарегистрированные механики и их состояние.',
                permissionLevel: CommandPermissionLevel.Any,
                cheatsRequired: false,
            },
            handler: () => {
                const runtime = getRuntime();
                if (!runtime) return fail('Движок механик ещё не запущен.');
                const lines = runtime.registry.status().map((entry) => {
                    const state = entry.active ? `${Color.green}вкл` : `${Color.red}выкл`;
                    return `${state}${Color.reset} ${Color.yellow}${entry.id}${Color.gray} — ${entry.description}${Color.reset}`;
                });
                return ok(lines.length > 0 ? lines.join('\n') : 'Механики не зарегистрированы.');
            },
        },
        {
            definition: {
                name: `${COMMAND_NAMESPACE}:toggle`,
                description: 'Включить или выключить механику (сохраняется между рестартами).',
                permissionLevel: CommandPermissionLevel.Admin,
                cheatsRequired: false,
                mandatoryParameters: [
                    { name: MECHANIC_ENUM, type: CustomCommandParamType.Enum },
                    { name: 'enabled', type: CustomCommandParamType.Boolean },
                ],
            },
            handler: (_origin, ...args) => {
                const runtime = getRuntime();
                if (!runtime) return fail('Движок механик ещё не запущен.');

                const [id, enabled] = args;
                if (typeof id !== 'string' || typeof enabled !== 'boolean') {
                    return fail('Использование: /mc:toggle <механика> <true|false>');
                }
                if (!runtime.registry.has(id)) {
                    return fail(`Неизвестная механика «${id}».`);
                }
                // Активация подписывается на события — это мутация, откладываем на тик.
                defer(runtime.log, `toggle:${id}`, () => {
                    runtime.registry.setEnabled(id, enabled);
                });
                return ok(`Механика «${id}» будет ${enabled ? 'включена' : 'выключена'}.`);
            },
        },
    ];
}
