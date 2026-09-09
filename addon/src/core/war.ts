import { GameMode, system, type Player } from '@minecraft/server';
import { Color } from './format.js';
import type { WarConfig } from '../config.js';

/**
 * Война между двумя игроками.
 *
 * Мирное время: игроки не наносят друг другу урона. Объявление войны запускает
 * подготовку, затем боевые действия, после которых всё возвращается как было.
 *
 * Состояние живёт только в памяти. Война длится минуты, а восстанавливать её
 * из половины сохранённых данных после перезапуска сервера опаснее, чем просто
 * закончить: иначе игроки рискуют навсегда остаться в чужом режиме игры.
 */

export type WarPhase = 'preparation' | 'combat';

export interface Combatant {
    readonly id: string;
    readonly name: string;
}

export interface WarState {
    phase: WarPhase;
    readonly attacker: Combatant;
    readonly defender: Combatant;
    /** Тиков до конца текущей фазы. */
    ticksLeft: number;
    /** id игрока -> сколько убийств он совершил. */
    readonly kills: Map<string, number>;
    /** Режим игры до войны, чтобы вернуть его в конце. */
    readonly restoreGameMode: Map<string, GameMode>;
}

let current: WarState | undefined;

export function getWar(): WarState | undefined {
    return current;
}

export interface WarResult {
    readonly ok: boolean;
    readonly message: string;
}

/** Объявление войны. Одновременно идёт не более одной. */
export function declareWar(attacker: Player, defender: Player, config: WarConfig): WarResult {
    if (current) {
        return { ok: false, message: `Война уже идёт: ${current.attacker.name} против ${current.defender.name}.` };
    }
    if (attacker.id === defender.id) {
        return { ok: false, message: 'Нельзя объявить войну самому себе.' };
    }

    current = {
        phase: 'preparation',
        attacker: { id: attacker.id, name: attacker.name },
        defender: { id: defender.id, name: defender.name },
        ticksLeft: config.preparationTicks,
        kills: new Map(),
        restoreGameMode: new Map(),
    };
    return { ok: true, message: `Война объявлена игроку ${defender.name}.` };
}

export type WarTransition = 'combatStarted' | 'warEnded';

/**
 * Продвигает отсчёт. Возвращает переход, если фаза сменилась.
 * Вызывающий сам применяет последствия — смену режима игры и уведомления.
 */
export function advanceWar(ticks: number, config: WarConfig): WarTransition | undefined {
    if (!current) return undefined;

    current.ticksLeft -= ticks;
    if (current.ticksLeft > 0) return undefined;

    if (current.phase === 'preparation') {
        current.phase = 'combat';
        current.ticksLeft = config.combatTicks;
        return 'combatStarted';
    }
    return 'warEnded';
}

/** Идут ли боевые действия именно между этими двумя. */
export function isCombatBetween(firstId: string, secondId: string): boolean {
    if (!current || current.phase !== 'combat') return false;
    const ids = [current.attacker.id, current.defender.id];
    return ids.includes(firstId) && ids.includes(secondId) && firstId !== secondId;
}

export function isCombatant(playerId: string): boolean {
    return current !== undefined && (current.attacker.id === playerId || current.defender.id === playerId);
}

export function recordKill(killerId: string): void {
    if (!current || !isCombatant(killerId)) return;
    current.kills.set(killerId, (current.kills.get(killerId) ?? 0) + 1);
}

export function rememberGameMode(playerId: string, mode: GameMode): void {
    if (!current) return;
    current.restoreGameMode.set(playerId, mode);
}

export function takeRestoreGameMode(playerId: string): GameMode | undefined {
    return current?.restoreGameMode.get(playerId);
}

export interface WarSummary {
    readonly attacker: Combatant;
    readonly defender: Combatant;
    readonly attackerKills: number;
    readonly defenderKills: number;
    /** Победитель или `undefined` при ничьей. */
    readonly winner?: Combatant;
}

export function summarizeWar(): WarSummary | undefined {
    if (!current) return undefined;
    const attackerKills = current.kills.get(current.attacker.id) ?? 0;
    const defenderKills = current.kills.get(current.defender.id) ?? 0;
    return {
        attacker: current.attacker,
        defender: current.defender,
        attackerKills,
        defenderKills,
        winner:
            attackerKills === defenderKills
                ? undefined
                : attackerKills > defenderKills
                  ? current.attacker
                  : current.defender,
    };
}

/** Завершает войну и очищает состояние. */
export function clearWar(): void {
    current = undefined;
}

/** Секунды до конца фазы — для обратного отсчёта на экране. */
export function secondsLeft(): number {
    return current ? Math.max(0, Math.ceil(current.ticksLeft / 20)) : 0;
}

/** «1:59» — формат обратного отсчёта. */
export function formatCountdown(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Заголовок на весь экран — тем же способом, что и приветствие при входе. */
function announce(player: Player, title: string, subtitle: string): void {
    try {
        player.onScreenDisplay.setTitle(title, {
            subtitle,
            fadeInDuration: 10,
            stayDuration: 70,
            fadeOutDuration: 20,
        });
    } catch {
        // Игрок вышел между проверкой и показом — не критично.
    }
}

/** Уведомляет обе стороны о начале подготовки. */
export function announceDeclaration(attacker: Player, defender: Player, config: WarConfig): void {
    const minutes = Math.round(config.preparationTicks / 20 / 60);

    announce(defender, `${Color.red}Вам объявлена война`, `${attacker.name} — ${minutes} мин на подготовку`);
    announce(attacker, `${Color.gold}Война объявлена`, `${defender.name} — ${minutes} мин на подготовку`);

    try {
        defender.playSound('mob.wither.spawn', { volume: 0.6 });
    } catch {
        // Звук не критичен.
    }

    system.run(() => {
        for (const player of [attacker, defender]) {
            if (!player.isValid) continue;
            player.sendMessage(
                `${Color.red}Война: ${Color.yellow}${attacker.name}${Color.gray} против ` +
                    `${Color.yellow}${defender.name}${Color.gray}. Подготовка ${minutes} мин.${Color.reset}`,
            );
        }
    });
}
