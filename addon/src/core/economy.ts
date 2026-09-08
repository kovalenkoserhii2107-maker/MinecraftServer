import type { Player } from '@minecraft/server';
import { readNumber, write } from './storage.js';

/**
 * Криптогривна — внутриигровая валюта.
 *
 * Ядро намеренно отделено от механики `economy`: списывать и начислять должны
 * уметь и участки, и будущие рынок с оружием, а отображение и стартовый грант
 * остаются заботой механики.
 *
 * Баланс хранится в dynamic property игрока и переживает перезаход.
 */

const KEY_BALANCE = 'mc:balance';

/** Дробные копейки не нужны: округляем к целому и не пускаем ниже нуля. */
function normalize(amount: number): number {
    if (!Number.isFinite(amount)) return 0;
    return Math.max(0, Math.floor(amount));
}

export function getBalance(player: Player): number {
    return readNumber(player, KEY_BALANCE, 0);
}

/** Возвращает `false`, если движок отказал в записи. */
export function setBalance(player: Player, amount: number): boolean {
    return write(player, KEY_BALANCE, normalize(amount));
}

/** Был ли игроку уже выдан стартовый капитал. */
export function hasAccount(player: Player): boolean {
    try {
        return typeof player.getDynamicProperty(KEY_BALANCE) === 'number';
    } catch {
        return false;
    }
}

/** Начисление. Возвращает новый баланс. */
export function deposit(player: Player, amount: number): number {
    const next = getBalance(player) + normalize(amount);
    setBalance(player, next);
    return next;
}

/**
 * Списание. Возвращает `false` и НЕ меняет баланс, если денег не хватает, —
 * вызывающему остаётся только сообщить об отказе.
 */
export function withdraw(player: Player, amount: number): boolean {
    const cost = normalize(amount);
    const balance = getBalance(player);
    if (balance < cost) return false;
    return setBalance(player, balance - cost);
}

export function canAfford(player: Player, amount: number): boolean {
    return getBalance(player) >= normalize(amount);
}

/** «100 000 ₴» — с неразрывными пробелами, чтобы число не разрывалось в UI. */
export function formatMoney(amount: number, symbol = '₴'): string {
    const digits = String(normalize(amount));
    let grouped = '';
    for (let i = 0; i < digits.length; i++) {
        if (i > 0 && (digits.length - i) % 3 === 0) grouped += ' ';
        grouped += digits[i];
    }
    return `${grouped} ${symbol}`;
}
