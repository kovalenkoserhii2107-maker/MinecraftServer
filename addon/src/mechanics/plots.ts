import { Player, system, world } from '@minecraft/server';
import { failure, info } from '../core/format.js';
import { formatMoney, payTo } from '../core/economy.js';
import { defineMechanic, type MechanicContext } from '../core/mechanic.js';
import { chunkAt, getOwner, listOwnedChunks, chunkOutline } from '../core/plots.js';


/** Отказы приходят пачками (зажатая кнопка) — не спамим чат. */
const WARN_COOLDOWN_TICKS = 40;
const lastWarning = new Map<string, number>();

function warnForeign(player: Player, owner: string): void {
    const previous = lastWarning.get(player.id) ?? Number.NEGATIVE_INFINITY;
    if (system.currentTick - previous < WARN_COOLDOWN_TICKS) return;
    lastWarning.set(player.id, system.currentTick);

    // Обработчики before-событий работают в read-only режиме: сообщение
    // отправляем следующим тиком.
    system.run(() => {
        if (player.isValid) {
            player.sendMessage(failure(`Это частная собственность: ${owner}.`));
        }
    });
}

/**
 * Может ли игрок изменять блок в этой точке.
 * Ничейная земля доступна всем — ограничиваем только чужие участки.
 */
function mayModify(player: Player, dimensionId: string, x: number, z: number): boolean {
    const owner = getOwner(chunkAt(dimensionId, x, z));
    if (!owner) return true;
    if (owner.id === player.id) return true;
    warnForeign(player, owner.name);
    return false;
}

/**
 * Частная собственность на участки.
 *
 * На чужом участке нельзя ни ломать, ни ставить блоки, ни взаимодействовать с
 * ними. Владелец получает налоговые поступления со своих чанков.
 */
export const plotsMechanic = defineMechanic({
    id: 'plots',
    description: 'Участки 16×16 и 32×32: защита от чужих и налоги владельцу.',
    enabledByDefault: true,

    activate(ctx: MechanicContext): void {
        const config = ctx.config.plots;

        ctx.store.subscribe(world.beforeEvents.playerBreakBlock, 'breakBlock', (event) => {
            const block = event.block;
            if (!mayModify(event.player, block.dimension.id, block.x, block.z)) {
                event.cancel = true;
            }
        });

        // В стабильном API нет before-события установки блока, поэтому ставим
        // защиту на взаимодействие с блоком — установка проходит через него.
        // Заодно закрываются сундуки, двери и кнопки на чужом участке.
        ctx.store.subscribe(world.beforeEvents.playerInteractWithBlock, 'interactBlock', (event) => {
            if (!event.isFirstEvent) return;
            const block = event.block;
            if (!mayModify(event.player, block.dimension.id, block.x, block.z)) {
                event.cancel = true;
            }
        });

        // Подстраховка для края участка: игрок мог кликнуть по блоку снаружи, а
        // поставить внутрь — тогда взаимодействие было законным, а результат нет.
        ctx.store.subscribe(world.afterEvents.playerPlaceBlock, 'placeBlock', (event) => {
            const block = event.block;
            const owner = getOwner(chunkAt(block.dimension.id, block.x, block.z));
            if (!owner || owner.id === event.player.id) return;

            system.run(() => {
                try {
                    block.setType('minecraft:air');
                } catch (error) {
                    ctx.log.warn('Не удалось снять блок с чужого участка:', error);
                }
            });
            warnForeign(event.player, owner.name);
        });

        if (config.taxPerChunk > 0) {
            ctx.store.runInterval('plotTaxes', config.taxIntervalTicks, () => {
                const symbol = ctx.config.economy.currencySymbol;
                for (const player of world.getAllPlayers()) {
                    if (!player.isValid) continue;
                    const chunks = listOwnedChunks(player.id).length;
                    if (chunks === 0) continue;

                    const income = chunks * config.taxPerChunk;
                    payTo(player, income);
                    player.sendMessage(
                        info(`Налоги с ${chunks} чанк(ов): +${formatMoney(income, symbol)}.`),
                    );
                }
            });
        }

        ctx.store.runInterval('plotBorders', 15, () => {
            for (const player of world.getAllPlayers()) {
                if (!player.isValid) continue;
                if (player.getDynamicProperty('mc:show_plot_borders') !== true) continue;

                const center = chunkAt(player.dimension.id, player.location.x, player.location.z);
                const baseHeight = player.location.y + 0.1;
                
                // Проверяем чанки вокруг игрока (радиус 1)
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dz = -1; dz <= 1; dz++) {
                        const ref = { dimensionId: center.dimensionId, cx: center.cx + dx, cz: center.cz + dz };
                        const owner = getOwner(ref);
                        if (!owner) continue;

                        const isMine = owner.id === player.id;
                        const particle = isMine ? 'minecraft:villager_happy' : 'minecraft:basic_flame_particle';

                        // Получаем владельцев соседних чанков
                        const nOwner = getOwner({ dimensionId: ref.dimensionId, cx: ref.cx, cz: ref.cz - 1 });
                        const sOwner = getOwner({ dimensionId: ref.dimensionId, cx: ref.cx, cz: ref.cz + 1 });
                        const eOwner = getOwner({ dimensionId: ref.dimensionId, cx: ref.cx + 1, cz: ref.cz });
                        const wOwner = getOwner({ dimensionId: ref.dimensionId, cx: ref.cx - 1, cz: ref.cz });

                        // Функция вычисления высоты для грани (своя грань поднимается, если сосед - чужой)
                        // Но пользователь просил: "Свои обозначения ниже, а над ними чужие"
                        // Значит, если мы рисуем СВОЙ чанк (isMine), высота базовая.
                        // Если мы рисуем ЧУЖОЙ чанк (!isMine), и он граничит со СВОИМ (neighbor is mine), высота должна быть выше (baseHeight + 1.0).
                        const getHeight = (neighborOwner: typeof nOwner) => {
                            if (!isMine && neighborOwner && neighborOwner.id === player.id) {
                                return baseHeight + 1.0;
                            }
                            return baseHeight;
                        };

                        // Флаги видимости граней:
                        // Не рисуем, если сосед принадлежит ТОМУ ЖЕ владельцу
                        const edges = {
                            north: nOwner?.id !== owner.id,
                            south: sOwner?.id !== owner.id,
                            east:  eOwner?.id !== owner.id,
                            west:  wOwner?.id !== owner.id,
                        };

                        // Отрисовываем каждую грань отдельно, если у неё может быть своя высота
                        const drawEdge = (flag: boolean, height: number, singleEdge: typeof edges) => {
                            if (!flag) return;
                            const points = chunkOutline(ref, height, 0.5, singleEdge);
                            for (const point of points) {
                                try {
                                    player.spawnParticle(particle, point);
                                } catch {
                                    // вне прогрузки
                                }
                            }
                        };

                        drawEdge(edges.north, getHeight(nOwner), { north: true, south: false, east: false, west: false });
                        drawEdge(edges.south, getHeight(sOwner), { north: false, south: true, east: false, west: false });
                        drawEdge(edges.east,  getHeight(eOwner), { north: false, south: false, east: true, west: false });
                        drawEdge(edges.west,  getHeight(wOwner), { north: false, south: false, east: false, west: true });
                    }
                }
            }
        });

        ctx.store.subscribe(world.afterEvents.playerLeave, 'playerLeave', (event) => {
            lastWarning.delete(event.playerId);
        });
        ctx.store.add(() => lastWarning.clear());
    },
});

