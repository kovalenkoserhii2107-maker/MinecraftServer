import { CommandPermissionLevel, world } from '@minecraft/server';
import { Color, formatMinutes } from '../core/format.js';
import { fail, ok, playerFrom, type MechanicCommand } from '../core/commands.js';
import { defineMechanic, type MechanicContext } from '../core/mechanic.js';
import { increment, readNumber, write } from '../core/storage.js';

const KEY_MINUTES = 'mc:playtime_minutes';
const KEY_REWARD_INDEX = 'mc:playtime_reward_index';
const KEY_DEATH_COUNT = 'mc:death_count';

const statsCommand: MechanicCommand = {
    definition: {
        name: 'mc:stats',
        description: 'Показать ваше время в игре и статистику.',
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
    },
    handler: (origin) => {
        const player = playerFrom(origin);
        if (!player) return fail('Команда доступна только игроку.');

        const minutes = readNumber(player, KEY_MINUTES, 0);
        const deaths = readNumber(player, KEY_DEATH_COUNT, 0);
        return ok(
            `${Color.aqua}${player.name}${Color.gray} — в игре: ${Color.yellow}${formatMinutes(minutes)}` +
                `${Color.gray}, смертей: ${Color.yellow}${deaths}${Color.reset}`,
        );
    },
};

/**
 * Учёт наигранного времени и награды за пороговые значения.
 *
 * Производительность: один интервал на весь сервер, обходим только онлайн-игроков
 * (обычно 2–4 человека) раз в минуту — никаких пер-тиковых обходов сущностей.
 */
export const playtimeRewardsMechanic = defineMechanic({
    id: 'playtime_rewards',
    description: 'Учёт времени в игре и награды за наигранные часы.',
    enabledByDefault: true,
    commands: [statsCommand],

    activate(ctx: MechanicContext): void {
        const config = ctx.config.playtime;
        const thresholds = [...config.rewardMinutes].sort((a, b) => a - b);
        const minutesPerTick = config.tickInterval / 1200;

        ctx.store.runInterval('playtimeTick', config.tickInterval, () => {
            for (const player of world.getAllPlayers()) {
                if (!player.isValid) continue;

                const minutes = increment(player, KEY_MINUTES, minutesPerTick);
                let rewardIndex = readNumber(player, KEY_REWARD_INDEX, 0);

                // Порогов немного (единицы), цикл дешёвый и выполняется раз в минуту.
                while (rewardIndex < thresholds.length && minutes >= (thresholds[rewardIndex] ?? Infinity)) {
                    const threshold = thresholds[rewardIndex] ?? 0;
                    rewardIndex += 1;

                    player.addExperience(config.rewardXp);
                    player.onScreenDisplay.setActionBar(
                        `${Color.gold}Награда за ${formatMinutes(threshold)} в игре: +${config.rewardXp} опыта${Color.reset}`,
                    );
                    player.playSound('random.levelup', { volume: 0.6 });
                    ctx.log.info(`${player.name} получил награду за порог ${threshold} мин.`);
                }

                write(player, KEY_REWARD_INDEX, rewardIndex);
            }
        });
    },
});
