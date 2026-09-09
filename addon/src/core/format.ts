/**
 * Форматирование сообщений: коды цветов Bedrock и общие префиксы.
 * Консоли (Switch/PS5) корректно отображают §-последовательности в чате,
 * заголовках и action bar.
 */

export const Color = {
    black: '§0',
    darkBlue: '§1',
    darkGreen: '§2',
    darkAqua: '§3',
    darkRed: '§4',
    darkPurple: '§5',
    gold: '§6',
    gray: '§7',
    darkGray: '§8',
    blue: '§9',
    green: '§a',
    aqua: '§b',
    red: '§c',
    lightPurple: '§d',
    yellow: '§e',
    white: '§f',
    reset: '§r',
    bold: '§l',
    italic: '§o',
} as const;

/**
 * Палитра для подписей на кнопках форм.
 *
 * Кнопки Bedrock рисуются на светлом фоне, а тело формы — на тёмном. Светлые
 * цвета (§a, §b, §e, §7) на кнопках почти сливаются с фоном, поэтому для них
 * нужны тёмные тона. В теле формы, наоборот, читаются светлые.
 */
export const Button = {
    /** Основное действие. */
    primary: '§1',
    /** Созидательное: купить, получить, сохранить. */
    good: '§2',
    /** Разрушительное: продать, удалить, объявить войну. */
    danger: '§4',
    /** Второстепенное: «Назад», «Закрыть». */
    muted: '§8',
    /** Выделение внутри подписи. */
    accent: '§5',
    /** Пояснение второй строкой. */
    note: '§8',
} as const;

/** Префикс всех сообщений движка механик. */
export const PREFIX = `${Color.darkAqua}[${Color.aqua}MC${Color.darkAqua}]${Color.reset} `;

/** Обычное информационное сообщение игроку. */
export function info(text: string): string {
    return `${PREFIX}${Color.white}${text}${Color.reset}`;
}

/** Успешное действие. */
export function success(text: string): string {
    return `${PREFIX}${Color.green}${text}${Color.reset}`;
}

/** Предупреждение / отказ. */
export function warn(text: string): string {
    return `${PREFIX}${Color.yellow}${text}${Color.reset}`;
}

/** Ошибка. */
export function failure(text: string): string {
    return `${PREFIX}${Color.red}${text}${Color.reset}`;
}

/** Округление координат до целых для вывода игроку. */
export function formatCoords(location: { x: number; y: number; z: number }): string {
    return `${Math.floor(location.x)}, ${Math.floor(location.y)}, ${Math.floor(location.z)}`;
}

/** Человекочитаемое имя измерения. */
export function formatDimension(dimensionId: string): string {
    switch (dimensionId) {
        case 'minecraft:overworld':
            return 'Обычный мир';
        case 'minecraft:nether':
            return 'Незер';
        case 'minecraft:the_end':
            return 'Край';
        default:
            return dimensionId;
    }
}

/** Длительность в минутах -> «2 ч 05 мин». */
export function formatMinutes(totalMinutes: number): string {
    const minutes = Math.max(0, Math.floor(totalMinutes));
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return hours > 0 ? `${hours} ч ${String(rest).padStart(2, '0')} мин` : `${rest} мин`;
}
