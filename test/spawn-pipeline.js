const assert = require('assert');
const mocks = require('./mock-screeps');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function setup(energy = 800, spawnCount = 1) {
    mocks.installGlobals({ limit: 100, tickLimit: 500, bucket: 10000, getUsed: () => 0 });
    mocks.clearLocalModules();
    global.BODYPART_COST = { work: 100, carry: 50, move: 50, attack: 80, ranged_attack: 150, heal: 250, tough: 10, claim: 600 };
    const room = addRoom('W1N1', energy, spawnCount);
    const hive = require('HiveMind.Memory');
    const config = hive.getConfig('spawn');
    Object.assign(config, { maxNewRequestsPerRoomPerTick: 10, maxQueueLengthPerRoom: 10 });
    Object.assign(config.roleCaps, { Scout: 10, Volley: 10, CoreBreaker: 10 });
    // Keep real Arbiter/Policy routing; isolate CPU/economy measurements with existing mocks.
    require('HiveMind.Capacity').evaluate = () => ({ allowed: true });
    require('HiveMind.ColonyState').get = () => ({ phase: 'STABLE', growthAllowed: true });
    require('HiveMind.Economy').canSpawnRequest = () => ({ allowed: true });
    require('HiveMind.Economy').localRecoveryRequest = () => ({ mandatory: false });
    return room;
}
function addRoom(name, energy = 800, spawnCount = 1) {
    const room = { name, energyAvailable: energy, energyCapacityAvailable: 800,
        controller: { my: true, level: 5, ticksToDowngrade: 80000 }, find: () => [] };
    Game.rooms[name] = room;
    Memory.rooms[name] = { spawn: { queue: [] } };
    room.calls = [];
    for (let i = 0; i < spawnCount; i++) {
        const name = room.name + ':' + i;
        Game.spawns[name] = { name, my: true, room, spawning: null,
            // Deliberately defer ALL Game/Memory effects as the real intent API can.
            spawnCreep(body, creepName, options) { room.calls.push({ body, name: creepName, memory: options.memory, spawn: name }); return OK; } };
    }
    for (const role of ['Foreman', 'Extractor', 'Freighter']) {
        const name = room.name + role;
        Game.creeps[name] = { name, room, memory: { role, homeRoom: room.name }, body: [], ticksToLive: 1000 };
    }
    delete global.__sushiTickIndex;
    return room;
}
function queued(room, role, priority, body, extra = {}) {
    const request = { role, priority, body, requestedAt: Game.time,
        bodyRequirements: { fixed: true }, memory: { role, homeRoom: room.name }, ...extra };
    Memory.rooms[room.name].spawn.queue.push(request);
    return request;
}
function demand(board, extra = {}) {
    return board.emit({ id: 'test', role: 'Volley', count: 1, priority: 90,
        bodyRequirements: { body: [RANGED_ATTACK, MOVE], fixed: true }, ...extra });
}

test('fixed high priority waits for refills instead of funding endless cheaper spawns', () => {
    const room = setup(100);
    queued(room, 'Volley', 90, [RANGED_ATTACK, MOVE]);
    queued(room, 'Scout', 10, [MOVE]);
    const manager = require('spawn.manager');
    for (let tick = 0; tick < 3; tick++) {
        assert.strictEqual(manager.runRoom(room.name).result, ERR_NOT_ENOUGH_ENERGY);
        assert.strictEqual(room.calls.length, 0);
        Game.time++;
    }
    room.energyAvailable = 200;
    assert.strictEqual(manager.runRoom(room.name).role, 'Volley');
    assert.deepStrictEqual(room.calls[0].body, [RANGED_ATTACK, MOVE]);
});
test('mandatory local recovery may pass a waiting army; remote optional work may not', () => {
    const room = setup(200);
    queued(room, 'Volley', 90, [RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE]);
    queued(room, 'Extractor', 10, [WORK, CARRY, MOVE]);
    require('HiveMind.Economy').localRecoveryRequest = (room, request) => ({ mandatory: request.role === 'Extractor' });
    assert.strictEqual(require('spawn.manager').runRoom(room.name).role, 'Extractor');
});
test('impossible bodies and policy-rejected work do not reserve energy', () => {
    const room = setup(100);
    queued(room, 'Volley', 90, Array(10).fill(RANGED_ATTACK));
    queued(room, 'Scout', 10, [MOVE]);
    assert.strictEqual(require('spawn.manager').runRoom(room.name).role, 'Scout');
});
test('DemandBoard falls through Capacity and Arbiter rejection to the next room', () => {
    const room = setup();
    const next = addRoom('W2N1');
    require('HiveMind.Capacity').evaluate = room => ({ allowed: room.name !== 'W1N1', reason: 'CPU_CAPACITY_EXHAUSTED' });
    const board = require('Spawn.DemandBoard');
    demand(board, { preferredSpawnRoom: room.name });
    const report = board.flush();
    assert.strictEqual(report.demands.test.spawnRoom, next.name);
    assert.strictEqual(report.demands.test.queued, 1);
    assert.strictEqual(Memory.rooms[room.name].spawn.queue.length, 0);
});
test('count demands allocate stable unique slots, retry partially admitted rooms, and do not duplicate', () => {
    const room = setup();
    addRoom('W2N1');
    require('HiveMind.Memory').getConfig('spawn').maxNewRequestsPerRoomPerTick = 1;
    const board = require('Spawn.DemandBoard');
    const d = demand(board, { count: 2, preferredSpawnRoom: room.name });
    assert.strictEqual(board.flush().demands.test.queued, 2);
    const requests = Object.values(Memory.rooms).flatMap(r => r.spawn.queue);
    assert.strictEqual(new Set(requests.map(q => q.requestId)).size, 2);
    assert.deepStrictEqual(requests.map(q => q.memory.demandSlot).sort(), [0, 1]);
    assert.strictEqual(board.assignmentCount(d), 2);
    assert.strictEqual(board.flush().demands.test.queued, 0);
    Game.time++;
    assert.strictEqual(board.flush().demands.test.queued, 0);
});
test('malformed scalable capabilities never crash emit, hydration, or flush', () => {
    setup();
    const board = require('Spawn.DemandBoard');
    for (const [index, capabilities] of [undefined, null, {}, { work: NaN }, { work: -1 }, { work: '5' }].entries()) {
        demand(board, { id: 'bad' + index, capabilities, bodyRequirements: { scalable: true } });
    }
    demand(board, { id: 'good', capabilities: { ranged_attack: 2 }, bodyRequirements: { scalable: true } });
    for (let tick = 0; tick < 2; tick++) {
        const report = board.flush();
        assert.strictEqual(report.demands.bad0.queued, 0);
        assert.strictEqual(report.demands.bad0.reason, 'invalid scalable capabilities');
        Game.time++;
    }
    assert.strictEqual(Memory.rooms.W1N1.spawn.queue.length, 1);
});
test('multiple idle spawns share energy, reserve names, and retain pending demand accounting', () => {
    const room = setup(450, 3);
    const board = require('Spawn.DemandBoard');
    const d = demand(board, { count: 3 });
    assert.strictEqual(board.flush().demands.test.queued, 3);
    const manager = require('spawn.manager');
    const result = manager.runRoom(room.name);
    assert.strictEqual(result.spawned.length, 2);
    assert.strictEqual(new Set(room.calls.map(c => c.name)).size, 2);
    assert.strictEqual(new Set(room.calls.map(c => c.spawn)).size, 2);
    assert.strictEqual(Memory.rooms.W1N1.spawn.queue.length, 1);
    assert.strictEqual(board.assignmentCount(d), 3);
    assert.strictEqual(require('Spawn.Context').snapshot(room.name).byRole.Volley, 3);
    assert.strictEqual(board.flush().demands.test.queued, 0);
    manager.runRoom(room.name);
    assert.strictEqual(room.calls.length, 2);
});
test('all idle spawns can run when funded; failed API calls reserve neither energy nor names', () => {
    const room = setup(800, 3);
    const board = require('Spawn.DemandBoard');
    demand(board, { count: 3 });
    board.flush();
    const first = Object.values(Game.spawns)[0];
    first.spawnCreep = () => ERR_BUSY;
    const result = require('spawn.manager').runRoom(room.name);
    assert.strictEqual(result.spawned.length, 2);
    first.spawnCreep = (body, name, options) => { room.calls.push({ body, name, memory: options.memory }); return OK; };
    assert.strictEqual(require('spawn.manager').runRoom(room.name).spawned.length, 1);
    assert.strictEqual(room.calls.length, 3);
    assert.strictEqual(new Set(room.calls.map(c => c.name)).size, 3);
});
test('fixed economy bodies survive Arbiter normalization unchanged', () => {
    const room = setup();
    const body = [WORK, CARRY, MOVE];
    const normalized = require('Spawn.Arbiter').normalize(room.name, {
        role: 'Extractor', body, bodyRequirements: { fixed: true }, memory: { role: 'Extractor' } });
    assert.deepStrictEqual(normalized.body, body);
});
test('every combat role including CoreBreaker and Breacher shares economy and capacity classification', () => {
    setup();
    for (const role of ['Ronin', 'Volley', 'Cleric', 'CoreBreaker', 'Breacher']) {
        assert.strictEqual(require('Spawn.Context').isCombatRole(role), true);
        assert.strictEqual(require('HiveMind.Economy').categoryForRequest({ role }), 'combat');
        assert.strictEqual(require('HiveMind.Capacity').classify({ role }), 'MILITARY');
    }
    assert.strictEqual(require('Spawn.Context').isCombatRole('Extractor'), false);
});
test('only a current actionable imminent owned defense may bypass the economy anchor', () => {
    const room = setup();
    const policy = require('Spawn.Policy');
    const request = { role: 'CoreBreaker', body: [WORK, MOVE], defenseRequest: true,
        defendedRoom: room.name, emergency: true, memory: { role: 'CoreBreaker' } };
    const context = { queue: [], byRole: {}, total: 0, nonCombatTotal: 0 };
    const threats = require('HiveMind.Memory').ensure().threats;
    assert.strictEqual(policy.evaluate(room, request, context).allowed, false);
    threats[room.name] = { tick: Game.time, emergency: true,
        hostiles: [{ autoEngage: false, closestCriticalRange: 1 }] };
    assert.strictEqual(policy.evaluate(room, request, context).allowed, false);
    threats[room.name].hostiles[0].autoEngage = true;
    assert.strictEqual(policy.evaluate(room, request, context).allowed, true);
    assert.strictEqual(policy.evaluate(room, { ...request, emergency: false }, context).allowed, false);
    Game.time++;
    assert.strictEqual(policy.evaluate(room, request, context).allowed, false);
});
test('fallback IDs distinguish assignments, sources, producers, and delimiter boundaries', () => {
    setup();
    const board = require('Spawn.DemandBoard');
    const inputs = [
        { assignmentKey: 'a' }, { assignmentKey: 'b' }, { memory: { sourceId: 'a' } },
        { memory: { sourceTargetId: 'a' } }, { memory: { sourceId: 'a', remoteSourceId: 'b' } },
        { producer: 'other', memory: { sourceId: 'a' } },
        { originRoom: 'x:y', targetRoom: 'z' }, { originRoom: 'x', targetRoom: 'y:z' }
    ];
    const demands = inputs.map(input => demand(board, { ...input, id: undefined }));
    assert.strictEqual(new Set(demands.map(d => d.id)).size, inputs.length);
    assert.strictEqual(demand(board, { ...inputs[0], id: undefined }).id, demands[0].id);
    assert.strictEqual(board.memoryMatches(demands[0], { demandId: demands[1].id, role: 'Volley' }), false);
});
test('names extend past 100 and avoid spawning names absent from creep memory', () => {
    setup();
    for (let i = 1; i <= 150; i++) Memory.creeps['Scout_' + String(i).padStart(3, '0')] = {};
    Object.values(Game.spawns)[0].spawning = { name: 'Scout_151' };
    assert.strictEqual(require('utility.spawn').genCreepName('Scout'), 'Scout_152');
});
test('a missing local Foreman may restore spawn filling while an army waits', () => {
    const room = setup(100);
    delete Game.creeps.W1N1Foreman;
    queued(room, 'Volley', 90, [RANGED_ATTACK, MOVE]);
    queued(room, 'Foreman', 10, [CARRY, MOVE]);
    assert.strictEqual(require('spawn.manager').runRoom(room.name).role, 'Foreman');
});
test('all three funded idle spawns execute in one call and pending role caps still apply', () => {
    const room = setup(800, 3);
    const config = require('HiveMind.Memory').getConfig('spawn');
    config.roleCaps.Volley = 3;
    const board = require('Spawn.DemandBoard');
    demand(board, { count: 3 });
    board.flush();
    assert.strictEqual(require('spawn.manager').runRoom(room.name).spawned.length, 3);
    const arbiter = require('Spawn.Arbiter');
    assert.strictEqual(arbiter.admit(room.name, { requestId: 'extra', role: 'Volley', body: [RANGED_ATTACK, MOVE],
        memory: { role: 'Volley' } }).reason, 'role cap reached');
    const pending = require('Spawn.Intents').get().spawns[0].request;
    assert.strictEqual(arbiter.admit(room.name, pending).requested, 0);
});
test('StructureSpawn memory cannot mask a spawning creep assignment', () => {
    const room = setup();
    const board = require('Spawn.DemandBoard');
    const d = demand(board);
    const spawn = Object.values(Game.spawns)[0];
    spawn.spawning = { name: 'inFlight' };
    spawn.memory = { building: 'spawn' };
    Memory.creeps.inFlight = { role: 'Volley', demandId: d.id, demandSlot: 0, homeRoom: room.name };
    assert.strictEqual(board.assignmentCount(d), 1);
    assert.strictEqual(require('Spawn.Context').snapshot(room.name).byRole.Volley, 1);
});
test('combat queue share excludes its own request during revalidation', () => {
    const room = setup();
    const config = require('HiveMind.Memory').getConfig('spawn');
    config.maxQueueLengthPerRoom = 2;
    config.combatSpawnShare = 0.5;
    const arbiter = require('Spawn.Arbiter');
    const admitted = arbiter.admit(room.name, { role: 'CoreBreaker', body: [WORK, MOVE],
        defenseRequest: true, defendedRoom: room.name, memory: { role: 'CoreBreaker' } });
    assert.strictEqual(admitted.ok, true);
    assert.strictEqual(arbiter.revalidate(room, admitted.request).allowed, true);
    assert.strictEqual(arbiter.admit(room.name, { requestId: 'second', role: 'Breacher', body: [WORK, MOVE],
        defenseRequest: true, defendedRoom: room.name, memory: { role: 'Breacher' } }).reason,
        'combat spawn-share budget exhausted');
});
console.log(`Spawn pipeline regression tests passed: ${passed}`);
