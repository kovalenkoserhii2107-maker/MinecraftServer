import { system } from '@minecraft/server';
import type { Logger } from './logger.js';

/** Функция освобождения ресурса (отписка, снятие таймера и т.п.). */
export type Disposer = () => void;

/**
 * Структурный тип любого `*EventSignal` из `@minecraft/server`.
 * Второй параметр `subscribe` (фильтры вида `EntityEventOptions`) необязателен,
 * поэтому сигналы с фильтрами тоже подходят под этот интерфейс.
 */
export interface EventSignalLike<TEvent> {
    subscribe(callback: (event: TEvent) => void): unknown;
    unsubscribe(callback: (event: TEvent) => void): void;
}

/**
 * Оборачивает колбэк в try/catch: исключение внутри обработчика события
 * Bedrock Script API прерывает весь тик, поэтому ловим его на границе.
 */
export function guard<TArgs extends unknown[]>(
    log: Logger,
    label: string,
    fn: (...args: TArgs) => void,
): (...args: TArgs) => void {
    return (...args: TArgs) => {
        try {
            fn(...args);
        } catch (error) {
            log.error(`Необработанная ошибка в «${label}»:`, error);
        }
    };
}

/**
 * Набор ресурсов одной механики: подписки на события и запланированные задачи.
 *
 * Каждая механика получает собственный store, поэтому её можно выключить
 * в рантайме (`/mc:toggle`) без утечки подписок и интервалов — требование
 * производительности из CLAUDE.md.
 */
export class DisposableStore {
    private readonly disposers = new Set<Disposer>();
    private disposed = false;

    constructor(private readonly log: Logger) {}

    get isDisposed(): boolean {
        return this.disposed;
    }

    /** Количество живых ресурсов — используется в диагностике и тестах. */
    get size(): number {
        return this.disposers.size;
    }

    /**
     * Регистрирует функцию очистки и возвращает «отменялку»: она снимает
     * ресурс досрочно и убирает его из набора, чтобы разовые задачи
     * не накапливались на долгоживущем сервере.
     */
    add(disposer: Disposer): Disposer {
        if (this.disposed) {
            disposer();
            return () => {};
        }
        this.disposers.add(disposer);
        return () => {
            if (this.disposers.delete(disposer)) disposer();
        };
    }

    /** Подписка на событие мира/системы с автоматической отпиской и try/catch. */
    subscribe<TEvent>(
        signal: EventSignalLike<TEvent>,
        label: string,
        handler: (event: TEvent) => void,
    ): Disposer {
        const wrapped = guard(this.log, label, handler);
        signal.subscribe(wrapped);
        return this.add(() => {
            try {
                signal.unsubscribe(wrapped);
            } catch (error) {
                this.log.warn(`Не удалось отписаться от «${label}»:`, error);
            }
        });
    }

    /** Периодическая задача. `tickInterval` — в игровых тиках (20 тиков = 1 с). */
    runInterval(label: string, tickInterval: number, handler: () => void): Disposer {
        const runId = system.runInterval(guard(this.log, label, handler), tickInterval);
        return this.add(() => system.clearRun(runId));
    }

    /**
     * Одноразовая отложенная задача. После срабатывания сама вычёркивается
     * из набора: иначе каждый вход игрока навсегда добавлял бы запись.
     */
    runTimeout(label: string, tickDelay: number, handler: () => void): Disposer {
        const runId = system.runTimeout(() => {
            // Снимаем регистрацию до вызова: таймер уже отработал, clearRun не нужен.
            this.forget(disposer);
            guard(this.log, label, handler)();
        }, tickDelay);
        const disposer: Disposer = () => system.clearRun(runId);
        return this.add(disposer);
    }

    /** Убирает ресурс из набора, НЕ вызывая его функцию очистки. */
    private forget(disposer: Disposer): void {
        this.disposers.delete(disposer);
    }

    /** Освобождает все ресурсы. Повторный вызов безопасен. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        // В обратном порядке регистрации — как при stack-based освобождении ресурсов.
        for (const disposer of [...this.disposers].reverse()) {
            try {
                disposer();
            } catch (error) {
                this.log.warn('Ошибка при освобождении ресурса:', error);
            }
        }
        this.disposers.clear();
    }
}
