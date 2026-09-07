import { CommandPermissionLevel, GameMode, Player, world } from '@minecraft/server';
import { Color, failure, formatCoords, formatDimension, info, success } from '../core/format.js';
import { defer, fail, ok, playerFrom, type MechanicCommand } from '../core/commands.js';
import { defineMechanic, type MechanicContext } from '../core/mechanic.js';
import { getRuntime } from '../core/runtime.js';
import { clear, increment, readNumber, readString, readVector, write } from '../core/storage.js';

const KEY_DEATH_POS = 'mc:death_pos';
const KEY_DEATH_DIM = 'mc:death_dim';
const KEY_RETURNS_LEFT = 'mc:death_returns_left';
const KEY_DEATH_COUNT = 'mc:death_count';

interface DeathPoint {
    readonly location: { x: number; y: number; z: number };
    readonly dimensionId: string;
    readonly returnsLeft: number;
}

function readDeathPoint(player: Player): DeathPoint | undefined {
    const location = readVector(player, KEY_DEATH_POS);
    const dimensionId = readString(player, KEY_DEATH_DIM, '');
    if (!location || dimensionId === '') return undefined;
    return { location, dimensionId, returnsLeft: readNumber(player, KEY_RETURNS_LEFT, 0) };
}

const backCommand: MechanicCommand = {
    definition: {
        name: 'mc:back',
        description: 'Вернуться к месту последней смерти.',
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
    },
    handler: (origin) => {
        const player = playerFrom(origin);
        if (!player) return fail('Команда доступна только игроку.');

        const runtime = getRuntime();
        if (!runtime) return fail('Движок механик ещё не запущен.');

        const point = readDeathPoint(player);
        if (!point) return fail('Точка смерти не найдена — вы ещё не погибали.');
        if (point.returnsLeft <= 0) return fail('Возвраты к этой точке смерти исчерпаны.');

        const config = runtime.config.deathBeacon;
        if (config.sameDimensionOnly && player.dimension.id !== point.dimensionId) {
            return fail(
                `Точка смерти находится в другом измерении: ${formatDimension(point.dimensionId)}.`,
            );
        }

        // Телепорт — мутация мира, в read-only обработчике команды выполнять нельзя.
        defer(runtime.log, 'deathBeacon:back', () => {
            if (!player.isValid) return;
            try {
                player.teleport(point.location, { dimension: world.getDimension(point.dimensionId) });
                write(player, KEY_RETURNS_LEFT, point.returnsLeft - 1);
                player.sendMessage(success(`Вы вернулись к точке смерти (${formatCoords(point.location)}).`));
            } catch (error) {
                runtime.log.error('Телепорт к точке смерти не удался:', error);
                player.sendMessage(failure('Не удалось телепортироваться — точка недоступна.'));
            }
        });
        return ok('Телепортация...');
    },
};

const deathPointCommand: MechanicCommand = {
    definition: {
        name: 'mc:deathpoint',
        description: 'Показать координаты последней смерти.',
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
    },
    handler: (origin) => {
        const player = playerFrom(origin);
        if (!player) return fail('Команда доступна только игроку.');

        const point = readDeathPoint(player);
        if (!point) return fail('Точка смерти не найдена — вы ещё не погибали.');

        return ok(
            `${Color.gray}Последняя смерть: ${Color.yellow}${formatCoords(point.location)}` +
                `${Color.gray} (${formatDimension(point.dimensionId)}), возвратов осталось: ` +
                `${Color.yellow}${point.returnsLeft}${Color.reset}`,
        );
    },
};

/**
 * «Маяк смерти»: запоминает место гибели игрока, сообщает координаты
 * и даёт ограниченное число возвратов через `/mc:back`.
 */
export const deathBeaconMechanic = defineMechanic({
    id: 'death_beacon',
    description: 'Координаты места смерти и ограниченный возврат через /mc:back.',
    enabledByDefault: true,
    commands: [backCommand, deathPointCommand],

    activate(ctx: MechanicContext): void {
        const config = ctx.config.deathBeacon;

        ctx.store.subscribe(world.afterEvents.entityDie, 'entityDie', (event) => {
            const entity = event.deadEntity;
            if (!(entity instanceof Player)) return;
            // В творческом/наблюдателе смерть — не игровое событие, точку не пишем.
            if (entity.getGameMode() === GameMode.Creative || entity.getGameMode() === GameMode.Spectator) {
                return;
            }

            const location = { x: entity.location.x, y: entity.location.y, z: entity.location.z };
            const stored =
                write(entity, KEY_DEATH_POS, location) &&
                write(entity, KEY_DEATH_DIM, entity.dimension.id) &&
                write(entity, KEY_RETURNS_LEFT, config.maxReturnsPerDeath);

            const deaths = increment(entity, KEY_DEATH_COUNT);

            if (!stored) {
                // Лимит dynamic properties исчерпан — чистим, чтобы не оставить полузапись.
                clear(entity, KEY_DEATH_POS);
                clear(entity, KEY_DEATH_DIM);
                ctx.log.warn(`Не удалось сохранить точку смерти для ${entity.name}.`);
                return;
            }

            entity.sendMessage(
                info(
                    `Вы погибли на ${Color.yellow}${formatCoords(location)}${Color.white} ` +
                        `(${formatDimension(entity.dimension.id)}). Смертей всего: ${deaths}.`,
                ),
            );
            if (config.maxReturnsPerDeath > 0) {
                entity.sendMessage(info('Команда /mc:back вернёт вас на это место.'));
            }
            ctx.log.debug(`${entity.name} погиб: ${formatCoords(location)} (${event.damageSource.cause}).`);
        });
    },
});
