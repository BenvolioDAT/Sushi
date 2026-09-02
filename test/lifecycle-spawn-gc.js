const path = require('path');
const assert = require('assert');
const mocks = require('./mock-screeps');

let passed = 0;
function test(name, fn) {
    fn();
    passed++;
    console.log(`PASS ${name}`);
}
function fresh(file) {
    const resolved = path.join(mocks.root, file);
    delete require.cache[require.resolve(resolved)];
    return require(resolved);
}
function reset() {
    mocks.installGlobals({ limit: 100, tickLimit: 500, bucket: 10000, getUsed: () => 0 });
    mocks.clearLocalModules();
}
function makeRoom(name, rcl = 3) {
    const room = {
        name, energyAvailable: 800, energyCapacityAvailable: 800,
        controller: { my: true, level: rcl, ticksToDowngrade: 10000 },
        find: () => []
    };
    Game.rooms[name] = room;
    Memory.rooms[name] = { spawn: { queue: [] } };
    return room;
}
function spawn(room, spawningName) {
    Game.spawns.Spawn1 = { name: 'Spawn1', my: true, room, spawning: spawningName ? { name: spawningName } : null };
}
function creep(name, room, role, extra = {}) {
    const unit = new Creep();
    unit.name = name;
    unit.room = room;
    unit.memory = { role, homeRoom: room.name, ...extra };
    unit.body = [{ type: MOVE, hits: 100 }];
    unit.ticksToLive = 1000;
    Game.creeps[name] = unit;
    return unit;
}
function addCore(room) {
    creep('foreman', room, 'Foreman');
    creep('extractor', room, 'Extractor');
    creep('extractor-2', room, 'Extractor');
    creep('freighter', room, 'Freighter');
}

test('DemandBoard uses the shared role, room, queue, and per-tick admission limits', () => {
    reset();
    const room = makeRoom('W1N1');
    spawn(room);
    addCore(room);
    const memory = fresh('HiveMind.Memory.js');
    const policy = memory.getConfig('spawn');
    policy.maxNewRequestsPerRoomPerTick = 1;
    policy.maxQueueLengthPerRoom = 1;
    policy.roleCaps.Scout = 1;
    delete global.__sushiTickIndex;
    const board = fresh('Spawn.DemandBoard.js');
    board.emit({ id: 'scout:a', role: 'Scout', count: 1, bodyRequirements: { body: [MOVE] }, originRoom: room.name });
    board.emit({ id: 'scout:b', role: 'Scout', count: 1, bodyRequirements: { body: [MOVE] }, originRoom: room.name });
    const report = board.flush();
    assert.strictEqual(Memory.rooms.W1N1.spawn.queue.length, 1);
    assert.strictEqual(report.demands['scout:b'].queued, 0);
});

test('living, spawning, and queued units are counted exactly once', () => {
    reset();
    const room = makeRoom('W1N1');
    creep('same', room, 'Tech');
    Memory.creeps.same = { role: 'Tech', homeRoom: room.name };
    spawn(room, 'same');
    Memory.rooms.W1N1.spawn.queue.push({ role: 'Tech', requestId: 'q1', memory: { role: 'Tech' } });
    delete global.__sushiTickIndex;
    const context = fresh('Spawn.Context.js').snapshot(room.name);
    assert.deepStrictEqual({ living: context.living, spawning: context.spawning, queued: context.queued, total: context.total },
        { living: 1, spawning: 0, queued: 1, total: 2 });
});

test('owned-room squad defense remains admissible during RECOVERY', () => {
    reset();
    const room = makeRoom('W1N1');
    spawn(room);
    addCore(room);
    Memory.rooms.W1N1.economy = { state: 'RECOVERY' };
    const hive = fresh('HiveMind.Memory.js').ensure();
    hive.operations['defend:W1N1'] = { id: 'defend:W1N1', type: 'DEFEND_OWNED_ROOM', state: 'ACTIVE', targetRoom: room.name };
    delete global.__sushiTickIndex;
    const board = fresh('Spawn.DemandBoard.js');
    board.emit({
        id: 'squad:defense:attacker', operationId: 'defend:W1N1', squadId: 'duo:defense',
        role: 'Volley', count: 1, originRoom: room.name, targetRoom: room.name,
        defenseRequest: true, defendedRoom: room.name, economyCategory: 'emergencyDefense',
        memory: { defenseRequest: true, defendedRoom: room.name }, bodyRequirements: { body: [RANGED_ATTACK, MOVE] }
    });
    board.flush();
    assert.strictEqual(Memory.rooms.W1N1.spawn.queue.length, 1);
});

test('DemandBoard persistent hydration happens only once per tick', () => {
    reset();
    fresh('HiveMind.Memory.js').ensure();
    const board = fresh('Spawn.DemandBoard.js');
    board.beginTick();
    Memory.hive.demands.late = { id: 'late', role: 'Scout', count: 1, validUntil: Game.time + 10 };
    assert.strictEqual(board.getDemands().some(item => item.id === 'late'), false);
    Game.time++;
    assert.strictEqual(board.getDemands().some(item => item.id === 'late'), true);
});

test('colony lifecycle separates maturity, economy, and alert overlays', () => {
    reset();
    const room = makeRoom('W1N1', 2);
    spawn(room);
    addCore(room);
    Memory.rooms.W1N1.economy = { state: 'STABLE' };
    fresh('HiveMind.Memory.js').getConfig('lifecycle').hysteresisTicks = 1;
    delete global.__sushiTickIndex;
    const colony = fresh('HiveMind.ColonyState.js');
    let state = colony.update(room);
    assert.strictEqual(state.phase, 'GROWTH');
    assert.strictEqual(state.economy, 'STABLE');
    assert.ok(state.unmet.includes('waiting for extensions'));
    assert.strictEqual(state.alert, 'PEACE');
});

test('strategy ranking enforces deterministic empire operation budgets', () => {
    reset();
    const operations = fresh('HiveMind.Operations.js');
    const config = fresh('HiveMind.Memory.js').getConfig('combat').strategy;
    config.maxActiveNonEmergency = 1;
    const high = operations.create('SCOUT_INTEL', { id: 'a-high', priority: 80, utility: { urgency: 80 } });
    const low = operations.create('SCOUT_INTEL', { id: 'b-low', priority: 10, utility: { urgency: 10 } });
    operations.run([high, low]);
    assert.strictEqual(high.strategyDecision, 'allow');
    assert.strictEqual(low.strategyDecision, 'wait');
    assert.strictEqual(low.strategyReason, 'Empire operation budget exhausted');
});

test('terminal squads are deleted after retention and skipped by execution', () => {
    reset();
    const hiveMemory = fresh('HiveMind.Memory.js');
    const hive = hiveMemory.ensure();
    hiveMemory.getConfig('memoryGC').squadRetention = 10;
    hive.squads.dead = { id: 'dead', type: 'RANGED_DUO', state: 'COMPLETE', completedTick: Game.time - 11 };
    const controlled = fresh('Squad.Controller.js').execute();
    assert.strictEqual(controlled.size, 0);
    fresh('HiveMind.MemoryGC.js').run({ force: true });
    assert.strictEqual(hive.squads.dead, undefined);
});

test('stale ordinary and terminal-operation queue requests reconcile away', () => {
    reset();
    const room = makeRoom('W1N1');
    spawn(room);
    const hive = fresh('HiveMind.Memory.js').ensure();
    hive.operations.done = { id: 'done', state: 'COMPLETE', completedTick: Game.time };
    Memory.rooms.W1N1.spawn.queue.push(
        { role: 'Tech', requestId: 'stale', expiresAt: Game.time - 1, memory: { role: 'Tech' } },
        { role: 'Volley', requestId: 'done-defender', operationId: 'done', expiresAt: Game.time + 10,
            memory: { role: 'Volley', defenseRequest: true } }
    );
    const removed = fresh('Spawn.Arbiter.js').pruneRoom(room.name);
    assert.strictEqual(removed, 2);
    assert.strictEqual(Memory.rooms.W1N1.spawn.queue.length, 0);
});

test('Memory GC preserves protected rooms, manual diplomacy, active targets, and unknown fields', () => {
    reset();
    const memory = fresh('HiveMind.Memory.js');
    const hive = memory.ensure();
    memory.getConfig('memoryGC').intelRetention = 10;
    hive.homeRooms = { names: ['W1N1'], updatedAt: Game.time };
    hive.players.friend = { manual: true, classification: 'ally', updatedTick: 0 };
    hive.operations.active = { id: 'active', state: 'ACTIVE', targetRoom: 'W3N3' };
    Memory.rooms.W1N1 = { identity: { type: 'HOME' }, custom: { keep: true }, scoutIntel: { tick: 0 } };
    Memory.rooms.W3N3 = { identity: { type: 'INTEL' }, custom: { keep: true }, scoutIntel: { tick: 0 } };
    Memory.rooms.W9N9 = { identity: { type: 'INTEL' }, custom: { keep: true }, scoutIntel: { tick: 0 }, sources: { old: true } };
    fresh('HiveMind.MemoryGC.js').run({ force: true });
    assert.strictEqual(Memory.rooms.W1N1.scoutIntel.tick, 0);
    assert.strictEqual(Memory.rooms.W3N3.scoutIntel.tick, 0);
    assert.deepStrictEqual(Memory.rooms.W9N9.custom, { keep: true });
    assert.strictEqual(Memory.rooms.W9N9.scoutIntel, undefined);
    assert.strictEqual(hive.players.friend.classification, 'ally');
});

test('critical structures precede bulk roads in planner release priority', () => {
    reset();
    const planner = fresh('Planner.Brain.js');
    const priority = planner.getBuildPriority();
    assert.ok(priority.indexOf(STRUCTURE_EXTENSION) < priority.indexOf(STRUCTURE_ROAD));
    assert.ok(priority.indexOf(STRUCTURE_TOWER) < priority.indexOf(STRUCTURE_ROAD));
    assert.ok(priority.indexOf(STRUCTURE_STORAGE) < priority.indexOf(STRUCTURE_ROAD));
    const entries = planner.getBuildEntries({ controller: { level: 3 } }, { byRcl: {
        1: [], 2: [{ type: STRUCTURE_ROAD, x: 1, y: 1 }],
        3: [{ type: STRUCTURE_TOWER, x: 2, y: 2 }]
    } });
    assert.strictEqual(entries[0].type, STRUCTURE_TOWER);
});

test('schema cache rebuilds after a simulated global reset without losing user fields', () => {
    reset();
    let memory = fresh('HiveMind.Memory.js');
    memory.ensure().customUserField = { retained: true };
    mocks.clearLocalModules();
    memory = require(path.join(mocks.root, 'HiveMind.Memory.js'));
    assert.deepStrictEqual(memory.ensure().customUserField, { retained: true });
    assert.ok(memory.getConfig('memoryGC'));
});

console.log(`Lifecycle/spawn/GC integration tests passed: ${passed}`);
