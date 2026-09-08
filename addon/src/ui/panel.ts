import { CommandPermissionLevel, Player, system } from '@minecraft/server';
import { ActionFormData, FormCancelationReason } from '@minecraft/server-ui';
import { Color, formatCoords, formatDimension, formatMinutes } from '../core/format.js';
import { formatMoney, getBalance } from '../core/economy.js';
import { chunkAt, chunkBounds, getOwner, listOwnedChunks } from '../core/plots.js';
import { ensureMarked } from '../core/markedItem.js';
import { blueprintItemSpec } from '../mechanics/blueprints.js';
import { renderPlotMap } from '../mechanics/plots.js';
import type { Logger } from '../core/logger.js';
import type { EngineRuntime } from '../core/runtime.js';
import { readNumber, readString, readVector } from '../core/storage.js';

/**
 * Панель сервера — единая точка управления для всех механик.
 *
 * Открывается двумя способами: предметом-коммуникатором (механика `device`)
 * и командой `/mc:panel`. Оба ведут сюда, поэтому меню описано один раз.
 *
 * Форма листается стиками и крестовиной, поэтому годится и для консолей,
 * где набирать команды с геймпада неудобно.
 */

/**
 * Клиент отвечает `UserBusy`, пока у игрока открыт другой интерфейс — а после
 * ввода слэш-команды чат ещё закрывается. Ждём освобождения UI, но не вечно.
 */
const BUSY_RETRY_ATTEMPTS = 10;
const BUSY_RETRY_TICKS = 10;

async function showWhenReady(form: ActionFormData, player: Player, log: Logger) {
    for (let attempt = 0; attempt < BUSY_RETRY_ATTEMPTS; attempt++) {
        if (!player.isValid) return undefined;
        const response = await form.show(player);
        if (response.cancelationReason !== FormCancelationReason.UserBusy) {
            return response;
        }
        await system.waitTicks(BUSY_RETRY_TICKS);
    }
    log.warn(`Не удалось открыть панель для ${player.name}: интерфейс занят.`);
    return undefined;
}

function playerSummary(player: Player): string {
    const minutes = readNumber(player, 'mc:playtime_minutes', 0);
    const deaths = readNumber(player, 'mc:death_count', 0);
    const joins = readNumber(player, 'mc:join_count', 0);
    const deathPos = readVector(player, 'mc:death_pos');
    const deathDim = readString(player, 'mc:death_dim', '');

    const lines = [
        `${Color.gray}Игрок: ${Color.yellow}${player.name}${Color.reset}`,
        `${Color.gray}Баланс: ${Color.gold}${formatMoney(getBalance(player))}${Color.reset}`,
        `${Color.gray}В игре: ${Color.yellow}${formatMinutes(minutes)}${Color.reset}`,
        `${Color.gray}Входов: ${Color.yellow}${joins}${Color.gray}, смертей: ${Color.yellow}${deaths}${Color.reset}`,
    ];
    if (deathPos && deathDim !== '') {
        lines.push(
            `${Color.gray}Точка смерти: ${Color.yellow}${formatCoords(deathPos)}${Color.gray} (${formatDimension(deathDim)})${Color.reset}`,
        );
    }
    return lines.join('\n');
}

async function showMechanicsMenu(player: Player, runtime: EngineRuntime): Promise<void> {
    const entries = runtime.registry.status();
    const form = new ActionFormData()
        .title('Механики сервера')
        .body(`${Color.gray}Выберите механику, чтобы переключить её состояние.${Color.reset}`);

    for (const entry of entries) {
        const state = entry.active ? `${Color.green}вкл` : `${Color.red}выкл`;
        form.button(`${entry.id}\n${state}${Color.reset}`);
    }
    form.button(`${Color.gray}Назад${Color.reset}`);

    const response = await showWhenReady(form, player, runtime.log);
    if (!response || response.canceled || response.selection === undefined) return;

    const selected = entries[response.selection];
    if (!selected) {
        await showMainMenu(player, runtime);
        return;
    }

    // Активация подписывается на события — это мутация, откладываем на тик.
    system.run(() => {
        runtime.registry.setEnabled(selected.id, !selected.active);
    });
    player.sendMessage(
        `${Color.gray}Механика ${Color.yellow}${selected.id}${Color.gray} теперь ` +
            `${selected.active ? `${Color.red}выключена` : `${Color.green}включена`}${Color.reset}`,
    );
    await showMechanicsMenu(player, runtime);
}


/** Карта вокруг игрока и список его владений. */
async function showPlotsMenu(player: Player, runtime: EngineRuntime): Promise<void> {
    const config = runtime.config.plots;
    const symbol = runtime.config.economy.currencySymbol;
    const here = chunkAt(player.dimension.id, player.location.x, player.location.z);
    const owner = getOwner(here);
    const owned = listOwnedChunks(player.id);
    const bounds = chunkBounds(here);

    const body = [
        renderPlotMap(player, config.mapRadius),
        '',
        `${Color.green}█${Color.gray} ваше   ${Color.red}█${Color.gray} чужое   ${Color.darkGray}░${Color.gray} свободно   ${Color.yellow}▣${Color.gray} вы здесь${Color.reset}`,
        '',
        owner
            ? `${Color.gray}Здесь: ${owner.id === player.id ? `${Color.green}ваш участок` : `${Color.red}${owner.name}`}${Color.reset}`
            : `${Color.gray}Здесь: ${Color.yellow}земля свободна${Color.reset}`,
        `${Color.gray}Границы чанка: ${bounds.minX}..${bounds.maxX} X, ${bounds.minZ}..${bounds.maxZ} Z${Color.reset}`,
        `${Color.gray}Ваших чанков: ${Color.yellow}${owned.length}${Color.reset}`,
    ].join('\n');

    const form = new ActionFormData()
        .title('Участки')
        .body(body)
        .button(`${Color.yellow}Купить 16×16${Color.gray}\n${formatMoney(config.cost16, symbol)}${Color.reset}`)
        .button(`${Color.yellow}Купить 32×32${Color.gray}\n${formatMoney(config.cost32, symbol)}${Color.reset}`)
        .button(`${Color.aqua}Обновить карту${Color.reset}`)
        .button(`${Color.gray}Назад${Color.reset}`);

    const response = await showWhenReady(form, player, runtime.log);
    if (!response || response.canceled || response.selection === undefined) return;

    switch (response.selection) {
        case 0:
        case 1:
            // Покупка меняет мир, поэтому идёт отдельным тиком, а результат
            // приходит сообщением в чат — форму заново не открываем.
            player.sendMessage(
                `${Color.gray}Наберите ${Color.yellow}/mc:claim ${response.selection === 0 ? '16x16' : '32x32'}${Color.gray}, чтобы подтвердить покупку.${Color.reset}`,
            );
            return;
        case 2:
            await showPlotsMenu(player, runtime);
            return;
        default:
            await showMainMenu(player, runtime);
    }
}

async function showMainMenu(player: Player, runtime: EngineRuntime): Promise<void> {
    const isAdmin = player.commandPermissionLevel >= CommandPermissionLevel.Admin;

    const form = new ActionFormData()
        .title('Панель сервера')
        .body(playerSummary(player))
        .button(`${Color.yellow}Список команд${Color.reset}`)
        .button(`${Color.green}Участки и карта${Color.reset}`)
        .button(`${Color.aqua}Получить чертёж${Color.reset}`);

    if (isAdmin) {
        form.button(`${Color.aqua}Механики${Color.reset}`);
    }
    form.button(`${Color.gray}Закрыть${Color.reset}`);

    const response = await showWhenReady(form, player, runtime.log);
    if (!response || response.canceled || response.selection === undefined) return;

    if (response.selection === 0) {
        player.sendMessage(
            `${Color.aqua}Команды:${Color.reset}\n` +
                `${Color.yellow}/mc:panel${Color.gray} — эта панель\n` +
                `${Color.yellow}/mc:device${Color.gray} — получить коммуникатор\n` +
                `${Color.yellow}/mc:balance${Color.gray} — баланс криптогривны\n` +
                `${Color.yellow}/mc:blueprint${Color.gray} — получить чертёж\n` +
                `${Color.yellow}/mc:bplist${Color.gray} — список типовых зданий\n` +
                `${Color.yellow}/mc:claim${Color.gray} — купить участок 16x16 или 32x32\n` +
                `${Color.yellow}/mc:plotinfo${Color.gray} — чей участок под вами\n` +
                `${Color.yellow}/mc:unclaim${Color.gray} — продать участок\n` +
                `${Color.yellow}/mc:stats${Color.gray} — ваша статистика\n` +
                `${Color.yellow}/mc:kit${Color.gray} — стартовый набор\n` +
                `${Color.yellow}/mc:deathpoint${Color.gray} — координаты смерти\n` +
                `${Color.yellow}/mc:back${Color.gray} — возврат к месту смерти${Color.reset}`,
        );
        return;
    }
    if (response.selection === 1) {
        await showPlotsMenu(player, runtime);
        return;
    }
    if (response.selection === 2) {
        // Выдача предмета — мутация мира, поэтому отдельным тиком.
        system.run(() => {
            if (!player.isValid) return;
            if (ensureMarked(player, blueprintItemSpec(runtime.config.blueprints))) {
                player.sendMessage(
                    `${Color.green}Чертёж выдан. Возьмите его в руку и смотрите на место постройки.${Color.reset}`,
                );
            } else {
                player.sendMessage(`${Color.red}Освободите слот в инвентаре.${Color.reset}`);
            }
        });
        return;
    }
    if (isAdmin && response.selection === 3) {
        await showMechanicsMenu(player, runtime);
    }
}

/**
 * Открывает панель. Безопасно вызывать из обработчика события или команды:
 * показ формы сам по себе мутацией не является, но вызывающий обязан быть
 * вне read-only режима — см. `defer()` в `core/commands.ts`.
 */
export function openPanel(player: Player, runtime: EngineRuntime): void {
    void showMainMenu(player, runtime).catch((error: unknown) => {
        runtime.log.error('Ошибка панели сервера:', error);
    });
}
