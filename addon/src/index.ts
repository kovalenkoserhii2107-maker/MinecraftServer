/**
 * Точка входа Behavior Pack.
 *
 * Порядок инициализации задан движком Bedrock:
 *   1. `system.beforeEvents.startup` — единственная фаза, где доступен
 *      `customCommandRegistry`. Мир ещё не загружен, обращаться к `world` нельзя.
 *   2. `world.afterEvents.worldLoad` — мир готов, поднимаем механики.
 *   3. `system.beforeEvents.shutdown` — корректно снимаем подписки и таймеры.
 */
import { system, world } from '@minecraft/server';
import { DEFAULT_CONFIG, resolveLogLevel } from './config.js';
import { registerCommands } from './core/commands.js';
import { PREFIX } from './core/format.js';
import { createLogger, setAdminBroadcast, setLogLevel } from './core/logger.js';
import { MechanicRegistry } from './core/registry.js';
import { setRuntime } from './core/runtime.js';
import { MECHANICS } from './mechanics/index.js';

const log = createLogger('engine');
const registry = new MechanicRegistry(DEFAULT_CONFIG);

for (const mechanic of MECHANICS) {
    registry.register(mechanic);
}

system.beforeEvents.startup.subscribe((event) => {
    try {
        registerCommands(event.customCommandRegistry, MECHANICS, log);
    } catch (error) {
        // Сервер должен подняться даже без кастомных команд.
        log.error('Регистрация кастомных команд не удалась:', error);
    }
});

world.afterEvents.worldLoad.subscribe(() => {
    try {
        setLogLevel(resolveLogLevel());
        setAdminBroadcast(DEFAULT_CONFIG.broadcastErrorsToAdmins);

        // Команды могут выполняться уже сейчас, поэтому runtime публикуем до активации.
        setRuntime({ config: DEFAULT_CONFIG, registry, log });
        registry.activateAll();

        const active = registry.status().filter((entry) => entry.active).length;
        log.info(`Движок механик запущен: активно ${active} из ${MECHANICS.length}.`);
        world.sendMessage(`${PREFIX}Движок механик загружен (${active} активно).`);
    } catch (error) {
        log.error('Критическая ошибка при запуске движка механик:', error);
    }
});

system.beforeEvents.shutdown.subscribe(() => {
    try {
        registry.disposeAll();
        log.info('Движок механик остановлен.');
    } catch (error) {
        log.error('Ошибка при остановке движка механик:', error);
    }
});
