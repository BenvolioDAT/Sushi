const assert = require('assert');
const mocks = require('./mock-screeps');
let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS ' + name); }
    catch (error) { process.exitCode = 1; console.error('FAIL ' + name, error); }
}
function store(energy = 0, capacity = 800) {
    return { energy, getCapacity: () => capacity, getUsedCapacity() { return this.energy; },
        getFreeCapacity() { return capacity - this.energy; } };
}
function world(required = 6, energy = 800, travel = 34) {
    mocks.installGlobals(); mocks.clearLocalModules();
    global.CREEP_LIFE_TIME = 1500;
    global.BODYPART_COST = { work: 100, carry: 50, move: 50 };
    const room = { name: 'W39S47', energyAvailable: energy, energyCapacityAvailable: 800,
        controller: { my: true, level: 3, ticksToDowngrade: 20000, pos: new RoomPosition(5, 33, 'W39S47') },
        structures: [], find(type) { return [FIND_STRUCTURES, FIND_MY_STRUCTURES].includes(type) ? this.structures : []; } };
    Game.rooms[room.name] = room;
    const calls = [];
    const spawn = Game.spawns.Spawn1 = { name: 'Spawn1', id: 'spawn', my: true, room,
        structureType: STRUCTURE_SPAWN, hits: 5000, isActive: () => true, pos: new RoomPosition(22, 27, room.name),
        store: store(0, 300), spawning: null,
        spawnCreep(body, name, options) {
            calls.push({ body: body.slice(), name, memory: options.memory });
            this.spawning = { name, needTime: body.length * 3, remainingTime: body.length * 3 };
            Memory.creeps[name] = options.memory; return OK;
        } };
    room.structures.push(spawn);
    for (let i = 0; i < 10; i++) room.structures.push({ id: 'ext' + i, structureType: STRUCTURE_EXTENSION,
        my: true, hits: 1000, isActive: () => true, pos: new RoomPosition(20 + i, 20, room.name), store: store(0, 50) });
    const snapshot = { roomName: room.name, sampleTick: Game.time, state: 'STABLE', rawState: 'STABLE',
        energyTrend: 1, spawnFill: 1, energyAvailable: energy, energyCapacity: 800, storageEnergy: 10000,
        harvest: { workActive: 10, workRequired: 10, actualOrEstimatedIncome: 20, expectedIncome: 20,
            sources: [{ id: 'source', distance: (travel - 4) / 2, haulRoundTrip: travel }] },
        haul: { requiredCarry: required, localCarry: required, localCarryMissing: 0, activeCarry: required, backlog: 0 },
        growth: { mode: 'GROWTH_NORMAL', storedEnergy: 10000, reserveTarget: 300, energyAboveReserve: 9700,
            estimatedNetIncome: 15, localGrossIncome: 20, remoteGrossIncome: 0, remote: {} } };
    const memory = Memory.rooms[room.name] = { spawn: { queue: [] }, economy: snapshot,
        colony: { phase: 'ESTABLISHED', growthAllowed: true } };
    const E = require('HiveMind.Economy'), manager = require('spawn.request.manager');
    function refresh() {
        delete global.__sushiTickIndex; delete global.__sushiCapacity;
        snapshot.sampleTick = Game.time;
        global.__sushiEconomy = { tick: Game.time, rooms: { [room.name]: snapshot } };
        snapshot.haul.localCarry = E.freighterCoverage(room.name, 'local').living;
        snapshot.haul.localCarryMissing = Math.max(0, required - snapshot.haul.localCarry);
    }
    function unit(name, carry = 1, ttl = 100, assignment = 'localLogistics') {
        const c = { name, my: true, room, pos: new RoomPosition(22, 26, room.name), ticksToLive: ttl,
            memory: { role: 'Freighter', homeRoom: room.name, assignmentFunction: assignment },
            body: [...Array(carry).fill(CARRY), ...Array(carry).fill(MOVE)].map(type => ({ type, hits: 100 })),
            store: store(0, carry * 50), getActiveBodyparts(type) { return this.body.filter(p => p.type === type && p.hits !== 0).length; } };
        Game.creeps[name] = c; Memory.creeps[name] = c.memory; refresh(); return c;
    }
    function core(name, role, body) {
        const c = unit(name, 1, 1200); c.memory = { role, homeRoom: room.name };
        c.body = body.map(type => ({ type, hits: 100 })); Memory.creeps[name] = c.memory; refresh();
    }
    core('foreman', 'Foreman', [CARRY, MOVE]); core('miner', 'Extractor', [WORK, WORK, WORK, WORK, WORK, CARRY, MOVE]);
    Game.getObjectById = id => room.structures.find(s => s.id === id) || null;
    require('HiveMind.Memory').getConfig('spawn').maxNewRequestsPerRoomPerTick = 10;
    const demand = () => ({ localCarryRequired: required, remoteCarryRequired: 0, desiredCarryParts: required });
    const plan = () => { refresh(); return manager.requestDynamicFreightersForRoom(room, 112, demand()); };
    refresh();
    return { room, spawn, calls, snapshot, memory, queue: memory.spawn.queue, unit, E, manager, refresh, plan };
}

test('nearby natural expiries form one larger replacement while workers remain active', () => {
    const f = world();
    for (let i = 0; i < 6; i++) f.unit('old' + i, 1, 90 + i * 5);
    const before = f.E.freighterCoverage(f.room.name, 'local'); assert.strictEqual(before.living, 6);
    const result = f.plan(); assert.strictEqual(result.requested, 1, result.reason);
    assert.ok(f.queue[0].requestedCarryParts >= 2);
    assert.ok(f.queue[0].replacementFor.length >= 2);
    assert.strictEqual(f.E.freighterCoverage(f.room.name, 'local').living, 6);
    assert.ok(Object.values(Game.creeps).filter(c => c.memory.role === 'Freighter').every(c => !c.memory.freighterRetiring));
    assert.strictEqual(f.plan().requested, 0, 'queued cohort must suppress duplicates');
    assert.strictEqual(require('spawn.manager').runRoom(f.room.name).result, OK);
    assert.ok(f.calls[0].body.filter(p => p === CARRY).length >= 2);
});

test('immediate hauling loss still receives an affordable emergency body', () => {
    const f = world(6, 100); const result = f.plan();
    assert.strictEqual(result.requested, 1, result.reason);
    assert.strictEqual(f.queue[0].freighterRenewal, undefined);
    assert.strictEqual(require('spawn.manager').runRoom(f.room.name).result, OK);
    assert.strictEqual(f.calls[0].body.filter(p => p === CARRY).length, 1);
});

test('young workers and isolated expiries do not trigger speculative extra haulers', () => {
    for (const ttls of [[900, 901, 902, 903, 904, 905], [40, 400, 600, 800, 1000, 1200]]) {
        const f = world(); ttls.forEach((ttl, i) => f.unit('c' + i, 1, ttl));
        assert.strictEqual(f.E.freighterRenewalPlan(f.room, 'local'), null);
        const result = f.plan();
        if (result.requested) assert.strictEqual(f.queue[0].freighterRenewal, undefined);
    }
});

test('cohort body accounts for excess capacity instead of replacing every old CARRY', () => {
    const f = world(4); for (let i = 0; i < 6; i++) f.unit('old' + i, 1, 90 + i * 5);
    const result = f.plan(); assert.strictEqual(result.requested, 1, result.reason);
    assert.ok(f.queue[0].requestedCarryParts < f.queue[0].replacementFor.length);
});

test('an imminent expiry or blocked spawn cannot delay hauling behind a large body', () => {
    for (const busy of [0, 100]) {
        const f = world(); for (let i = 0; i < 6; i++) f.unit('old' + i, 1, 30 + i);
        if (busy) f.spawn.spawning = { name: 'other', remainingTime: busy };
        assert.strictEqual(f.E.freighterRenewalPlan(f.room, 'local'), null);
        const result = f.plan(); assert.strictEqual(result.requested, 1, result.reason);
        assert.strictEqual(f.queue[0].freighterRenewal, undefined);
    }
});

test('local, remote and explicit transport cohorts stay separate', () => {
    const f = world(3);
    for (let i = 0; i < 3; i++) f.unit('local' + i, 1, 100 + i);
    for (let i = 0; i < 3; i++) f.unit('remote' + i, 1, 100 + i, 'remoteHauling');
    const borrowed = f.unit('borrowed', 1, 100); borrowed.memory.freighterJob = 'transport';
    const result = f.plan(); assert.strictEqual(result.requested, 1, result.reason);
    assert.ok(f.queue[0].replacementFor.every(name => name.startsWith('local')));
    assert.strictEqual(f.E.freighterCoverage(f.room.name, 'remote').living, 3);
});

test('a funded cohort request retains its efficient body after a temporary refill loss', () => {
    const f = world(); for (let i = 0; i < 6; i++) f.unit('old' + i, 1, 110 + i);
    assert.strictEqual(f.plan().requested, 1);
    f.room.energyAvailable = 100;
    const result = require('spawn.manager').runRoom(f.room.name);
    assert.strictEqual(result.result, ERR_NOT_ENOUGH_ENERGY);
    assert.strictEqual(f.calls.length, 0);
    assert.strictEqual(f.queue[0].requestedCarryParts, 6);
    f.room.energyAvailable = 800; Game.time++; for (const c of Object.values(Game.creeps)) c.ticksToLive--;
    assert.strictEqual(require('spawn.manager').runRoom(f.room.name).result, OK);
    assert.strictEqual(f.calls[0].body.filter(p => p === CARRY).length, 6);
});

test('deadline pressure falls back to immediate recovery and releases cohort claims', () => {
    const f = world(); for (let i = 0; i < 6; i++) f.unit('old' + i, 1, 100 + i);
    assert.strictEqual(f.plan().requested, 1);
    // Advance the queued plan close to the natural expiry while energy is lost.
    f.queue[0].expiresAt = Game.time + 200;
    Game.time += 60; for (const c of Object.values(Game.creeps)) c.ticksToLive -= 60;
    f.room.energyAvailable = 100; f.refresh();
    assert.strictEqual(require('spawn.manager').runRoom(f.room.name).result, OK);
    assert.strictEqual(f.calls[0].body.filter(p => p === CARRY).length, 1);
    assert.strictEqual(f.calls[0].memory.freighterPredecessors, undefined);
});

test('changed demand shrinks or cancels future replacement capability', () => {
    for (const required of [2, 0]) {
        const f = world(); for (let i = 0; i < 6; i++) f.unit('old' + i, 1, 100 + i);
        assert.strictEqual(f.plan().requested, 1);
        f.snapshot.haul.requiredCarry = required;
        f.snapshot.growth.energyAboveReserve = 300;
        require('HiveMind.Capacity').get(true);
        const result = require('spawn.manager').runRoom(f.room.name);
        if (required) {
            assert.strictEqual(result.result, OK);
            assert.strictEqual(f.calls[0].body.filter(p => p === CARRY).length, required);
        } else { assert.strictEqual(f.calls.length, 0); assert.strictEqual(f.queue.length, 0); }
    }
});

test('miner loss and zero income abort discretionary renewal', () => {
    const f = world(); for (let i = 0; i < 6; i++) f.unit('old' + i, 1, 100 + i);
    assert.strictEqual(f.plan().requested, 1);
    f.snapshot.harvest.actualOrEstimatedIncome = 0;
    f.snapshot.harvest.workActive = 0;
    require('spawn.manager').runRoom(f.room.name);
    assert.strictEqual(f.calls.length, 0); assert.strictEqual(f.queue.length, 0);
});

test('loss of a live worker switches the queued request to ordinary recovery', () => {
    const f = world(); for (let i = 0; i < 6; i++) f.unit('old' + i, 1, 100 + i);
    assert.strictEqual(f.plan().requested, 1);
    delete Game.creeps.old0; delete Memory.creeps.old0; f.refresh();
    assert.strictEqual(require('spawn.manager').runRoom(f.room.name).result, OK);
    assert.strictEqual(f.calls[0].body.filter(p => p === CARRY).length, 1);
    assert.strictEqual(f.calls[0].memory.freighterPredecessors, undefined);
});

test('destroyed MOVE or CARRY cannot be used to promise uninterrupted delivery', () => {
    for (const type of [MOVE, CARRY]) {
        const f = world(); for (let i = 0; i < 6; i++) f.unit('old' + i, 1, 100 + i);
        Game.creeps.old0.body.find(p => p.type === type).hits = 0; f.refresh();
        assert.strictEqual(f.E.freighterRenewalPlan(f.room, 'local'), null);
        const result = f.plan(); assert.strictEqual(result.requested, 1, result.reason);
        assert.strictEqual(f.queue[0].freighterRenewal, undefined);
    }
});

test('same-tick accepted spawn intents and visible spawning bodies suppress duplicate cohorts', () => {
    const f = world(); for (let i = 0; i < 6; i++) f.unit('old' + i, 1, 100 + i);
    f.plan(); require('spawn.manager').runRoom(f.room.name);
    assert.strictEqual(f.plan().requested, 0);
    const call = f.calls[0], c = f.unit(call.name, 6, 1500);
    c.memory = call.memory; c.spawning = true; f.refresh();
    assert.strictEqual(f.E.freighterCoverage(f.room.name, 'local').spawning, 6);
    assert.strictEqual(f.plan().requested, 0);
});

test('successor claims survive reset, expire naturally and cannot capture a reused name', () => {
    const f = world(); const old = f.unit('old', 1, 100);
    const next = f.unit('next', 2, 1500);
    next.memory.freighterPredecessors = [{ name: old.name, deathAt: Game.time + old.ticksToLive }];
    delete global.__sushiTickIndex; // Claims are ordinary creep Memory, not heap ownership.
    require('Freighter.Renewal').prune(next); assert.strictEqual(next.memory.freighterPredecessors.length, 1);
    old.ticksToLive = 1500; // Same name, different generation.
    require('Freighter.Renewal').prune(next); assert.strictEqual(next.memory.freighterPredecessors, undefined);
});

test('tick rollback invalidates a queued forecast without delaying actual recovery', () => {
    const f = world(); for (let i = 0; i < 6; i++) f.unit('old' + i, 1, 100 + i);
    f.plan(); const q = f.queue[0];
    Game.time--; f.refresh();
    assert.strictEqual(f.E.freighterRenewalRequest(f.room, q, f.queue).active, false);
});

test('remote cohorts use remote travel and never include local workers', () => {
    const f = world(2);
    f.unit('local', 2, 1200);
    for (let i = 0; i < 4; i++) f.unit('remote' + i, 1, 180 + i, 'remoteHauling');
    f.memory.remotePlanner = { activeSourceIds: ['r'], sourceInfos: {
        r: { sourceId: 'r', roomName: 'W38S47', active: true, effectiveEnergyPerTick: 1.6, roundTripTicks: 100 } } };
    const p = f.E.freighterRenewalPlan(f.room, 'remote');
    assert.ok(p); assert.ok(p.predecessors.every(e => e.name.startsWith('remote')));
    assert.strictEqual(p.carry, 4);
    const result = f.manager.requestDynamicFreightersForRoom(f.room, 112,
        { localCarryRequired: 2, remoteCarryRequired: 4, desiredCarryParts: 6 });
    assert.strictEqual(result.requested, 1, result.reason);
    assert.strictEqual(f.queue[0].memory.assignmentFunction, 'remoteHauling');
    assert.strictEqual(require('spawn.manager').runRoom(f.room.name).result, OK);
    assert.strictEqual(f.calls[0].body.filter(p => p === CARRY).length, 4);
});

test('closed remote routes invalidate future hauling renewals', () => {
    const f = world(2); f.unit('local', 2, 1200);
    for (let i = 0; i < 4; i++) f.unit('remote' + i, 1, 180 + i, 'remoteHauling');
    f.memory.remotePlanner = { activeSourceIds: ['r'], sourceInfos: {
        r: { sourceId: 'r', roomName: 'W38S47', active: true, effectiveEnergyPerTick: 1.6, roundTripTicks: 100 } } };
    f.manager.requestDynamicFreightersForRoom(f.room, 112, { localCarryRequired: 2, remoteCarryRequired: 4, desiredCarryParts: 6 });
    assert.strictEqual(f.queue.length, 1);
    f.memory.remotePlanner.sourceInfos.r.route = { valid: false };
    require('spawn.manager').runRoom(f.room.name);
    assert.strictEqual(f.calls.length, 0); assert.strictEqual(f.queue.length, 0);
});

test('low CPU admits a validated worker-saving renewal while the hard safety cap remains', () => {
    for (const bucket of [3000, 500]) {
    const f = world(); for (let i = 0; i < 6; i++) f.unit('old' + i, 1, 100 + i);
    const Hive = require('HiveMind.Memory');
    Hive.ensure().telemetry.cpu = { total: 18, samples: 20, phases: {} };
    Game.cpu.bucket = bucket;
    const result = f.plan(); assert.strictEqual(result.requested, 1, result.reason);
    const q = f.queue[0], C = require('HiveMind.Capacity'), context = require('Spawn.Context').snapshot(f.room.name);
    const view = C.get(true).rooms[f.room.name]; view.population.hardSafetyCap = context.total - 1;
    assert.strictEqual(require('Spawn.Arbiter').revalidate(f.room, q).allowed, false);
    }
});

test('500 modeled ticks consolidate a staggered fleet with no delivery-capacity gap', () => {
    for (const initial of [6, 12]) {
        const f = world(initial); for (let i = 0; i < initial; i++) f.unit('old' + i, 1, 90 + i * 5);
        const readiness = new Map(), deliveries = []; let maxQueue = 0;
        for (let tick = 0; tick < 500; tick++) {
            f.room.energyAvailable = 800; f.refresh();
            if (tick % 3 === 0) f.plan();
            maxQueue = Math.max(maxQueue, f.queue.length);
            if (!f.spawn.spawning) require('spawn.manager').runRoom(f.room.name);
            const activeCarry = Object.values(Game.creeps).filter(c => c.memory.role === 'Freighter' &&
                (readiness.get(c.name) || 0) <= Game.time).reduce((sum, c) => sum + c.getActiveBodyparts(CARRY), 0);
            assert.ok(activeCarry >= initial, 'delivery capacity gap at tick ' + tick + ': ' + activeCarry + '/' + initial);
            deliveries.push(Math.min(20, activeCarry / initial * 20));
            Game.time++;
            for (const c of Object.values(Game.creeps)) if (--c.ticksToLive <= 0) { delete Game.creeps[c.name]; delete Memory.creeps[c.name]; }
            if (f.spawn.spawning && --f.spawn.spawning.remainingTime <= 0) {
                const call = f.calls.find(c => c.name === f.spawn.spawning.name);
                const carry = call.body.filter(p => p === CARRY).length;
                const c = f.unit(call.name, carry, 1500); c.memory = call.memory; Memory.creeps[c.name] = c.memory;
                readiness.set(c.name, Game.time + 34); f.spawn.spawning = null;
            }
        }
        const living = Object.values(Game.creeps).filter(c => c.memory.role === 'Freighter');
        assert.ok(living.length <= Math.ceil(initial / 7), 'fleet did not consolidate: ' + living.length);
        assert.strictEqual(living.reduce((sum, c) => sum + c.getActiveBodyparts(CARRY), 0), initial);
        assert.strictEqual(deliveries.reduce((a, b) => a + b, 0), 10000);
        assert.ok(maxQueue <= 1);
        console.log('MEASURE ' + initial + ' one-CARRY workers -> ' + living.length + ' haulers; ' + f.calls.length + ' spawns; zero modeled delivery gaps');
    }
});

test('a loaded predecessor retains its cargo, job and delivery target throughout renewal', () => {
    const f = world(); for (let i = 0; i < 6; i++) f.unit('old' + i, 1, 100 + i);
    const old = Game.creeps.old0;
    old.store.energy = 50; Object.assign(old.memory, { FreighterWorking: true, freighterDeliveryTargetId: 'sink' });
    const before = JSON.stringify(old.memory);
    f.plan(); assert.strictEqual(require('spawn.manager').runRoom(f.room.name).result, OK);
    assert.strictEqual(old.store.energy, 50); assert.strictEqual(JSON.stringify(old.memory), before);
});

test('renewal body guarantees also apply when generic spawn policy is disabled', () => {
    const f = world(); for (let i = 0; i < 6; i++) f.unit('old' + i, 1, 110 + i);
    require('HiveMind.Memory').getConfig('spawn').enabled = false;
    f.plan(); f.room.energyAvailable = 100;
    assert.strictEqual(require('spawn.manager').runRoom(f.room.name).result, ERR_NOT_ENOUGH_ENERGY);
    assert.strictEqual(f.calls.length, 0);
});

test('excess headcount and critical CPU do not block a verified reduction or trigger pathfinding', () => {
    const f = world(40);
    for (let i = 0; i < 40; i++) f.unit('old' + i, 1, i < 7 ? 100 + i : 1200);
    Game.cpu.bucket = 500; PathFinder.search = () => { throw Error('renewal must not pathfind'); };
    const result = f.plan(); assert.strictEqual(result.requested, 1, result.reason);
    assert.strictEqual(f.queue[0].requestedCarryParts, 7);
    assert.strictEqual(f.queue[0].replacementFor.length, 7);
});

test('malformed or reused predecessor claims cannot reserve a cohort indefinitely', () => {
    const f = world(); for (let i = 0; i < 6; i++) f.unit('old' + i, 1, 100 + i);
    Game.creeps.old0.memory.freighterPredecessors = { invalid: true };
    Game.creeps.old1.memory.freighterPredecessors = [null, { name: 'old2', deathAt: Game.time + 1500 }];
    assert.strictEqual(f.plan().requested, 1);
    f.queue[0].freighterRenewal.predecessors.push(null);
    assert.strictEqual(require('spawn.manager').runRoom(f.room.name).result, OK);
});

test('unknown remote travel times cannot authorize a speculative cohort', () => {
    const f = world(2); f.unit('local', 2, 1200);
    for (let i = 0; i < 4; i++) f.unit('remote' + i, 1, 180 + i, 'remoteHauling');
    f.memory.remotePlanner = { activeSourceIds: ['r'], sourceInfos: {
        r: { sourceId: 'r', roomName: 'W38S47', active: true, effectiveEnergyPerTick: 10 } } };
    assert.strictEqual(f.E.freighterRenewalPlan(f.room, 'remote'), null);
});

test('ordinary recovery lead includes production and a complete modeled delivery trip', () => {
    const f = world(1, 100, 54); f.unit('old', 1, 69);
    assert.strictEqual(f.E.freighterCoverage(f.room.name, 'local').living, 0);
    const result = f.plan(); assert.strictEqual(result.requested, 1, result.reason);
    assert.strictEqual(f.queue[0].freighterRenewal, undefined);
    assert.strictEqual(require('spawn.manager').runRoom(f.room.name).result, OK);
});

test('a damaged successor releases claims and forecasts only its remaining useful CARRY', () => {
    const f = world(); for (let i = 0; i < 6; i++) f.unit('old' + i, 1, 100 + i);
    f.plan(); require('spawn.manager').runRoom(f.room.name);
    const call = f.calls[0]; Game.time++; for (const c of Object.values(Game.creeps)) c.ticksToLive--;
    const next = f.unit(call.name, 6, 1500); next.memory = call.memory;
    f.spawn.spawning = null;
    next.body.filter(p => p.type === CARRY).slice(0, 4).forEach(p => { p.hits = 0; });
    require('Freighter.Renewal').prune(next); f.refresh();
    assert.strictEqual(next.memory.freighterPredecessors, undefined);
    const result = f.plan(); assert.strictEqual(result.requested, 1, result.reason);
    assert.strictEqual(f.queue[0].requestedCarryParts, 4);
});

test('a sustained energy shortage preserves modeled delivery while consolidation yields', () => {
    const f = world(); for (let i = 0; i < 6; i++) f.unit('old' + i, 1, 100 + i * 5);
    f.plan(); const readiness = new Map();
    for (let tick = 0; tick < 250; tick++) {
        f.room.energyAvailable = tick < 80 ? 100 : 800; f.refresh();
        if (tick % 3 === 0) f.plan();
        if (!f.spawn.spawning) require('spawn.manager').runRoom(f.room.name);
        const carry = Object.values(Game.creeps).filter(c => c.memory.role === 'Freighter' &&
            (readiness.get(c.name) || 0) <= Game.time).reduce((n, c) => n + c.getActiveBodyparts(CARRY), 0);
        assert.ok(carry >= 6, 'modeled delivery gap during low-energy recovery at ' + tick);
        Game.time++; for (const c of Object.values(Game.creeps)) if (--c.ticksToLive <= 0) {
            delete Game.creeps[c.name]; delete Memory.creeps[c.name];
        }
        if (f.spawn.spawning && --f.spawn.spawning.remainingTime <= 0) {
            const call = f.calls.find(c => c.name === f.spawn.spawning.name);
            const c = f.unit(call.name, call.body.filter(p => p === CARRY).length, 1500);
            c.memory = call.memory; Memory.creeps[c.name] = c.memory;
            readiness.set(c.name, Game.time + 34); f.spawn.spawning = null;
        }
    }
    assert.ok(f.calls.length > 0);
});

test('renewal respects economic reserves and exposes its forecast in room diagnostics', () => {
    const f = world(); for (let i = 0; i < 6; i++) f.unit('old' + i, 1, 100 + i);
    f.snapshot.growth.energyAboveReserve = 500;
    const result = f.plan(); assert.strictEqual(result.requested, 1, result.reason);
    assert.strictEqual(f.queue[0].requestedCarryParts, 5);
    assert.strictEqual(f.calls.length, 0);
    const view = require('Diagnostics.View').room(f.room.name);
    assert.strictEqual(view.logistics.renewals[0].carry, 5);
    assert.strictEqual(view.logistics.renewals[0].predecessors.length, 5);
});

test('a protected emergency queue is considered before committing to a cohort deadline', () => {
    const f = world(); for (let i = 0; i < 6; i++) f.unit('old' + i, 1, 100 + i);
    f.queue.push({ role: 'Extractor', priority: 200, body: Array(40).fill(WORK), expiresAt: Game.time + 200,
        memory: { role: 'Extractor', homeRoom: f.room.name } });
    assert.strictEqual(f.E.freighterRenewalPlan(f.room, 'local'), null);
    assert.strictEqual(f.plan().requested, 0);
});

console.log('Freighter renewal scenarios passed: ' + passed);
module.exports = { world };
