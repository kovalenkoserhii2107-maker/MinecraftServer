// Мок Bedrock Script API, достаточный для проверки связности движка.
export class Signal {
  constructor(name){ this.name = name; this.subs = new Set(); }
  subscribe(cb){ this.subs.add(cb); return cb; }
  unsubscribe(cb){ this.subs.delete(cb); }
  emit(ev){ for (const cb of [...this.subs]) cb(ev); }
  get count(){ return this.subs.size; }
}
export const CommandPermissionLevel = { Any:0, GameDirectors:1, Admin:2, Host:3, Owner:4 };
export const CustomCommandParamType = { Enum:'Enum', Boolean:'Boolean', String:'String' };
export const CustomCommandStatus = { Success:0, Failure:1 };
export const GameMode = { Survival:'Survival', Creative:'Creative', Adventure:'Adventure', Spectator:'Spectator' };
export const EntityComponentTypes = { Health:'minecraft:health', Inventory:'minecraft:inventory' };

export class ItemStack { constructor(typeId, amount){ this.typeId = typeId; this.amount = amount; } }

class Props {
  constructor(){ this.p = new Map(); }
  getDynamicProperty(k){ return this.p.get(k); }
  setDynamicProperty(k, v){ if (v === undefined) this.p.delete(k); else this.p.set(k, v); }
}
export class Entity extends Props {}
export class Player extends Entity {
  constructor(name, opts = {}){
    super();
    this.name = name; this.id = `pid-${name}`; this.isValid = true;
    this.commandPermissionLevel = opts.op ? CommandPermissionLevel.Admin : CommandPermissionLevel.Any;
    this.location = opts.location ?? { x: 10.5, y: 64, z: -20.5 };
    this.dimension = { id: 'minecraft:overworld' };
    this.messages = []; this.actionBars = []; this.titles = []; this.sounds = [];
    this.xp = 0; this.teleports = [];
    this.container = { items: [], emptySlotsCount: 36,
      addItem(stack){ this.items.push(stack); this.emptySlotsCount--; } };
    this.health = { currentValue: 20, effectiveMax: 20 };
    this.onScreenDisplay = {
      setActionBar: (t) => this.actionBars.push(t),
      setTitle: (t, o) => this.titles.push({ t, o }),
    };
  }
  getGameMode(){ return GameMode.Survival; }
  getComponent(id){
    if (id === EntityComponentTypes.Inventory) return { container: this.container };
    if (id === EntityComponentTypes.Health) return this.health;
    return undefined;
  }
  sendMessage(m){ this.messages.push(m); }
  playSound(id, o){ this.sounds.push({ id, o }); }
  addExperience(n){ this.xp += n; return this.xp; }
  teleport(loc, opts){ this.teleports.push({ loc, opts }); this.location = loc; }
}

const players = [];
export function __addPlayer(p){ players.push(p); return p; }
export function __players(){ return players; }

class WorldMock extends Props {
  constructor(){
    super();
    this.broadcast = [];
    this.afterEvents = {
      worldLoad: new Signal('worldLoad'), playerSpawn: new Signal('playerSpawn'),
      playerLeave: new Signal('playerLeave'), entityDie: new Signal('entityDie'),
      entityHurt: new Signal('entityHurt'),
    };
    this.beforeEvents = {};
  }
  getAllPlayers(){ return players.filter((p) => p.isValid); }
  sendMessage(m){ this.broadcast.push(m); }
  getDimension(id){ return { id }; }
}
export const world = new WorldMock();

class SystemMock {
  constructor(){
    this.currentTick = 0;
    this.intervals = new Map(); this.timeouts = new Map(); this.pending = [];
    this.nextId = 1;
    this.beforeEvents = { startup: new Signal('startup'), shutdown: new Signal('shutdown') };
    this.afterEvents = { scriptEventReceive: new Signal('scriptEventReceive') };
  }
  run(cb){ const id = this.nextId++; this.pending.push({ id, cb }); return id; }
  runInterval(cb, ticks = 1){ const id = this.nextId++; this.intervals.set(id, { cb, ticks, next: this.currentTick + ticks }); return id; }
  runTimeout(cb, ticks = 1){ const id = this.nextId++; this.timeouts.set(id, { cb, at: this.currentTick + ticks }); return id; }
  clearRun(id){ this.intervals.delete(id); this.timeouts.delete(id); this.pending = this.pending.filter((p) => p.id !== id); }
  waitTicks(){ return Promise.resolve(); }
  /** Прокручивает игровой цикл на n тиков. */
  advance(n){
    for (let i = 0; i < n; i++){
      this.currentTick++;
      const due = this.pending; this.pending = [];
      for (const p of due) p.cb();
      for (const [id, t] of [...this.timeouts]) if (t.at <= this.currentTick) { this.timeouts.delete(id); t.cb(); }
      for (const t of this.intervals.values()) if (t.next <= this.currentTick) { t.next = this.currentTick + t.ticks; t.cb(); }
    }
  }
  get liveTasks(){ return this.intervals.size + this.timeouts.size; }
}
export const system = new SystemMock();

export class CustomCommandRegistry {
  constructor(){ this.commands = new Map(); this.enums = new Map(); }
  registerCommand(def, cb){
    if (this.commands.has(def.name)) throw new Error(`duplicate command ${def.name}`);
    if (!def.name.includes(':')) throw new Error(`command without namespace: ${def.name}`);
    for (const p of [...(def.mandatoryParameters ?? []), ...(def.optionalParameters ?? [])]) {
      if (p.type === CustomCommandParamType.Enum && !this.enums.has(p.name)) {
        throw new Error(`enum param ${p.name} is not registered`);
      }
    }
    this.commands.set(def.name, { def, cb });
  }
  registerEnum(name, values){
    if (!name.includes(':')) throw new Error(`enum without namespace: ${name}`);
    this.enums.set(name, values);
  }
  invoke(name, origin, ...args){
    const entry = this.commands.get(name);
    if (!entry) throw new Error(`unknown command ${name}`);
    return entry.cb(origin, ...args);
  }
}
