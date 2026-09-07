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
import { system, world, Player, CustomCommandRegistry, CustomCommandStatus, CommandPermissionLevel, __addPlayer } from '@minecraft/server';
import { __shown } from '@minecraft/server-ui';

await import('../addon/scripts/index.js');

const results = [];
const check = (name, fn) => { try { fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); } };

// --- 1. Фаза startup: регистрация команд ---
const registry = new CustomCommandRegistry();
system.beforeEvents.startup.emit({ customCommandRegistry: registry });

check('команды зарегистрированы', () => {
  const names = [...registry.commands.keys()].sort();
  assert.deepEqual(names, ['mc:back','mc:deathpoint','mc:help','mc:kit','mc:mechanics','mc:panel','mc:stats','mc:toggle']);
});
check('enum механик зарегистрирован до использования', () => {
  assert.deepEqual(registry.enums.get('mc:mechanic_id'),
    ['welcome','death_beacon','playtime_rewards','combat_feedback','admin_panel']);
});

// --- 2. Команда до загрузки мира отвечает отказом, а не падает ---
const alice = __addPlayer(new Player('Alice', { op: true }));
check('команда до worldLoad -> Failure', () => {
  const r = registry.invoke('mc:stats', { sourceEntity: alice });
  assert.equal(r.status, CustomCommandStatus.Failure);
});

// --- 3. Загрузка мира: активация механик ---
world.afterEvents.worldLoad.emit({});
check('все 5 механик активны', () => {
  const r = registry.invoke('mc:mechanics', { sourceEntity: alice });
  assert.equal(r.status, CustomCommandStatus.Success);
  assert.equal((r.message.match(/вкл/g) ?? []).length, 5);
});

// --- 4. welcome: первый вход выдаёт набор и объявление ---
world.afterEvents.playerSpawn.emit({ player: alice, initialSpawn: true });
system.advance(60);
check('первый вход: объявление в чат', () => {
  assert.ok(world.broadcast.some((m) => m.includes('Alice') && m.includes('впервые')));
});
check('первый вход: выдан стартовый набор из 4 предметов', () => {
  assert.equal(alice.container.items.length, 4);
  assert.equal(alice.container.items[0].typeId, 'minecraft:bread');
});
check('первый вход: показан заголовок', () => assert.equal(alice.titles.length, 1));

// повторный вход не выдаёт набор второй раз
world.afterEvents.playerSpawn.emit({ player: alice, initialSpawn: true });
system.advance(60);
check('повторный вход: набор не дублируется', () => assert.equal(alice.container.items.length, 4));
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
