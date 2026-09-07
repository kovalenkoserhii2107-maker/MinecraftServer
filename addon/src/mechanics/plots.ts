import {
    CommandPermissionLevel,
    CustomCommandParamType,
    Player,
    system,
    world,
} from '@minecraft/server';
import type { PlotsConfig } from '../config.js';
import { Color, failure, info, success } from '../core/format.js';
import { defer, fail, ok, playerFrom, type MechanicCommand } from '../core/commands.js';
import { canAfford, formatMoney, withdraw } from '../core/economy.js';
import { defineMechanic, type MechanicContext } from '../core/mechanic.js';
import {
    chunkAt,
    chunkBounds,
    chunksForSize,
    clearOwner,
    firstTakenChunk,
    getOwner,
    listOwnedChunks,
    setOwner,
    toChunk,
    type ChunkRef,
} from '../core/plots.js';
import { getRuntime } from '../core/runtime.js';
import { payTo, refreshDisplay } from './economy.js';

const SIZE_ENUM = 'mc:plot_size';
const SIZE_VALUES = ['16x16', '32x32'] as const;

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

function describeChunk(ref: ChunkRef): string {
    const bounds = chunkBounds(ref);
    return `${bounds.minX}..${bounds.maxX} по X, ${bounds.minZ}..${bounds.maxZ} по Z`;
}

const claimCommand: MechanicCommand = {
    definition: {
        name: 'mc:claim',
        description: 'Купить участок под собой: 16x16 или 32x32.',
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
        mandatoryParameters: [{ name: SIZE_ENUM, type: CustomCommandParamType.Enum }],
    },
    enums: { [SIZE_ENUM]: SIZE_VALUES },
    handler: (origin, ...args) => {
        const player = playerFrom(origin);
        if (!player) return fail('Команда доступна только игроку.');

        const runtime = getRuntime();
        if (!runtime) return fail('Движок механик ещё не запущен.');

        const raw = args[0];
        if (typeof raw !== 'string' || !SIZE_VALUES.includes(raw as (typeof SIZE_VALUES)[number])) {
            return fail('Использование: /mc:claim <16x16|32x32>');
        }
        const size = raw === '32x32' ? 32 : 16;

        const result = claim(player, size, runtime.config.plots, runtime.config.economy.currencySymbol);
        return result.okText ? ok(result.okText) : fail(result.failText ?? 'Не удалось купить участок.');
    },
};

interface ClaimResult {
    okText?: string;
    failText?: string;
}

/** Покупка участка. Списание и запись владельца — единой операцией. */
function claim(player: Player, size: 16 | 32, config: PlotsConfig, symbol: string): ClaimResult {
    const here = chunkAt(player.dimension.id, player.location.x, player.location.z);
    const chunks = chunksForSize(here, size);

    const taken = firstTakenChunk(chunks);
    if (taken) {
        const owner = getOwner(taken);
        return {
            failText:
                owner?.id === player.id
                    ? 'Этот участок уже ваш.'
                    : `Участок уже принадлежит игроку ${owner?.name ?? '—'}.`,
        };
    }

    if (config.maxChunksPerPlayer > 0) {
        const owned = listOwnedChunks(player.id).length;
        if (owned + chunks.length > config.maxChunksPerPlayer) {
            return { failText: `Превышен лимит: не больше ${config.maxChunksPerPlayer} чанков во владении.` };
        }
    }

    const cost = size === 32 ? config.cost32 : config.cost16;
    if (!canAfford(player, cost)) {
        return { failText: `Не хватает средств: нужно ${formatMoney(cost, symbol)}.` };
    }

    // Деньги списываем до записи владельца: если запись сорвётся, возвращаем.
    if (!withdraw(player, cost)) {
        return { failText: 'Не удалось списать средства.' };
    }

    const claimed: ChunkRef[] = [];
    for (const chunk of chunks) {
        if (setOwner(chunk, { id: player.id, name: player.name })) {
            claimed.push(chunk);
        } else {
            // Откатываем частичную покупку целиком — половина участка бесполезна.
            for (const done of claimed) clearOwner(done);
            payTo(player, cost);
            return { failText: 'Хранилище мира отказало в записи, средства возвращены.' };
        }
    }

    refreshDisplay(player);
    const area = size === 32 ? '32×32' : '16×16';
    return {
        okText: `Участок ${area} куплен за ${formatMoney(cost, symbol)}. Границы: ${describeChunk(chunks[0]!)}.`,
    };
}

const unclaimCommand: MechanicCommand = {
    definition: {
        name: 'mc:unclaim',
        description: 'Отказаться от участка под собой и вернуть часть средств.',
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
    },
    handler: (origin) => {
        const player = playerFrom(origin);
        if (!player) return fail('Команда доступна только игроку.');

        const runtime = getRuntime();
        if (!runtime) return fail('Движок механик ещё не запущен.');

        const here = chunkAt(player.dimension.id, player.location.x, player.location.z);
        const owner = getOwner(here);
        if (!owner) return fail('Здесь нет участка.');
        if (owner.id !== player.id) return fail(`Участок принадлежит игроку ${owner.name}.`);

        const config = runtime.config.plots;
        const symbol = runtime.config.economy.currencySymbol;
        const refund = Math.floor(config.cost16 * config.refundRatio);

        defer(runtime.log, 'plots:unclaim', () => {
            clearOwner(here);
            payTo(player, refund);
            player.sendMessage(success(`Участок продан. Возвращено ${formatMoney(refund, symbol)}.`));
        });
        return ok('Оформляем продажу...');
    },
};

const plotInfoCommand: MechanicCommand = {
    definition: {
        name: 'mc:plotinfo',
        description: 'Чей участок под вами.',
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
    },
    handler: (origin) => {
        const player = playerFrom(origin);
        if (!player) return fail('Команда доступна только игроку.');

        const here = chunkAt(player.dimension.id, player.location.x, player.location.z);
        const owner = getOwner(here);
        return ok(
            owner
                ? `${Color.gray}Владелец: ${Color.yellow}${owner.name}${Color.gray}. Границы: ${describeChunk(here)}.${Color.reset}`
                : `${Color.gray}Земля ничейная. Границы будущего участка: ${describeChunk(here)}.${Color.reset}`,
        );
    },
};

/**
 * Частная собственность на участки.
 *
 * На чужом участке нельзя ни ломать, ни ставить блоки, ни взаимодействовать с
 * ними. Владелец получает налоговые поступления со своих чанков.
 */
export const plotsMechanic = defineMechanic({
    id: 'plots',
    description: 'Участки 16×16 и 32×32: покупка, защита от чужих, налоги.',
    enabledByDefault: true,
    commands: [claimCommand, unclaimCommand, plotInfoCommand],

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

        ctx.store.subscribe(world.afterEvents.playerLeave, 'playerLeave', (event) => {
            lastWarning.delete(event.playerId);
        });
        ctx.store.add(() => lastWarning.clear());
    },
});

/** Текстовая карта участков вокруг игрока — используется панелью. */
export function renderPlotMap(player: Player, radius: number): string {
    const centerX = toChunk(player.location.x);
    const centerZ = toChunk(player.location.z);
    const dimensionId = player.dimension.id;
    const rows: string[] = [];

    for (let dz = -radius; dz <= radius; dz++) {
        let row = '';
        for (let dx = -radius; dx <= radius; dx++) {
            const owner = getOwner({ dimensionId, cx: centerX + dx, cz: centerZ + dz });
            const isHere = dx === 0 && dz === 0;
            if (isHere) {
                row += owner?.id === player.id ? `${Color.green}▣` : owner ? `${Color.red}▣` : `${Color.yellow}▣`;
            } else if (!owner) {
                row += `${Color.darkGray}░`;
            } else if (owner.id === player.id) {
                row += `${Color.green}█`;
            } else {
                row += `${Color.red}█`;
            }
        }
        rows.push(row + Color.reset);
    }

    return rows.join('\n');
}
