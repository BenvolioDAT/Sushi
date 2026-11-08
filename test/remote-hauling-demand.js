const assert = require('assert');
const { world } = require('./freighter-renewal');
let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS ' + name); }
    catch (error) { process.exitCode = 1; console.error('FAIL ' + name, error); }
}
function fixture() {
    const f = world(2);
    const info = { sourceId: 'remoteSource', roomName: 'W39S48', active: true,
        effectiveEnergyPerTick: 5, roundTripTicks: 100 };
    f.memory.remotePlanner = { activeSourceIds: [info.sourceId], sourceInfos: { [info.sourceId]: info } };
    const memory = { role: 'Extractor', homeRoom: f.room.name, remoteMining: true, sourceId: info.sourceId };
    function miner(name, work = 3) {
        const c = f.unit(name, 1, 1200);
        c.memory = { ...memory }; c.body = [...Array(work).fill(WORK), MOVE].map(type => ({ type, hits: 100 }));
        Memory.creeps[name] = c.memory; f.refresh(); return c;
    }
    const required = haul => f.E.remoteHaulRequirement(info, haul, f.room.name);
    return { ...f, info, memory, miner, required };
}
test('selected but unstaffed routes have no recurring hauling demand', () => {
    const f = fixture(); assert.strictEqual(f.required(), 0);
    assert.strictEqual(f.E.remoteEconomy(f.room.name).requiredCarry, 0);
    assert.strictEqual(f.required({ lastSeen: Game.time - 26, amount: 10000 }), 0);
    assert.strictEqual(f.required({ lastSeen: Game.time + 1, amount: 10000 }), 0);
});
test('fresh backlog without miners retains bounded collection demand', () => {
    const f = fixture();
    assert.strictEqual(f.required({ lastSeen: Game.time, amount: 1500 }), 2);
    assert.strictEqual(f.required({ lastSeen: Game.time, amount: 1500, reservedCarry: 1500 }), 0);
});
test('actual WORK caps production and source output caps overlapping miners', () => {
    const f = fixture(); const c = f.miner('remoteMiner', 1);
    assert.strictEqual(f.required(), 5);
    c.body.unshift({ type: WORK, hits: 100 }, { type: WORK, hits: 100 }); f.refresh();
    assert.strictEqual(f.required(), 11);
    f.miner('overlap', 3); assert.strictEqual(f.required(), 11);
});
test('unrelated, immobile, damaged or expired miners cannot promise production', () => {
    for (const change of [c => { c.memory.sourceId = 'other'; }, c => { c.memory.homeRoom = 'W1N1'; },
        c => { c.memory.remoteMining = false; }, c => { c.body.find(p => p.type === MOVE).hits = 0; },
        c => { c.body.filter(p => p.type === WORK).forEach(p => { p.hits = 0; }); },
        c => { delete Game.creeps[c.name]; }]) {
        const f = fixture(), c = f.miner('miner'); change(c); f.refresh(); assert.strictEqual(f.required(), 0);
    }
});
test('new queue commitments are visible in the same tick and expire normally', () => {
    const f = fixture(); assert.strictEqual(f.required(), 0);
    f.queue.push({ role: 'Extractor', body: [WORK, MOVE], memory: { ...f.memory }, expiresAt: Game.time + 10 });
    assert.strictEqual(f.required(), 5);
    f.queue[0].expiresAt = Game.time - 1; assert.strictEqual(f.required(), 0);
});
test('accepted intents and visible spawning miners are counted once', () => {
    const f = fixture(); assert.strictEqual(f.required(), 0);
    const request = { body: [WORK, MOVE], memory: { ...f.memory, extractorSpawnWorkParts: 1 } };
    require('Spawn.Intents').record(f.spawn, 'newMiner', request, 150, 800);
    assert.strictEqual(f.required(), 5);
    f.spawn.spawning = { name: 'newMiner', remainingTime: 6 }; Memory.creeps.newMiner = request.memory;
    assert.strictEqual(f.required(), 5);
    const c = f.miner('newMiner', 1); c.spawning = true; f.refresh();
    assert.strictEqual(f.required(), 5);
});
test('an unstaffed portfolio cannot authorize a remote renewal or speculative recovery', () => {
    const f = fixture(); f.unit('local', 2, 1200);
    for (let i = 0; i < 4; i++) f.unit('remote' + i, 1, 180 + i, 'remoteHauling');
    assert.strictEqual(f.E.freighterRenewalPlan(f.room, 'remote'), null);
    const request = { role: 'Freighter', body: [CARRY, MOVE], memory: { homeRoom: f.room.name, assignmentFunction: 'remoteHauling' } };
    assert.strictEqual(f.E.remoteHaulingRequest(f.room, request, []).obsolete, true);
    f.manager.runForRoom(f.room, { skipNormalPlanning: true });
    assert.strictEqual(f.queue.filter(q => q.role === 'Freighter').length, 0);
});
test('CPU-skipped light planning still consolidates committed remote hauling without expansion', () => {
    const f = fixture(); f.miner('remoteMiner'); f.unit('local', 2, 1200);
    f.unit('oldA', 3, 125, 'remoteHauling'); f.unit('oldB', 4, 170, 'remoteHauling');
    f.info.roundTripTicks = 58;
    const planner = Memory.rooms[f.room.name].remotePlanner;
    planner.activeSourceIds.push('unstaffed');
    planner.sourceInfos.unstaffed = { sourceId: 'unstaffed', roomName: 'W38S47', active: true,
        effectiveEnergyPerTick: 5, roundTripTicks: 1000 };
    const forecast = f.E.freighterRenewalPlan(f.room, 'remote'); assert.ok(forecast);
    Game.cpu.getUsed = () => 19; global.__sushiCpuRolling = { total: 21 };
    const report = f.manager.runForRoom(f.room, { skipNormalPlanning: true });
    const request = f.queue.find(q => q.freighterRenewal?.assignment === 'remote');
    assert.ok(request, JSON.stringify(report.requests));
    assert.strictEqual(request.requestedCarryParts, 7);
    f.manager.runForRoom(f.room, { skipNormalPlanning: true });
    assert.strictEqual(f.queue.filter(q => q.role === 'Freighter').length, 1);
    assert.strictEqual(require('spawn.manager').runRoom(f.room.name).result, OK);
    assert.strictEqual(f.calls[0].body.filter(p => p === CARRY).length, 7);
    assert.deepStrictEqual(f.calls[0].memory.freighterPredecessors.map(p => p.name).sort(), ['oldA', 'oldB']);
});
test('light planning maintains a committed route when a cohort deadline needs ordinary recovery', () => {
    const f = fixture(); f.miner('remoteMiner'); f.unit('local', 2, 1200);
    f.info.roundTripTicks = 58; f.unit('old', 8, 100, 'remoteHauling');
    f.snapshot.haul.remoteCarryRequired = f.required();
    const report = f.manager.runForRoom(f.room, { skipNormalPlanning: true });
    const request = f.queue.find(q => q.role === 'Freighter');
    assert.ok(request, JSON.stringify(report.requests));
    assert.strictEqual(request.freighterRenewal, undefined);
    assert.strictEqual(request.requestedCarryParts, 7);
    assert.strictEqual(request.memory.assignmentFunction, 'remoteHauling');
    f.manager.runForRoom(f.room, { skipNormalPlanning: true });
    assert.strictEqual(f.queue.filter(q => q.role === 'Freighter').length, 1);
});
test('a redundant oversized remote hauler expires without speculative successor credit', () => {
    const f = fixture(); f.miner('remoteMiner'); f.unit('local', 2, 1200);
    f.info.roundTripTicks = 58;
    f.unit('excess', 8, 105, 'remoteHauling'); f.unit('needed', 8, 165, 'remoteHauling');
    f.snapshot.haul.remoteCarryRequired = f.required();
    assert.strictEqual(f.E.freighterRenewalPlan(f.room, 'remote'), null);
    f.manager.runForRoom(f.room, { skipNormalPlanning: true });
    assert.strictEqual(f.queue.filter(q=>q.role==='Freighter').length, 0);
    Game.time += 55; for (const c of Object.values(Game.creeps)) c.ticksToLive -= 55; f.refresh();
    f.manager.runForRoom(f.room, { skipNormalPlanning: true });
    assert.strictEqual(f.queue.find(q=>q.role==='Freighter')?.requestedCarryParts, 7);
});
console.log('Remote hauling demand scenarios passed: ' + passed);
