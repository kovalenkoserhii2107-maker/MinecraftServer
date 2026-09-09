import type { Mechanic } from '../core/mechanic.js';
import { blueprintsMechanic } from './blueprints.js';
import { combatFeedbackMechanic } from './combatFeedback.js';
import { deathBeaconMechanic } from './deathBeacon.js';
import { deviceMechanic } from './device.js';
import { economyMechanic } from './economy.js';
import { plotsMechanic } from './plots.js';
import { playtimeRewardsMechanic } from './playtimeRewards.js';
import { warMechanic } from './war.js';
import { welcomeMechanic } from './welcome.js';

/**
 * Единый список механик сервера.
 *
 * Порядок важен только для вывода `/mc:help` и `/mc:mechanics`.
 * Чтобы добавить механику: создайте файл в этой папке, экспортируйте её через
 * `defineMechanic` и допишите сюда — больше нигде правки не нужны.
 */
export const MECHANICS: readonly Mechanic[] = [
    deviceMechanic,
    economyMechanic,
    plotsMechanic,
    warMechanic,
    blueprintsMechanic,
    welcomeMechanic,
    deathBeaconMechanic,
    playtimeRewardsMechanic,
    combatFeedbackMechanic,
];
