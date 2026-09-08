/**
 * Функциональная проверка движка механик на моках Bedrock Script API.
 *
 * Запуск: npm test (сборка выполняется автоматически).
 *
 * Проверяется то, что нельзя проверить компилятором: регистрация команд,
 * порядок фаз запуска, поведение механик, снятие подписок и таймеров при
 * выключении механики и при остановке сервера.
 */
import assert from 'node:assert/strict';
import { system, world, Player, Block, CustomCommandRegistry, CustomCommandStatus, CommandPermissionLevel, ItemLockMode, DisplaySlotId, __addPlayer } from '@minecraft/server';
import { __shown, __queueResponses, __reset } from '@minecraft/server-ui';

await import('../addon/scripts/index.js');

const results = [];
const check = (name, fn) => { try { fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); } };

// --- 1. Фаза startup: регистрация команд ---
const registry = new CustomCommandRegistry();
system.beforeEvents.startup.emit({ customCommandRegistry: registry });

check('команды зарегистрированы', () => {
  const names = [...registry.commands.keys()].sort();
  assert.deepEqual(names, ['mc:back','mc:balance','mc:blueprint','mc:bpdelete','mc:bplist','mc:bpsave',
    'mc:claim','mc:deathpoint','mc:device','mc:help','mc:kit','mc:mechanics','mc:panel','mc:plotinfo',
    'mc:stats','mc:toggle','mc:unclaim'].sort());
});
check('enum механик зарегистрирован до использования', () => {
  assert.deepEqual(registry.enums.get('mc:mechanic_id'),
    ['device','economy','plots','blueprints','welcome','death_beacon','playtime_rewards','combat_feedback','admin_panel']);
  assert.deepEqual(registry.enums.get('mc:plot_size'), ['16x16','32x32']);
});

// --- 2. Команда до загрузки мира отвечает отказом, а не падает ---
const alice = __addPlayer(new Player('Alice', { op: true }));
check('команда до worldLoad -> Failure', () => {
  const r = registry.invoke('mc:stats', { sourceEntity: alice });
  assert.equal(r.status, CustomCommandStatus.Failure);
});

// --- 3. Загрузка мира: активация механик ---
world.afterEvents.worldLoad.emit({});
check('все 9 механик активны', () => {
  const r = registry.invoke('mc:mechanics', { sourceEntity: alice });
  assert.equal(r.status, CustomCommandStatus.Success);
  assert.equal((r.message.match(/вкл/g) ?? []).length, 9);
});

// --- 4. welcome: первый вход выдаёт набор и объявление ---
world.afterEvents.playerSpawn.emit({ player: alice, initialSpawn: true });
system.advance(60);
check('первый вход: объявление в чат', () => {
  assert.ok(world.broadcast.some((m) => m.includes('Alice') && m.includes('впервые')));
});
const kitItems = (p) => p.container.items.filter((i) => i.getDynamicProperty('mc:device') !== true);
check('первый вход: выдан стартовый набор из 4 предметов', () => {
  assert.equal(kitItems(alice).length, 4);
  assert.equal(kitItems(alice)[0].typeId, 'minecraft:bread');
});
check('первый вход: показан заголовок', () => assert.equal(alice.titles.length, 1));

// повторный вход не выдаёт набор второй раз
world.afterEvents.playerSpawn.emit({ player: alice, initialSpawn: true });
system.advance(60);
check('повторный вход: набор не дублируется', () => assert.equal(kitItems(alice).length, 4));
check('/mc:kit после автовыдачи -> Failure', () => {
  assert.equal(registry.invoke('mc:kit', { sourceEntity: alice }).status, CustomCommandStatus.Failure);
});

// --- 5. death_beacon ---
alice.location = { x: 100.7, y: 40, z: -55.2 };
world.afterEvents.entityDie.emit({ deadEntity: alice, damageSource: { cause: 'fall' } });
check('точка смерти сообщена игроку', () => {
  assert.ok(alice.messages.some((m) => m.includes('100, 40, -56')));
});
check('/mc:deathpoint показывает координаты', () => {
  const r = registry.invoke('mc:deathpoint', { sourceEntity: alice });
  assert.equal(r.status, CustomCommandStatus.Success);
  assert.ok(r.message.includes('100, 40, -56'));
});
alice.location = { x: 0, y: 64, z: 0 };
check('/mc:back телепортирует к точке смерти', () => {
  const r = registry.invoke('mc:back', { sourceEntity: alice });
  assert.equal(r.status, CustomCommandStatus.Success);
  system.advance(2);
  assert.equal(alice.teleports.length, 1);
  assert.equal(Math.floor(alice.teleports[0].loc.x), 100);
});
check('второй /mc:back исчерпан -> Failure', () => {
  assert.equal(registry.invoke('mc:back', { sourceEntity: alice }).status, CustomCommandStatus.Failure);
});

// --- 6. playtime_rewards ---
system.advance(1200 * 30);
check('награда за 30 минут выдана', () => {
  assert.equal(alice.xp, 50);
  assert.ok(alice.actionBars.some((b) => b.includes('30 мин')));
});
check('/mc:stats показывает наигранное время', () => {
  const r = registry.invoke('mc:stats', { sourceEntity: alice });
  assert.ok(r.message.includes('30 мин'), r.message);
});

// --- 7. combat_feedback ---
const bob = __addPlayer(new Player('Bob'));
bob.health.currentValue = 4;
world.afterEvents.entityHurt.emit({ hurtEntity: bob, damage: 6, damageSource: { cause: 'entityAttack', damagingEntity: alice } });
check('атакующий видит полосу здоровья цели', () => {
  assert.ok(alice.actionBars.at(-1).includes('Bob'));
  assert.ok(alice.actionBars.at(-1).includes('▮'));
});
check('жертва предупреждена о низком здоровье', () => {
  assert.ok(bob.titles.some((t) => t.t.includes('Мало здоровья')));
});
const titlesBefore = bob.titles.length;
world.afterEvents.entityHurt.emit({ hurtEntity: bob, damage: 1, damageSource: { cause: 'fire' } });
check('антиспам предупреждений работает', () => assert.equal(bob.titles.length, titlesBefore));

// --- 8. admin_panel ---
registry.invoke('mc:panel', { sourceEntity: alice });
system.advance(3);
await new Promise((r) => setImmediate(r));
check('панель показана оператору с разделом механик', () => {
  assert.equal(__shown.length, 1);
  assert.ok(__shown[0].buttons.some((b) => b.includes('Механики')));
});


// --- 8a. device: коммуникатор у каждого игрока ---
const deviceOf = (p) => p.container.items.find((i) => i.getDynamicProperty('mc:device') === true);

check('коммуникатор выдан при входе', () => {
  const d = deviceOf(alice);
  assert.ok(d, 'коммуникатор не найден в инвентаре');
  assert.equal(d.typeId, 'minecraft:clock');
  assert.ok(d.nameTag.includes('Коммуникатор'));
});
check('коммуникатор не теряется при смерти и не выбрасывается', () => {
  const d = deviceOf(alice);
  assert.equal(d.keepOnDeath, true);
  assert.equal(d.lockMode, ItemLockMode.inventory);
});
check('повторный вход не плодит вторую копию', () => {
  world.afterEvents.playerSpawn.emit({ player: alice, initialSpawn: true });
  system.advance(60);
  const devices = alice.container.items.filter((i) => i.getDynamicProperty('mc:device') === true);
  assert.equal(devices.length, 1);
});
check('/mc:device при наличии предмета не выдаёт второй', () => {
  registry.invoke('mc:device', { sourceEntity: alice });
  system.advance(2);
  const devices = alice.container.items.filter((i) => i.getDynamicProperty('mc:device') === true);
  assert.equal(devices.length, 1);
  assert.ok(alice.messages.at(-1).includes('уже у вас'));
});

// Использование предмета открывает ту же панель, что и команда.
__reset();
check('использование коммуникатора открывает панель', () => {
  world.afterEvents.itemUse.emit({ itemStack: deviceOf(alice), source: alice });
  system.advance(2);
});
await new Promise((r) => setImmediate(r));
check('панель открыта именно коммуникатором', () => {
  assert.equal(__shown.length, 1);
  assert.equal(__shown[0].title, 'Панель сервера');
});

__reset();
check('посторонний предмет панель не открывает', () => {
  // Именно предмет из набора: коммуникатор выдаётся первым и лежит в слоте 0.
  world.afterEvents.itemUse.emit({ itemStack: kitItems(alice)[0], source: alice });
  system.advance(2);
});
await new Promise((r) => setImmediate(r));
check('обычный предмет проигнорирован', () => assert.equal(__shown.length, 0));

// Навигация по меню: главное меню -> «Механики» -> переключение первой механики.
__reset();
__queueResponses([3, 0]);  // 0 команды, 1 участки, 2 чертёж, 3 механики
check('через панель переключается механика', () => {
  world.afterEvents.itemUse.emit({ itemStack: deviceOf(alice), source: alice });
  system.advance(2);
});
await new Promise((r) => setImmediate(r));
system.advance(2);
await new Promise((r) => setImmediate(r));
check('открылось меню механик и состояние изменилось', () => {
  assert.ok(__shown.length >= 2, `показано форм: ${__shown.length}`);
  assert.equal(__shown[1].title, 'Механики сервера');
  assert.equal(world.getDynamicProperty('mc:mechanic.device.enabled'), false);
});
// Возвращаем механику, чтобы не влиять на дальнейшие проверки.
registry.invoke('mc:toggle', { sourceEntity: alice }, 'device', true);
system.advance(2);

check('игрок без места в инвентаре получает подсказку', () => {
  const full = __addPlayer(new Player('Full', { inventorySize: 1 }));
  full.container.addItem({ typeId: 'minecraft:stone', getDynamicProperty: () => undefined });
  world.afterEvents.playerSpawn.emit({ player: full, initialSpawn: true });
  system.advance(60);
  assert.ok(full.messages.some((m) => m.includes('/mc:device')));
});


// --- 8b. Криптогривна ---
check('стартовый капитал начислен при первом входе', () => {
  assert.equal(alice.getDynamicProperty('mc:balance'), 100000);
  assert.ok(alice.messages.some((m) => m.includes('стартовый капитал')));
});
check('баланс виден на боковой панели', () => {
  const objective = world.scoreboard.slots.get(DisplaySlotId.Sidebar);
  assert.ok(objective, 'табло не занимает боковой слот');
  assert.equal(objective.getScore(alice), 100000);
});
check('/mc:balance показывает сумму с разделителями', () => {
  const r = registry.invoke('mc:balance', { sourceEntity: alice });
  assert.equal(r.status, CustomCommandStatus.Success);
  // Разряды разделяются неразрывным пробелом, чтобы число не переносилось в UI.
  assert.ok(r.message.includes('100\u00A0000'), JSON.stringify(r.message));
});

// --- 8c. Участки: покупка и защита ---
const blockAt = (p, x, z) => new Block(x, 64, z, p.dimension);

alice.location = { x: 8, y: 64, z: 8 };   // чанк 0,0
bob.location = { x: 8, y: 64, z: 8 };

check('/mc:claim покупает участок 16x16 и списывает цену', () => {
  const r = registry.invoke('mc:claim', { sourceEntity: alice }, '16x16');
  assert.equal(r.status, CustomCommandStatus.Success, r.message);
  assert.equal(alice.getDynamicProperty('mc:balance'), 100000 - 5000);
  assert.equal(world.getDynamicProperty('mc:plot.o.0.0'), `${alice.id}|Alice`);
});
check('повторная покупка своего же участка отклоняется', () => {
  const r = registry.invoke('mc:claim', { sourceEntity: alice }, '16x16');
  assert.equal(r.status, CustomCommandStatus.Failure);
  assert.ok(r.message.includes('уже ваш'));
});
check('чужой участок купить нельзя', () => {
  const r = registry.invoke('mc:claim', { sourceEntity: bob }, '16x16');
  assert.equal(r.status, CustomCommandStatus.Failure);
  assert.ok(r.message.includes('Alice'), r.message);
});

check('владелец ломает блок на своём участке', () => {
  const event = { block: blockAt(alice, 5, 5), player: alice, cancel: false };
  world.beforeEvents.playerBreakBlock.emit(event);
  assert.equal(event.cancel, false);
});
check('чужой не может ломать блок на участке', () => {
  const event = { block: blockAt(bob, 5, 5), player: bob, cancel: false };
  world.beforeEvents.playerBreakBlock.emit(event);
  assert.equal(event.cancel, true);
  system.advance(2);
  assert.ok(bob.messages.some((m) => m.includes('частная собственность')));
});
check('чужой не может взаимодействовать с блоком', () => {
  const event = { block: blockAt(bob, 5, 5), player: bob, cancel: false, isFirstEvent: true };
  world.beforeEvents.playerInteractWithBlock.emit(event);
  assert.equal(event.cancel, true);
});
check('за пределами участка ограничений нет', () => {
  const event = { block: blockAt(bob, 100, 100), player: bob, cancel: false };
  world.beforeEvents.playerBreakBlock.emit(event);
  assert.equal(event.cancel, false);
});
check('блок, поставленный чужим на участке, снимается', () => {
  const block = blockAt(bob, 7, 7);
  world.afterEvents.playerPlaceBlock.emit({ block, player: bob });
  system.advance(2);
  assert.equal(block.typeId, 'minecraft:air');
});
check('блок владельца на своём участке остаётся', () => {
  const block = blockAt(alice, 7, 7);
  world.afterEvents.playerPlaceBlock.emit({ block, player: alice });
  system.advance(2);
  assert.equal(block.typeId, 'minecraft:stone');
});

// --- 8d. Участок 32x32 занимает выровненный квадрат 2x2 чанка ---
const carl = __addPlayer(new Player('Carl'));
world.afterEvents.playerSpawn.emit({ player: carl, initialSpawn: true });
system.advance(60);
carl.location = { x: 8 * 16 + 5, y: 64, z: 9 * 16 + 5 };  // чанк 8,9

check('/mc:claim 32x32 занимает четыре чанка по чётной сетке', () => {
  const r = registry.invoke('mc:claim', { sourceEntity: carl }, '32x32');
  assert.equal(r.status, CustomCommandStatus.Success, r.message);
  for (const key of ['mc:plot.o.8.8','mc:plot.o.8.9','mc:plot.o.9.8','mc:plot.o.9.9']) {
    assert.ok(world.getDynamicProperty(key), `не занят чанк ${key}`);
  }
  assert.equal(carl.getDynamicProperty('mc:balance'), 100000 - 18000);
});
check('не хватает средств — покупка отклоняется', () => {
  carl.setDynamicProperty('mc:balance', 10);
  carl.location = { x: 500, y: 64, z: 500 };
  const r = registry.invoke('mc:claim', { sourceEntity: carl }, '16x16');
  assert.equal(r.status, CustomCommandStatus.Failure);
  assert.ok(r.message.includes('Не хватает'), r.message);
});

// --- 8e. Налоги и продажа ---
check('налоги начисляются по числу чанков', () => {
  carl.setDynamicProperty('mc:balance', 0);
  system.advance(12000);
  assert.equal(carl.getDynamicProperty('mc:balance'), 4 * 25);
  assert.ok(carl.messages.some((m) => m.includes('Налоги')));
});
check('/mc:unclaim возвращает часть средств и снимает владение', () => {
  alice.location = { x: 8, y: 64, z: 8 };
  const before = alice.getDynamicProperty('mc:balance');
  const r = registry.invoke('mc:unclaim', { sourceEntity: alice });
  assert.equal(r.status, CustomCommandStatus.Success);
  system.advance(2);
  assert.equal(world.getDynamicProperty('mc:plot.o.0.0'), undefined);
  assert.equal(alice.getDynamicProperty('mc:balance'), before + 2500);
});
check('после продажи чужой снова может строить', () => {
  const event = { block: blockAt(bob, 5, 5), player: bob, cancel: false };
  world.beforeEvents.playerBreakBlock.emit(event);
  assert.equal(event.cancel, false);
});
check('/mc:plotinfo сообщает владельца', () => {
  carl.location = { x: 8 * 16 + 5, y: 64, z: 9 * 16 + 5 };
  const r = registry.invoke('mc:plotinfo', { sourceEntity: carl });
  assert.ok(r.message.includes('Carl'), r.message);
});

// --- 8f. Карта участков ---
__reset();
__queueResponses([1]);
check('в панели открывается карта участков', () => {
  world.afterEvents.itemUse.emit({ itemStack: deviceOf(carl), source: carl });
  system.advance(2);
});
await new Promise((r) => setImmediate(r));
system.advance(2);
await new Promise((r) => setImmediate(r));
check('карта показывает свой участок и легенду', () => {
  const map = __shown.find((f) => f.title === 'Участки');
  assert.ok(map, 'меню участков не открылось');
  assert.ok(map.body.includes('▣'), 'нет отметки положения игрока');
  assert.ok(map.body.includes('свободно'), 'нет легенды');
  assert.ok(map.body.includes('Ваших чанков: '), 'нет счётчика владений');
});


// --- 8g. Чертежи ---
const dave = __addPlayer(new Player('Dave', { op: true }));
world.afterEvents.playerSpawn.emit({ player: dave, initialSpawn: true });
system.advance(60);
dave.setDynamicProperty('mc:balance', 100000);

const bpItem = () => dave.container.items.find((i) => i.getDynamicProperty('mc:blueprint') === true);
const lookAt = (p, x, y, z, face = 'Up') => {
  p.viewHit = { block: new Block(x, y, z, p.dimension), face, faceLocation: { x, y, z } };
};

check('/mc:blueprint выдаёт защищённый предмет', () => {
  registry.invoke('mc:blueprint', { sourceEntity: dave });
  system.advance(2);
  const item = bpItem();
  assert.ok(item, 'чертёж не выдан');
  assert.equal(item.typeId, 'minecraft:paper');
  assert.ok(item.nameTag.includes('Чертёж'));
});

check('присед + использование отмечают углы области', () => {
  dave.isSneaking = true;
  lookAt(dave, 100, 64, 100);
  world.afterEvents.itemUse.emit({ itemStack: bpItem(), source: dave });
  system.advance(2);
  lookAt(dave, 104, 67, 103);
  world.afterEvents.itemUse.emit({ itemStack: bpItem(), source: dave });
  system.advance(2);
  dave.isSneaking = false;
  assert.deepEqual(dave.getDynamicProperty('mc:bp_corner_a'), { x: 100, y: 65, z: 100 });
  assert.deepEqual(dave.getDynamicProperty('mc:bp_corner_b'), { x: 104, y: 68, z: 103 });
});

check('/mc:bpsave снимает структуру и регистрирует чертёж', () => {
  const r = registry.invoke('mc:bpsave', { sourceEntity: dave }, 'Домик', 3000);
  assert.equal(r.status, CustomCommandStatus.Success, r.message);
  system.advance(2);
  const structure = world.structureManager.get('mc:bp_домик');
  assert.ok(structure, 'структура не снята');
  assert.deepEqual(structure.size, { x: 5, y: 4, z: 4 });
  assert.ok(dave.messages.some((m) => m.includes('5×4×4')), 'нет подтверждения габарита');
});

check('/mc:bplist показывает чертёж с ценой', () => {
  const r = registry.invoke('mc:bplist', { sourceEntity: dave });
  assert.ok(r.message.includes('Домик'), r.message);
  assert.ok(r.message.includes('3'), r.message);
});

check('слишком большая область отклоняется', () => {
  dave.setDynamicProperty('mc:bp_corner_a', { x: 0, y: 0, z: 0 });
  dave.setDynamicProperty('mc:bp_corner_b', { x: 200, y: 10, z: 10 });
  const r = registry.invoke('mc:bpsave', { sourceEntity: dave }, 'Огромный', 1);
  assert.equal(r.status, CustomCommandStatus.Failure);
  assert.ok(r.message.includes('64'), r.message);
});

// Габарит и контур считаются чистыми функциями — проверяем их напрямую.
const { boxAt, boxOutline, checkPlot, targetOrigin } = await import('../addon/scripts/mechanics/blueprints.js');
const houseBp = { id:'домик', name:'Домик', structureId:'mc:bp_домик', sizeX:5, sizeY:4, sizeZ:4, price:3000 };

check('габарит растёт от точки установки', () => {
  const box = boxAt({ x: 10, y: 64, z: 10 }, houseBp);
  assert.deepEqual(box.min, { x: 10, y: 64, z: 10 });
  assert.deepEqual(box.max, { x: 14, y: 67, z: 13 });
});
check('контур укладывается в лимит частиц', () => {
  const big = { ...houseBp, sizeX: 60, sizeY: 40, sizeZ: 60 };
  const points = boxOutline(boxAt({ x: 0, y: 0, z: 0 }, big), 120);
  assert.ok(points.length <= 200, `точек ${points.length}`);
  assert.ok(points.length > 0);
});
check('рейкаст выбирает блок у грани, на которую смотрит игрок', () => {
  lookAt(dave, 50, 64, 50, 'Up');
  assert.deepEqual(targetOrigin(dave, 12), { x: 50, y: 65, z: 50 });
  lookAt(dave, 50, 64, 50, 'North');
  assert.deepEqual(targetOrigin(dave, 12), { x: 50, y: 64, z: 49 });
});

// --- 8h. Приват: главное требование ---
const bpConfig = { requireOwnPlot: true };

check('на своём участке строить можно', () => {
  dave.location = { x: 8, y: 64, z: 8 };
  registry.invoke('mc:claim', { sourceEntity: dave }, '16x16');
  const box = boxAt({ x: 4, y: 64, z: 4 }, houseBp);
  assert.equal(checkPlot(dave, box, bpConfig).allowed, true);
});
check('габарит, вылезающий за свой участок, отклоняется', () => {
  // Дом 5 блоков шириной от x=14 уходит в соседний чанк.
  const box = boxAt({ x: 14, y: 64, z: 4 }, houseBp);
  const result = checkPlot(dave, box, bpConfig);
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes('за пределы'), result.reason);
});
check('на чужом участке строить нельзя', () => {
  alice.location = { x: 200 * 16 + 8, y: 64, z: 8 };
  registry.invoke('mc:claim', { sourceEntity: alice }, '16x16');
  const box = boxAt({ x: 200 * 16 + 4, y: 64, z: 4 }, houseBp);
  const result = checkPlot(dave, box, bpConfig);
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes('Alice'), result.reason);
});
check('без требования участка ничейная земля разрешена', () => {
  const box = boxAt({ x: 900, y: 64, z: 900 }, houseBp);
  assert.equal(checkPlot(dave, box, { requireOwnPlot: false }).allowed, true);
});

// --- 8i. Голограмма и постройка ---
check('голограмма рисуется только с выбранным чертежом в руке', () => {
  dave.particles.length = 0;
  dave.location = { x: 8, y: 64, z: 8 };
  lookAt(dave, 4, 64, 4);
  system.advance(6);
  assert.equal(dave.particles.length, 0, 'чертёж не выбран — частиц быть не должно');

  dave.setDynamicProperty('mc:bp_selected', 'домик');
  dave.selectedSlotIndex = dave.container.slots.findIndex((i) => i && i.getDynamicProperty('mc:blueprint'));
  system.advance(6);
  assert.ok(dave.particles.length > 0, 'контур не нарисован');
  assert.equal(dave.particles[0].effectName, 'minecraft:villager_happy');
});
check('над чужим участком контур меняет частицу на предупреждающую', () => {
  dave.particles.length = 0;
  lookAt(dave, 200 * 16 + 4, 64, 4);
  system.advance(6);
  assert.ok(dave.particles.length > 0);
  assert.equal(dave.particles[0].effectName, 'minecraft:basic_flame_particle');
});

__reset();
__queueResponses([0, 0]);   // выбрать «Домик», затем «Построить»
check('покупка через меню ставит структуру и списывает цену', () => {
  dave.particles.length = 0;
  lookAt(dave, 4, 64, 4);
  dave.setDynamicProperty('mc:balance', 100000);
  world.afterEvents.itemUse.emit({ itemStack: bpItem(), source: dave });
  system.advance(2);
});
await new Promise((r) => setImmediate(r));
system.advance(2);
await new Promise((r) => setImmediate(r));
system.advance(2);
check('структура установлена в точке под курсором', () => {
  const placed = world.structureManager.placements.at(-1);
  assert.ok(placed, 'структура не установлена');
  assert.equal(placed.id, 'mc:bp_домик');
  assert.deepEqual(placed.location, { x: 4, y: 65, z: 4 });
});
check('со счёта списана стоимость здания', () => {
  assert.equal(dave.getDynamicProperty('mc:balance'), 100000 - 3000);
});

// --- 9. Отключение механики снимает подписки и таймеры ---
const tasksBefore = system.liveTasks;
const subsBefore = world.afterEvents.entityHurt.count;
check('/mc:toggle выключает механику', () => {
  const r = registry.invoke('mc:toggle', { sourceEntity: alice }, 'combat_feedback', false);
  assert.equal(r.status, CustomCommandStatus.Success);
  system.advance(2);
  assert.equal(world.afterEvents.entityHurt.count, subsBefore - 1);
});
check('команда выключенной механики отвечает отказом', () => {
  registry.invoke('mc:toggle', { sourceEntity: alice }, 'playtime_rewards', false);
  system.advance(2);
  const r = registry.invoke('mc:stats', { sourceEntity: alice });
  assert.equal(r.status, CustomCommandStatus.Failure);
});
check('интервал выключенной механики снят', () => assert.ok(system.liveTasks < tasksBefore));
check('состояние сохранено в мире', () => {
  assert.equal(world.getDynamicProperty('mc:mechanic.combat_feedback.enabled'), false);
});
check('/mc:toggle включает обратно', () => {
  registry.invoke('mc:toggle', { sourceEntity: alice }, 'combat_feedback', true);
  system.advance(2);
  assert.equal(world.afterEvents.entityHurt.count, subsBefore);
});

// --- 10. Утечки: разовые таймеры не копятся, Map чистится по выходу ---
const tasksIdle = system.liveTasks;
for (let i = 0; i < 50; i++) { world.afterEvents.playerSpawn.emit({ player: bob, initialSpawn: true }); system.advance(60); }
check('50 входов не оставили висящих таймеров', () => assert.equal(system.liveTasks, tasksIdle));

// --- 11. Ошибка в обработчике не роняет тик ---
const broken = __addPlayer(new Player('Broken'));
Object.defineProperty(broken, 'isValid', { get(){ throw new Error('boom'); } });
check('исключение внутри обработчика перехвачено', () => {
  world.afterEvents.entityDie.emit({ deadEntity: broken, damageSource: { cause: 'void' } });
  system.advance(5);
});

// --- 12. Корректная остановка ---
system.beforeEvents.shutdown.emit({});
check('shutdown снимает все подписки и задачи', () => {
  assert.equal(system.liveTasks, 0);
  assert.equal(world.afterEvents.entityHurt.count, 0);
  assert.equal(world.afterEvents.entityDie.count, 0);
});

console.log('\n' + results.map(([s, n, e]) => `${s === 'PASS' ? '  ok  ' : ' FAIL '} ${n}${e ? ' -> ' + e : ''}`).join('\n'));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed ? 1 : 0);
