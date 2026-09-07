const assert = require('assert');
const mocks = require('./mock-screeps');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function world() {
    mocks.installGlobals({ limit: 100, bucket: 10000, getUsed: () => 0 }); mocks.clearLocalModules();
    const Hive = require('../HiveMind.Memory'); Hive.ensure();
    Hive.ensure().telemetry.cpu = { total: 25, samples: 20 };
    const sites = [];
    const room = { name: 'W1N1', energyAvailable: 5000, energyCapacityAvailable: 5000,
        controller: { my: true, level: 5, ticksToDowngrade: 20000, pos: { findInRange: () => [] } },
        find: type => type === FIND_MY_CONSTRUCTION_SITES ? sites : [] };
    Game.rooms.W1N1 = room; Game.spawns.Spawn1 = { name: 'Spawn1', my: true, room, spawning: null };
    Memory.rooms.W1N1 = { spawn: { queue: [] }, economy: { state: 'SURPLUS', energyTrend: 2,
        harvest: { workRequired: 5, workActive: 5 }, haul: { localCarry: 10, requiredCarry: 10 },
        growth: { mode: 'GROWTH_AGGRESSIVE', storedEnergy: 900000, reserveTarget: 10000,
            energyAboveReserve: 890000, estimatedNetIncome: 20, localGrossIncome: 20, affordableWork: 14, remote: {} } } };
    const S = require('../HiveMind.Surplus'), C = require('../HiveMind.Capacity');
    const economy = Memory.rooms.W1N1.economy;
    return { room, sites, economy, S, C, Hive, plan: () => S.plan(room, economy, C.get(true).rooms.W1N1) };
}
test('A rich RCL5 invests stockpile in Tech WORK without upgradeRush', () => {
    const w = world(); const rich = require('../spawn.request.manager').getDesiredTechWork(w.room);
    assert.ok(rich >= 50, rich); assert.strictEqual(Memory.rooms.W1N1.surplus.reason, 'STOCKPILE_DRAWDOWN');
    w.economy.growth.storedEnergy = 60000; w.economy.growth.energyAboveReserve = 50000;
    w.C.get(true); const lean = require('../spawn.request.manager').getDesiredTechWork(w.room);
    assert.ok(rich > lean + 20);
});
test('B low CPU and E saturated Spawn close investment', () => {
    const w = world(); Game.cpu.bucket = 1000; assert.strictEqual(w.plan().budget, 0);
    Game.cpu.bucket = 10000; Game.time++; const cap = w.C.get(true).rooms.W1N1; cap.spawn.headroom = 0;
    assert.strictEqual(w.S.plan(w.room, w.economy, cap).reason, 'SPAWN_LIMIT');
});
test('C massive construction exceeds 24 WORK through Artificer demand', () => {
    const w = world(); w.sites.push({ structureType: STRUCTURE_EXTENSION, progressTotal: 1500000, progress: 0 });
    const demand = require('../spawn.request.manager').getArtificerBuildDemand(w.room);
    assert.ok(demand.desiredWork > 24, demand.desiredWork);
    assert.ok(demand.desiredWork <= 80);
    assert.ok(demand.workByEconomyCategory.construction > 0);
});
test('D no backlog creates no Artificer demand and leaves energy for Tech', () => {
    const w = world(); const demand = require('../spawn.request.manager').getArtificerBuildDemand(w.room);
    assert.strictEqual(demand.desiredWork, 0); assert.ok(w.plan().techWork >= 50);
});
test('F baseline thirty remains an admission baseline', () => {
    const w = world(); for (let i = 0; i < 30; i++) Game.creeps['c' + i] = { name: 'c' + i, memory: { role: 'Tech', homeRoom: 'W1N1' }, body: [{ type: WORK }] }; assert.ok(w.C.get(true).rooms.W1N1.population.softCap > 30);
});
test('G EXPAND receives support and completed operations do not', () => {
    const w = world(); w.Hive.ensure().operations.x = { type: 'EXPAND', originRoom: 'W1N1', state: 'ACTIVE' };
    assert.strictEqual(w.plan().expansionWork, 2);
    w.Hive.ensure().operations.x.state = 'COMPLETE'; assert.strictEqual(w.plan().expansionWork, 0);
});
test('H drawdown hysteresis tapers and exits at protected band', () => {
    const w = world(); const first = w.plan();
    w.economy.growth.storedEnergy = 150000; const falling = w.plan();
    assert.strictEqual(falling.mode, 'DRAWDOWN'); assert.ok(falling.extraSpendPerTick < first.extraSpendPerTick);
    w.economy.growth.storedEnergy = 60000; assert.strictEqual(w.plan().extraSpendPerTick, 0);
    w.economy.growth.storedEnergy = 150000; assert.strictEqual(w.plan().mode, 'INCOME');
});
test('I RCL8 stays at fifteen normal controller WORK', () => {
    const w = world(); w.room.controller.level = 8;
    assert.ok(require('../spawn.request.manager').getDesiredTechWork(w.room) <= 15);
});
test('J recovery disables surplus; malformed settings remain finite', () => {
    const w = world(); w.economy.state = 'RECOVERY'; assert.strictEqual(w.plan().budget, 0);
    w.Hive.getConfig('surplus').drawdownHorizon = NaN; assert.ok(Number.isFinite(w.S.config().drawdownHorizon));
});
test('profitable routed remote receives investment; unsafe remote does not', () => {
    const w = world(); Memory.rooms.W1N1.remotePlanner = { sourceInfos: {
        good: { sourceId: 'good', netIncome: 5, score: 5, requiredWork: 5, requiredCarry: 12, route: { valid: true } },
        bad: { sourceId: 'bad', netIncome: 5, score: 5, risk: 4, route: { valid: true } }
    } };
    const plan = w.plan(); assert.ok(plan.allocations.some(a => a.id === 'remoteBootstrap:good' && a.allocated > 0));
    assert.ok(!plan.allocations.some(a => a.id === 'remoteBootstrap:bad'));
});
test('role-cap diagnostics preserve config and allow explicit dynamic opt-out', () => {
    const w = world(); Memory.rooms.W1N1.techDesiredWork = 60;
    const P = require('../Spawn.Policy'), policy = w.Hive.getConfig('spawn'); policy.roleCaps.Tech = 2;
    assert.ok(P.economyRoleCap(w.room, 'Tech', { maxWorkParts: 1 }, policy) >= 5);
    assert.strictEqual(policy.roleCaps.Tech, 2); w.Hive.getConfig('surplus').dynamicRoleCaps = false;
    assert.strictEqual(P.economyRoleCap(w.room, 'Tech', { maxWorkParts: 1 }, policy), 2);
});
test('E Artificer consolidation claims only matching expiring work and respects deadline', () => {
    const w = world();
    for (let i = 0; i < 3; i++) Game.creeps['old' + i] = { name: 'old' + i, room: w.room, ticksToLive: 150,
        memory: { role: 'Artificer', homeRoom: 'W1N1', artificerWorkCategory: i === 2 ? 'remote' : 'construction' },
        body: Array(6).fill({ type: WORK }).concat(Array(9).fill({ type: MOVE })) };
    const request = require('../Spawn.Arbiter').normalize('W1N1', { role: 'Artificer', economyCategory: 'construction',
        body: Array(12).fill(WORK).concat([CARRY, MOVE]), maxWorkParts: 12,
        memory: { role: 'Artificer', homeRoom: 'W1N1', artificerWorkCategory: 'construction' } });
    assert.strictEqual(request.replacementFor.length, 2);
    assert.ok(request.body.length <= 50 && request.body.length * 3 <= 150);
});
test('allocations share one budget including the existing controller income floor', () => {
    const w = world(); w.sites.push({ progressTotal: 2000000, progress: 0 });
    const p = w.plan(); assert.ok(p.allocations.reduce((sum, a) => sum + a.allocated, 0) <= p.budget + 0.001);
    assert.ok(p.techWork >= w.economy.growth.affordableWork);
});
console.log('Surplus investment tests passed: ' + passed);
