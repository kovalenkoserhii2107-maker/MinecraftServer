import { GameMode, Player, world } from '@minecraft/server';
import { Color } from '../core/format.js';
import { defineMechanic, type MechanicContext } from '../core/mechanic.js';
import { chunkAt, getOwner } from '../core/plots.js';
import {
    advanceWar,
    clearWar,
    formatCountdown,
    getWar,
    isCombatBetween,
    isCombatant,
    recordKill,
    rememberGameMode,
    secondsLeft,
    summarizeWar,
    takeRestoreGameMode,
    type WarState,
} from '../core/war.js';

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

function eachCombatant(war: WarState, action: (player: Player) => void): void {
    for (const player of world.getAllPlayers()) {
        if (!player.isValid) continue;
        if (player.id === war.attacker.id || player.id === war.defender.id) action(player);
    }
}

/**
 * Война между игроками.
 *
 * В мирное время игроки не наносят друг другу урона. Война объявляется из
 * панели, после двух минут подготовки защита снимается ровно между этими двумя
 * на время боя, а затем всё возвращается как было.
 */
export const warMechanic = defineMechanic({
    id: 'war',
    description: 'PvP-защита и войны: объявление, подготовка, бой и итоги.',
    enabledByDefault: true,

    activate(ctx: MechanicContext): void {
        const config = ctx.config.war;

        // --- защита игроков от урона ---
        ctx.store.subscribe(world.beforeEvents.entityHurt, 'entityHurt', (event) => {
            const victim = event.hurtEntity;
            // Для снаряда damagingEntity — стрелявший, поэтому оружие тоже сюда попадает.
            const attacker = event.damageSource.damagingEntity;
            if (!(victim instanceof Player) || !(attacker instanceof Player)) return;
            if (victim.id === attacker.id) return;

            if (!isCombatBetween(attacker.id, victim.id)) {
                event.cancel = true;
            }
        });

        // --- защита участков от взрывов ---
        ctx.store.subscribe(world.beforeEvents.explosion, 'explosion', (event) => {
            if (config.allowBlockDamage) return;

            const source = event.source;
            const ownerId = source instanceof Player ? source.id : undefined;
            const dimensionId = event.dimension.id;

            const impacted = event.getImpactedBlocks();
            // Взрыв остаётся видимым, но не ломает чужое: убираем защищённые блоки
            // из списка вместо отмены всего события.
            const allowed = impacted.filter((block) => {
                const owner = getOwner(chunkAt(dimensionId, block.x, block.z));
                return !owner || owner.id === ownerId;
            });

            if (allowed.length !== impacted.length) {
                event.setImpactedBlocks(allowed);
                ctx.log.debug(`Взрыв: защищено блоков ${impacted.length - allowed.length}.`);
            }
        });

        // --- счёт убийств ---
        ctx.store.subscribe(world.afterEvents.entityDie, 'entityDie', (event) => {
            const victim = event.deadEntity;
            const killer = event.damageSource.damagingEntity;
            if (!(victim instanceof Player) || !(killer instanceof Player)) return;
            if (!isCombatBetween(killer.id, victim.id)) return;

            recordKill(killer.id);
            const war = getWar();
            if (!war) return;
            eachCombatant(war, (player) => {
                player.sendMessage(`${Color.red}${killer.name}${Color.gray} убил ${Color.red}${victim.name}${Color.reset}`);
            });
        });

        // --- война прекращается, если участник вышел ---
        ctx.store.subscribe(world.afterEvents.playerLeave, 'playerLeave', (event) => {
            if (!isCombatant(event.playerId)) return;
            const war = getWar();
            if (!war) return;

            ctx.log.info(`Война прервана: ${event.playerName} вышел из игры.`);
            restoreGameModes();
            eachCombatant(war, (player) => {
                announce(player, `${Color.yellow}Война прервана`, `${event.playerName} покинул сервер`);
                clearCountdown(player);
            });
            clearWar();
        });

        // --- обратный отсчёт и смена фаз ---
        ctx.store.runInterval('warCountdown', config.countdownIntervalTicks, () => {
            const war = getWar();
            if (!war) return;

            const transition = advanceWar(config.countdownIntervalTicks, config);

            if (transition === 'combatStarted') {
                startCombat(war, ctx);
                return;
            }
            if (transition === 'warEnded') {
                finishWar(war, ctx);
                return;
            }

            const seconds = secondsLeft();
            const label = war.phase === 'preparation' ? 'До боя' : 'Бой';
            eachCombatant(war, (player) => {
                player.onScreenDisplay.setTitle(' ', {
                    subtitle: `${Color.gray}${label}  ${Color.red}${Color.bold}${formatCountdown(seconds)}${Color.reset}`,
                    fadeInDuration: 0,
                    stayDuration: 25,
                    fadeOutDuration: 0,
                });
            });
        });

        ctx.store.add(() => {
            // Механику могли выключить посреди войны — не оставляем игроков
            // в чужом режиме игры.
            const war = getWar();
            if (!war) return;
            restoreGameModes();
            clearWar();
        });
    },
});

function clearCountdown(player: Player): void {
    try {
        player.onScreenDisplay.setTitle(' ', { subtitle: ' ', stayDuration: 0, fadeInDuration: 0, fadeOutDuration: 0 });
    } catch {
        // Игрок уже вышел.
    }
}

function startCombat(war: WarState, ctx: MechanicContext): void {
    eachCombatant(war, (player) => {
        // Запоминаем режим до боя: обычно игроки в творческом и неуязвимы.
        rememberGameMode(player.id, player.getGameMode());
        try {
            player.setGameMode(GameMode.Survival);
        } catch (error) {
            ctx.log.warn(`Не удалось перевести ${player.name} в выживание:`, error);
        }
        announce(player, `${Color.red}Бой начался`, `${war.attacker.name} против ${war.defender.name}`);
        player.playSound('random.anvil_land', { volume: 0.7 });
    });
    ctx.log.info(`Бой: ${war.attacker.name} против ${war.defender.name}.`);
}

function restoreGameModes(): void {
    for (const player of world.getAllPlayers()) {
        if (!player.isValid) continue;
        const mode = takeRestoreGameMode(player.id);
        if (!mode) continue;
        try {
            player.setGameMode(mode);
        } catch {
            // Режим вернуть не удалось — сообщение об этом уйдёт в лог выше.
        }
    }
}

function finishWar(war: WarState, ctx: MechanicContext): void {
    const summary = summarizeWar();
    restoreGameModes();

    const outcome = !summary
        ? 'Итоги недоступны'
        : summary.winner
          ? `Победил ${summary.winner.name}`
          : 'Ничья';

    const scoreline = summary
        ? `${summary.attacker.name} ${summary.attackerKills} : ${summary.defenderKills} ${summary.defender.name}`
        : '';

    eachCombatant(war, (player) => {
        clearCountdown(player);
        announce(player, `${Color.green}Война окончена`, outcome);
        player.sendMessage(
            `${Color.gray}Итоги боя: ${Color.yellow}${scoreline}${Color.gray}. ${outcome}.${Color.reset}\n` +
                `${Color.gray}Защита от урона возобновлена.${Color.reset}`,
        );
    });

    ctx.log.info(`Война окончена: ${scoreline}. ${outcome}.`);
    clearWar();
}
