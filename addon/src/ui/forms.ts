import { system, type Player } from '@minecraft/server';
import type { ActionFormData, ActionFormResponse, ModalFormData, ModalFormResponse } from '@minecraft/server-ui';
import { FormCancelationReason } from '@minecraft/server-ui';
import type { Logger } from '../core/logger.js';

/**
 * Показ формы с ожиданием, пока клиент освободит интерфейс.
 *
 * Пока у игрока открыт другой экран, клиент отвечает `UserBusy`. Так бывает и
 * штатно: сразу после закрытия одной формы или выхода из чата.
 */
const BUSY_RETRY_ATTEMPTS = 10;
const BUSY_RETRY_TICKS = 10;

async function showWithRetry<TResponse extends { cancelationReason?: FormCancelationReason }>(
    show: (player: Player) => Promise<TResponse>,
    player: Player,
    log: Logger,
): Promise<TResponse | undefined> {
    for (let attempt = 0; attempt < BUSY_RETRY_ATTEMPTS; attempt++) {
        if (!player.isValid) return undefined;
        const response = await show(player);
        if (response.cancelationReason !== FormCancelationReason.UserBusy) return response;
        await system.waitTicks(BUSY_RETRY_TICKS);
    }
    log.warn(`Не удалось открыть форму для ${player.name}: интерфейс занят.`);
    return undefined;
}

export function showAction(
    form: ActionFormData,
    player: Player,
    log: Logger,
): Promise<ActionFormResponse | undefined> {
    return showWithRetry((target) => form.show(target), player, log);
}

export function showModal(
    form: ModalFormData,
    player: Player,
    log: Logger,
): Promise<ModalFormResponse | undefined> {
    return showWithRetry((target) => form.show(target), player, log);
}
