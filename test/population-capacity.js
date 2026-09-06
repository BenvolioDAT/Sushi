const assert = require('assert');
const mocks = require('./mock-screeps');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function reset() { mocks.installGlobals({ limit: 100, bucket: 10000, getUsed: () => 0 }); mocks.clearLocalModules(); }
function input(overrides = {}) {
    return { rcl: 5, cpu: { limit: 100, rollingUsed: 25, bucket: 10000, mode: 'high', headroom: 58, share: 58 },
        spawn: { count: 1, headroom: 0.5, replacementLoad: 0.25 },
        energy: { known: true, stored: 900000, aboveReserve: 890000, reserve: 10000,
            sustainableNetIncome: 20, trend: 2, healthy: true },
        population: { current: 30, baseline: 30, mandatory: 5, discretionary: 25 }, ...overrides };
}
function world(names = ['W1N1']) {
    reset();
    const Hive = require('../HiveMind.Memory'); Hive.ensure();
    Hive.ensure().telemetry.cpu = { total: 25, samples: 20, phases: { creepExecution: 15, traffic: 3, planning: 5 } };
    for (const name of names) {
        const room = { name, energyAvailable: 5000, energyCapacityAvailable: 5000,
            controller: { my: true, level: 5, ticksToDowngrade: 20000 }, find: () => [] };
        Game.rooms[name] = room;
        Game.spawns[name] = { name, my: true, room, spawning: null };
        Memory.rooms[name] = { spawn: { queue: [] }, economy: { state: 'SURPLUS', energyTrend: 2,
            harvest: { workRequired: 5, workActive: 5 }, haul: { localCarry: 10, requiredCarry: 10 },
            growth: { mode: 'GROWTH_AGGRESSIVE', storedEnergy: 900000, reserveTarget: 10000,
                energyAboveReserve: 890000, estimatedNetIncome: 20, localGrossIncome: 20, affordableWork: 14, remote: {} } } };
    }
    return { Capacity: require('../HiveMind.Capacity'), Hive, Context: require('../Spawn.Context'),
        Arbiter: require('../Spawn.Arbiter'), room: Game.rooms[names[0]] };
}
function request(role = 'Tech') { return { role, body: [WORK, CARRY, MOVE], maxWorkParts: 1,
    memory: { role, homeRoom: 'W1N1' }, economyCategory: role === 'Tech' ? 'upgradeSurplus' : 'construction' }; }
test('A rich RCL5 can exceed the old baseline only within useful resource capacity', () => {
    reset(); const cap = require('../HiveMind.Capacity').calculateRoom(input());
    assert.ok(cap.population.softCap > 30); assert.strictEqual(cap.mode, 'EXPAND');
});
test('B C D CPU, energy and spawn bottlenecks each close optional capacity', () => {
    reset(); const C = require('../HiveMind.Capacity');
    for (const changed of [{ cpu: { limit: 100, bucket: 1500, headroom: 0, share: 0, mode: 'low' } },
        { energy: { healthy: true, aboveReserve: 0, trend: -5, sustainableNetIncome: 0 } },
        { spawn: { count: 1, headroom: 0, replacementLoad: 0.9 } }]) {
        assert.strictEqual(C.calculateRoom(input(changed)).population.discretionarySlots, 0);
    }
});
test('E V spawn time accounts for giants and doubles available throughput with two spawns', () => {
    reset(); const C = require('../HiveMind.Capacity');
    const creeps = Array.from({ length: 8 }, (_, i) => ({ name: 'big' + i, body: Array(50).fill('move'), memory: {} }));
    const one = C.spawnView(creeps, [{}], [], C.DEFAULTS);
    const two = C.spawnView(creeps, [{}, {}], [], C.DEFAULTS);
    assert.ok(one.replacementLoad >= 0.79); assert.strictEqual(one.headroom, 0); assert.ok(two.headroom > 0.69);
    const claim = C.spawnView([{ body: ['claim', 'move'], memory: {} }], [{}], [], C.DEFAULTS);
    assert.strictEqual(claim.replacementLoad, 6 / 600);
    const aged = C.spawnView([{ body: Array(50).fill('carry'), memory: { season11AgingMultiplier: 5 } }], [{}], [], C.DEFAULTS);
    assert.strictEqual(aged.replacementLoad, 0.5);
});
test('P Q sustained idle Artificers are denied while productive useful Techs are admitted through Arbiter', () => {
    const w = world();
    w.Hive.ensure().telemetry.populationRooms = { W1N1: { Artificer: { samples: 10, utilization: 0.3, tick: Game.time },
        Tech: { samples: 10, utilization: 0.99, tick: Game.time } } };
    const idle = w.Capacity.evaluate(w.room, request('Artificer'), w.Context.snapshot('W1N1'), false);
    assert.strictEqual(idle.reason, 'ROLE_UNDERUTILIZED');
    assert.strictEqual(w.Arbiter.admit('W1N1', request()).ok, true);
});
test('R S soft capacity falls without killing creeps and mandatory recovery remains admissible', () => {
    const w = world(); const rich = w.Capacity.calculateRoom(input());
    const poor = w.Capacity.calculateRoom(input({ cpu: { limit: 100, bucket: 1500, headroom: 0, mode: 'low' } }));
    assert.ok(poor.population.softCap < rich.population.softCap);
    w.Hive.ensure().telemetry.cpu.total = 90; Game.cpu.bucket = 1500;
    const mandatory = w.Capacity.evaluate(w.room, request('Extractor'), w.Context.snapshot('W1N1'), true);
    assert.strictEqual(mandatory.allowed, true);
    assert.strictEqual(w.Capacity.evaluate(w.room, request(), w.Context.snapshot('W1N1'), false).allowed, false);
});
test('U rooms share empire CPU; queued commitments cannot reuse the same room share', () => {
    const w = world(['W1N1', 'W2N2']); const cap = w.Capacity.get();
    const shares = Object.values(cap.rooms).reduce((sum, r) => sum + r.cpu.share, 0);
    assert.ok(shares <= cap.cpu.headroom); assert.ok(cap.rooms.W1N1.cpu.share < cap.cpu.headroom);
    const context = w.Context.snapshot('W1N1');
    context.queue.push(...Array.from({ length: 300 }, () => request())); context.total = 300;
    assert.strictEqual(w.Capacity.evaluate(w.room, request(), context, false).reason, 'HARD_SAFETY_CAP');
});
test('rolling completed tick CPU dominates early-tick readings and retains phase costs', () => {
    const w = world(); w.Hive.ensure().telemetry.cpu.total = 90;
    const cap = w.Capacity.get(); assert.strictEqual(cap.cpu.headroom, 0);
    assert.strictEqual(cap.cpu.phases.creepExecution, 15);
    assert.strictEqual(w.Capacity.evaluate(w.room, request(), w.Context.snapshot('W1N1'), false).reason, 'CPU_CAPACITY_EXHAUSTED');
});
test('surplus allocator rejects idle work, funds useful work, and respects the RCL8 upgrade limit', () => {
    const w = world(); const S = require('../HiveMind.Surplus');
    const allocations = S.allocate([{ id: 'idleArt', demand: 0, benefit: 100 },
        { id: 'remote', demand: 7, income: 7 }, { id: 'Tech', demand: 12, benefit: 60 }], 19);
    assert.deepStrictEqual(allocations.map(a => a.id), ['remote', 'Tech']);
    const economy = Memory.rooms.W1N1.economy, cap = w.Capacity.get().rooms.W1N1;
    assert.ok(S.plan(w.room, economy, cap).techWork > 14);
    w.room.controller.level = 8;
    assert.ok(S.plan(w.room, economy, cap).techWork <= 15);
});
test('active, spawning and queued giant WORK stay distinct and missing work does not duplicate them', () => {
    const w = world();
    Game.creeps.active = { name: 'active', memory: { role: 'Tech', homeRoom: 'W1N1' }, body: [{ type: WORK }], ticksToLive: 1000 };
    Game.creeps.incoming = { name: 'incoming', spawning: true, memory: { role: 'Tech', homeRoom: 'W1N1' }, body: Array(18).fill({ type: WORK }) };
    Memory.rooms.W1N1.spawn.queue.push({ role: 'Tech', body: Array(6).fill(WORK) });
    delete global.__sushiTickIndex;
    assert.deepStrictEqual(w.Context.capability('W1N1', 'Tech', WORK), { active: 1, spawning: 18, queued: 6 });
});
test('role profiling uses small EMAs and requires sustained utilization samples', () => {
    const w = world(); const T = require('../HiveMind.Telemetry');
    for (let i = 0; i < 10; i++) T.samplePopulation({ W1N1: { Artificer: { cpu: 0.4, count: 2, active: 0 } } });
    const sample = w.Hive.ensure().telemetry.populationRooms.W1N1.Artificer;
    assert.strictEqual(sample.samples, 10); assert.strictEqual(sample.utilization, 0); assert.ok(sample.cpu <= 0.21);
});
test('rich RCL5 at thirty creeps emits useful Tech WORK through the real request manager', () => {
    const w = world(); w.room.energyCapacityAvailable = 1800; w.room.energyAvailable = 1800;
    for (let i = 0; i < 30; i++) {
        const role = ['Foreman', 'Extractor', 'Freighter'][i] || 'SupplyRunner';
        Game.creeps['unit' + i] = { name: 'unit' + i, room: w.room, ticksToLive: 1400,
            memory: { role, homeRoom: 'W1N1' }, body: [WORK, CARRY, MOVE].map(type => ({ type, hits: 100 })) };
    }
    delete global.__sushiTickIndex;
    const result = require('../spawn.request.manager').requestTechWorkForRoom(w.room,
        { desiredWork: 6, missingWork: 6, livingWork: 0, spawningWork: 0, queuedWork: 0 });
    assert.strictEqual(result.requested, 1, result.reason);
    assert.ok(w.Capacity.get().rooms.W1N1.population.softCap > 30);
});
test('queued and unqueued strategic commitments reserve spawn time without counting the same demand twice', () => {
    const w = world();
    w.Hive.ensure().demands.mission = { id: 'mission', role: 'Pioneer', originRoom: 'W1N1', count: 2,
        validUntil: Game.time + 10, bodyRequirements: { body: Array(50).fill(MOVE) }, memory: {} };
    const C = w.Capacity, queue = [{ body: Array(50).fill(MOVE), memory: { demandId: 'mission' } }];
    const pending = C.commitments('W1N1', queue, C.DEFAULTS);
    assert.strictEqual(pending.count, 1); assert.strictEqual(pending.load, 0.1);
    assert.strictEqual(C.commitments('W1N1', queue, C.DEFAULTS, 'mission').count, 0);
});
test('same-tick admissions share spawn and energy budgets and revalidate without self charging', () => {
    const w = world();
    const first = w.Arbiter.admit('W1N1', { role: 'Tech', body: Array(18).fill(WORK).concat(Array(18).fill(MOVE), [CARRY]),
        maxWorkParts: 18, memory: { role: 'Tech', homeRoom: 'W1N1' }, economyCategory: 'upgradeSurplus' });
    assert.strictEqual(first.ok, true, first.reason);
    assert.strictEqual(w.Arbiter.revalidate(w.room, first.request).allowed, true);
    const second = w.Arbiter.admit('W1N1', { role: 'Artificer', body: Array(20).fill(WORK).concat(Array(20).fill(MOVE), [CARRY]),
        maxWorkParts: 20, memory: { role: 'Artificer', homeRoom: 'W1N1' }, economyCategory: 'construction' });
    assert.strictEqual(second.ok, false); assert.strictEqual(second.reason, 'SPAWN_LOAD_HIGH');
});
test('CPU-neutral Tech replacement consolidates expiring work without authorizing extra growth', () => {
    const w = world(); w.Hive.ensure().telemetry.cpu.total = 88; Game.cpu.bucket = 1800;
    for (let i = 0; i < 3; i++) Game.creeps['old' + i] = { name: 'old' + i, room: w.room, ticksToLive: 150,
        memory: { role: 'Tech', homeRoom: 'W1N1' }, body: Array(6).fill({ type: WORK }).concat(Array(9).fill({ type: MOVE })) };
    Memory.rooms.W1N1.techDesiredWork = 18;
    const replacement = require('../spawn.request.manager').requestConsolidatingTech(w.room);
    assert.strictEqual(replacement.requested, 1, replacement.reason);
    const queued = Memory.rooms.W1N1.spawn.queue[0];
    assert.strictEqual(queued.replacementFor.length, 3);
    assert.ok(queued.body.length * 3 <= 150);
    assert.strictEqual(w.Arbiter.admit('W1N1', { ...request(), requestId: 'extra' }).ok, false);
});
console.log('Population capacity tests passed: ' + passed);
