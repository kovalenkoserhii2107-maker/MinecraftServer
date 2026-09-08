import {
    CommandPermissionLevel,
    CustomCommandParamType,
    Player,
    StructureSaveMode,
    system,
    world,
    type Vector3,
} from '@minecraft/server';
import { ActionFormData, FormCancelationReason } from '@minecraft/server-ui';
import type { BlueprintsConfig } from '../config.js';
import { Color, failure, info, success } from '../core/format.js';
import { defer, fail, ok, playerFrom, type MechanicCommand } from '../core/commands.js';
import {
    deleteBlueprint,
    getBlueprint,
    listBlueprints,
    saveBlueprint,
    slugify,
    structureIdFor,
    type Blueprint,
} from '../core/blueprints.js';
import { canAfford, formatMoney, withdraw } from '../core/economy.js';
import { ensureMarked, heldItem, isMarked, type MarkedItemSpec } from '../core/markedItem.js';
import { defineMechanic, type MechanicContext } from '../core/mechanic.js';
import { chunkAt, getOwner } from '../core/plots.js';
import { getRuntime } from '../core/runtime.js';
import { readString, readVector, write } from '../core/storage.js';
import { refreshDisplay } from './economy.js';

const KEY_BLUEPRINT = 'mc:blueprint';
const KEY_SELECTED = 'mc:bp_selected';
const KEY_CORNER_A = 'mc:bp_corner_a';
const KEY_CORNER_B = 'mc:bp_corner_b';

export function blueprintItemSpec(config: BlueprintsConfig): MarkedItemSpec {
    return {
        key: KEY_BLUEPRINT,
        itemType: config.itemType,
        itemName: config.itemName,
        lore: config.lore,
        // Чертёж — расходник по смыслу, но терять его при смерти незачем;
        // блокировать инвентарь не надо, пусть кладут в сундук.
        lockInInventory: false,
    };
}


/** Клиент отвечает UserBusy, пока открыт другой интерфейс. Ждём, но не вечно. */
async function showFormWhenReady(form: ActionFormData, player: Player, log: MechanicContext['log']) {
    for (let attempt = 0; attempt < 10; attempt++) {
        if (!player.isValid) return undefined;
        const response = await form.show(player);
        if (response.cancelationReason !== FormCancelationReason.UserBusy) return response;
        await system.waitTicks(10);
    }
    log.warn(`Не удалось открыть меню чертежей для ${player.name}: интерфейс занят.`);
    return undefined;
}

export interface BoundingBox {
    readonly min: Vector3;
    readonly max: Vector3;
}

/** Габарит постройки от точки установки: структура растёт вверх и на +X/+Z. */
export function boxAt(origin: Vector3, blueprint: Blueprint): BoundingBox {
    return {
        min: origin,
        max: {
            x: origin.x + blueprint.sizeX - 1,
            y: origin.y + blueprint.sizeY - 1,
            z: origin.z + blueprint.sizeZ - 1,
        },
    };
}

/**
 * Куда встанет постройка, если игрок смотрит на блок.
 * Origin — блок, примыкающий к грани, по которой пришёлся луч.
 */
export function targetOrigin(player: Player, distance: number): Vector3 | undefined {
    const hit = player.getBlockFromViewDirection({ maxDistance: distance });
    if (!hit) return undefined;

    const block = hit.block;
    switch (hit.face) {
        case 'Up':
            return { x: block.x, y: block.y + 1, z: block.z };
        case 'Down':
            return { x: block.x, y: block.y - 1, z: block.z };
        case 'North':
            return { x: block.x, y: block.y, z: block.z - 1 };
        case 'South':
            return { x: block.x, y: block.y, z: block.z + 1 };
        case 'West':
            return { x: block.x - 1, y: block.y, z: block.z };
        case 'East':
            return { x: block.x + 1, y: block.y, z: block.z };
        default:
            return { x: block.x, y: block.y + 1, z: block.z };
    }
}

/**
 * Точки рёбер габаритного контейнера.
 *
 * Рисуем только 12 рёбер, а не заливку, и прореживаем шаг так, чтобы уложиться
 * в лимит частиц: голограмма обновляется несколько раз в секунду и не должна
 * утяжелять тик.
 */
export function boxOutline(box: BoundingBox, maxPoints: number): Vector3[] {
    const { min, max } = box;
    const spanX = max.x - min.x;
    const spanY = max.y - min.y;
    const spanZ = max.z - min.z;
    const edgeLength = (spanX + spanY + spanZ) * 4 + 12;
    const step = Math.max(1, Math.ceil(edgeLength / Math.max(1, maxPoints)));

    const points: Vector3[] = [];
    const push = (x: number, y: number, z: number) => {
        points.push({ x: x + 0.5, y: y + 0.5, z: z + 0.5 });
    };

    for (const y of [min.y, max.y]) {
        for (let x = min.x; x <= max.x; x += step) {
            push(x, y, min.z);
            push(x, y, max.z);
        }
        for (let z = min.z; z <= max.z; z += step) {
            push(min.x, y, z);
            push(max.x, y, z);
        }
    }
    for (let y = min.y; y <= max.y; y += step) {
        push(min.x, y, min.z);
        push(max.x, y, min.z);
        push(min.x, y, max.z);
        push(max.x, y, max.z);
    }
    return points;
}

export interface PlotCheck {
    readonly allowed: boolean;
    readonly reason?: string;
}

/**
 * Помещается ли габарит в собственный участок игрока.
 * Проверяются все чанки, которые задевает контур, включая крайние.
 */
export function checkPlot(player: Player, box: BoundingBox, config: BlueprintsConfig): PlotCheck {
    const dimensionId = player.dimension.id;
    const from = chunkAt(dimensionId, box.min.x, box.min.z);
    const to = chunkAt(dimensionId, box.max.x, box.max.z);

    for (let cx = from.cx; cx <= to.cx; cx++) {
        for (let cz = from.cz; cz <= to.cz; cz++) {
            const owner = getOwner({ dimensionId, cx, cz });
            if (owner && owner.id !== player.id) {
                return { allowed: false, reason: `Габарит задевает участок игрока ${owner.name}.` };
            }
            if (!owner && config.requireOwnPlot) {
                return { allowed: false, reason: 'Габарит выходит за пределы вашего участка.' };
            }
        }
    }
    return { allowed: true };
}

function cornersOf(player: Player): { a?: Vector3; b?: Vector3 } {
    return { a: readVector(player, KEY_CORNER_A), b: readVector(player, KEY_CORNER_B) };
}

const blueprintCommand: MechanicCommand = {
    definition: {
        name: 'mc:blueprint',
        description: 'Получить чертёж для строительства типовых зданий.',
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
    },
    handler: (origin) => {
        const player = playerFrom(origin);
        if (!player) return fail('Команда доступна только игроку.');
        const runtime = getRuntime();
        if (!runtime) return fail('Движок механик ещё не запущен.');

        defer(runtime.log, 'blueprints:give', () => {
            if (!player.isValid) return;
            if (ensureMarked(player, blueprintItemSpec(runtime.config.blueprints))) {
                player.sendMessage(success('Чертёж выдан. Возьмите его в руку и смотрите на место постройки.'));
            } else {
                player.sendMessage(failure('Освободите слот в инвентаре и повторите /mc:blueprint.'));
            }
        });
        return ok();
    },
};

const saveCommand: MechanicCommand = {
    definition: {
        name: 'mc:bpsave',
        description: 'Сохранить постройку между двумя отмеченными углами как чертёж.',
        permissionLevel: CommandPermissionLevel.Admin,
        cheatsRequired: false,
        mandatoryParameters: [
            { name: 'name', type: CustomCommandParamType.String },
            { name: 'price', type: CustomCommandParamType.Integer },
        ],
    },
    handler: (origin, ...args) => {
        const player = playerFrom(origin);
        if (!player) return fail('Команда доступна только игроку.');
        const runtime = getRuntime();
        if (!runtime) return fail('Движок механик ещё не запущен.');

        const [nameRaw, priceRaw] = args;
        if (typeof nameRaw !== 'string' || typeof priceRaw !== 'number') {
            return fail('Использование: /mc:bpsave <название> <цена>');
        }

        const { a, b } = cornersOf(player);
        if (!a || !b) {
            return fail('Отметьте два угла: приседая, нажмите «Использовать» чертежом по двум блокам.');
        }

        const config = runtime.config.blueprints;
        const min = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) };
        const max = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) };
        const size = { x: max.x - min.x + 1, y: max.y - min.y + 1, z: max.z - min.z + 1 };

        if (size.x > config.maxSize || size.y > config.maxSize || size.z > config.maxSize) {
            return fail(`Слишком большая область: сторона не должна превышать ${config.maxSize} блоков.`);
        }

        const id = slugify(nameRaw);
        if (getBlueprint(id)) return fail(`Чертёж «${nameRaw}» уже существует.`);

        // Снятие структуры читает мир — выполняем вне read-only режима команды.
        defer(runtime.log, 'blueprints:save', () => {
            const structureId = structureIdFor(id);
            try {
                world.structureManager.createFromWorld(structureId, player.dimension, min, max, {
                    saveMode: StructureSaveMode.World,
                    includeEntities: false,
                });
            } catch (error) {
                runtime.log.error('Не удалось снять структуру:', error);
                player.sendMessage(failure('Не удалось сохранить структуру — подробности в логе сервера.'));
                return;
            }

            const blueprint: Blueprint = {
                id,
                name: nameRaw,
                structureId,
                sizeX: size.x,
                sizeY: size.y,
                sizeZ: size.z,
                price: Math.max(0, Math.floor(priceRaw)),
            };
            if (!saveBlueprint(blueprint)) {
                world.structureManager.delete(structureId);
                player.sendMessage(failure('Хранилище мира отказало в записи чертежа.'));
                return;
            }
            player.sendMessage(
                success(`Чертёж «${nameRaw}» сохранён: ${size.x}×${size.y}×${size.z}, цена ${blueprint.price}.`),
            );
        });
        return ok('Сохраняем чертёж...');
    },
};

const listCommand: MechanicCommand = {
    definition: {
        name: 'mc:bplist',
        description: 'Список доступных чертежей.',
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
    },
    handler: () => {
        const runtime = getRuntime();
        if (!runtime) return fail('Движок механик ещё не запущен.');

        const blueprints = listBlueprints();
        if (blueprints.length === 0) {
            return ok('Чертежей пока нет. Оператор создаёт их командой /mc:bpsave.');
        }
        const symbol = runtime.config.economy.currencySymbol;
        return ok(
            blueprints
                .map(
                    (bp) =>
                        `${Color.yellow}${bp.name}${Color.gray} — ${bp.sizeX}×${bp.sizeY}×${bp.sizeZ}, ` +
                        `${formatMoney(bp.price, symbol)}${Color.reset}`,
                )
                .join('\n'),
        );
    },
};

const deleteCommand: MechanicCommand = {
    definition: {
        name: 'mc:bpdelete',
        description: 'Удалить чертёж.',
        permissionLevel: CommandPermissionLevel.Admin,
        cheatsRequired: false,
        mandatoryParameters: [{ name: 'name', type: CustomCommandParamType.String }],
    },
    handler: (_origin, ...args) => {
        const runtime = getRuntime();
        if (!runtime) return fail('Движок механик ещё не запущен.');
        const nameRaw = args[0];
        if (typeof nameRaw !== 'string') return fail('Использование: /mc:bpdelete <название>');

        const id = slugify(nameRaw);
        const blueprint = getBlueprint(id);
        if (!blueprint) return fail(`Чертёж «${nameRaw}» не найден.`);

        defer(runtime.log, 'blueprints:delete', () => {
            try {
                world.structureManager.delete(blueprint.structureId);
            } catch {
                // Структуры могло уже не быть — карточку всё равно убираем.
            }
            deleteBlueprint(id);
        });
        return ok(`Чертёж «${blueprint.name}» удалён.`);
    },
};

/**
 * Строительство типовых зданий.
 *
 * Игрок держит чертёж, смотрит на место — контур из частиц показывает габарит
 * будущей постройки. Использование предмета открывает выбор здания и списывает
 * стоимость. Строить можно только в границах собственного участка.
 */
export const blueprintsMechanic = defineMechanic({
    id: 'blueprints',
    description: 'Чертежи: голограмма габарита и постройка типовых зданий.',
    enabledByDefault: true,
    commands: [blueprintCommand, saveCommand, listCommand, deleteCommand],

    activate(ctx: MechanicContext): void {
        const config = ctx.config.blueprints;

        ctx.store.subscribe(world.afterEvents.itemUse, 'itemUse', (event) => {
            if (!isMarked(event.itemStack, KEY_BLUEPRINT)) return;
            const runtime = getRuntime();
            if (!runtime) return;

            const player = event.source;
            // Присед + использование — режим разметки углов для оператора.
            if (player.isSneaking) {
                markCorner(player, config, ctx.log);
                return;
            }
            void openBlueprintMenu(player, runtime.config.blueprints, runtime.config.economy.currencySymbol).catch(
                (error: unknown) => ctx.log.error('Ошибка меню чертежей:', error),
            );
        });

        // Голограмма: только для тех, кто реально держит чертёж в руке.
        ctx.store.runInterval('blueprintHologram', config.hologramIntervalTicks, () => {
            for (const player of world.getAllPlayers()) {
                if (!player.isValid) continue;
                if (!isMarked(heldItem(player), KEY_BLUEPRINT)) continue;

                const blueprint = selectedBlueprint(player);
                if (!blueprint) continue;

                const origin = targetOrigin(player, config.raycastDistance);
                if (!origin) continue;

                const box = boxAt(origin, blueprint);
                const allowed = checkPlot(player, box, config).allowed;
                // Запрет показываем цветом: своя площадка зелёная, чужая красная.
                const particle = allowed ? config.hologramParticle : 'minecraft:basic_flame_particle';

                for (const point of boxOutline(box, config.hologramMaxPoints)) {
                    try {
                        player.spawnParticle(particle, point);
                    } catch {
                        // Точка вне загруженного чанка — пропускаем молча.
                    }
                }
            }
        });

        // Состояние выбора и углов хранится в свойствах игрока, поэтому
        // переживает перезаход и не требует чистки в памяти.
    },
});


/**
 * Меню выбора здания и подтверждения покупки.
 *
 * Показ формы и постройка — не read-only операции, поэтому вызывается из
 * обработчика события, а не напрямую из команды.
 */
async function openBlueprintMenu(player: Player, config: BlueprintsConfig, symbol: string): Promise<void> {
    const runtime = getRuntime();
    if (!runtime) return;

    const blueprints = listBlueprints();
    if (blueprints.length === 0) {
        player.sendMessage(info('Чертежей пока нет. Оператор создаёт их командой /mc:bpsave.'));
        return;
    }

    const form = new ActionFormData()
        .title('Чертежи')
        .body(`${Color.gray}Выберите здание. Контур покажет габарит на месте, куда вы смотрите.${Color.reset}`);
    for (const blueprint of blueprints) {
        form.button(
            `${blueprint.name}\n${Color.gray}${blueprint.sizeX}×${blueprint.sizeY}×${blueprint.sizeZ} — ` +
                `${formatMoney(blueprint.price, symbol)}${Color.reset}`,
        );
    }
    form.button(`${Color.gray}Закрыть${Color.reset}`);

    const response = await showFormWhenReady(form, player, runtime.log);
    if (!response || response.canceled || response.selection === undefined) return;

    const blueprint = blueprints[response.selection];
    if (!blueprint) return;

    // Выбор запоминаем сразу: голограмма должна показать габарит ещё до покупки.
    write(player, KEY_SELECTED, blueprint.id);

    const origin = targetOrigin(player, config.raycastDistance);
    if (!origin) {
        player.sendMessage(info(`Выбран «${blueprint.name}». Наведитесь на место постройки и используйте чертёж.`));
        return;
    }

    const box = boxAt(origin, blueprint);
    const plot = checkPlot(player, box, config);
    const affordable = canAfford(player, blueprint.price);

    const lines = [
        `${Color.gray}Здание: ${Color.yellow}${blueprint.name}${Color.reset}`,
        `${Color.gray}Габарит: ${blueprint.sizeX}×${blueprint.sizeY}×${blueprint.sizeZ}${Color.reset}`,
        `${Color.gray}Угол: ${origin.x}, ${origin.y}, ${origin.z}${Color.reset}`,
        `${Color.gray}Стоимость: ${Color.gold}${formatMoney(blueprint.price, symbol)}${Color.reset}`,
        '',
        plot.allowed
            ? `${Color.green}Участок: место подходит${Color.reset}`
            : `${Color.red}Участок: ${plot.reason}${Color.reset}`,
        affordable ? `${Color.green}Средств достаточно${Color.reset}` : `${Color.red}Не хватает средств${Color.reset}`,
    ];

    const confirm = new ActionFormData().title('Подтверждение').body(lines.join('\n'));
    const canBuild = plot.allowed && affordable;
    confirm.button(canBuild ? `${Color.green}Построить${Color.reset}` : `${Color.darkGray}Построить нельзя${Color.reset}`);
    confirm.button(`${Color.gray}Отмена${Color.reset}`);

    const decision = await showFormWhenReady(confirm, player, runtime.log);
    if (!decision || decision.canceled || decision.selection !== 0) return;
    if (!canBuild) {
        player.sendMessage(failure(plot.allowed ? 'Не хватает средств.' : (plot.reason ?? 'Место не подходит.')));
        return;
    }

    build(player, blueprint, origin, config, symbol);
}

/** Списание и установка структуры. Порядок важен: деньги берём после успеха. */
function build(
    player: Player,
    blueprint: Blueprint,
    origin: Vector3,
    config: BlueprintsConfig,
    symbol: string,
): void {
    const runtime = getRuntime();
    if (!runtime) return;

    // Между открытием формы и подтверждением мир мог измениться — проверяем снова.
    const box = boxAt(origin, blueprint);
    const plot = checkPlot(player, box, config);
    if (!plot.allowed) {
        player.sendMessage(failure(plot.reason ?? 'Место больше не подходит.'));
        return;
    }
    if (!canAfford(player, blueprint.price)) {
        player.sendMessage(failure('Не хватает средств.'));
        return;
    }

    system.run(() => {
        try {
            world.structureManager.place(blueprint.structureId, player.dimension, origin);
        } catch (error) {
            runtime.log.error(`Не удалось построить «${blueprint.name}»:`, error);
            player.sendMessage(failure('Постройка не удалась — подробности в логе сервера.'));
            return;
        }

        // Списываем только после успешной установки: иначе игрок потеряет
        // деньги, не получив здание.
        if (!withdraw(player, blueprint.price)) {
            runtime.log.warn(`Здание построено, но списание у ${player.name} не прошло.`);
        }
        refreshDisplay(player);
        player.sendMessage(
            success(`«${blueprint.name}» построено за ${formatMoney(blueprint.price, symbol)}.`),
        );
        runtime.log.info(`${player.name} построил «${blueprint.name}» в ${origin.x},${origin.y},${origin.z}.`);
    });
}

function markCorner(player: Player, config: BlueprintsConfig, log: MechanicContext['log']): void {
    const origin = targetOrigin(player, config.raycastDistance);
    if (!origin) {
        player.sendMessage(info('Наведитесь на блок, чтобы отметить угол.'));
        return;
    }
    const { a } = cornersOf(player);
    if (!a) {
        write(player, KEY_CORNER_A, origin);
        player.sendMessage(success(`Угол A: ${origin.x}, ${origin.y}, ${origin.z}.`));
    } else {
        write(player, KEY_CORNER_B, origin);
        player.sendMessage(success(`Угол B: ${origin.x}, ${origin.y}, ${origin.z}. Теперь /mc:bpsave <имя> <цена>.`));
    }
    log.debug(`${player.name} отметил угол области чертежа.`);
}

function selectedBlueprint(player: Player): Blueprint | undefined {
    const id = readString(player, KEY_SELECTED, '');
    return id === '' ? undefined : getBlueprint(id);
}
