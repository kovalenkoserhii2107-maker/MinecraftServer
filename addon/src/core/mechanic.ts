import type { EngineConfig } from '../config.js';
import type { MechanicCommand } from './commands.js';
import type { DisposableStore } from './lifecycle.js';
import type { Logger } from './logger.js';

/** Всё, что механика получает при активации. */
export interface MechanicContext {
    /** Логгер с областью видимости, равной id механики. */
    readonly log: Logger;
    /** Конфигурация движка (только чтение). */
    readonly config: EngineConfig;
    /**
     * Хранилище ресурсов механики. Всё, что подписано/запланировано через него,
     * автоматически освобождается при выключении механики.
     */
    readonly store: DisposableStore;
}

/**
 * Модуль игровой механики.
 *
 * Контракт намеренно узкий: механика только подписывается на события и
 * планирует задачи через `ctx.store`. Ручная отписка не нужна и не приветствуется —
 * это гарантирует отсутствие «повисших» обработчиков при `/mc:toggle`.
 */
export interface Mechanic {
    /** Стабильный идентификатор в snake_case; используется в командах и хранилище. */
    readonly id: string;
    /** Короткое описание для `/mc:mechanics`. */
    readonly description: string;
    /** Активна ли механика, если состояние ещё не сохранено в мире. */
    readonly enabledByDefault: boolean;
    /**
     * Кастомные слэш-команды механики.
     *
     * Регистрируются один раз при старте сервера (`system.beforeEvents.startup`)
     * и не снимаются при выключении механики — движок сам отвечает отказом,
     * если механика неактивна.
     */
    readonly commands?: readonly MechanicCommand[];
    /** Точка входа. Вызывается ровно один раз на каждую активацию. */
    activate(ctx: MechanicContext): void;
}

/** Хелпер для описания механики: даёт вывод типов без явных аннотаций. */
export function defineMechanic(mechanic: Mechanic): Mechanic {
    return mechanic;
}
