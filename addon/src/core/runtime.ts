import type { EngineConfig } from '../config.js';
import type { Logger } from './logger.js';
import type { MechanicRegistry } from './registry.js';

/**
 * Общий доступ к состоянию движка для кода, который выполняется вне активации
 * механик — прежде всего для обработчиков кастомных команд: они регистрируются
 * в `system.beforeEvents.startup`, то есть ДО загрузки мира и до старта механик.
 */
export interface EngineRuntime {
    readonly config: EngineConfig;
    readonly registry: MechanicRegistry;
    readonly log: Logger;
}

let current: EngineRuntime | undefined;

export function setRuntime(runtime: EngineRuntime): void {
    current = runtime;
}

/** `undefined`, пока мир не загружен и механики не подняты. */
export function getRuntime(): EngineRuntime | undefined {
    return current;
}
