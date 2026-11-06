const assert = require('assert');
const mocks = require('./mock-screeps');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function setup(capacity = 300, available = capacity) {
    mocks.installGlobals(); mocks.clearLocalModules();
    delete global.__sushiEconomy; delete global.__sushiCapacity;
    global.HARVEST_POWER = 2; global.ENERGY_REGEN_TIME = 300;
    global.CREEP_LIFE_TIME = 1500; global.CREEP_CLAIM_LIFE_TIME = 600;
    global.BODYPART_COST = { work: 100, carry: 50, move: 50 };
    const room = { name: 'W3S47', energyAvailable: available, energyCapacityAvailable: capacity,
        controller: { my: true, level: 3, ticksToDowngrade: 20000, pos: new RoomPosition(25, 25, 'W3S47') },
        getTerrain: () => Game.map.getRoomTerrain('W3S47'), sites: [], structures: [],
        find(type) {
            if (type === FIND_SOURCES) return this.sources;
            if ([FIND_STRUCTURES, FIND_MY_STRUCTURES].includes(type)) return this.structures;
            if ([FIND_MY_CONSTRUCTION_SITES, FIND_CONSTRUCTION_SITES].includes(type)) return this.sites;
            if (type === FIND_MY_SPAWNS) return [Game.spawns.Spawn1];
            return [];
        } };
    room.sources = ['A', 'B'].map((id, i) => ({ id, room, energyCapacity: 3000, energy: 3000,
        pos: new RoomPosition(10 + i * 20, 10, room.name) }));
    const seats = (source, count) => {
        const result = [];
        for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) {
            if (x || y) result.push({ x: source.pos.x + x, y: source.pos.y + y, roomName: room.name });
        }
        return result.slice(0, count);
    };
    Game.rooms[room.name] = room;
    Memory.rooms[room.name] = { spawn: { queue: [] }, sources: Object.fromEntries(room.sources.map((source, i) =>
        [source.id, { id: source.id, assignedMiner: [], seats: seats(source, i ? 6 : 1), seatCount: i ? 6 : 1 }])) };
    const calls = [];
    const spawn = Game.spawns.Spawn1 = { name: 'Spawn1', id: 'spawn', structureType: STRUCTURE_SPAWN,
        my: true, hits: 5000, isActive: () => true, room, pos: new RoomPosition(24, 25, room.name),
        store: { getCapacity: () => 300 }, spawning: null,
        spawnCreep(body, name, options) {
            calls.push({ body, name, memory: options.memory });
            this.spawning = { name, remainingTime: body.length * 3 };
            Memory.creeps[name] = options.memory; return OK;
        } };
    room.structures.push(spawn);
    for (let energy = 300; energy < capacity; energy += 50) room.structures.push({ id: 'ext' + energy,
        my: true, hits: 1000, isActive: () => true, structureType: STRUCTURE_EXTENSION,
        store: { getCapacity: () => 50 }, pos: new RoomPosition(20, 20, room.name) });
    Game.getObjectById = id => room.sources.find(s => s.id === id) || room.structures.find(s => s.id === id) || Game.creeps[id] || null;
    const config = require('HiveMind.Memory').getConfig('spawn');
    config.maxNewRequestsPerRoomPerTick = 10;
    function miner(name, work, id = 'A', ttl = 1200) {
        const seat = Memory.rooms[room.name].sources[id].seats[0];
        const c = { name, id: name, my: true, room, ticksToLive: ttl, spawning: false,
            memory: { role: 'Extractor', homeRoom: room.name, sourceId: id, sourceRoom: room.name,
                targetRoom: room.name, miningSeat: { ...seat, sourceId: id }, miningSeatKey: room.name + ':' + seat.x + ':' + seat.y },
            body: [...Array(work).fill(WORK), CARRY, MOVE].map(type => ({ type, hits: 100 })),
            pos: new RoomPosition(seat.x, seat.y, room.name),
            getActiveBodyparts(type) { return this.body.filter(p => p.type === type && p.hits > 0).length; },
            store: { energy: 0, getFreeCapacity: () => 50, getCapacity: () => 50 },
            setWorkingArea() {}, moveTo: () => OK, harvest: () => OK, transfer: () => OK };
        Game.creeps[name] = c; Memory.creeps[name] = c.memory;
        Memory.rooms[room.name].sources[id].assignedMiner.push(name);
        return c;
    }
    function core() {
        for (const [name, role, count, part] of [['foreman', 'Foreman', 2, CARRY], ['hauler', 'Freighter', 40, CARRY]]) {
            const c = miner(name, 0); c.memory = { role, homeRoom: room.name };
            c.body = [...Array(count).fill(part), MOVE].map(type => ({ type, hits: 100 }));
        }
    }
    function sample() { delete global.__sushiTickIndex; return require('HiveMind.Economy').updateRoom(room); }
    function plan() {
        return require('spawn.request.manager').requestDynamicExtractorsForRoom(room, 110);
    }
    function describe(id = 'A') {
        return sample().harvest.sources.find(s => s.id === id);
    }
    return { room, spawn, calls, miner, core, sample, plan, describe,
        queue: Memory.rooms[room.name].spawn.queue, memory: Memory.rooms[room.name] };
}

if (require.main === module) {
test('1 one-seat source distinguishes required, achievable, active and planned WORK', () => {
    const f = setup(); f.miner('weak', 1);
    const row = f.describe();
    assert.deepStrictEqual([row.workRequired, row.maxAchievableWork, row.workActive, row.stationedWork, row.plannedWork], [5, 2, 1, 1, 1]);
    assert.strictEqual(row.seatCount, 1); assert.strictEqual(row.action.replacementFor, 'weak');
});
test('2 six-seat source counts mixed active parts and excludes destroyed WORK', () => {
    const f = setup(); f.miner('first', 2, 'B'); const second = f.miner('second', 4, 'B');
    second.body[0].hits = 0;
    const row = f.describe('B'); assert.strictEqual(row.workActive, 5);
    assert.strictEqual(row.maxAchievableWork, 5); assert.strictEqual(row.action, null);
});
test('3 300 energy chooses two WORK, CARRY and MOVE; 200 permits emergency one WORK', () => {
    const f = setup(), planning = require('Harvest.Planning');
    assert.deepStrictEqual(planning.body(f.room, 5).body, [WORK, WORK, MOVE, CARRY]);
    assert.strictEqual(planning.body(f.room, 5, 200).WORK, 1);
    assert.strictEqual(planning.body(f.room, 5, 199), null);
});
test('4 extensions enable a five-WORK replacement for a full one-seat source', () => {
    const f = setup(700); f.core(); f.miner('weak', 2); f.miner('other', 5, 'B'); f.sample();
    assert.strictEqual(f.plan().requested, 1);
    assert.deepStrictEqual(f.queue[0].replacementFor, ['weak']);
    assert.strictEqual(f.queue[0].requestedWorkParts, 5);
    assert.strictEqual(require('spawn.manager').runRoom(f.room.name).result, OK);
    assert.strictEqual(f.calls[0].body.filter(p => p === WORK).length, 5);
});
test('5 full 300-energy idle spawn reports capacity constraint instead of redundant miners', () => {
    const f = setup(); f.core(); f.miner('first', 2); for (let i = 0; i < 5; i++) f.miner('b' + i, 1, 'B');
    const s = f.sample(); assert.strictEqual(s.harvest.workActive, 7);
    assert.strictEqual(f.plan().requested, 0); assert.strictEqual(f.queue.length, 0);
    assert.strictEqual(f.describe().constraint, 'SPAWN_CAPACITY');
    assert.match(f.describe().planningReason, /insufficient maximum/);
});
test('6 underpowered unique-seat miner upgrades once without double-counting planned WORK', () => {
    const f = setup(); f.core(); f.miner('weak', 1); f.miner('other', 5, 'B'); f.sample();
    assert.strictEqual(f.plan().requested, 1); assert.strictEqual(f.plan().requested, 0);
    const row = f.describe(); assert.strictEqual(row.workActive, 1); assert.strictEqual(row.workQueued, 2);
    assert.strictEqual(row.plannedWork, 2); assert.strictEqual(row.replacementStatus, 'PENDING');
});
test('7 spawning replacement reserves source even before Game.creeps exposes it', () => {
    const f = setup(); f.core(); f.miner('weak', 1); f.miner('other', 5, 'B'); f.sample(); f.plan();
    assert.strictEqual(require('spawn.manager').runRoom(f.room.name).result, OK);
    Game.time++; const row = f.describe();
    assert.strictEqual(row.workSpawning, 2); assert.strictEqual(row.workActive, 1);
    assert.strictEqual(row.plannedWork, 2); assert.strictEqual(f.plan().requested, 0);
});
test('8 blocked handoff times out without retiring incumbent; cooldown prevents loops', () => {
    const f = setup(); const old = f.miner('old', 1), next = f.miner('next', 2);
    next.pos = new RoomPosition(6, 6, f.room.name); next.memory.extractorReplacementFor = old.name;
    next.memory.extractorHandoffStarted = Game.time - 151;
    const helper = require('utility.Creep'); assert.strictEqual(helper.runExtractorLifecycle(next), true);
    assert.ok(!old.memory.extractorRetiring); assert.ok(next.memory.extractorReplacementAborted);
    assert.ok(f.memory.sources.A.upgradeRetryAt > Game.time);
    const row = f.describe(); assert.strictEqual(row.workActive, 1); assert.strictEqual(row.action, null);
});
test('9 recovery stays unhealthy when infrastructure limits harvesting', () => {
    const f = setup(); f.core(); f.miner('a', 2); f.miner('b', 5, 'B'); const snapshot = f.sample();
    assert.strictEqual(snapshot.state, 'RECOVERY');
    assert.strictEqual(require('HiveMind.Economy').localHarvestCoverage(snapshot).status, 'MISSING');
    assert.strictEqual(snapshot.harvest.infrastructureRecovery, true);
});
test('10 infrastructure escape permits bounded construction and minimum sustainable growth', () => {
    const f = setup(); f.core(); f.miner('a', 2); f.miner('b', 5, 'B');
    const snapshot = f.sample(), colony = require('HiveMind.ColonyState').update(f.room);
    assert.strictEqual(colony.growthAllowed, true); assert.strictEqual(colony.coreFloor.complete, false);
    assert.strictEqual(snapshot.growth.mode, 'GROWTH_MINIMUM');
    assert.strictEqual(snapshot.growth.affordableWork, 1);
    assert.strictEqual(require('HiveMind.Economy').canSpend(f.room, 'criticalInfrastructure'), true);
    f.room.sites.push({ id: 'site', my: true, structureType: STRUCTURE_EXTENSION, pos: new RoomPosition(20, 20, f.room.name), progress: 0, progressTotal: 3000 });
    const manager = require('spawn.request.manager');
    const demand = manager.getArtificerBuildDemand(f.room);
    const result = manager.requestDynamicArtificersForRoom(f.room, demand);
    assert.strictEqual(result.requested, 1);
    assert.strictEqual(f.queue[0].economyCategory, 'criticalInfrastructure');
    assert.ok(f.queue[0].requestedWorkParts <= 2);
});
test('11 emergency miner uses current energy immediately when no income exists', () => {
    const f = setup(700, 200); f.sample(); f.plan();
    assert.strictEqual(require('spawn.manager').runRoom(f.room.name).result, OK);
    assert.strictEqual(f.calls[0].body.filter(p => p === WORK).length, 1);
    assert.strictEqual(require('BodyProfiles').cost(f.calls[0].body), 200);
});
test('12 preferred energy never arrives: bounded wait releases to a useful upgrade', () => {
    const f = setup(700, 300); f.core(); f.miner('old', 1); f.miner('b', 5, 'B'); f.sample(); f.plan();
    const manager = require('spawn.manager'); assert.strictEqual(manager.runRoom(f.room.name).result, ERR_NOT_ENOUGH_ENERGY);
    const deadline = f.queue[0].spawnSizing.deadline;
    for (; Game.time < deadline; Game.time++) {
        f.sample(); assert.notStrictEqual(manager.runRoom(f.room.name).result, OK);
        assert.strictEqual(f.queue[0].spawnSizing.deadline, deadline);
    }
    f.sample(); assert.strictEqual(manager.runRoom(f.room.name).result, OK);
    assert.strictEqual(f.calls[0].body.filter(p => p === WORK).length, 2);
});
test('13 incumbent death preserves replacement and lets successor claim the unique seat', () => {
    const f = setup(); const old = f.miner('old', 1); const next = f.miner('next', 2);
    next.memory.extractorReplacementFor = old.name; delete Game.creeps.old;
    const helper = require('utility.Creep'); assert.strictEqual(helper.runExtractorLifecycle(next), false);
    assert.strictEqual(next.memory.extractorReplacementFor, undefined);
    assert.strictEqual(helper.getAssignedSource(next).id, 'A');
    assert.deepStrictEqual(helper.getAssignedMiningSeat(next, f.room.sources[0]), next.pos);
});
test('14 economic deterioration cancels discretionary wait without spawning a weaker upgrade', () => {
    const f = setup(700, 300); f.core(); f.miner('old', 1); f.miner('b', 5, 'B'); f.sample(); f.plan();
    const manager = require('spawn.manager'); assert.strictEqual(manager.runRoom(f.room.name).result, ERR_NOT_ENOUGH_ENERGY);
    Game.time++; const snapshot = f.sample(); snapshot.energyTrend = -10;
    assert.strictEqual(manager.runRoom(f.room.name).result, OK);
    assert.strictEqual(f.calls[0].body.filter(p => p === WORK).length, 2);
});
test('15 unavailable or destroyed extensions bound body capacity; partial damage stays usable', () => {
    const f = setup(700); f.room.structures.filter(s => s.structureType === STRUCTURE_EXTENSION).forEach((s, i) => {
        if (i < 4) s.isActive = () => false; else s.hits = 0;
    });
    const planner = require('Harvest.Planning'); assert.strictEqual(planner.energyCapacity(f.room), 300);
    assert.strictEqual(planner.body(f.room, 5).WORK, 2);
    f.room.structures[1].isActive = () => true; f.room.structures[1].hits = 1;
    assert.strictEqual(planner.energyCapacity(f.room), 350);
});
test('handoff keeps incumbent mining until arrival, uses a free exit and unique seat ownership', () => {
    const f = setup(); const old = f.miner('old', 1), next = f.miner('next', 2);
    next.pos = new RoomPosition(5, 5, f.room.name); next.memory.extractorReplacementFor = old.name;
    delete next.memory.miningSeat; delete next.memory.miningSeatKey;
    const helper = require('utility.Creep'); helper.runExtractorLifecycle(next);
    assert.ok(!old.memory.extractorRetiring);
    next.pos = new RoomPosition(8, 9, f.room.name); helper.runExtractorLifecycle(next);
    assert.strictEqual(old.memory.extractorRetiring, next.name); assert.ok(old.memory.extractorRetirePos);
    const exit = old.memory.extractorRetirePos; old.pos = new RoomPosition(exit.x, exit.y, exit.roomName);
    assert.strictEqual(helper.runExtractorLifecycle(next), false);
    assert.strictEqual(old.memory.miningSeat, undefined);
    assert.strictEqual(helper.getAssignedSource(next).id, 'A');
    const seat = helper.getAssignedMiningSeat(next, f.room.sources[0]);
    assert.deepStrictEqual([seat.x, seat.y], [9, 9]);
});
test('urgent local hauling preempts a discretionary miner wait', () => {
    const f = setup(700, 300); f.core(); f.miner('old', 1); f.miner('b', 5, 'B'); f.sample(); f.plan();
    delete Game.creeps.hauler; f.sample();
    f.queue.push({ role: 'Freighter', priority: 50, body: [CARRY, MOVE], requestedAt: Game.time,
        memory: { role: 'Freighter', homeRoom: f.room.name, assignmentFunction: 'localLogistics' } });
    assert.strictEqual(require('spawn.manager').runRoom(f.room.name).role, 'Freighter');
});
test('logistics shortage and falling income cannot enable infrastructure escape', () => {
    const f = setup(); f.miner('a', 2); f.miner('b', 5, 'B');
    assert.strictEqual(f.sample().harvest.infrastructureRecovery, false);
    f.core(); const snapshot = f.sample(); snapshot.energyTrend = -10;
    f.memory.economy.energyTrend = -10; Game.time++;
    assert.strictEqual(f.sample().harvest.infrastructureRecovery, false);
});
test('replacement pending does not conceal death risk or allow a duplicate admission', () => {
    const f = setup(700); f.core(); f.miner('old', 2, 'A', 50); f.miner('b', 5, 'B'); f.sample(); f.plan();
    const arbiter = require('Spawn.Arbiter');
    const duplicate = { ...f.queue[0], requestId: 'duplicate' };
    assert.strictEqual(arbiter.admit(f.room.name, duplicate).ok, false);
    assert.strictEqual(f.describe().replacementStatus, 'PENDING');
});
test('failed early upgrade is not retried repeatedly against an unchanged handoff', () => {
    const f = setup(); const old = f.miner('old', 1), next = f.miner('next', 2);
    next.memory.extractorReplacementFor = old.name;
    next.memory.extractorHandoffStarted = Game.time - 151;
    require('utility.Creep').runExtractorLifecycle(next);
    delete Game.creeps.next; Game.time += 300;
    assert.strictEqual(f.describe().action, null);
    old.ticksToLive = 50;
    assert.strictEqual(f.describe().action.replacementFor, old.name, 'lifetime replacement still runs');
});
test('extension loss cancels an upgrade that cannot beat the incumbent at realistic capacity', () => {
    const f = setup(700); f.core(); f.miner('old', 2); f.miner('other', 5, 'B'); f.sample(); f.plan();
    assert.strictEqual(f.queue[0].minimumWorkParts, 3);
    f.room.structures.filter(s => s.structureType === STRUCTURE_EXTENSION).forEach(s => { s.isActive = () => false; });
    f.sample(); const result = require('spawn.manager').runRoom(f.room.name);
    assert.notStrictEqual(result.result, OK); assert.strictEqual(f.queue.length, 0);
    assert.match(f.memory.spawn.lastDecision.blocked.reason, /no productive body/);
});
test('dead predecessor and lost seat recycle the successor instead of leaving it stranded', () => {
    const f = setup(); f.miner('old', 1); const next = f.miner('next', 2);
    next.memory.extractorReplacementFor = 'old'; delete Game.creeps.old;
    f.memory.sources.A.seats = []; f.memory.sources.A.seatCount = 0;
    Game.map.getRoomTerrain = () => ({ get: () => TERRAIN_MASK_WALL });
    assert.strictEqual(require('utility.Creep').runExtractorLifecycle(next), true);
    assert.strictEqual(next.memory.extractorReplacementAborted, true);
});
test('full planning pipeline admits the construction needed to leave capacity recovery', () => {
    const f = setup(); f.core(); f.miner('a', 2); f.miner('b', 5, 'B');
    f.room.sites.push({ id: 'extensionSite', my: true, structureType: STRUCTURE_EXTENSION,
        pos: new RoomPosition(20, 20, f.room.name), progress: 0, progressTotal: 3000 });
    for (let i = 0; i < 5; i++) {
        f.sample(); require('HiveMind.ColonyState').update(f.room);
        require('spawn.request.manager').runForRoom(f.room); Game.time++;
    }
    assert.ok(f.queue.some(q => q.role === 'Artificer' && q.economyCategory === 'criticalInfrastructure'));
});
test('Black Box records plan transitions without generating an event each unchanged tick', () => {
    const f = setup(); f.core(); f.miner('a', 2); f.miner('b', 5, 'B'); f.sample();
    const d = require('Diagnostics');
    const events = () => d.events(1000).filter(e => e.event === 'HARVEST_PLAN_CHANGED');
    const before = JSON.stringify(events());
    for (let i = 0; i < 5; i++) { Game.time++; f.sample(); }
    assert.strictEqual(JSON.stringify(events()), before);
    const view = require('Diagnostics.View').room(f.room.name);
    assert.strictEqual(view.sources[0].maximumWork, 2);
    assert.strictEqual(view.sources[0].miners[0].body.CARRY, 1);
    assert.match(view.sources[0].recommendedAction, /extensions/);
    require('spawn.manager').runRoom(f.room.name);
    assert.match(f.memory.spawn.lastDecision.reason, /maximum spawning capacity/);
});
test('unchanged available energy reuses body preview; changed energy reevaluates it', () => {
    const f = setup(700, 300); f.core(); f.miner('old', 1); f.miner('b', 5, 'B'); f.sample(); f.plan();
    const manager = require('spawn.manager'), request = f.queue[0];
    manager.runRoom(f.room.name); const cached = request.affordableBodyCache.preview;
    Game.time++; f.sample(); manager.runRoom(f.room.name);
    assert.strictEqual(request.affordableBodyCache.preview, cached);
    f.room.energyAvailable = 700; Game.time++; f.sample();
    assert.strictEqual(manager.runRoom(f.room.name).result, OK);
    assert.strictEqual(f.calls[0].body.filter(p => p === WORK).length, 5);
});
test('admission rejection remains visible when it leaves the spawn queue empty', () => {
    const f = setup(); f.miner('old', 1); f.sample();
    require('HiveMind.Capacity').evaluate = () => ({ allowed: false, reason: 'HARD_SAFETY_CAP' });
    f.plan(); assert.strictEqual(f.queue.length, 0);
    require('spawn.manager').runRoom(f.room.name);
    assert.strictEqual(f.memory.spawn.lastDecision.status, 'BLOCK');
    assert.strictEqual(f.memory.spawn.lastDecision.reason, 'HARD_SAFETY_CAP');
    assert.strictEqual(f.memory.spawn.lastDecision.stage, 'admission');
});
test('an affordable partial upgrade does not immediately trigger another replacement wave', () => {
    const f = setup(700); const old = f.miner('old', 1), next = f.miner('next', 2);
    next.memory.extractorReplacementFor = old.name;
    next.pos = new RoomPosition(8, 9, f.room.name);
    old.pos = new RoomPosition(8, 8, f.room.name);
    assert.strictEqual(require('utility.Creep').runExtractorLifecycle(next), false);
    assert.strictEqual(f.describe().action, null);
    Game.time += 251;
    assert.strictEqual(f.describe().action.replacementFor, next.name);
});
console.log('Harvesting capacity scenarios passed: ' + passed);
}
module.exports = { setup };
