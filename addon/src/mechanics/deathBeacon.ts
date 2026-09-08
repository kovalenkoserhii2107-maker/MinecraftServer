import { GameMode, Player, world } from '@minecraft/server';
import { Color, formatCoords, formatDimension, info } from '../core/format.js';
import { defineMechanic, type MechanicContext } from '../core/mechanic.js';
import { clear, increment, write } from '../core/storage.js';

const KEY_DEATH_POS = 'mc:death_pos';
const KEY_DEATH_DIM = 'mc:death_dim';
const KEY_RETURNS_LEFT = 'mc:death_returns_left';
const KEY_DEATH_COUNT = 'mc:death_count';

/**
 * «Маяк смерти»: запоминает место гибели игрока, сообщает координаты
 * и даёт ограниченное число возвратов через `/mc:back`.
 */
export const deathBeaconMechanic = defineMechanic({
    id: 'death_beacon',
    description: 'Координаты места смерти и возврат к ней из панели.',
    enabledByDefault: true,

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
                entity.sendMessage(info('Коммуникатор → Игрок → «Вернуться к месту смерти».'));
            }
            ctx.log.debug(`${entity.name} погиб: ${formatCoords(location)} (${event.damageSource.cause}).`);
        });
    },
});
