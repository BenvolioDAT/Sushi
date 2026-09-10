const assert = require('assert');
const mocks = require('./mock-screeps');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function setup() {
    mocks.installGlobals({ limit: 100, tickLimit: 500, bucket: 10000, getUsed: () => 0 });
    mocks.clearLocalModules();
    Game.time = 1000;
    const room = { name: 'W1N1', energyAvailable: 800, energyCapacityAvailable: 800,
        controller: { my: true, level: 5, ticksToDowngrade: 80000 }, find: () => [] };
    Game.rooms[room.name] = room;
    Game.spawns.Spawn1 = { name: 'Spawn1', room, my: true, spawning: null, pos: new RoomPosition(25, 25, room.name) };
    Memory.rooms[room.name] = { spawn: { queue: [] }, useful: { keep: true } };
    require('HiveMind.Memory').ensure();
    require('HiveMind.Memory').getRoomSpawnMemory(room.name);
    return room;
}
function request(extra = {}) {
    return { requestId: 'q', role: 'Volley', body: [RANGED_ATTACK, MOVE], priority: 90,
        memory: { role: 'Volley', homeRoom: 'W1N1' }, ...extra };
}
function isolateAdmission() {
    require('HiveMind.Capacity').evaluate = () => ({ allowed: true });
    require('HiveMind.ColonyState').get = () => ({ phase: 'STABLE', growthAllowed: true });
    require('HiveMind.Economy').canSpawnRequest = () => ({ allowed: true });
    require('HiveMind.Economy').localRecoveryRequest = () => ({ mandatory: false });
}

test('upgrade preserves useful Memory and ignores old generic caps only for SPECIAL_STRATEGY', () => {
    const room = setup();
    Memory.config.spawn.roleCaps = { ThoriumMiner: 0, ThoriumHauler: 1, ReactorClaimer: 0, Volley: 0, customRole: 7 };
    Memory = JSON.parse(JSON.stringify(Memory)); // Restore current-schema Memory under new code.
    mocks.clearLocalModules();
    isolateAdmission();
    const policy = require('Spawn.Policy');
    const config = require('HiveMind.Memory').getConfig('spawn');
    const context = { queue: [], byRole: { ThoriumMiner: 10, ThoriumHauler: 10, ReactorClaimer: 10 }, total: 30, nonCombatTotal: 30 };
    for (const role of ['ThoriumMiner', 'ThoriumHauler', 'ReactorClaimer']) {
        for (const useMemory of [false, true]) {
            const q = request({ role, strategyCategory: useMemory ? undefined : 'SPECIAL_STRATEGY',
                memory: { role, strategyCategory: useMemory ? 'SPECIAL_STRATEGY' : undefined } });
            assert.strictEqual(policy.evaluate(room, q, context).allowed, true);
            assert.strictEqual(Memory.rooms.W1N1.spawn.governor.roleCaps[role].effective, null);
        }
    }
    assert.strictEqual(policy.evaluate(room, request(), { ...context, byRole: {} }).reason, 'role cap reached');
    assert.strictEqual(config.roleCaps.customRole, 7);
    assert.strictEqual(config.roleCaps.ThoriumMiner, 0);
    assert.deepStrictEqual(Memory.rooms.W1N1.useful, { keep: true });
    require('HiveMind.Capacity').evaluate = () => ({ allowed: false, reason: 'HARD_SAFETY_CAP' });
    assert.strictEqual(policy.evaluate(room, request({ strategyCategory: 'SPECIAL_STRATEGY' }), context).reason, 'HARD_SAFETY_CAP');
});
test('invalid persisted controls are repaired while zero limits, false, and custom fields survive', () => {
    setup();
    Object.assign(Memory.config.spawn, { enabled: false, maxQueueLengthPerRoom: -4,
        maxNewRequestsPerRoomPerTick: 'bad', combatSpawnShare: Infinity,
        roleCaps: { Scout: NaN, Volley: 0, Custom: 12, InvalidCustom: -1 },
        maxCreepsPerRoomByRcl: { RCL1: null, RCL2: 22 }, economyRoleHardCaps: { Extractor: -1, Freighter: 0 },
        userNote: 'preserve' });
    Memory.config.memoryGC.queueRetention = NaN;
    Memory.config.cpu.roomPlanningInterval = Infinity;
    const config = require('HiveMind.Memory').getConfig('spawn');
    assert.strictEqual(config.enabled, false);
    assert.strictEqual(config.maxQueueLengthPerRoom, 8);
    assert.strictEqual(config.maxNewRequestsPerRoomPerTick, 2);
    assert.strictEqual(config.roleCaps.Volley, 0);
    assert.strictEqual(config.roleCaps.Custom, 12);
    assert.strictEqual(config.roleCaps.InvalidCustom, undefined);
    assert.strictEqual(config.economyRoleHardCaps.Extractor, 32);
    assert.strictEqual(config.economyRoleHardCaps.Freighter, 0);
    assert.strictEqual(config.userNote, 'preserve');
    assert.strictEqual(Memory.config.cpu.roomPlanningInterval, 3);
    assert.ok(Memory.hive.spawnConfigRepairs.repairs.some(r => r.path === 'spawn.maxQueueLengthPerRoom'));
    Object.assign(config, { maxQueueLengthPerRoom: 0, maxNewRequestsPerRoomPerTick: 0, combatSpawnShare: 0 });
    assert.strictEqual(require('HiveMind.Memory').getConfig('spawn').maxQueueLengthPerRoom, 0);
});
test('deliberate zero queue admission produces a persisted-config diagnosis', () => {
    const room = setup(); isolateAdmission();
    Memory.config.spawn.maxQueueLengthPerRoom = 0;
    const result = require('Spawn.Arbiter').admit(room.name, request());
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.blockSource, 'persistedConfig');
    assert.strictEqual(result.configPath, 'spawn.maxQueueLengthPerRoom');
    assert.strictEqual(Memory.rooms.W1N1.spawn.admissionDecision.configured, 0);
});
test('known old requests with missing/invalid expiry cannot reserve queue space forever', () => {
    setup();
    const queue = Memory.rooms.W1N1.spawn.queue;
    for (const expiresAt of [undefined, null, NaN, Infinity, 'later', -1])
        queue.push(request({ expiresAt, requestedAt: 100 }));
    const arbiter = require('Spawn.Arbiter');
    assert.strictEqual(arbiter.pruneRoom('W1N1'), 6);
    assert.strictEqual(queue.length, 0);
    assert.strictEqual(Memory.rooms.W1N1.spawn.queueMaintenance.blockSource, 'staleQueue');
    queue.push(request());
    arbiter.pruneRoom('W1N1');
    const expiry = queue[0].expiresAt;
    Game.time++;
    arbiter.pruneRoom('W1N1');
    assert.strictEqual(queue[0].expiresAt, expiry);
    Game.time = expiry + 1;
    assert.strictEqual(arbiter.pruneRoom('W1N1'), 1);
});
test('rollback rebases queue control ticks but retains body, assignment and finite lifetime', () => {
    setup();
    Memory.rooms.W1N1.spawn.queue.push(request({ requestedAt: 9000, refreshTick: 9100, expiresAt: 9200,
        memory: { role: 'Volley', targetRoom: 'W2N1', assignment: 'keep' } }));
    Memory = JSON.parse(JSON.stringify(Memory)); mocks.clearLocalModules();
    const arbiter = require('Spawn.Arbiter');
    arbiter.pruneRoom('W1N1');
    const q = Memory.rooms.W1N1.spawn.queue[0];
    assert.strictEqual(q.requestedAt, Game.time);
    assert.strictEqual(q.expiresAt, Game.time + 50);
    assert.strictEqual(q.memory.assignment, 'keep');
    assert.deepStrictEqual(q.body, [RANGED_ATTACK, MOVE]);
    Game.time += 51;
    assert.strictEqual(arbiter.pruneRoom('W1N1'), 1);
});
test('admission cleans stale queue entries before enforcing a configured queue limit', () => {
    const room = setup(); isolateAdmission();
    Memory.config.spawn.maxQueueLengthPerRoom = 1;
    Memory.rooms.W1N1.spawn.queue.push(request({ requestId: 'stale', requestedAt: 1 }));
    assert.strictEqual(require('Spawn.Arbiter').admit(room.name, request({ requestId: 'fresh' })).ok, true);
    assert.deepStrictEqual(Memory.rooms.W1N1.spawn.queue.map(q => q.requestId), ['fresh']);
});
test('demand-cache schedules recover after restore, rollback and invalid values', () => {
    for (const next of [NaN, Infinity, null, '2000', -1, 1000000]) {
        const room = setup();
        const cache = Memory.rooms.W1N1.spawn.demandCache;
        Object.assign(cache, { nextFullPlanTick: next, useful: 'retain' });
        const manager = require('spawn.request.manager');
        manager.runForRoom(room, { skipNormalPlanning: true });
        assert.ok(Number.isSafeInteger(cache.nextFullPlanTick));
        assert.ok(cache.nextFullPlanTick <= Game.time + 3);
        assert.ok(cache.scheduleRepair);
        Game.time = cache.nextFullPlanTick;
        const report = manager.runForRoom(room);
        assert.strictEqual(report.fullPlan, true);
        assert.strictEqual(cache.useful, 'retain');
    }
});
test('valid demand-cache staggering is preserved and its wait is diagnosed', () => {
    const room = setup();
    Memory.rooms.W1N1.spawn.demandCache.nextFullPlanTick = Game.time + 2;
    const report = require('spawn.request.manager').runForRoom(room);
    assert.strictEqual(report.fullPlan, false);
    assert.strictEqual(report.demandCacheState.blockSource, 'demandCache');
    assert.strictEqual(report.nextFullPlanTick, Game.time + 2);
    Game.time = 5;
    require('spawn.request.manager').runForRoom(room, { skipNormalPlanning: true });
    assert.strictEqual(Memory.rooms.W1N1.spawn.demandCache.scheduleRepair.reason, 'tick rollback');
});
test('economy hysteresis remains conservative after rollback and reports its spawn block', () => {
    const room = setup();
    const economy = require('HiveMind.Economy');
    const snapshot = { state: 'STABLE', energyAvailable: 800, energyCapacity: 800, spawnFill: 1,
        storageEnergy: 20000, liquidEnergy: 20800, energyTrend: 0, replacementRisk: 0,
        harvest: { expectedIncome: 20, actualOrEstimatedIncome: 20, workRequired: 10, workActive: 10, sources: [] },
        haul: { requiredCarry: 10, localCarry: 10, activeCarry: 10 }, spawnPressure: { queued: 0, busy: 0 } };
    let previous = { state: 'SURVIVAL', healthyTicks: -Infinity, sampleTick: 9000, stateSince: 8900, stateChangedAt: 8900 };
    const next = economy.applyHysteresis({ ...snapshot }, previous);
    assert.strictEqual(next.state, 'SURVIVAL');
    assert.strictEqual(next.healthyTicks, 1);
    assert.strictEqual(next.stateSince, Game.time);
    Memory.rooms.W1N1.economy = next;
    const denied = economy.canSpawnRequest(room, request());
    assert.strictEqual(denied.allowed, false);
    assert.strictEqual(denied.blockSource, 'economyHysteresis');
    assert.strictEqual(denied.confirmationTicks, 12);
    assert.strictEqual(Memory.rooms.W1N1.spawn.lastEconomyBlock.blockSource, 'economyHysteresis');
    previous = next;
    for (let i = 1; i < 12; i++) { Game.time++; previous = economy.applyHysteresis({ ...snapshot }, previous); }
    assert.strictEqual(previous.state, 'RECOVERY');
});
test('expired requests stay expired even if another timestamp came from the future', () => {
    setup();
    Memory.rooms.W1N1.spawn.queue.push(request({ requestedAt: 9000, expiresAt: 900 }));
    assert.strictEqual(require('Spawn.Arbiter').pruneRoom('W1N1'), 1);
});
console.log(`Persistent spawn Memory tests passed: ${passed}`);
