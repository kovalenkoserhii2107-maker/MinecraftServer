import type { EngineConfig } from '../config.js';
import { isMechanicEnabled, persistMechanicEnabled } from '../config.js';
import { DisposableStore } from './lifecycle.js';
import { createLogger, type Logger } from './logger.js';
import type { Mechanic } from './mechanic.js';

export interface MechanicStatus {
    readonly id: string;
    readonly description: string;
    readonly active: boolean;
}

interface RegisteredMechanic {
    readonly mechanic: Mechanic;
    store?: DisposableStore;
}

/**
 * Реестр механик: активация при загрузке мира и включение/выключение в рантайме.
 *
 * Ошибка активации одной механики не должна ронять остальные, поэтому каждая
 * активация изолирована try/catch, а её ресурсы освобождаются при сбое.
 */
export class MechanicRegistry {
    private readonly entries = new Map<string, RegisteredMechanic>();
    private readonly log: Logger;

    constructor(private readonly config: EngineConfig) {
        this.log = createLogger('registry');
    }

    /** Регистрирует механику. Дубликаты id отклоняются с предупреждением. */
    register(mechanic: Mechanic): void {
        if (this.entries.has(mechanic.id)) {
            this.log.warn(`Механика «${mechanic.id}» уже зарегистрирована — повтор проигнорирован.`);
            return;
        }
        this.entries.set(mechanic.id, { mechanic });
    }

    /** Активирует все механики, включённые по конфигурации/сохранённому состоянию. */
    activateAll(): void {
        for (const entry of this.entries.values()) {
            if (isMechanicEnabled(entry.mechanic.id, entry.mechanic.enabledByDefault)) {
                this.activate(entry.mechanic.id);
            } else {
                this.log.info(`Механика «${entry.mechanic.id}» выключена в настройках мира.`);
            }
        }
    }

    /** Возвращает `true`, если механика активна после вызова. */
    activate(id: string): boolean {
        const entry = this.entries.get(id);
        if (!entry) {
            this.log.warn(`Неизвестная механика «${id}».`);
            return false;
        }
        if (entry.store) return true;

        const log = createLogger(id);
        const store = new DisposableStore(log);
        try {
            entry.mechanic.activate({ log, config: this.config, store });
            entry.store = store;
            this.log.info(`Механика «${id}» активирована.`);
            return true;
        } catch (error) {
            // Частично созданные подписки не должны пережить неудачную активацию.
            store.dispose();
            this.log.error(`Не удалось активировать механику «${id}»:`, error);
            return false;
        }
    }

    /** Освобождает все ресурсы механики. Возвращает `true`, если что-то выключили. */
    deactivate(id: string): boolean {
        const entry = this.entries.get(id);
        if (!entry?.store) return false;
        entry.store.dispose();
        entry.store = undefined;
        this.log.info(`Механика «${id}» выключена.`);
        return true;
    }

    /**
     * Включает/выключает механику и сохраняет выбор в мире,
     * чтобы он пережил рестарт контейнера.
     */
    setEnabled(id: string, enabled: boolean): boolean {
        if (!this.entries.has(id)) return false;
        const ok = enabled ? this.activate(id) : (this.deactivate(id), true);
        if (ok) persistMechanicEnabled(id, enabled);
        return ok;
    }

    has(id: string): boolean {
        return this.entries.has(id);
    }

    /** Снимок состояния для `/mc:mechanics`. */
    status(): MechanicStatus[] {
        return [...this.entries.values()].map((entry) => ({
            id: entry.mechanic.id,
            description: entry.mechanic.description,
            active: entry.store !== undefined,
        }));
    }

    /** Полная остановка (например, при выключении сервера). */
    disposeAll(): void {
        for (const id of this.entries.keys()) {
            this.deactivate(id);
        }
    }
}
