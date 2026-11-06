const assert = require('assert');
const { setup } = require('./harvesting-capacity');
let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}
function planCycle(f) {
    const snapshot = f.sample();
    require('HiveMind.ColonyState').update(f.room);
    require('spawn.request.manager').runForRoom(f.room);
    return snapshot;
}

test('constrained harvest recovery requests missing hauling despite an existing hauler', () => {
    const f = setup(); f.core(); f.miner('a', 2); f.miner('b', 5, 'B');
    Game.creeps.hauler.body = [CARRY, MOVE].map(type => ({ type, hits: 100 }));
    for (let i = 0; i < 12; i++) { planCycle(f); Game.time++; }
    assert.ok(f.queue.some(q => q.role === 'Freighter'), 'hauling needed to enable infrastructure recovery must be planned');
});

test('a queued upgrade becomes an affordable lifetime replacement as death approaches', () => {
    const f = setup(700); f.core(); const old = f.miner('old', 2); f.miner('b', 5, 'B');
    f.sample(); f.plan(); assert.strictEqual(f.queue[0].minimumWorkParts, 3);
    old.ticksToLive = 20; f.room.energyAvailable = 200; Game.time++;
    f.sample();
    const result = require('spawn.manager').runRoom(f.room.name);
    assert.strictEqual(result.result, OK, 'a useful death replacement must not wait for the former upgrade');
    assert.strictEqual(f.calls[0].memory.extractorReplacementFor, old.name);
});

test('predecessor death releases an upgrade minimum while preserving source targeting', () => {
    const f = setup(700); f.core(); f.miner('old', 2); f.miner('b', 5, 'B');
    f.sample(); f.plan(); delete Game.creeps.old; f.room.energyAvailable = 200; Game.time++;
    f.sample();
    assert.strictEqual(require('spawn.manager').runRoom(f.room.name).result, OK);
    assert.strictEqual(f.calls[0].memory.sourceId, 'A');
});

test('a successor staging beside the source does not cover its incumbent twice', () => {
    const f = setup(700); f.core(); f.miner('old', 4); f.miner('b', 5, 'B');
    const next = f.miner('next', 5); next.memory.extractorReplacementFor = 'old';
    next.memory.extractorState = 'waitingForReplacementSeat';
    const s = f.sample(), row = s.harvest.sources[0];
    assert.strictEqual(row.workActive, 4);
    assert.strictEqual(row.healthyWork, 4);
    assert.strictEqual(row.plannedWork, 5);
    assert.strictEqual(require('HiveMind.Economy').localHarvestCoverage(s).status, 'RECOVERING');
});

test('retiring miners cannot make a fresh recovery request obsolete', () => {
    const f = setup(700); f.core(); const old = f.miner('retired', 5); f.miner('b', 5, 'B');
    old.memory.extractorRetiring = 'lostSuccessor';
    f.sample(); f.plan();
    assert.ok(f.queue.some(q => q.role === 'Extractor' && q.memory.sourceId === 'A'));
    assert.strictEqual(require('spawn.manager').runRoom(f.room.name).result, OK);
});

test('final body selection respects active spawn capacity after extension loss', () => {
    const f = setup(700); f.core(); f.miner('b', 5, 'B');
    f.sample(); f.plan();
    f.room.structures.filter(s => s.structureType === STRUCTURE_EXTENSION).forEach(s => { s.isActive = () => false; });
    Game.time++; f.sample();
    const result = require('spawn.manager').runRoom(f.room.name);
    assert.strictEqual(result.result, OK);
    assert.ok(require('BodyProfiles').cost(f.calls[0].body) <= 300, 'inactive extension energy cannot size the body');
});

test('startup with no reserves spends its first energy on income', () => {
    const f = setup(300, 200); f.room.controller.level = 1;
    planCycle(f);
    assert.strictEqual(require('spawn.manager').runRoom(f.room.name).role, 'Extractor');
    assert.strictEqual(require('BodyProfiles').cost(f.calls[0].body), 200);
});

test('an early upgrade is discarded when another miner has already restored source coverage', () => {
    const f = setup(700); f.core(); f.miner('old', 2); f.miner('b', 5, 'B');
    f.sample(); f.plan();
    const secondSeat = { x: 9, y: 10, roomName: f.room.name };
    f.memory.sources.A.seats.push(secondSeat); f.memory.sources.A.seatCount = 2;
    const restored = f.miner('restored', 3);
    restored.pos = new RoomPosition(secondSeat.x, secondSeat.y, secondSeat.roomName);
    restored.memory.miningSeat = { ...secondSeat, sourceId: 'A' };
    Game.time++; f.sample();
    assert.notStrictEqual(require('spawn.manager').runRoom(f.room.name).result, OK);
    assert.strictEqual(f.queue.length, 0, 'obsolete upgrade must not consume energy');
});

test('stable mining avoids redundant miners and authorizes baseline controller growth', () => {
    const f = setup(700); f.core(); f.miner('a', 5); f.miner('b', 5, 'B');
    for (let i = 0; i < 5; i++) { planCycle(f); Game.time++; }
    assert.ok(!f.queue.some(q => q.role === 'Extractor'));
    assert.ok(f.queue.some(q => q.role === 'Tech' && q.memory.controllerGrowthFloor));
});

test('source allocation fills the uncovered source without duplicating a pending unique-seat upgrade', () => {
    const f = setup(700); f.core(); f.miner('weak', 2);
    f.sample(); f.plan(); f.sample(); f.plan(); f.sample(); f.plan();
    assert.deepStrictEqual(f.queue.filter(q => q.role === 'Extractor').map(q => q.memory.sourceId).sort(), ['A', 'B']);
    assert.strictEqual(f.queue.filter(q => q.memory.extractorReplacementFor === 'weak').length, 1);
});

test('an occupied seat cannot spend energy on an equal or weaker discretionary replacement', () => {
    const f = setup(700, 200); f.core(); f.miner('old', 2); f.miner('b', 5, 'B');
    f.sample(); f.plan();
    for (let i = 0; i < 30; i++) {
        f.sample(); assert.notStrictEqual(require('spawn.manager').runRoom(f.room.name).result, OK); Game.time++;
    }
    assert.strictEqual(f.queue[0].minimumWorkParts, 3);
});

test('preferred-body waiting ends promptly when the attainable full energy arrives', () => {
    const f = setup(700, 300); f.core(); f.miner('old', 1); f.miner('b', 5, 'B');
    f.sample(); f.plan(); const manager = require('spawn.manager');
    assert.strictEqual(manager.runRoom(f.room.name).result, ERR_NOT_ENOUGH_ENERGY);
    f.room.energyAvailable = 700; Game.time++; f.sample();
    assert.strictEqual(manager.runRoom(f.room.name).result, OK);
    assert.strictEqual(f.calls[0].body.filter(p => p === WORK).length, 5);
});

test('replacement lead includes the preferred spawn duration and slow local travel', () => {
    const f = setup(700); f.core(); const old = f.miner('old', 5, 'A', 200); f.miner('b', 5, 'B');
    f.memory.cache = { economyDistances: { 'A:spawn': { version: 1, distance: 70 } } };
    f.room.findPath = () => Array(70).fill({ x: 20, y: 20 });
    assert.strictEqual(f.describe().action, null, 'healthy incumbent must not be replaced unnecessarily early');
    old.ticksToLive = 170;
    const row = f.describe();
    assert.strictEqual(row.action.replacementFor, old.name);
    assert.strictEqual(row.action.upgrade, false);
    assert.ok(row.preferredBody.length * 3 + row.distance * 2 < old.ticksToLive);
});

test('imminent owned defense preempts a discretionary miner upgrade', () => {
    const f = setup(700, 300); f.core(); f.miner('old', 1); f.miner('b', 5, 'B');
    f.sample(); f.plan();
    require('HiveMind.Memory').ensure().threats[f.room.name] = { tick: Game.time, emergency: true,
        hostiles: [{ autoEngage: true, closestCriticalRange: 2 }] };
    BODYPART_COST.attack = 80;
    f.queue.push({ role: 'Ronin', emergency: true, priority: 50, body: [ATTACK, MOVE],
        bodyRequirements: { fixed: true }, memory: { role: 'Ronin', homeRoom: f.room.name,
            defendedRoom: f.room.name, defenseRequest: true } });
    assert.strictEqual(require('spawn.manager').runRoom(f.room.name).role, 'Ronin');
});

test('impossible harvest demand permits bounded infrastructure while preserving the warning', () => {
    const f = setup(); f.core(); f.miner('a', 2); f.miner('b', 5, 'B');
    f.room.sites.push({ id: 'extensionSite', my: true, structureType: STRUCTURE_EXTENSION,
        pos: new RoomPosition(20, 20, f.room.name), progress: 0, progressTotal: 3000 });
    for (let i = 0; i < 5; i++) { planCycle(f); Game.time++; }
    assert.ok(f.queue.some(q => q.role === 'Artificer' && q.economyCategory === 'criticalInfrastructure'));
    const snapshot = f.sample();
    assert.strictEqual(snapshot.harvest.sources[0].constraint, 'SPAWN_CAPACITY');
    assert.strictEqual(snapshot.state, 'RECOVERY');
});

test('the dashboard exposes staging work without claiming active or spawning work', () => {
    const f = setup(700); f.core(); f.miner('old', 4); f.miner('b', 5, 'B');
    const next = f.miner('next', 5); next.memory.extractorReplacementFor = 'old';
    next.memory.extractorState = 'waitingForReplacementSeat'; f.sample();
    const view = require('Diagnostics.View').room(f.room.name);
    assert.deepStrictEqual([view.activeWork, view.stagingWork, view.spawningWork], [9, 5, 0]);
    assert.strictEqual(view.sources[0].stagingWork, 5);
});

test('generated local miner bodies satisfy energy, source demand, mobility and carry bounds', () => {
    const f = setup(700), bodies = require('BodyProfiles');
    for (const energy of [0, 100, 199, 200, 250, 299, 300, 449, 450, 549, 550, 699, 700]) {
        for (const work of [1, 2, 3, 5]) {
            const profile = require('Harvest.Planning').body(f.room, work, energy);
            if (energy < 200) assert.strictEqual(profile, null);
            else {
                assert.ok(profile.WORK > 0 && profile.WORK <= work);
                assert.ok(profile.CARRY > 0 && profile.MOVE > 0);
                assert.ok(bodies.cost(profile.body) <= energy && profile.body.length <= 50);
            }
        }
    }
});

test('total miner loss rebuilds source-targeted income ahead of optional development', () => {
    const f = setup(700); f.core(); f.miner('a', 5); f.miner('b', 5, 'B');
    planCycle(f); delete Game.creeps.a; delete Game.creeps.b; Game.time++;
    planCycle(f);
    const result = require('spawn.manager').runRoom(f.room.name);
    assert.strictEqual(result.role, 'Extractor');
    assert.ok(['A', 'B'].includes(f.calls[0].memory.sourceId));
    assert.strictEqual(require('HiveMind.ColonyState').get(f.room.name).growthAllowed, false);
});

test('zero usable source positions produce an explicit access constraint and no futile miner', () => {
    const f = setup(); f.core();
    Game.map.getRoomTerrain = () => ({ get: () => TERRAIN_MASK_WALL });
    f.sample(); f.plan();
    assert.strictEqual(f.queue.length, 0);
    assert.strictEqual(f.describe().constraint, 'NO_HARVEST_SEAT');
    assert.strictEqual(f.describe().recommendedAction, 'restore source access');
});

test('staging plus an incumbent cannot falsely cover a partial replacement plan', () => {
    const f = setup(700); f.core(); f.miner('old', 2); f.miner('b', 5, 'B');
    const next = f.miner('next', 3); next.memory.extractorReplacementFor = 'old';
    next.memory.extractorState = 'waitingForReplacementSeat';
    const s = f.sample();
    assert.strictEqual(s.harvest.sources[0].plannedWork, 3);
    assert.strictEqual(require('HiveMind.Economy').localHarvestCoverage(s).status, 'MISSING');
});

test('recovery miners deliver to the spawn until a local hauler is actually active', () => {
    const f = setup(700, 200); f.core(); delete Game.creeps.hauler;
    const miner = f.miner('a', 5); f.miner('b', 5, 'B');
    const snapshot = f.sample();
    assert.strictEqual(snapshot.state, 'RECOVERY');
    f.queue.push({ role: 'Freighter', body: [CARRY, MOVE], memory: { role: 'Freighter', homeRoom: f.room.name } });
    miner.store.energy = 50; miner.store.getFreeCapacity = () => 0;
    miner.pos.findClosestByPath = () => f.spawn;
    miner.transfer = () => ERR_NOT_IN_RANGE;
    let destination = null;
    require('utility.Travel.Creep').move = (c, target) => { destination = target; return OK; };
    require('utility').planSourceContainers = () => {};
    require('utility.Creep').getAssignedSource = () => f.room.sources[0];
    require('utility.Creep').getAssignedMiningSeat = () => { throw new Error('delivery must precede station correction'); };
    require('role.Extractor').run(miner);
    assert.strictEqual(destination, f.spawn);
    assert.strictEqual(miner.memory.extractorState, 'bootstrapSelfDelivery');
    snapshot.haul.localCarry = 1;
    assert.strictEqual(require('HiveMind.Economy').shouldBootstrapSelfDeliver(f.room.name), false);
});

test('900 decision cycles recover from combined miner and hauler loss without queue growth', () => {
    const f = setup(700); f.core(); f.miner('a', 5); f.miner('b', 5, 'B');
    Game.creeps.hauler.body = [...Array(20).fill(CARRY), ...Array(20).fill(MOVE)].map(type => ({ type, hits: 100 }));
    const manager = require('spawn.manager'), bodies = require('BodyProfiles');
    let production = null, restoredAt = null, highestQueue = 0, replacements = 0;
    // Controlled economy model: actual planning/spawn APIs, body costs, spawn
    // durations, TTL, queue and handoff policy. Delivery is a conservative
    // fixed-rate approximation and completed workers are placed at their jobs;
    // this does not simulate the game engine's movement or resource actions.
    const originalSpawn = f.spawn.spawnCreep;
    f.spawn.spawnCreep = function(body, name, options) {
        assert.ok(bodies.cost(body) <= f.room.energyAvailable);
        const result = originalSpawn.call(this, body, name, options);
        if (result === OK) {
            f.room.energyAvailable -= bodies.cost(body);
            production = { body: body.slice(), name, memory: { ...options.memory } };
        }
        return result;
    };
    for (let tick = 0; tick < 900; tick++) {
        if (tick === 60) {
            for (const [name, c] of Object.entries(Game.creeps)) {
                if (['Extractor', 'Freighter'].includes(c.memory.role)) delete Game.creeps[name];
            }
            f.room.energyAvailable = 300;
        }
        if (f.spawn.spawning && --f.spawn.spawning.remainingTime <= 0) {
            const p = production;
            const c = f.miner(p.name, bodies.metrics(p.body).WORK, p.memory.sourceId || 'A', 1500);
            c.body = p.body.map(type => ({ type, hits: 100 })); c.memory = p.memory;
            if (c.memory.extractorReplacementFor) {
                replacements++;
                // Model a clear physical exit, then run the actual handoff.
                const old = Game.creeps[c.memory.extractorReplacementFor];
                if (old) old.pos = new RoomPosition(7, 8, f.room.name);
                require('utility.Creep').runExtractorLifecycle(c);
            }
            if (c.memory.role === 'Extractor' && !c.memory.extractorReplacementFor) {
                const occupied = Object.values(Game.creeps).filter(other => other !== c &&
                    other.memory.sourceId === c.memory.sourceId && !other.memory.extractorRetiring)
                    .map(other => other.memory.miningSeat).filter(Boolean);
                const seat = f.memory.sources[c.memory.sourceId].seats.find(pos =>
                    !occupied.some(taken => taken.x === pos.x && taken.y === pos.y));
                assert.ok(seat, 'a completed worker must have a distinct usable source position');
                c.pos = new RoomPosition(seat.x, seat.y, seat.roomName);
                c.memory.miningSeat = { ...seat, sourceId: c.memory.sourceId };
                c.memory.extractorState = 'miningLocalSource';
            }
            f.spawn.spawning = null; production = null;
        }
        for (const [name, c] of Object.entries(Game.creeps)) {
            if (--c.ticksToLive <= 0 || c.memory.extractorRetiring) delete Game.creeps[name];
        }
        const s = planCycle(f);
        highestQueue = Math.max(highestQueue, f.queue.length);
        assert.strictEqual(new Set(f.queue.map(q => q.requestId)).size, f.queue.length, 'no duplicate stable requests');
        assert.ok(s.harvest.workActive <= s.harvest.workRequired, 'useful WORK stays capped by source');
        manager.runRoom(f.room.name);
        if (restoredAt === null && tick > 60 && s.harvest.workActive === 10 && s.haul.localCarry >= s.haul.requiredCarry * 0.85) restoredAt = tick;
        // Source drops plus existing Foreman provide a modest refill while the
        // haul fleet recovers. There is no invented refill without a miner.
        const delivering = Object.values(Game.creeps).some(c => ['Foreman', 'Freighter'].includes(c.memory.role));
        const refill = delivering ? Math.min(8, s.harvest.actualOrEstimatedIncome) : 0;
        f.room.energyAvailable = Math.min(700, f.room.energyAvailable + refill + (f.room.energyAvailable < 300 ? 1 : 0));
        Game.time++;
    }
    const final = f.sample();
    assert.ok(restoredAt !== null, 'local mining and hauling recover after the forced loss: ' + JSON.stringify({
        work: final.harvest.workActive, carry: final.haul.localCarry, requiredCarry: final.haul.requiredCarry,
        sources: final.harvest.sources.map(s => ({ id: s.id, work: s.workActive, plan: s.planningReason })),
        queue: f.queue.map(q => ({ role: q.role, source: q.memory.sourceId, upgrade: q.minerUpgrade })), decision: f.memory.spawn.lastDecision }));
    assert.ok(highestQueue <= 8, 'queue stays bounded under repeated planning');
    assert.ok(f.calls.length < 30, 'recovery must not buy an unbounded stream of workers');
    assert.ok(replacements < 10, 'no repeated replacement wave');
    assert.strictEqual(require('HiveMind.Economy').localHarvestCoverage(final).status, 'HEALTHY');
    assert.strictEqual(require('HiveMind.ColonyState').get(f.room.name).growthAllowed, true);
    console.log(`Simulation: recovery at cycle ${restoredAt}, ${f.calls.length} spawns, max queue ${highestQueue}, ${replacements} handoffs`);
});

console.log(`Spawning intelligence scenarios: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
