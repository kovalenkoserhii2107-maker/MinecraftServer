import { world } from '@minecraft/server';
import type { BlueprintsConfig } from '../config.js';
import {
    boxAt,
    boxOutline,
    checkPlot,
    markCorner,
    selectedBlueprint,
    targetOrigin,
} from '../core/building.js';
import { info, success } from '../core/format.js';
import { heldItem, isMarked, type MarkedItemSpec } from '../core/markedItem.js';
import { defineMechanic, type MechanicContext } from '../core/mechanic.js';
import { getRuntime } from '../core/runtime.js';
import { showCatalog, showConfirmPlacement } from '../ui/panel.js';

/** Метка чертежа: как и у коммуникатора, живёт в свойстве самого ItemStack. */
export const KEY_BLUEPRINT = 'mc:blueprint';

export function blueprintItemSpec(config: BlueprintsConfig): MarkedItemSpec {
    return {
        key: KEY_BLUEPRINT,
        itemType: config.itemType,
        itemName: config.itemName,
        lore: config.lore,
        // Чертёж можно класть в сундук — в отличие от коммуникатора.
        lockInInventory: false,
    };
}

/**
 * Строительство типовых зданий.
 *
 * Механика отвечает только за события: использование предмета и отрисовку
 * голограммы. Каталог, покупка и сохранение чертежей живут в панели, а
 * операции — в `core/building.ts`.
 */
export const blueprintsMechanic = defineMechanic({
    id: 'blueprints',
    description: 'Чертежи: голограмма габарита и постройка типовых зданий.',
    enabledByDefault: true,

    activate(ctx: MechanicContext): void {
        const config = ctx.config.blueprints;

        ctx.store.subscribe(world.afterEvents.itemUse, 'itemUse', (event) => {
            if (!isMarked(event.itemStack, KEY_BLUEPRINT)) return;
            const runtime = getRuntime();
            if (!runtime) return;

            const player = event.source;

            // Присед + использование — разметка углов будущего чертежа.
            if (player.isSneaking) {
                const origin = targetOrigin(player, config.raycastDistance);
                if (!origin) {
                    player.sendMessage(info('Наведитесь на блок, чтобы отметить угол.'));
                    return;
                }
                const corner = markCorner(player, origin);
                player.sendMessage(
                    success(
                        corner === 'A'
                            ? `Угол A: ${origin.x}, ${origin.y}, ${origin.z}.`
                            : `Угол B: ${origin.x}, ${origin.y}, ${origin.z}. Теперь «Строительство → Сохранить чертёж».`,
                    ),
                );
                return;
            }

            const selected = selectedBlueprint(player);
            if (selected) {
                void showConfirmPlacement(player, selected, runtime).catch((error: unknown) =>
                    ctx.log.error('Ошибка окна постройки:', error),
                );
            } else {
                void showCatalog(player, runtime).catch((error: unknown) =>
                    ctx.log.error('Ошибка каталога зданий:', error),
                );
            }
        });

        // Голограмма — только тем, кто реально держит чертёж в руке.
        ctx.store.runInterval('blueprintHologram', config.hologramIntervalTicks, () => {
            for (const player of world.getAllPlayers()) {
                if (!player.isValid) continue;
                if (!isMarked(heldItem(player), KEY_BLUEPRINT)) continue;

                const blueprint = selectedBlueprint(player);
                if (!blueprint) continue;

                const origin = targetOrigin(player, config.raycastDistance);
                if (!origin) continue;

                const box = boxAt(origin, blueprint);
                // Цвет сразу показывает вердикт по участку — ещё до открытия меню.
                const particle = checkPlot(player, box, config).allowed
                    ? config.hologramParticle
                    : 'minecraft:basic_flame_particle';

                for (const point of boxOutline(box, config.hologramMaxPoints)) {
                    try {
                        player.spawnParticle(particle, point);
                    } catch {
                        // Точка вне загруженного чанка — пропускаем молча.
                    }
                }
            }
        });
    },
});
