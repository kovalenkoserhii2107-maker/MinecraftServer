/**
 * Типобезопасные обёртки над dynamic properties Bedrock Script API.
 *
 * Dynamic properties — единственное штатное персистентное хранилище скриптов
 * (Node.js `fs` в движке недоступен). Ограничения движка:
 *   • строка — до 32 КБ на свойство;
 *   • суммарный объём на мир ограничен, поэтому храним только компактные данные.
 *
 * Все операции защищены try/catch: обращение к свойствам невалидного игрока
 * (вышел из игры в момент обработки) бросает исключение.
 */

/** Носитель dynamic properties: мир, сущность/игрок или предмет. */
export interface DynamicPropertyHolder {
    getDynamicProperty(identifier: string): boolean | number | string | { x: number; y: number; z: number } | undefined;
    setDynamicProperty(
        identifier: string,
        value?: boolean | number | string | { x: number; y: number; z: number },
    ): void;
}

export function readNumber(holder: DynamicPropertyHolder, key: string, fallback: number): number {
    try {
        const value = holder.getDynamicProperty(key);
        return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    } catch {
        return fallback;
    }
}

export function readBoolean(holder: DynamicPropertyHolder, key: string, fallback: boolean): boolean {
    try {
        const value = holder.getDynamicProperty(key);
        return typeof value === 'boolean' ? value : fallback;
    } catch {
        return fallback;
    }
}

export function readString(holder: DynamicPropertyHolder, key: string, fallback: string): string {
    try {
        const value = holder.getDynamicProperty(key);
        return typeof value === 'string' ? value : fallback;
    } catch {
        return fallback;
    }
}

export function readVector(
    holder: DynamicPropertyHolder,
    key: string,
): { x: number; y: number; z: number } | undefined {
    try {
        const value = holder.getDynamicProperty(key);
        if (typeof value === 'object' && value !== null) return value;
        return undefined;
    } catch {
        return undefined;
    }
}

/** Возвращает `false`, если движок отказал в записи (например, превышен лимит). */
export function write(
    holder: DynamicPropertyHolder,
    key: string,
    value?: boolean | number | string | { x: number; y: number; z: number },
): boolean {
    try {
        holder.setDynamicProperty(key, value);
        return true;
    } catch {
        return false;
    }
}

/** Удаляет свойство (запись `undefined` — штатный способ очистки). */
export function clear(holder: DynamicPropertyHolder, key: string): boolean {
    return write(holder, key, undefined);
}

/** Атомарное увеличение счётчика; возвращает новое значение. */
export function increment(holder: DynamicPropertyHolder, key: string, delta = 1): number {
    const next = readNumber(holder, key, 0) + delta;
    write(holder, key, next);
    return next;
}
