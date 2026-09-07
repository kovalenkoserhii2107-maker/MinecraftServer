import { world } from '@minecraft/server';
import { LogLevel } from './core/logger.js';
import { readBoolean, readNumber, write } from './core/storage.js';

/**
 * Конфигурация движка механик.
 *
 * Значения по умолчанию задаются здесь (правится в git), а включение/выключение
 * отдельных механик переживает рестарт сервера через dynamic properties мира —
 * чтобы менять поведение с геймпада, без пересборки и передеплоя.
 */
export interface EngineConfig {
    /** Порог логирования в `docker logs -f bds`. */
    readonly logLevel: LogLevel;
    /** Дублировать WARN/ERROR в чат операторам. */
    readonly broadcastErrorsToAdmins: boolean;
    readonly welcome: WelcomeConfig;
    readonly deathBeacon: DeathBeaconConfig;
    readonly playtime: PlaytimeConfig;
    readonly combat: CombatConfig;
    readonly device: DeviceConfig;
}

export interface WelcomeConfig {
    /** Сообщение дня, показывается при каждом входе. */
    readonly motd: string;
    /** Выдавать стартовый набор при самом первом входе игрока. */
    readonly giveStarterKit: boolean;
    /** Содержимое стартового набора: идентификатор предмета -> количество. */
    readonly starterKit: ReadonlyArray<{ readonly item: string; readonly amount: number }>;
    /** Задержка перед показом заголовка, в тиках (даём клиенту прогрузиться). */
    readonly titleDelayTicks: number;
}

export interface DeathBeaconConfig {
    /** Сколько раз за жизнь можно телепортироваться к месту смерти (`/mc:back`). */
    readonly maxReturnsPerDeath: number;
    /** Возврат доступен только в том же измерении, где произошла смерть. */
    readonly sameDimensionOnly: boolean;
}

export interface PlaytimeConfig {
    /** Период опроса онлайна, в тиках. 1200 тиков = 60 секунд. */
    readonly tickInterval: number;
    /** Пороги в минутах, на которых выдаётся награда. */
    readonly rewardMinutes: readonly number[];
    /** Сколько опыта выдавать за достижение порога. */
    readonly rewardXp: number;
}

export interface CombatConfig {
    /** Показывать полосу здоровья цели в action bar при ударе. */
    readonly showTargetHealth: boolean;
    /** Доля здоровья, ниже которой игрок получает предупреждение (0..1). */
    readonly lowHealthRatio: number;
    /** Минимальная пауза между предупреждениями о низком здоровье, в тиках. */
    readonly lowHealthCooldownTicks: number;
}

export interface DeviceConfig {
    /**
     * Предмет, играющий роль коммуникатора.
     *
     * Здесь ванильный предмет, а не собственный: кастомному предмету нужен
     * resource pack с текстурой и названием, иначе в руках у игрока будет
     * «отсутствующая текстура». Когда resource pack появится, достаточно
     * поменять идентификатор здесь.
     */
    readonly itemType: string;
    /** Название в руках. Оно же отличает коммуникатор от обычного предмета. */
    readonly itemName: string;
    /** Подсказка под названием. */
    readonly lore: readonly string[];
    /** Выдавать при входе, если у игрока его нет. */
    readonly giveOnJoin: boolean;
    /** Запретить выбрасывать и убирать в сундуки. */
    readonly lockInInventory: boolean;
}

export const DEFAULT_CONFIG: EngineConfig = {
    logLevel: LogLevel.Info,
    broadcastErrorsToAdmins: true,
    welcome: {
        motd: 'Добро пожаловать! Наберите /mc:help, чтобы увидеть доступные команды.',
        giveStarterKit: true,
        starterKit: [
            { item: 'minecraft:bread', amount: 16 },
            { item: 'minecraft:stone_axe', amount: 1 },
            { item: 'minecraft:stone_pickaxe', amount: 1 },
            { item: 'minecraft:torch', amount: 32 },
        ],
        titleDelayTicks: 40,
    },
    deathBeacon: {
        maxReturnsPerDeath: 1,
        sameDimensionOnly: true,
    },
    playtime: {
        tickInterval: 1200,
        rewardMinutes: [30, 60, 120, 240],
        rewardXp: 50,
    },
    combat: {
        showTargetHealth: true,
        lowHealthRatio: 0.3,
        lowHealthCooldownTicks: 100,
    },
    device: {
        itemType: 'minecraft:clock',
        itemName: '§b§lКоммуникатор',
        lore: ['§7Используйте предмет,', '§7чтобы открыть панель сервера'],
        giveOnJoin: true,
        lockInInventory: true,
    },
};

/** Ключ dynamic property мира, хранящий состояние «включена ли механика». */
function mechanicKey(mechanicId: string): string {
    return `mc:mechanic.${mechanicId}.enabled`;
}

/** Прочитать сохранённое состояние механики (по умолчанию — включена). */
export function isMechanicEnabled(mechanicId: string, fallback: boolean): boolean {
    return readBoolean(world, mechanicKey(mechanicId), fallback);
}

/** Сохранить состояние механики так, чтобы оно пережило рестарт сервера. */
export function persistMechanicEnabled(mechanicId: string, enabled: boolean): boolean {
    return write(world, mechanicKey(mechanicId), enabled);
}

/** Переопределение уровня логирования из мира (удобно включить DEBUG в бою). */
export function resolveLogLevel(): LogLevel {
    return readNumber(world, 'mc:log_level', DEFAULT_CONFIG.logLevel) as LogLevel;
}

export function persistLogLevel(level: LogLevel): boolean {
    return write(world, 'mc:log_level', level);
}
