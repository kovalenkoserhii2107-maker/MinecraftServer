import { CommandPermissionLevel, GameMode, system, world, type Player } from '@minecraft/server';
import { ActionFormData, ModalFormData } from '@minecraft/server-ui';
import { listBlueprints, type Blueprint } from '../core/blueprints.js';
import {
    boxAt,
    checkPlot,
    corners,
    placeBlueprint,
    removeBlueprint,
    saveFromSelection,
    selectBlueprint,
    targetOrigin,
} from '../core/building.js';
import { formatMoney, getBalance } from '../core/economy.js';
import { Button, Color, formatCoords, formatDimension, formatMinutes } from '../core/format.js';
import { ensureMarked } from '../core/markedItem.js';
import { giveStarterKit, returnToDeath } from '../core/playerActions.js';
import {
    chunkAt,
    chunkBounds,
    claimPlot,
    getOwner,
    listOwnedChunks,
    renderPlotMap,
    unclaimPlot,
} from '../core/plots.js';
import type { EngineRuntime } from '../core/runtime.js';
import {
    announceDeclaration,
    declareWar,
    formatCountdown,
    getWar,
    secondsLeft,
} from '../core/war.js';
import { readNumber, readString, readVector } from '../core/storage.js';
import { showAction, showModal } from './forms.js';

/**
 * Панель коммуникатора — единственный способ управлять сервером.
 *
 * Чат-команд у движка нет: набирать их с геймпада неудобно, а на консолях это
 * основная платформа. Всё управление собрано здесь и разложено по категориям.
 */

function isAdmin(player: Player): boolean {
    return player.commandPermissionLevel >= CommandPermissionLevel.Admin;
}

/** Мутации мира нельзя выполнять внутри обработчика формы — откладываем на тик. */
function apply(action: () => void): void {
    system.run(action);
}

// ---------------------------------------------------------------- главное меню

export function openPanel(player: Player, runtime: EngineRuntime): void {
    void showMainMenu(player, runtime).catch((error: unknown) => {
        runtime.log.error('Ошибка панели сервера:', error);
    });
}

async function showMainMenu(player: Player, runtime: EngineRuntime): Promise<void> {
    const symbol = runtime.config.economy.currencySymbol;
    const owned = listOwnedChunks(player.id).length;

    const body = [
        `${Color.gray}Игрок: ${Color.yellow}${player.name}${Color.reset}`,
        `${Color.gray}Баланс: ${Color.gold}${formatMoney(getBalance(player), symbol)}${Color.reset}`,
        `${Color.gray}Участков (чанков): ${Color.yellow}${owned}${Color.reset}`,
    ].join('\n');

    const form = new ActionFormData()
        .title('Коммуникатор')
        .body(body)
        .button(`${Button.good}Территории${Button.note}\nучастки и карта${Color.reset}`)
        .button(`${Button.primary}Строительство${Button.note}\nчертежи и здания${Color.reset}`)
        .button(`${Button.primary}Игрок${Button.note}\nстатистика и набор${Color.reset}`)
        .button(`${Button.danger}Война${Button.note}\n${warHint()}${Color.reset}`)
        .button(`${Button.accent}Система${Button.note}\nмодули движка${Color.reset}`)
        .button(`${Button.muted}Закрыть${Color.reset}`);

    const response = await showAction(form, player, runtime.log);
    if (!response || response.canceled || response.selection === undefined) return;

    switch (response.selection) {
        case 0:
            await showTerritories(player, runtime);
            return;
        case 1:
            await showBuilding(player, runtime);
            return;
        case 2:
            await showPlayerMenu(player, runtime);
            return;
        case 3:
            await showWar(player, runtime);
            return;
        case 4:
            await showSystem(player, runtime);
            return;
        default:
            return;
    }
}

// ------------------------------------------------------------------ территории

async function showTerritories(player: Player, runtime: EngineRuntime): Promise<void> {
    const config = runtime.config.plots;
    const symbol = runtime.config.economy.currencySymbol;
    const here = chunkAt(player.dimension.id, player.location.x, player.location.z);
    const owner = getOwner(here);

    const body = [
        renderPlotMap(player, config.mapRadius),
        '',
        `${Color.green}█${Color.gray} ваше  ${Color.red}█${Color.gray} чужое  ` +
            `${Color.darkGray}░${Color.gray} свободно  ${Color.yellow}▣${Color.gray} вы здесь${Color.reset}`,
    ].join('\n');

    const form = new ActionFormData()
        .title('Территории')
        .body(body);
        
    const actions: (() => Promise<void> | void)[] = [];

    form.button(`${Button.primary}Информация об участке${Color.reset}`);
    actions.push(async () => showPlotInfo(player, runtime));

    form.button(`${Button.good}Купить 16×16${Button.note}\n${formatMoney(config.cost16, symbol)}${Color.reset}`);
    actions.push(() => {
        apply(() => {
            if (!player.isValid) return;
            const result = claimPlot(player, 16, config, symbol);
            player.sendMessage(result.ok ? `${Color.green}${result.message}` : `${Color.red}${result.message}`);
        });
    });

    form.button(`${Button.good}Купить 32×32${Button.note}\n${formatMoney(config.cost32, symbol)}${Color.reset}`);
    actions.push(() => {
        apply(() => {
            if (!player.isValid) return;
            const result = claimPlot(player, 32, config, symbol);
            player.sendMessage(result.ok ? `${Color.green}${result.message}` : `${Color.red}${result.message}`);
        });
    });

    const isMine = owner?.id === player.id;
    if (isMine) {
        const refund = Math.floor(config.cost16 * config.refundRatio);
        form.button(`${Button.danger}Продать участок${Button.note}\n+${formatMoney(refund, symbol)}${Color.reset}`);
        actions.push(() => {
            apply(() => {
                if (!player.isValid) return;
                const result = unclaimPlot(player, config, symbol);
                player.sendMessage(result.ok ? `${Color.green}${result.message}` : `${Color.red}${result.message}`);
            });
        });
    }

    const showBorders = player.getDynamicProperty('mc:show_plot_borders') === true;
    form.button(`${Button.accent}${showBorders ? 'Скрыть' : 'Показать'} границы${Button.note}\nчужих и своих участков${Color.reset}`);
    actions.push(() => {
        apply(() => {
            if (!player.isValid) return;
            player.setDynamicProperty('mc:show_plot_borders', !showBorders);
            player.sendMessage(`${Color.green}Отображение границ участков ${!showBorders ? 'включено' : 'выключено'}.${Color.reset}`);
        });
    });

    form.button(`${Button.muted}Назад${Color.reset}`);
    actions.push(async () => showMainMenu(player, runtime));

    const response = await showAction(form, player, runtime.log);
    if (!response || response.canceled || response.selection === undefined) return;

    const action = actions[response.selection];
    if (action) await action();
}

async function showPlotInfo(player: Player, runtime: EngineRuntime): Promise<void> {
    const here = chunkAt(player.dimension.id, player.location.x, player.location.z);
    const owner = getOwner(here);
    const bounds = chunkBounds(here);
    const owned = listOwnedChunks(player.id);

    const status = !owner
        ? `${Color.yellow}свободен — можно купить${Color.reset}`
        : owner.id === player.id
          ? `${Color.green}ваш${Color.reset}`
          : `${Color.red}занят: ${owner.name}${Color.reset}`;

    const body = [
        `${Color.gray}Статус: ${status}`,
        `${Color.gray}Измерение: ${formatDimension(player.dimension.id)}${Color.reset}`,
        `${Color.gray}Чанк: ${here.cx}, ${here.cz}${Color.reset}`,
        `${Color.gray}Границы: ${bounds.minX}..${bounds.maxX} по X${Color.reset}`,
        `${Color.gray}         ${bounds.minZ}..${bounds.maxZ} по Z${Color.reset}`,
        '',
        `${Color.gray}Всего ваших чанков: ${Color.yellow}${owned.length}${Color.reset}`,
    ].join('\n');

    const form = new ActionFormData()
        .title('Информация об участке')
        .body(body)
        .button(`${Button.muted}Назад${Color.reset}`);

    await showAction(form, player, runtime.log);
    await showTerritories(player, runtime);
}

// --------------------------------------------------------------- строительство

async function showBuilding(player: Player, runtime: EngineRuntime): Promise<void> {
    const config = runtime.config.blueprints;
    const { a, b } = corners(player);
    const marked = a && b ? 'оба угла отмечены' : a ? 'отмечен угол A' : 'углы не отмечены';

    const form = new ActionFormData()
        .title('Строительство')
        .body(
            `${Color.gray}Возьмите чертёж в руку и смотрите на место — контур покажет габарит.\n` +
            `${Color.gray}Сохранение чертежа: отметьте 2 угла по диагонали на нижнем уровне (высота до 128 блоков захватится автоматически).\n` +
            `Разметка области: ${Color.yellow}${marked}${Color.reset}`,
        );

    const actions: (() => Promise<void> | void)[] = [];

    form.button(`${Button.primary}Каталог зданий${Color.reset}`);
    actions.push(async () => showCatalog(player, runtime));

    form.button(`${Button.good}Получить чертёж${Color.reset}`);
    actions.push(() => {
        apply(() => {
            if (!player.isValid) return;
            const spec = {
                key: 'mc:blueprint',
                itemType: config.itemType,
                itemName: config.itemName,
                lore: config.lore,
                // Чертёж можно класть в сундук — в отличие от коммуникатора.
                lockInInventory: false,
            };
            player.sendMessage(
                ensureMarked(player, spec)
                    ? `${Color.green}Чертёж выдан.${Color.reset}`
                    : `${Color.red}Освободите слот в инвентаре.${Color.reset}`,
            );
        });
    });

    form.button(`${Button.good}Сохранить чертёж${Button.note}\nиз отмеченной области${Color.reset}`);
    actions.push(async () => showSaveBlueprint(player, runtime));

    // Сохранять чертежи может любой игрок, поэтому и удалять тоже: иначе
    // ошибочно созданный чертёж остаётся в каталоге навсегда.
    form.button(`${Button.danger}Удалить чертёж${Color.reset}`);
    actions.push(async () => showDeleteBlueprint(player, runtime));

    form.button(`${Button.muted}Назад${Color.reset}`);
    actions.push(async () => showMainMenu(player, runtime));

    const response = await showAction(form, player, runtime.log);
    if (!response || response.canceled || response.selection === undefined) return;

    const action = actions[response.selection];
    if (action) await action();
}

/** Каталог: выбор здания активирует голограмму и открывает подтверждение. */
export async function showCatalog(player: Player, runtime: EngineRuntime): Promise<void> {
    const symbol = runtime.config.economy.currencySymbol;
    const blueprints = listBlueprints();

    if (blueprints.length === 0) {
        const empty = new ActionFormData()
            .title('Каталог зданий')
            .body(
                `${Color.gray}Чертежей пока нет.\n\nОператор создаёт их так: построить здание, ` +
                    `отметить два угла приседом с чертежом, затем «Строительство → Сохранить чертёж».${Color.reset}`,
            )
            .button(`${Button.muted}Назад${Color.reset}`);
        await showAction(empty, player, runtime.log);
        return;
    }

    const form = new ActionFormData()
        .title('Каталог зданий')
        .body(`${Color.gray}Выбор здания включает контур габарита на месте, куда вы смотрите.${Color.reset}`);
    for (const blueprint of blueprints) {
        form.button(
            `${blueprint.name}\n${blueprint.sizeX}×${blueprint.sizeY}×${blueprint.sizeZ} — ${formatMoney(blueprint.price, symbol)}`
        );
    }
    form.button(`${Button.muted}Назад${Color.reset}`);

    const response = await showAction(form, player, runtime.log);
    if (!response || response.canceled || response.selection === undefined) return;

    const blueprint = blueprints[response.selection];
    if (!blueprint) return;

    // Выбор сохраняем сразу: голограмма должна работать ещё до покупки.
    selectBlueprint(player, blueprint);
    player.sendMessage(`${Color.gray}Чертёж «${blueprint.name}» выбран. Возьмите его в руку, прицельтесь и нажмите (Использовать), чтобы построить.${Color.reset}`);
}

export async function showConfirmPlacement(player: Player, blueprint: Blueprint, runtime: EngineRuntime): Promise<void> {
    const config = runtime.config.blueprints;
    const symbol = runtime.config.economy.currencySymbol;
    
    const origin = targetOrigin(player, config.raycastDistance);
    if (!origin) {
        player.sendMessage(`${Color.gray}Наведитесь на место постройки — появится контур.${Color.reset}`);
        return;
    }

    const plot = checkPlot(player, boxAt(origin, blueprint), config);
    const affordable = getBalance(player) >= blueprint.price;
    const canBuild = plot.allowed && affordable;

    const confirm = new ActionFormData()
        .title('Подтверждение')
        .body(
            [
                `Здание: ${blueprint.name}`,
                `Габарит: ${blueprint.sizeX}×${blueprint.sizeY}×${blueprint.sizeZ}`,
                `Угол: ${origin.x}, ${origin.y}, ${origin.z}`,
                `Стоимость: ${formatMoney(blueprint.price, symbol)}`,
                '',
                plot.allowed ? `Место подходит` : plot.reason,
                affordable ? `Средств достаточно` : `Не хватает средств`,
            ].join('\n'),
        )
        .button(canBuild ? `${Button.good}Построить${Color.reset}` : `${Button.muted}Построить нельзя${Color.reset}`)
        .button(`${Button.muted}Отмена${Color.reset}`);

    const decision = await showAction(confirm, player, runtime.log);
    if (!decision || decision.canceled || decision.selection !== 0 || !canBuild) return;

    apply(() => {
        if (!player.isValid) return;
        const result = placeBlueprint(player, blueprint, origin, config, symbol);
        player.sendMessage(result.ok ? `${Color.green}${result.message}` : `${Color.red}${result.message}`);
        if (result.ok) {
            runtime.log.info(`${player.name} построил «${blueprint.name}» в ${origin.x},${origin.y},${origin.z}.`);
        }
    });
}

/** Сохранение чертежа: название и цена вводятся в модальной форме. */
async function showSaveBlueprint(player: Player, runtime: EngineRuntime): Promise<void> {
    const config = runtime.config.blueprints;
    const { a, b } = corners(player);

    if (!a || !b) {
        const hint = new ActionFormData()
            .title('Сохранить чертёж')
            .body(
                `${Color.red}Область не размечена.${Color.reset}\n\n` +
                    `${Color.gray}Возьмите чертёж, присядьте и используйте предмет по двум ` +
                    `противоположным углам постройки, затем вернитесь сюда.${Color.reset}`,
            )
            .button(`${Button.muted}Назад${Color.reset}`);
        await showAction(hint, player, runtime.log);
        await showBuilding(player, runtime);
        return;
    }

    const size = {
        x: Math.abs(a.x - b.x) + 1,
        y: Math.abs(a.y - b.y) + 1,
        z: Math.abs(a.z - b.z) + 1,
    };

    // Без .label(): декоративные элементы могут занимать позицию в formValues,
    // и индексы полей поехали бы. Габарит выносим в заголовок.
    const form = new ModalFormData()
        .title(`Чертёж ${size.x}×${size.y}×${size.z}`)
        .textField('Название постройки', 'Например: Домик')
        .textField('Стоимость', '3000', { defaultValue: '0' })
        .submitButton('Сохранить');

    const response = await showModal(form, player, runtime.log);
    if (!response || response.canceled || !response.formValues) return;

    const name = String(response.formValues[0] ?? '');
    const price = Number(String(response.formValues[1] ?? '').replace(/\s/g, ''));

    apply(() => {
        if (!player.isValid) return;
        const result = saveFromSelection(player, name, price, config);
        player.sendMessage(result.ok ? `${Color.green}${result.message}` : `${Color.red}${result.message}`);
        if (!result.ok) runtime.log.warn(`Сохранение чертежа не удалось: ${result.message}`);
    });
}

async function showDeleteBlueprint(player: Player, runtime: EngineRuntime): Promise<void> {
    const blueprints = listBlueprints();
    if (blueprints.length === 0) {
        player.sendMessage(`${Color.gray}Удалять нечего — чертежей нет.${Color.reset}`);
        return;
    }

    const form = new ActionFormData().title('Удалить чертёж').body(`${Color.gray}Действие необратимо.${Color.reset}`);
    for (const blueprint of blueprints) form.button(`${Button.danger}${blueprint.name}${Color.reset}`);
    form.button(`${Button.muted}Назад${Color.reset}`);

    const response = await showAction(form, player, runtime.log);
    if (!response || response.canceled || response.selection === undefined) return;

    const blueprint = blueprints[response.selection];
    if (!blueprint) {
        await showBuilding(player, runtime);
        return;
    }

    apply(() => {
        removeBlueprint(blueprint);
        player.sendMessage(`${Color.green}Чертёж «${blueprint.name}» удалён.${Color.reset}`);
    });
}

// ----------------------------------------------------------------------- игрок

async function showPlayerMenu(player: Player, runtime: EngineRuntime): Promise<void> {
    const symbol = runtime.config.economy.currencySymbol;
    const minutes = readNumber(player, 'mc:playtime_minutes', 0);
    const deaths = readNumber(player, 'mc:death_count', 0);
    const joins = readNumber(player, 'mc:join_count', 0);
    const deathPos = readVector(player, 'mc:death_pos');
    const deathDim = readString(player, 'mc:death_dim', '');
    const returnsLeft = readNumber(player, 'mc:death_returns_left', 0);

    const lines = [
        `${Color.gray}Баланс: ${Color.gold}${formatMoney(getBalance(player), symbol)}${Color.reset}`,
        `${Color.gray}В игре: ${Color.yellow}${formatMinutes(minutes)}${Color.reset}`,
        `${Color.gray}Входов: ${Color.yellow}${joins}${Color.gray}, смертей: ${Color.yellow}${deaths}${Color.reset}`,
    ];
    if (deathPos && deathDim !== '') {
        lines.push(
            `${Color.gray}Точка смерти: ${Color.yellow}${formatCoords(deathPos)}${Color.gray} ` +
                `(${formatDimension(deathDim)}), возвратов: ${returnsLeft}${Color.reset}`,
        );
    }

    const form = new ActionFormData().title('Игрок').body(lines.join('\n'));
    const canReturn = deathPos !== undefined && returnsLeft > 0;
    form.button(
        canReturn
            ? `${Color.aqua}Вернуться к месту смерти${Color.reset}`
            : `${Color.darkGray}Возврат недоступен${Color.reset}`,
    );
    form.button(`${Button.good}Стартовый набор${Color.reset}`);
    form.button(`${Button.primary}Режим игры${Button.note}\nвыживание / творческий${Color.reset}`);
    form.button(`${Button.muted}Назад${Color.reset}`);

    const response = await showAction(form, player, runtime.log);
    if (!response || response.canceled || response.selection === undefined) return;

    if (response.selection === 0 && canReturn) {
        apply(() => {
            if (!player.isValid) return;
            const result = returnToDeath(player, runtime.config.deathBeacon);
            player.sendMessage(result.ok ? `${Color.green}${result.message}` : `${Color.red}${result.message}`);
        });
        return;
    }
    if (response.selection === 1) {
        apply(() => {
            if (!player.isValid) return;
            const result = giveStarterKit(player, runtime.config.welcome);
            player.sendMessage(result.ok ? `${Color.green}${result.message}` : `${Color.red}${result.message}`);
        });
        return;
    }
    if (response.selection === 2) {
        apply(() => {
            if (!player.isValid) return;
            try {
                if (player.getGameMode() === GameMode.Creative) {
                    player.setGameMode(GameMode.Survival);
                    player.sendMessage(`${Color.green}Установлен режим выживания.${Color.reset}`);
                } else {
                    player.setGameMode(GameMode.Creative);
                    player.sendMessage(`${Color.green}Установлен творческий режим.${Color.reset}`);
                }
            } catch (e) {
                player.sendMessage(`${Color.red}Не удалось сменить режим игры.${Color.reset}`);
            }
        });
        return;
    }
    await showMainMenu(player, runtime);
}


// ------------------------------------------------------------------------ война

/** Подпись под кнопкой «Война» в главном меню. */
function warHint(): string {
    const war = getWar();
    if (!war) return 'объявить и воевать';
    return war.phase === 'preparation'
        ? `подготовка ${formatCountdown(secondsLeft())}`
        : `идёт бой ${formatCountdown(secondsLeft())}`;
}

async function showWar(player: Player, runtime: EngineRuntime): Promise<void> {
    const config = runtime.config.war;
    const war = getWar();

    if (war) {
        const phase = war.phase === 'preparation' ? 'Подготовка' : 'Идёт бой';
        const body = [
            `${Color.gray}Стороны: ${Color.yellow}${war.attacker.name}${Color.gray} против ` +
                `${Color.yellow}${war.defender.name}${Color.reset}`,
            `${Color.gray}Этап: ${Color.red}${phase}${Color.reset}`,
            `${Color.gray}Осталось: ${Color.red}${formatCountdown(secondsLeft())}${Color.reset}`,
            '',
            war.phase === 'preparation'
                ? `${Color.gray}Когда отсчёт кончится, защита от урона снимется между вами двумя,` +
                  `\nи оба перейдёте в выживание.${Color.reset}`
                : `${Color.gray}Защита снята. По окончании боя режим игры вернётся прежним.${Color.reset}`,
        ].join('\n');

        const form = new ActionFormData()
            .title('Война')
            .body(body)
            .button(`${Button.muted}Назад${Color.reset}`);
        await showAction(form, player, runtime.log);
        await showMainMenu(player, runtime);
        return;
    }

    const minutes = Math.round(config.preparationTicks / 20 / 60);
    const combatMinutes = Math.round(config.combatTicks / 20 / 60);
    const body = [
        `${Color.gray}Сейчас мир: игроки не наносят друг другу урона.${Color.reset}`,
        '',
        `${Color.gray}После объявления у обеих сторон ${Color.yellow}${minutes} мин${Color.gray} на подготовку.`,
        `${Color.gray}Затем ${Color.yellow}${combatMinutes} мин${Color.gray} боя: защита снимается,`,
        `${Color.gray}оба переходят в выживание. После — всё как было и итоги.${Color.reset}`,
    ].join('\n');

    const form = new ActionFormData()
        .title('Война')
        .body(body)
        .button(`${Button.danger}Объявить войну${Color.reset}`)
        .button(`${Button.muted}Назад${Color.reset}`);

    const response = await showAction(form, player, runtime.log);
    if (!response || response.canceled || response.selection !== 0) {
        if (response && !response.canceled) await showMainMenu(player, runtime);
        return;
    }
    await showDeclareWar(player, runtime);
}

async function showDeclareWar(player: Player, runtime: EngineRuntime): Promise<void> {
    // Воевать можно только с тем, кто сейчас в игре: подготовка и бой идут в
    // реальном времени, и отсутствующий игрок просто потерял бы её вслепую.
    const targets = world.getAllPlayers().filter((other) => other.isValid && other.id !== player.id);

    if (targets.length === 0) {
        const empty = new ActionFormData()
            .title('Объявить войну')
            .body(`${Color.gray}На сервере больше никого нет.${Color.reset}`)
            .button(`${Button.muted}Назад${Color.reset}`);
        await showAction(empty, player, runtime.log);
        return;
    }

    const form = new ActionFormData()
        .title('Объявить войну')
        .body(`${Color.gray}Кому объявляем войну?${Color.reset}`);
    for (const target of targets) form.button(`${Button.danger}${target.name}${Color.reset}`);
    form.button(`${Button.muted}Отмена${Color.reset}`);

    const response = await showAction(form, player, runtime.log);
    if (!response || response.canceled || response.selection === undefined) return;

    const target = targets[response.selection];
    if (!target) return;

    const confirm = new ActionFormData()
        .title('Подтверждение')
        .body(
            `${Color.gray}Объявить войну игроку ${Color.yellow}${target.name}${Color.gray}?` +
                `\n\nОтменить объявление будет нельзя.${Color.reset}`,
        )
        .button(`${Button.danger}Объявить${Color.reset}`)
        .button(`${Button.muted}Отмена${Color.reset}`);

    const decision = await showAction(confirm, player, runtime.log);
    if (!decision || decision.canceled || decision.selection !== 0) return;

    apply(() => {
        if (!player.isValid || !target.isValid) return;
        const result = declareWar(player, target, runtime.config.war);
        if (!result.ok) {
            player.sendMessage(`${Color.red}${result.message}${Color.reset}`);
            return;
        }
        announceDeclaration(player, target, runtime.config.war);
        runtime.log.info(`${player.name} объявил войну ${target.name}.`);
    });
}

// --------------------------------------------------------------------- система

async function showSystem(player: Player, runtime: EngineRuntime): Promise<void> {
    const entries = runtime.registry.status();
    const admin = isAdmin(player);

    const body = [
        `${Color.gray}Активных модулей: ${Color.yellow}${entries.filter((e) => e.active).length}` +
            `${Color.gray} из ${entries.length}${Color.reset}`,
        '',
        admin
            ? `${Color.gray}Выберите модуль, чтобы переключить его состояние.${Color.reset}`
            : `${Color.gray}Переключение доступно операторам.${Color.reset}`,
    ].join('\n');

    const form = new ActionFormData().title('Система').body(body);
    for (const entry of entries) {
        const state = entry.active ? `${Color.green}вкл` : `${Color.red}выкл`;
        form.button(`${Button.primary}${entry.id}  ${state}${Button.note}\n${entry.description}${Color.reset}`);
    }
    form.button(`${Button.muted}Назад${Color.reset}`);

    const response = await showAction(form, player, runtime.log);
    if (!response || response.canceled || response.selection === undefined) return;

    const selected = entries[response.selection];
    if (!selected || !admin) {
        await showMainMenu(player, runtime);
        return;
    }

    apply(() => {
        runtime.registry.setEnabled(selected.id, !selected.active);
        player.sendMessage(
            `${Color.gray}Модуль ${Color.yellow}${selected.id}${Color.gray} теперь ` +
                `${selected.active ? `${Color.red}выключен` : `${Color.green}включён`}${Color.reset}`,
        );
    });
    await showSystem(player, runtime);
}
