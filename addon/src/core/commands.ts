import {
    CustomCommandStatus,
    Player,
    system,
    type CustomCommand,
    type CustomCommandOrigin,
    type CustomCommandRegistry,
    type CustomCommandResult,
} from '@minecraft/server';
import { guard } from './lifecycle.js';
import type { Logger } from './logger.js';
import type { Mechanic } from './mechanic.js';
import { getRuntime } from './runtime.js';

/**
 * Пространство имён команд движка.
 *
 * Управление сервером живёт в панели коммуникатора: набирать команды с
 * геймпада неудобно, а консоли — основная платформа. В чате осталась ровно
 * одна команда — `/mc:device`, страховка на случай, если коммуникатор потерян
 * и панель открыть нечем.
 */
export const COMMAND_NAMESPACE = 'mc';

/**
 * Описание команды, принадлежащей механике.
 *
 * Команды регистрируются один раз при старте движка и живут всё время работы
 * сервера, поэтому обработчик обязан сам проверять, активна ли механика:
 * `/mc:toggle` может выключить её в любой момент.
 */
export interface MechanicCommand {
    readonly definition: CustomCommand;
    /**
     * Enum-параметры команды: имя (с namespace `mc:`) -> допустимые значения.
     * Регистрируются до самой команды — движок иначе отвергнет ссылку на
     * неизвестный enum.
     */
    readonly enums?: Readonly<Record<string, readonly string[]>>;
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
    for (const mechanic of mechanics) {
        for (const command of mechanic.commands ?? []) {
            for (const [name, values] of Object.entries(command.enums ?? {})) {
                try {
                    registry.registerEnum(name, [...values]);
                } catch (error) {
                    log.error(`Не удалось зарегистрировать enum ${name}:`, error);
                }
            }
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

