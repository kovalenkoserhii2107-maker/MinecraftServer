/**
 * Функциональная проверка движка на моках Bedrock Script API.
 *
 * Запуск: npm test (сборка выполняется автоматически).
 *
 * Управление сервером живёт в панели коммуникатора, поэтому большинство
 * сценариев прогоняется навигацией по формам, а не вызовом команд: так тест
 * проверяет тот же путь, которым идёт игрок.
 */
import assert from 'node:assert/strict';
import {
    system, world, Player, Block, CustomCommandRegistry, CustomCommandStatus,
    ItemLockMode, DisplaySlotId, __addPlayer,
} from '@minecraft/server';
import { __shown, __queueResponses, __queueModalResponses, __reset } from '@minecraft/server-ui';

await import('../addon/scripts/index.js');

const results = [];
const check = (name, fn) => { try { fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); } };

/** Прокручивает тики вперемешку с микрозадачами: формы асинхронные. */
async function pump(ticks = 6) {
    for (let i = 0; i < ticks; i++) {
        system.advance(1);
        await new Promise((r) => setImmediate(r));
    }
}

// --- 1. Старт: команд в чате почти не осталось ---
const registry = new CustomCommandRegistry();
system.beforeEvents.startup.emit({ customCommandRegistry: registry });

check('в чате осталась одна спасательная команда', () => {
    assert.deepEqual([...registry.commands.keys()], ['mc:device']);
});
check('enum механик больше не регистрируется', () => {
    assert.equal(registry.enums.size, 0);
});

// --- 2. Загрузка мира ---
const alice = __addPlayer(new Player('Alice', { op: true }));
world.afterEvents.worldLoad.emit({});
world.afterEvents.playerSpawn.emit({ player: alice, initialSpawn: true });
await pump(60);

const deviceOf = (p) => p.container.items.find((i) => i.lore.some(l => l.includes('mc:device')));
const bpItemOf = (p) => p.container.items.find((i) => i.lore.some(l => l.includes('mc:blueprint')));
const kitItems = (p) => p.container.items.filter((i) => !i.lore.some(l => l.includes('mc:device')) && !i.lore.some(l => l.includes('mc:blueprint')));

check('активны 8 механик', () => {
    const active = world.broadcast.find((m) => m.includes('Движок механик загружен'));
    assert.ok(active, 'нет сообщения о загрузке');
    assert.ok(active.includes('8 активно'), active);
});
check('коммуникатор выдан и защищён от потери', () => {
    const d = deviceOf(alice);
    assert.ok(d, 'коммуникатор не выдан');
    assert.equal(d.keepOnDeath, true);
    assert.equal(d.lockMode, ItemLockMode.inventory);
});
check('стартовый капитал начислен', () => {
    assert.equal(alice.getDynamicProperty('mc:balance'), 100000);
});
check('баланс виден на боковой панели', () => {
    const objective = world.scoreboard.slots.get(DisplaySlotId.Sidebar);
    assert.ok(objective);
    assert.equal(objective.getScore(alice), 100000);
});
check('первый вход: объявление и стартовый набор', () => {
    assert.ok(world.broadcast.some((m) => m.includes('Alice') && m.includes('впервые')));
    assert.equal(kitItems(alice).length, 4);
});

// --- 3. Главное меню открывается коммуникатором ---
/** Прямой вызов панели — нужен, когда механика device выключена. */
const panelModule = await import('../addon/scripts/ui/panel.js');
const runtimeModule = await import('../addon/scripts/core/runtime.js');
const openPanelRaw = async (p, responses = [], modal = []) => {
    __reset();
    __queueResponses(responses);
    __queueModalResponses(modal);
    panelModule.openPanel(p, runtimeModule.getRuntime());
    await pump(10);
};

const openPanel = async (p, responses = [], modal = []) => {
    __reset();
    __queueResponses(responses);
    __queueModalResponses(modal);
    world.afterEvents.itemUse.emit({ itemStack: deviceOf(p), source: p });
    await pump(10);
};

await openPanel(alice);
check('коммуникатор открывает главное меню', () => {
    assert.equal(__shown.length, 1);
    assert.equal(__shown[0].title, 'Коммуникатор');
});
check('баланс выводится прямо в теле меню', () => {
    assert.ok(__shown[0].body.includes('100 000'), JSON.stringify(__shown[0].body));
});
check('меню разложено по категориям', () => {
    const buttons = __shown[0].buttons.join(' ');
    for (const category of ['Территории', 'Строительство', 'Игрок', 'Система']) {
        assert.ok(buttons.includes(category), `нет категории ${category}`);
    }
});

// --- 4. Территории ---
alice.location = { x: 8, y: 64, z: 8 };            // чанк 0,0
await openPanel(alice, [0, 1]);                     // Территории -> Купить 16x16
check('участок 16×16 куплен через панель', () => {
    assert.equal(world.getDynamicProperty('mc:plot.o.0.0'), `${alice.id}|Alice`);
    assert.equal(alice.getDynamicProperty('mc:balance'), 100000 - 5000);
});
check('в подменю есть карта и легенда', () => {
    const territories = __shown.find((f) => f.title === 'Территории');
    assert.ok(territories, 'подменю не открылось');
    assert.ok(territories.body.includes('свободно'), 'нет легенды');
});

await openPanel(alice, [0, 0]);                     // Территории -> Информация
check('информация показывает статус занятости', () => {
    const info = __shown.find((f) => f.title === 'Информация об участке');
    assert.ok(info, 'информация не открылась');
    assert.ok(info.body.includes('ваш'), info.body);
});

const bob = __addPlayer(new Player('Bob'));
world.afterEvents.playerSpawn.emit({ player: bob, initialSpawn: true });
await pump(60);
bob.location = { x: 8, y: 64, z: 8 };

const blockAt = (p, x, z) => new Block(x, 64, z, p.dimension);
check('чужой не может ломать блок на участке', () => {
    const event = { block: blockAt(bob, 5, 5), player: bob, cancel: false };
    world.beforeEvents.playerBreakBlock.emit(event);
    assert.equal(event.cancel, true);
});
check('чужой не может взаимодействовать с блоком', () => {
    const event = { block: blockAt(bob, 5, 5), player: bob, cancel: false, isFirstEvent: true };
    world.beforeEvents.playerInteractWithBlock.emit(event);
    assert.equal(event.cancel, true);
});
check('блок, поставленный чужим, снимается', () => {
    const block = blockAt(bob, 7, 7);
    world.afterEvents.playerPlaceBlock.emit({ block, player: bob });
    system.advance(2);
    assert.equal(block.typeId, 'minecraft:air');
});
check('владелец строит на своём участке свободно', () => {
    const event = { block: blockAt(alice, 5, 5), player: alice, cancel: false };
    world.beforeEvents.playerBreakBlock.emit(event);
    assert.equal(event.cancel, false);
});
check('налоги начисляются владельцу', () => {
    const before = alice.getDynamicProperty('mc:balance');
    system.advance(12000);
    assert.equal(alice.getDynamicProperty('mc:balance'), before + 25);
});

await openPanel(alice, [0, 3]);                     // Территории -> Продать
check('участок продан через панель с возвратом', () => {
    assert.equal(world.getDynamicProperty('mc:plot.o.0.0'), undefined);
});

// --- 5. Строительство ---
alice.location = { x: 8, y: 64, z: 8 };
await openPanel(alice, [0, 1]);                     // вернуть участок для построек
const lookAt = (p, x, y, z, face = 'Up') => {
    p.viewHit = { block: new Block(x, y, z, p.dimension), face, faceLocation: { x, y, z } };
};

await openPanel(alice, [1, 0]);                     // Строительство -> Каталог (пустой)
check('пустой каталог объясняет, как создать чертёж', () => {
    const catalog = __shown.find((f) => f.title === 'Каталог зданий');
    assert.ok(catalog, 'каталог не открылся');
    assert.ok(catalog.body.includes('Сохранить чертёж'), catalog.body);
});

await openPanel(alice, [1, 1]);                     // Строительство -> Получить чертёж
check('чертёж выдаётся из панели', () => {
    const item = bpItemOf(alice);
    assert.ok(item, 'чертёж не выдан');
    assert.equal(item.typeId, 'minecraft:paper');
});

check('присед + использование отмечают два угла', () => {
    alice.isSneaking = true;
    lookAt(alice, 2, 64, 2);
    world.afterEvents.itemUse.emit({ itemStack: bpItemOf(alice), source: alice });
    lookAt(alice, 6, 67, 5);
    world.afterEvents.itemUse.emit({ itemStack: bpItemOf(alice), source: alice });
    alice.isSneaking = false;
    assert.deepEqual(alice.getDynamicProperty('mc:bp_corner_a'), { x: 2, y: 65, z: 2 });
    assert.deepEqual(alice.getDynamicProperty('mc:bp_corner_b'), { x: 6, y: 68, z: 5 });
});

// Строительство -> Сохранить чертёж, затем модальная форма с полями
await openPanel(alice, [1, 2], [['Домик', '3000']]);
check('модальная форма спрашивает название и стоимость', () => {
    const modal = __shown.find((f) => f.modal);
    assert.ok(modal, 'модальная форма не открылась');
    const labels = modal.fields.map((f) => f.label);
    assert.deepEqual(labels, ['Название постройки', 'Стоимость']);
});
check('чертёж сохранён со снятой структурой', () => {
    const structure = world.structureManager.get('mc:bp_домик');
    assert.ok(structure, 'структура не снята');
    assert.deepEqual(structure.size, { x: 5, y: 4, z: 4 });
    assert.ok(alice.messages.some((m) => m.includes('5×4×4')), 'нет подтверждения габарита');
});
check('разметка углов сброшена после сохранения', () => {
    assert.equal(alice.getDynamicProperty('mc:bp_corner_a'), undefined);
});

// --- 6. Геометрия и приват (чистые функции ядра) ---
const building = await import('../addon/scripts/core/building.js');
const houseBp = { id: 'домик', name: 'Домик', structureId: 'mc:bp_домик', sizeX: 5, sizeY: 4, sizeZ: 4, price: 3000 };

check('габарит растёт от точки установки', () => {
    const box = building.boxAt({ x: 10, y: 64, z: 10 }, houseBp);
    assert.deepEqual(box.max, { x: 14, y: 67, z: 13 });
});
check('контур укладывается в лимит частиц', () => {
    const big = { ...houseBp, sizeX: 60, sizeY: 40, sizeZ: 60 };
    const points = building.boxOutline(building.boxAt({ x: 0, y: 0, z: 0 }, big), 120);
    assert.ok(points.length > 0 && points.length <= 200, `точек ${points.length}`);
});
check('рейкаст выбирает блок у грани взгляда', () => {
    lookAt(alice, 50, 64, 50, 'North');
    assert.deepEqual(building.targetOrigin(alice, 12), { x: 50, y: 64, z: 49 });
});
check('на своём участке строить можно', () => {
    const box = building.boxAt({ x: 4, y: 64, z: 4 }, houseBp);
    assert.equal(building.checkPlot(alice, box, { requireOwnPlot: true }).allowed, true);
});
check('габарит, вылезающий за свой участок, отклоняется', () => {
    const box = building.boxAt({ x: 14, y: 64, z: 4 }, houseBp);
    const result = building.checkPlot(alice, box, { requireOwnPlot: true });
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes('за пределы'), result.reason);
});
check('чужой участок закрыт для постройки', () => {
    bob.location = { x: 300 * 16 + 8, y: 64, z: 8 };
    const territories = world.getDynamicProperty('mc:plot.o.300.0');
    assert.equal(territories, undefined);
    world.setDynamicProperty('mc:plot.o.300.0', `${bob.id}|Bob`);
    const box = building.boxAt({ x: 300 * 16 + 4, y: 64, z: 4 }, houseBp);
    const result = building.checkPlot(alice, box, { requireOwnPlot: true });
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes('Bob'), result.reason);
});

// --- 7. Покупка здания через каталог ---
alice.setDynamicProperty('mc:balance', 100000);
lookAt(alice, 4, 64, 4);
await openPanel(alice, [1, 0, 0, 0]);               // Строительство -> Каталог -> Домик -> Построить
check('здание установлено в точке под курсором', () => {
    const placed = world.structureManager.placements.at(-1);
    assert.ok(placed, 'структура не установлена');
    assert.equal(placed.id, 'mc:bp_домик');
    assert.deepEqual(placed.location, { x: 4, y: 65, z: 4 });
});
check('со счёта списана стоимость здания', () => {
    assert.equal(alice.getDynamicProperty('mc:balance'), 100000 - 3000);
});
// Отмена и запрет: постройки быть не должно ни в одном из случаев.
const placementsBefore = () => world.structureManager.placements.length;

let countBefore = placementsBefore();
let balanceBefore = alice.getDynamicProperty('mc:balance');
lookAt(alice, 4, 64, 4);
await openPanel(alice, [1, 0, 0, 1]);               // ... -> Отмена
check('отмена в подтверждении ничего не строит', () => {
    assert.equal(placementsBefore(), countBefore, 'структура построена вопреки отмене');
    assert.equal(alice.getDynamicProperty('mc:balance'), balanceBefore, 'деньги списаны при отмене');
});

countBefore = placementsBefore();
balanceBefore = alice.getDynamicProperty('mc:balance');
lookAt(alice, 300 * 16 + 4, 64, 4);                 // чужой участок Bob
await openPanel(alice, [1, 0, 0, 0]);               // ... -> Построить
check('на чужом участке подтверждение не строит', () => {
    assert.equal(placementsBefore(), countBefore, 'структура построена на чужом участке');
    assert.equal(alice.getDynamicProperty('mc:balance'), balanceBefore, 'деньги списаны без постройки');
});
check('подтверждение честно сообщает о запрете', () => {
    const confirm = __shown.find((f) => f.title === 'Подтверждение');
    assert.ok(confirm, 'подтверждение не открылось');
    assert.ok(confirm.body.includes('Bob'), confirm.body);
});

lookAt(alice, 4, 64, 4);
await openPanel(alice, [1, 0, 0, 0]);
check('подтверждение показывает габарит и вердикт по участку', () => {
    const confirm = __shown.find((f) => f.title === 'Подтверждение');
    assert.ok(confirm, 'подтверждение не открылось');
    assert.ok(confirm.body.includes('5×4×4'), confirm.body);
    assert.ok(confirm.body.includes('Место подходит'), confirm.body);
});

// --- 8. Голограмма ---
check('контур рисуется только с выбранным чертежом в руке', () => {
    alice.particles.length = 0;
    alice.selectedSlotIndex = alice.container.slots.findIndex((i) => i && i.lore.some(l => l.includes('mc:blueprint')));
    lookAt(alice, 4, 64, 4);
    system.advance(6);
    assert.ok(alice.particles.length > 0, 'контур не нарисован');
    assert.equal(alice.particles[0].effectName, 'minecraft:villager_happy');
});
check('над чужим участком частица становится предупреждающей', () => {
    alice.particles.length = 0;
    lookAt(alice, 300 * 16 + 4, 64, 4);
    system.advance(6);
    assert.ok(alice.particles.length > 0);
    assert.equal(alice.particles[0].effectName, 'minecraft:basic_flame_particle');
});

// --- 9. Игрок ---
alice.location = { x: 0, y: 64, z: 0 };
world.afterEvents.entityDie.emit({ deadEntity: alice, damageSource: { cause: 'fall' } });
alice.location = { x: 500, y: 64, z: 500 };
await openPanel(alice, [2, 0]);                     // Игрок -> Вернуться к месту смерти
check('возврат к месту смерти работает из панели', () => {
    assert.ok(alice.teleports.length > 0, 'телепорта не было');
    assert.deepEqual(alice.teleports.at(-1).loc, { x: 0, y: 64, z: 0 });
});
check('в разделе «Игрок» видны статистика и баланс', () => {
    const menu = __shown.find((f) => f.title === 'Игрок');
    assert.ok(menu, 'раздел не открылся');
    assert.ok(menu.body.includes('В игре'), menu.body);
    assert.ok(menu.body.includes('Баланс'), menu.body);
});

await openPanel(alice, [2, 1]);                     // Игрок -> Стартовый набор
check('повторный стартовый набор не выдаётся', () => {
    assert.ok(alice.messages.some((m) => m.includes('уже был получен')), 'нет отказа');
});

// --- 10. Система ---
await openPanel(alice, [3]);
check('раздел «Система» перечисляет модули с состоянием', () => {
    const menu = __shown.find((f) => f.title === 'Система');
    assert.ok(menu, 'раздел не открылся');
    assert.equal(menu.buttons.length, 9, 'ожидались 8 модулей и кнопка «Назад»');
    assert.ok(menu.body.includes('8'), menu.body);
});
await openPanel(alice, [3, 0]);                     // Система -> первый модуль
check('оператор переключает модуль из панели', () => {
    assert.equal(world.getDynamicProperty('mc:mechanic.device.enabled'), false);
});
// Проверяем это отдельно: модуль device выключен предыдущим шагом, значит
// коммуникатор больше не открывает панель.
__reset();
__queueResponses([0]);
world.afterEvents.itemUse.emit({ itemStack: deviceOf(alice), source: alice });
await pump(6);
check('выключенный модуль перестаёт реагировать на предмет', () => {
    assert.equal(__shown.length, 0, 'панель открылась у выключенного модуля');
});

// Включаем обратно и убеждаемся, что реакция вернулась.
await openPanelRaw(alice, [3, 0]);
__reset();
__queueResponses([]);
world.afterEvents.itemUse.emit({ itemStack: deviceOf(alice), source: alice });
await pump(6);
check('включённый обратно модуль снова работает', () => {
    assert.equal(__shown.length, 1);
    assert.equal(__shown[0].title, 'Коммуникатор');
});

// --- 11. Утечки и остановка ---
const tasksIdle = system.liveTasks;
for (let i = 0; i < 30; i++) {
    world.afterEvents.playerSpawn.emit({ player: bob, initialSpawn: true });
    system.advance(60);
}
check('30 входов не оставили висящих таймеров', () => assert.equal(system.liveTasks, tasksIdle));

check('исключение внутри обработчика перехвачено', () => {
    const broken = __addPlayer(new Player('Broken'));
    Object.defineProperty(broken, 'isValid', { get(){ throw new Error('boom'); } });
    world.afterEvents.entityDie.emit({ deadEntity: broken, damageSource: { cause: 'void' } });
    system.advance(5);
});

system.beforeEvents.shutdown.emit({});
check('shutdown снимает все подписки и задачи', () => {
    assert.equal(system.liveTasks, 0);
    assert.equal(world.afterEvents.entityHurt.count, 0);
    assert.equal(world.beforeEvents.playerBreakBlock.count, 0);
});

console.log('\n' + results.map(([s, n, e]) => `${s === 'PASS' ? '  ok  ' : ' FAIL '} ${n}${e ? ' -> ' + e : ''}`).join('\n'));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed ? 1 : 0);
