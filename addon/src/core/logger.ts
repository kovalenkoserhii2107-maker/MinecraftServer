import { CommandPermissionLevel, world } from '@minecraft/server';
import { Color, PREFIX } from './format.js';

export enum LogLevel {
    Debug = 10,
    Info = 20,
    Warn = 30,
    Error = 40,
    Silent = 100,
}

const LEVEL_LABEL: Record<number, string> = {
    [LogLevel.Debug]: 'DEBUG',
    [LogLevel.Info]: 'INFO',
    [LogLevel.Warn]: 'WARN',
    [LogLevel.Error]: 'ERROR',
};

let minimumLevel: LogLevel = LogLevel.Info;
let broadcastToAdmins = false;

/** Порог логирования; всё, что ниже, отбрасывается без затрат. */
export function setLogLevel(level: LogLevel): void {
    minimumLevel = level;
}

export function getLogLevel(): LogLevel {
    return minimumLevel;
}

/**
 * Дублировать WARN/ERROR в чат операторам. Полезно при отладке с консоли,
 * когда `docker logs` под рукой нет.
 */
export function setAdminBroadcast(enabled: boolean): void {
    broadcastToAdmins = enabled;
}

/**
 * Отправляет сообщение всем игрокам с правами оператора.
 * Никогда не бросает исключение: логирование не должно ронять механику.
 */
export function notifyAdmins(message: string): void {
    try {
        for (const player of world.getAllPlayers()) {
            if (player.commandPermissionLevel >= CommandPermissionLevel.Admin) {
                player.sendMessage(message);
            }
        }
    } catch {
        // Мир может быть ещё не готов (ранняя фаза загрузки) — молча пропускаем.
    }
}

function emit(level: LogLevel, scope: string, args: unknown[]): void {
    if (level < minimumLevel) return;

    const label = LEVEL_LABEL[level] ?? 'LOG';
    const line = `[${label}][${scope}] ${args.map(stringify).join(' ')}`;

    if (level >= LogLevel.Error) {
        console.error(line);
    } else if (level >= LogLevel.Warn) {
        console.warn(line);
    } else {
        console.log(line);
    }

    if (broadcastToAdmins && level >= LogLevel.Warn) {
        const color = level >= LogLevel.Error ? Color.red : Color.yellow;
        notifyAdmins(`${PREFIX}${color}${line}${Color.reset}`);
    }
}

function stringify(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

export interface Logger {
    readonly scope: string;
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
    child(scope: string): Logger;
}

/** Создаёт логгер с областью видимости, например `createLogger('welcome')`. */
export function createLogger(scope: string): Logger {
    return {
        scope,
        debug: (...args) => emit(LogLevel.Debug, scope, args),
        info: (...args) => emit(LogLevel.Info, scope, args),
        warn: (...args) => emit(LogLevel.Warn, scope, args),
        error: (...args) => emit(LogLevel.Error, scope, args),
        child: (childScope) => createLogger(`${scope}:${childScope}`),
    };
}
