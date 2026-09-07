import { EntityComponentTypes, Player, system, world } from '@minecraft/server';
import { Color } from '../core/format.js';
import { defineMechanic, type MechanicContext } from '../core/mechanic.js';

/** Отрисовывает полосу здоровья из 10 сегментов. */
function healthBar(current: number, max: number): string {
    const ratio = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
    const filled = Math.round(ratio * 10);
    const color = ratio > 0.5 ? Color.green : ratio > 0.25 ? Color.yellow : Color.red;
    return `${color}${'▮'.repeat(filled)}${Color.darkGray}${'▯'.repeat(10 - filled)}${Color.reset}`;
}

/**
 * Боевая обратная связь: показывает атакующему здоровье цели
 * и предупреждает игрока о критически низком здоровье.
 *
 * Подписки на `entityHurt` фильтруются на входе, чтобы не выполнять работу
 * на каждом уроне мобов друг другу.
 */
export const combatFeedbackMechanic = defineMechanic({
    id: 'combat_feedback',
    description: 'Полоса здоровья цели при ударе и предупреждение о низком здоровье.',
    enabledByDefault: true,

    activate(ctx: MechanicContext): void {
        const config = ctx.config.combat;
        /** Тик последнего предупреждения для каждого игрока: id -> tick. */
        const lastWarning = new Map<string, number>();

        ctx.store.subscribe(world.afterEvents.entityHurt, 'entityHurt', (event) => {
            const victim = event.hurtEntity;
            const attacker = event.damageSource.damagingEntity;

            if (config.showTargetHealth && attacker instanceof Player && victim.id !== attacker.id) {
                const health = victim.getComponent(EntityComponentTypes.Health);
                if (health) {
                    const name = victim instanceof Player ? victim.name : victim.typeId.replace('minecraft:', '');
                    attacker.onScreenDisplay.setActionBar(
                        `${Color.gray}${name} ${healthBar(health.currentValue, health.effectiveMax)} ` +
                            `${Color.white}${Math.ceil(health.currentValue)}${Color.gray}/${Math.ceil(health.effectiveMax)}${Color.reset}`,
                    );
                }
            }

            if (!(victim instanceof Player)) return;

            const health = victim.getComponent(EntityComponentTypes.Health);
            if (!health || health.effectiveMax <= 0) return;
            if (health.currentValue / health.effectiveMax > config.lowHealthRatio) return;

            // Антиспам: урон может приходить каждые несколько тиков (огонь, яд).
            const previous = lastWarning.get(victim.id) ?? Number.NEGATIVE_INFINITY;
            if (system.currentTick - previous < config.lowHealthCooldownTicks) return;
            lastWarning.set(victim.id, system.currentTick);

            victim.onScreenDisplay.setTitle(`${Color.red}Мало здоровья!`, {
                subtitle: `${Color.yellow}${Math.ceil(health.currentValue)} HP${Color.reset}`,
                fadeInDuration: 0,
                stayDuration: 20,
                fadeOutDuration: 10,
            });
            victim.playSound('random.orb', { volume: 0.4, pitch: 0.6 });
        });

        // Игрок вышел — освобождаем запись, иначе Map растёт всё время работы сервера.
        ctx.store.subscribe(world.afterEvents.playerLeave, 'playerLeave', (event) => {
            lastWarning.delete(event.playerId);
        });

        ctx.store.add(() => lastWarning.clear());
    },
});
