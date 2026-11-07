const assert = require('assert');
const mocks = require('./mock-screeps');
const { setup } = require('./harvesting-capacity');
let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS ' + name); }
    catch (error) { console.error('FAIL ' + name, error); process.exitCode = 1; }
}
function store(energy = 0, capacity = 100) {
    return { energy, getFreeCapacity() { return capacity - this.energy; },
        getCapacity: () => capacity, getUsedCapacity() { return this.energy; } };
}
function roleWorld() {
    mocks.installGlobals(); mocks.clearLocalModules(); Game.time = 101;
    const objects = {}, transfers = [], moves = [];
    const room = { name: 'W1N1', energyAvailable: 300, energyCapacityAvailable: 300,
        structures: [], sources: [], drops: [], controller: { my: true, pos: new RoomPosition(25, 25, 'W1N1') },
        find(type, options) {
            let list = type === FIND_STRUCTURES || type === FIND_MY_STRUCTURES ? this.structures :
                type === FIND_DROPPED_RESOURCES ? this.drops : type === FIND_SOURCES ? this.sources : [];
            return options && options.filter ? list.filter(options.filter) : list;
        }, lookForAt: () => [] };
    Game.rooms[room.name] = room; Memory.rooms[room.name] = { spawn: { queue: [] } };
    Game.getObjectById = id => objects[id] || null;
    require('Planner.Remote').getActiveRemoteSourcesForHome = () => [];
    const travel = require('utility.Travel.Creep');
    travel.move = (creep, target) => { moves.push(target.id); return OK; };
    const role = require('role.Freighter'), index = require('Logistics.Index');
    function target(id, x = 10, type = STRUCTURE_EXTENSION, free = 50) {
        const t = { id, my: true, structureType: type, pos: new RoomPosition(x, 10, room.name), store: store(0, free) };
        room.structures.push(t); objects[id] = t; return t;
    }
    function hauler(name, cargo = 100, x = 5) {
        const creep = Object.assign(new Creep(), { name, my: true, room, pos: new RoomPosition(x, 10, room.name),
            memory: { role: 'Freighter', homeRoom: room.name, assignmentFunction: 'localLogistics', FreighterWorking: cargo === 100 },
            body: [CARRY, CARRY, MOVE, MOVE].map(type => ({ type, hits: 100 })), store: store(cargo),
            transfer(t) { transfers.push({ name, target: t.id }); return ERR_NOT_IN_RANGE; },
            withdraw: () => ERR_NOT_IN_RANGE, pickup: () => ERR_NOT_IN_RANGE, drop: () => OK });
        Game.creeps[name] = creep; Memory.creeps[name] = creep.memory; return creep;
    }
    return { room, objects, transfers, moves, target, hauler, role, index, travel };
}

test('attainable mining capacity bounds local hauling while retaining full-source target', () => {
    const f = setup(300); f.miner('limited', 2, 'A'); f.miner('other', 5, 'B');
    const s = f.sample();
    assert.ok(s.haul.requiredCarry < s.haul.theoreticalCarry);
    const a = s.harvest.sources.find(s => s.id === 'A');
    assert.strictEqual(a.haulIncome, 4); assert.strictEqual(a.expectedIncome, 10);
    assert.ok(s.haul.requiredCarry > 0);
});
test('multiple local sources contribute independent production times travel distance', () => {
    const f = setup(700); f.room.findPath = start => Array(start.x === 10 ? 5 : 30).fill({ x: 1, y: 1 });
    f.miner('a', 5, 'A'); f.miner('b', 5, 'B');
    const s = f.sample(), [a, b] = s.harvest.sources;
    assert.deepStrictEqual([a.distance, b.distance], [5, 30]);
    assert.ok(b.haulCarry > a.haulCarry * 4);
    assert.strictEqual(s.haul.requiredCarry, Math.ceil((10 * 14 + 10 * 64) / 50 * 1.15));
});
test('same-tick requests cannot reuse cached capacity after a queue mutation', () => {
    const f = setup(700); f.miner('a', 5, 'A'); f.miner('b', 5, 'B'); f.sample();
    const manager = require('spawn.request.manager');
    const demand = manager.getFreighterCarryDemand(f.room);
    demand.localCarryRequired = 1; demand.remoteCarryRequired = 0;
    const first = manager.requestDynamicFreightersForRoom(f.room, 112, demand);
    assert.strictEqual(first.requested, 1, first.reason);
    const second = manager.requestDynamicFreightersForRoom(f.room, 112, demand);
    assert.strictEqual(second.requested, 0); assert.strictEqual(f.queue.length, 1);
});
test('redundant queued local hauler is obsolete once earlier commitments cover demand', () => {
    const f = setup(700); f.miner('a', 5, 'A'); f.miner('b', 5, 'B'); const s = f.sample();
    const request = () => ({ role: 'Freighter', body: Array(s.haul.requiredCarry).fill(CARRY).concat(MOVE),
        memory: { role: 'Freighter', homeRoom: f.room.name, assignmentFunction: 'localLogistics' } });
    const first = request(), duplicate = request();
    assert.strictEqual(require('HiveMind.Economy').localRecoveryRequest(f.room, duplicate, [first, duplicate]).obsolete, true);
});
test('coverage deduplicates Game spawning and records invisible same-tick spawn intents', () => {
    const f = setup(700); f.sample(); const E = require('HiveMind.Economy');
    const c = f.miner('incoming', 0); c.memory = { role: 'Freighter', homeRoom: f.room.name };
    c.body = [CARRY, CARRY, MOVE].map(type => ({ type, hits: 100 })); c.spawning = true;
    Memory.creeps.incoming = { ...c.memory, freighterSpawnCarryParts: 2 };
    f.spawn.spawning = { name: 'incoming', remainingTime: 9 }; delete global.__sushiTickIndex;
    assert.strictEqual(E.freighterCoverage(f.room.name, 'local').spawning, 2);
    f.spawn.spawning = null;
    const request = { body: [CARRY, CARRY, MOVE], memory: { ...c.memory, freighterSpawnCarryParts: 2 } };
    require('Spawn.Intents').record(f.spawn, 'invisible', request, 150, 700);
    assert.strictEqual(E.freighterCoverage(f.room.name, 'local').spawning, 4);
});
test('expired queues, remote workers and dying workers do not cover local capacity', () => {
    const f = setup(700); f.sample();
    const remote = f.miner('remote', 0), dying = f.miner('dying', 0);
    remote.memory = { role: 'Freighter', homeRoom: f.room.name, freighterJob: 'remoteDelivery' };
    dying.memory = { role: 'Freighter', homeRoom: f.room.name }; dying.ticksToLive = 1;
    for (const c of [remote, dying]) c.body = [{ type: CARRY, hits: 100 }, { type: MOVE, hits: 100 }];
    f.queue.push({ role: 'Freighter', body: [CARRY, MOVE], expiresAt: Game.time - 1, memory: dying.memory });
    delete global.__sushiTickIndex;
    const E = require('HiveMind.Economy'); assert.deepStrictEqual(E.freighterCoverage(f.room.name, 'local'), { living: 0, spawning: 0, queued: 0 });
    assert.strictEqual(E.freighterCoverage(f.room.name, 'remote').living, 1);
});
test('explicit transport borrows a local worker without counting it as local capacity', () => {
    const w = roleWorld(), c = w.hauler('borrowed', 0), jobs = require('Logistics.Jobs'), E = require('HiveMind.Economy');
    assert.strictEqual(jobs.assign(c, { originRoom: 'W1N1', destinationRoom: 'W1N2', amount: 100 }), true);
    assert.strictEqual(E.isLocalFreighter(c), false); assert.strictEqual(E.isRemoteFreighter(c), false);
    jobs.clear(c); assert.strictEqual(c.memory.assignmentFunction, 'localLogistics'); assert.strictEqual(E.isLocalFreighter(c), true);
});
test('stale remote haul observations never add age/backlog spawn bonuses', () => {
    const f = setup(700); f.sample();
    require('HiveMind.Economy').canSpend = () => true;
    const info = { sourceId: 'r', roomName: 'W1N2', effectiveEnergyPerTick: 5, roundTripTicks: 100, distance: 50 };
    require('Planner.Remote').getActiveRemoteSourcesForHome = () => [info];
    Memory.rooms.W1N2 = { sources: { r: { haul: { amount: 2000, reservedCarry: 0, lastSeen: Game.time - 101 } } } };
    const manager = require('spawn.request.manager');
    const stale = manager.getFreighterCarryDemand(f.room);
    assert.strictEqual(stale.remoteCarryRequired, 11);
    Memory.rooms.W1N2.sources.r.haul.lastSeen = Game.time;
    const fresh = manager.getFreighterCarryDemand(f.room);
    assert.ok(fresh.remoteCarryRequired > stale.remoteCarryRequired);
    assert.strictEqual(fresh.desiredCarryParts, fresh.localCarryRequired + fresh.remoteCarryRequired);
});
test('depleted local pickup releases a partial load for delivery', () => {
    const w = roleWorld(), c = w.hauler('partial', 25); w.target('extension');
    Object.assign(c.memory, { freighterJob: 'local', pickupRoom: w.room.name, pickupTargetId: 'gone' });
    w.role.run(c); assert.strictEqual(c.memory.FreighterWorking, true);
    assert.strictEqual(w.transfers[0].target, 'extension'); assert.strictEqual(c.memory.pickupTargetId, undefined);
});
test('empty local worker with no pickup stays idle without path searches', () => {
    const w = roleWorld(), c = w.hauler('empty', 0); w.role.run(c);
    assert.strictEqual(w.moves.length, 0); assert.strictEqual(w.transfers.length, 0);
});
test('delivery reservations spread local and remote cargo over useful destinations', () => {
    const w = roleWorld(), a = w.hauler('a'), b = w.hauler('b');
    w.target('one'); w.target('two', 11);
    assert.strictEqual(w.index.deliveryTarget(a, w.room.name, false).id, 'one');
    assert.strictEqual(require('Planner.Remote').getHomeDeliveryTarget(b).id, 'two');
});
test('dead workers and destroyed delivery targets release reservations next tick', () => {
    const w = roleWorld(), a = w.hauler('a'), b = w.hauler('b'); w.target('one');
    w.index.deliveryTarget(a, w.room.name, false); delete Game.creeps.a; Game.time++;
    assert.strictEqual(w.index.deliveryTarget(b, w.room.name, false).id, 'one');
    delete w.objects.one; w.room.structures = []; Game.time++;
    assert.strictEqual(w.index.deliveryTarget(b, w.room.name, false), null);
});
test('full destinations are skipped without discarding cargo', () => {
    const w = roleWorld(), c = w.hauler('a'); w.target('full', 10, STRUCTURE_EXTENSION, 0);
    assert.strictEqual(w.index.deliveryTarget(c, w.room.name, false), null);
    w.role.run(c); assert.strictEqual(c.store.energy, 100); assert.strictEqual(c.memory.FreighterWorking, true);
});
test('unreachable delivery is temporarily released and an alternate is selected', () => {
    const w = roleWorld(), c = w.hauler('a'); w.target('blocked'); w.target('open', 20);
    w.travel.move = () => ERR_NO_PATH;
    w.role.run(c); assert.strictEqual(c.memory.freighterDeliveryBlockedId, 'blocked');
    Game.time++; w.travel.move = () => OK; w.role.run(c);
    assert.strictEqual(w.transfers[1].target, 'open');
});
test('nearby useful pickup beats a distant large pile and reservations stay exclusive', () => {
    const w = roleWorld(), a = w.hauler('a', 0), b = w.hauler('b', 0);
    for (const [id, x, amount] of [['near', 7, 100], ['far', 35, 2000]]) {
        const d = { id, resourceType: RESOURCE_ENERGY, amount, pos: new RoomPosition(x, 10, w.room.name) };
        d.pos.findInRange = () => []; w.room.drops.push(d); w.objects[id] = d;
    }
    w.role.run(a); w.role.run(b);
    assert.strictEqual(a.memory.pickupTargetId, 'near'); assert.strictEqual(b.memory.pickupTargetId, 'far');
});
test('accepted failed intents do not count as delivered energy; resolved deliveries do', () => {
    const w = roleWorld(), c = w.hauler('a'); w.target('one', 10, STRUCTURE_EXTENSION, 300);
    c.transfer = () => OK; w.role.run(c); Game.time++; w.role.run(c);
    assert.strictEqual(c.memory.freighterFlow.delivered, 0);
    c.store.energy = 0; Game.time++; w.role.run(c);
    assert.strictEqual(c.memory.freighterFlow.delivered, 100);
});
test('stationary stale assignments are not reported as productive logistics', () => {
    const w = roleWorld(), c = w.hauler('a'); w.target('one');
    for (let i = 0; i < 10; i++) { w.role.run(c); Game.time++; }
    assert.strictEqual(require('Tick.Creeps').productive(c), false);
    assert.ok(c.memory.freighterFlow.idleTicks >= 10);
});
test('delivery selection replaces per-creep per-tick path searches with shared indexed choices', () => {
    const w = roleWorld(); let searches = 0;
    for (let i = 0; i < 10; i++) w.target('ext' + i, 10 + i, STRUCTURE_EXTENSION, 100);
    for (let i = 0; i < 10; i++) {
        const c = w.hauler('a' + i); c.pos.findClosestByPath = () => { searches++; return w.objects.ext0; };
        w.role.run(c);
    }
    assert.strictEqual(searches, 0); assert.strictEqual(new Set(w.transfers.map(t => t.target)).size, 10);
    console.log('MEASURE delivery target path searches: baseline 10 per tick; corrected ' + searches + ' for 10 loaded haulers');
});
test('20 CPU sustained pressure skips optional shared paths while essential travel continues', () => {
    const w = roleWorld(), c = w.hauler('a'); const t = w.target('store', 30, STRUCTURE_STORAGE, 1000);
    // Use the actual movement wrapper, not the role fixture stub.
    delete require.cache[require.resolve('utility.Travel.Creep')]; const travel = require('utility.Travel.Creep');
    let searches = 0, fallback = 0; PathFinder.search = () => { searches++; return { path: [], incomplete: true }; };
    c.travelTo = () => { fallback++; return OK; };
    Game.cpu.getUsed = () => 16; Game.cpu.limit = 20; Game.cpu.tickLimit = 500;
    for (let i = 0; i < 100; i++) { travel.move(c, t); Game.time++; }
    assert.strictEqual(searches, 0); assert.strictEqual(fallback, 100);
});
test('fatigued creeps skip shared path planning before Traveler', () => {
    const w = roleWorld(), c = w.hauler('a'), t = w.target('store', 30, STRUCTURE_STORAGE, 1000);
    delete require.cache[require.resolve('utility.Travel.Creep')]; const travel = require('utility.Travel.Creep');
    c.fatigue = 1; let searches = 0;
    PathFinder.search = () => { searches++; return { path: [], incomplete: false }; };
    c.travelTo = () => { throw Error('fatigued fallback'); };
    assert.strictEqual(travel.move(c, t), ERR_TIRED); assert.strictEqual(searches, 0);
});
test('CPU pressure defers economy path refinement and recovers without a 500-tick wait', () => {
    const f = setup(700); let paths = 0; f.room.findPath = () => { paths++; return Array(30).fill({}); };
    Game.cpu.getUsed = () => 16; f.sample(); assert.strictEqual(paths, 0);
    Game.cpu.getUsed = () => 0; Game.time++; const s = f.sample();
    assert.strictEqual(paths, 2); assert.strictEqual(s.harvest.sources[0].distance, 30);
    Game.time++; f.sample(); assert.strictEqual(paths, 2);
});
test('sampled operation costs preserve results and do not double-count phase CPU', () => {
    const w = roleWorld(); Game.time = 125; let used = 3; Game.cpu.getUsed = () => used;
    const D = require('Diagnostics'), T = require('HiveMind.Telemetry'); T.startTick();
    const result = T.measure('creepExecution', () => D.measureOperation('movement', () => { used += 2; return OK; }));
    assert.strictEqual(result, OK); const tick = T.finish();
    assert.strictEqual(tick.total, 5); assert.strictEqual(tick.phases.creepExecution, 2);
    assert.deepStrictEqual(T.getView().operations.costs.movement, { calls: 1, cpu: 2, ops: 0, incomplete: 0 });
});
test('idle haulers spread across sources and keep stable parking choices', () => {
    const w = roleWorld(), a = w.hauler('a', 0), b = w.hauler('b', 0);
    w.room.sources = [{ id: 's1', pos: new RoomPosition(20, 10, w.room.name) },
        { id: 's2', pos: new RoomPosition(40, 10, w.room.name) }];
    w.role.run(a); w.role.run(b);
    assert.notStrictEqual(a.memory.freighterIdleSourceId, b.memory.freighterIdleSourceId);
    const first = a.memory.freighterIdleSourceId; Game.time++; w.role.run(a); w.role.run(b);
    assert.strictEqual(a.memory.freighterIdleSourceId, first);
});
test('destroyed MOVE parts cannot provide usable hauling capacity', () => {
    const f = setup(700), c = f.miner('immobile', 0);
    c.memory = { role: 'Freighter', homeRoom: f.room.name };
    c.body = [{ type: CARRY, hits: 100 }, { type: MOVE, hits: 0 }];
    const snapshot = f.sample(); assert.strictEqual(snapshot.haul.localCarry, 0);
    assert.strictEqual(require('HiveMind.Economy').freighterCoverage(f.room.name, 'local').living, 0);
});
test('remote requests become obsolete when routes close and cannot bypass recovery as local logistics', () => {
    const f = setup(700); f.sample(); const E = require('HiveMind.Economy');
    const request = { role: 'Freighter', body: [CARRY, MOVE], memory: { role: 'Freighter', homeRoom: f.room.name, assignmentFunction: 'remoteHauling' } };
    assert.strictEqual(E.categoryForRequest(request), 'remoteMaintenance');
    assert.strictEqual(E.remoteHaulingRequest(f.room, request, []).obsolete, true);
    assert.strictEqual(E.localRecoveryRequest(f.room, request, []).mandatory, false);
});
test('explicit zero remote production does not fall back to historical gross income', () => {
    const f = setup(); f.sample();
    assert.strictEqual(require('HiveMind.Economy').remoteHaulRequirement({ effectiveEnergyPerTick: 0, grossEnergyPerTick: 10, roundTripTicks: 100 }, null), 0);
});
test('remote delivery evidence is recorded only after cargo decreases on the next tick', () => {
    const w = roleWorld(), c = w.hauler('remote'); w.target('one', 10, STRUCTURE_EXTENSION, 300);
    Memory.rooms.W1N2 = { sources: { source: { haul: {} } } };
    Object.assign(c.memory, { assignmentFunction: 'remoteHauling', freighterJob: 'remoteDelivery',
        remoteDeliveryRoom: 'W1N2', remoteDeliverySourceId: 'source' });
    c.transfer = () => OK; w.role.run(c);
    const haul = Memory.rooms.W1N2.sources.source.haul;
    assert.strictEqual(haul.lastDeliveryAt, undefined);
    Game.time++; w.role.run(c); assert.strictEqual(haul.lastDeliveryAt, undefined);
    Game.time++; c.store.energy = 0; w.role.run(c);
    assert.strictEqual(haul.lastDeliveryAt, Game.time);
});
test('traffic moves a loaded hauler around a movable blocker without moving a stationary miner', () => {
    const w = roleWorld(), hauler = w.hauler('loaded'), blocker = w.hauler('idle', 0, 6);
    const traffic = require('traffic_manager'); traffic.init();
    hauler.registerMove({ x: 6, y: 10 });
    const result = traffic.run(w.room, new PathFinder.CostMatrix(), 20, { creeps: [hauler, blocker] });
    assert.strictEqual(result.moved, 2);
    assert.notStrictEqual(hauler._matchedPackedCoord, blocker._matchedPackedCoord);
    delete hauler._trafficIntent; delete blocker._trafficIntent;
    blocker.memory = { role: 'Extractor', sourceId: 'source' }; blocker.memory.miningSeat = { x: 6, y: 10, roomName: w.room.name };
    blocker.memory.miningSeatKey = w.room.name + ':6:10'; blocker._trafficLocked = true;
    Game.time++; hauler.registerMove({ x: 6, y: 10 });
    const locked = traffic.run(w.room, new PathFinder.CostMatrix(), 20, { creeps: [hauler, blocker] });
    assert.strictEqual(locked.moved, 0);
});
test('execution shrinks a queued local Freighter to the remaining CARRY deficit', () => {
    const f = setup(700); f.miner('a', 5, 'A'); f.miner('b', 5, 'B'); const s = f.sample();
    const manager = require('spawn.request.manager');
    assert.strictEqual(manager.requestDynamicFreightersForRoom(f.room, 112).requested, 1);
    assert.ok(f.queue[0].requestedCarryParts > 1);
    s.haul.requiredCarry = 1; // E.g. production/transport changed while waiting for energy.
    assert.strictEqual(require('spawn.manager').runRoom(f.room.name).result, OK);
    assert.strictEqual(f.calls[0].body.filter(p => p === CARRY).length, 1);
});
test('remote admission reports its current deficit and execution sizes to it', () => {
    const f = setup(700); f.core(); f.miner('a', 5, 'A'); f.miner('b', 5, 'B'); f.sample();
    const E = require('HiveMind.Economy');
    // Isolate logistics admission/body selection from the independent remote spending gate.
    E.canSpawnRequest = () => ({ allowed: true });
    require('HiveMind.Capacity').evaluate = () => ({ allowed: true });
    const info = { active: true, roomName: 'W1N2', effectiveEnergyPerTick: 0.1, roundTripTicks: 50 };
    f.memory.remotePlanner = { activeSourceIds: ['r'], sourceInfos: { r: info } };
    const q = { role: 'Freighter', body: Array(7).fill(CARRY).concat(Array(7).fill(MOVE)),
        requestedCarryParts: 7, memory: { role: 'Freighter', homeRoom: f.room.name, assignmentFunction: 'remoteHauling' } };
    assert.strictEqual(E.remoteHaulingRequest(f.room, q, []).missing, 1);
    assert.strictEqual(require('Spawn.Arbiter').admit(f.room.name, q).requested, 1);
    assert.strictEqual(require('spawn.manager').runRoom(f.room.name).result, OK);
    assert.strictEqual(f.calls[0].body.filter(p => p === CARRY).length, 1);
});
test('local and remote hauling commitments have distinct stable request identities', () => {
    const f = setup(700); f.miner('a', 5, 'A'); f.miner('b', 5, 'B'); f.sample();
    const E = require('HiveMind.Economy'); E.canSpawnRequest = () => ({ allowed: true });
    require('HiveMind.Capacity').evaluate = () => ({ allowed: true });
    f.memory.remotePlanner = { activeSourceIds: ['r'], sourceInfos: {
        r: { active: true, sourceId: 'r', roomName: 'W1N2', effectiveEnergyPerTick: 2, roundTripTicks: 50 } } };
    const manager = require('spawn.request.manager');
    const demand = { localCarryRequired: 1, remoteCarryRequired: 3, desiredCarryParts: 4 };
    assert.strictEqual(manager.requestDynamicFreightersForRoom(f.room, 112, { ...demand }).requested, 1);
    assert.strictEqual(manager.requestDynamicFreightersForRoom(f.room, 112, { ...demand }).requested, 1);
    assert.strictEqual(f.queue.length, 2);
    assert.notStrictEqual(f.queue[0].requestId, f.queue[1].requestId);
    assert.strictEqual(E.freighterCoverage(f.room.name, 'remote').queued, 3);
    assert.strictEqual(manager.requestDynamicFreightersForRoom(f.room, 112, { ...demand }).requested, 0);
});
test('remote-only idle haulers never travel to local sources, including under CPU pressure', () => {
    const w = roleWorld(), c = w.hauler('remote-idle', 0);
    c.memory.assignmentFunction = 'remoteHauling';
    w.room.sources = [{ id: 'local', pos: new RoomPosition(40, 10, w.room.name) }];
    Game.cpu.getUsed = () => 19; Game.cpu.limit = 20;
    for (let i = 0; i < 100; i++) { w.role.run(c); Game.time++; }
    assert.strictEqual(w.moves.length, 0);
    assert.strictEqual(c.memory.freighterIdleSourceId, undefined);
});
test('100 idle local haulers reuse the room index instead of rescanning targets and sources', () => {
    const w = roleWorld();
    w.room.sources = [{ id: 'local', pos: new RoomPosition(7, 10, w.room.name) }];
    for (let i = 0; i < 100; i++) w.hauler('idle' + i, 0);
    let scans = 0; const find = w.room.find;
    w.room.find = function(...args) { scans++; return find.apply(this, args); };
    for (const c of Object.values(Game.creeps)) w.role.run(c);
    assert.ok(scans <= 10, 'room scans grew with population: ' + scans);
    assert.strictEqual(w.moves.length, 0);
    console.log('MEASURE idle room scans: baseline 400; corrected ' + scans + ' for 100 idle haulers');
});
test('deduplicated dynamic requests report no invented queued CARRY', () => {
    const f = setup(700); f.miner('a', 5, 'A'); f.miner('b', 5, 'B'); f.sample();
    const manager = require('spawn.request.manager'), demand = manager.getFreighterCarryDemand(f.room);
    const first = manager.requestDynamicFreightersForRoom(f.room, 112, demand);
    assert.strictEqual(first.requested, 1);
    assert.ok(demand.localCarryMissing > 0);
    const before = demand.localCarryQueued;
    const second = manager.requestDynamicFreightersForRoom(f.room, 112, demand);
    assert.strictEqual(second.requested, 0);
    assert.strictEqual(second.requestedCarryParts, 0);
    assert.strictEqual(demand.localCarryQueued, before);
    assert.strictEqual(demand.localCarryMissing, demand.localCarryRequired - before);
});
test('idle or congested living capacity is counted rather than replaced', () => {
    const f = setup(700);
    for (let i = 0; i < 30; i++) {
        const c = f.miner('idle' + i, 0);
        c.memory = { role: 'Freighter', homeRoom: f.room.name, assignmentFunction: 'localLogistics',
            freighterFlow: { idleTicks: 200, active: false } };
    }
    const s = f.sample(); const manager = require('spawn.request.manager');
    assert.ok(s.haul.localCarry > s.haul.requiredCarry);
    assert.strictEqual(manager.requestDynamicFreightersForRoom(f.room, 112).requested, 0);
    assert.strictEqual(f.queue.length, 0);
});
test('upgradeRush does not invent hauling demand above the production transport model', () => {
    const f = setup(700); f.core(); f.miner('a', 5, 'A'); f.miner('b', 5, 'B'); const s = f.sample();
    require('HiveMind.Memory').getConfig('upgrade').upgradeRush = true;
    s.growth.affordableWork = 12; s.growth.mode = 'GROWTH_NORMAL';
    assert.strictEqual(require('spawn.request.manager').getFreighterCarryDemand(f.room).localCarryRequired, s.haul.requiredCarry);
});
test('body profiles shrink to current hauling demand while fixed bodies retain their contract', () => {
    for (const fixed of [false, true]) {
        const f = setup(700); f.miner('a', 5, 'A'); f.miner('b', 5, 'B'); const s = f.sample();
        const q = { role: 'Freighter', body: Array(7).fill(CARRY).concat(Array(7).fill(MOVE)),
            requestedCarryParts: 7, bodyProfile: { desiredCarry: 7 }, bodyRequirements: { fixed },
            memory: { role: 'Freighter', homeRoom: f.room.name, assignmentFunction: 'localLogistics' } };
        assert.strictEqual(require('Spawn.Arbiter').admit(f.room.name, q).requested, 1);
        s.haul.requiredCarry = 1;
        assert.strictEqual(require('spawn.manager').runRoom(f.room.name).result, OK);
        assert.strictEqual(f.calls[0].body.filter(p => p === CARRY).length, fixed ? 7 : 1);
    }
});
test('CPU pressure defers idle local parking but pickup and recovery continue immediately', () => {
    const w = roleWorld(), c = w.hauler('idle', 0);
    w.room.sources = [{ id: 'local', pos: new RoomPosition(40, 10, w.room.name) }];
    Game.cpu.getUsed = () => 19; Game.cpu.limit = 20;
    w.role.run(c); assert.strictEqual(w.moves.length, 0);
    const d = { id: 'new', resourceType: RESOURCE_ENERGY, amount: 100, pos: new RoomPosition(20, 10, w.room.name) };
    w.room.drops.push(d); w.objects[d.id] = d; Game.time++;
    w.role.run(c); assert.strictEqual(c.memory.pickupTargetId, 'new');
    assert.strictEqual(w.moves[0], 'new');
});
test('indexed pickup observations refresh each tick and preserve source-container filtering', () => {
    const w = roleWorld(), c = w.hauler('idle', 0);
    w.room.sources = [{ id: 'local', pos: new RoomPosition(20, 10, w.room.name) }];
    const t = w.target('source-container', 21, STRUCTURE_CONTAINER, 100); t.store.energy = 100;
    const controller = w.target('controller-container', 40, STRUCTURE_CONTAINER, 100); controller.store.energy = 100;
    w.role.run(c); assert.strictEqual(c.memory.pickupTargetId, t.id);
    Game.time++; t.store.energy = 0; w.role.run(c);
    assert.strictEqual(c.memory.pickupTargetId, undefined);
    assert.strictEqual(w.index.localPickupOptions(w.room).length, 0);
});
test('parking motion is visible but cannot inflate productive Freighter utilization', () => {
    const w = roleWorld(), c = w.hauler('parking', 0); w.role.run(c);
    c.pos.x++; Game.time++; w.role.run(c);
    assert.strictEqual(require('Tick.Creeps').productive(c), false);
    assert.strictEqual(c.memory.freighterFlow.parkingTicks, 1);
    assert.strictEqual(c.memory.freighterFlow.workTicks, 0);
    assert.strictEqual(c.memory.freighterFlow.observedTicks, 1);
    c.memory.freighterJob = 'local'; c.pos.x++; Game.time++; w.role.run(c);
    assert.strictEqual(require('Tick.Creeps').productive(c), true);
    assert.strictEqual(c.memory.freighterFlow.workTicks, 1);
});
test('room diagnostics distinguish covered idle capacity and incomplete observations', () => {
    const f = setup(700);
    for (let i = 0; i < 30; i++) {
        const c = f.miner('idle' + i, 0);
        c.memory = { role: 'Freighter', homeRoom: f.room.name, assignmentFunction: 'localLogistics' };
    }
    f.sample(); const read = require('Diagnostics.View').room;
    let view = read(f.room.name).logistics;
    assert.strictEqual(view.revision, 'logistics-2026-11-07');
    assert.strictEqual(view.local.assessment, 'CAPACITY_COVERED_IDLE_WORKERS');
    assert.strictEqual(view.local.missing, 0); assert.strictEqual(view.local.idleWorkers, 30);
    Game.time++; view = read(f.room.name).logistics;
    assert.strictEqual(view.local.assessment, 'CURRENT_ECONOMY_UNAVAILABLE');
    assert.strictEqual(view.local.required, null);
});
test('Traveler replans an exhausted partial path without submitting an invalid direction', () => {
    const w = roleWorld(), c = w.hauler('partial-path', 100);
    const Traveler = require('Traveler').Traveler;
    _.round = Math.round;
    const destination = new RoomPosition(40, 10, w.room.name);
    let searches = 0; const directions = [];
    Traveler.findTravelPath = () => { searches++; return { path: [new RoomPosition(c.pos.x + 1, 10, w.room.name)], incomplete: true }; };
    const options = { range: 1, sushiMoveHandler(creep, direction) {
        directions.push(direction); return Number.isInteger(direction) && direction >= 1 && direction <= 8 ? OK : ERR_INVALID_ARGS;
    } };
    assert.strictEqual(Traveler.travelTo(c, destination, options), OK);
    Game.time++; c.pos.x++;
    assert.strictEqual(Traveler.travelTo(c, destination, options), OK);
    assert.strictEqual(searches, 2);
    assert.ok(directions.every(Number.isInteger));
});
test('covered CARRY with backlog preserves recovery but diagnoses flow instead of capacity', () => {
    const f = setup(700); f.core(); f.miner('a', 5, 'A'); f.miner('b', 5, 'B');
    const s = f.sample(); s.haul.backlog = 6500;
    const state = require('HiveMind.Economy').rawState(s);
    assert.strictEqual(state.state, 'RECOVERY');
    assert.strictEqual(state.reasonCode, 'LOCAL_HAUL_SHORTAGE'); // Existing spending/recovery contract.
    assert.match(state.reason, /capacity covered.*backlog|backlog.*capacity covered/);
    assert.strictEqual(require('Diagnostics.View').room(f.room.name).logistics.local.assessment, 'CAPACITY_COVERED_BACKLOG');
});
test('shared-lane travel invalidates Traveler paths from an earlier trip', () => {
    const w = roleWorld(), c = w.hauler('shared', 100), target = w.target('container', 10, STRUCTURE_CONTAINER, 2000);
    delete require.cache[require.resolve('utility.Travel.Creep')]; const travel = require('utility.Travel.Creep');
    c.memory._trav = { state: [9, 6, 0, 0, 9, 4, w.room.name], path: '2' };
    c.memory._move = { path: 'old' };
    c.memory._sushiRoute = { routeKey: 'lane', range: 1, destination: { x: 10, y: 10, roomName: w.room.name },
        lastX: 4, lastY: 10, lastRoom: w.room.name };
    Memory.rooms[w.room.name].routeCache = { routes: { lane: {
        from: { x: 5, y: 10, roomName: w.room.name }, path: '3333', complete: true, created: Game.time, lastUsed: Game.time } } };
    c.registerMove = () => OK;
    assert.strictEqual(travel.move(c, target), OK);
    assert.strictEqual(c.memory._trav, undefined); assert.strictEqual(c.memory._move, undefined);
    assert.strictEqual(c.memory._sushiRoute.routeKey, 'lane');
});
test('Traveler retains useful cached steps while a path remains', () => {
    const w = roleWorld(), c = w.hauler('cached-path', 100); _.round = Math.round;
    const Traveler = require('Traveler').Traveler; let searches = 0;
    Traveler.findTravelPath = () => { searches++; return { incomplete: false,
        path: [6, 7, 8, 9].map(x => new RoomPosition(x, 10, w.room.name)) }; };
    for (let i = 0; i < 3; i++) {
        assert.strictEqual(Traveler.travelTo(c, new RoomPosition(40, 10, w.room.name), { range: 1, sushiMoveHandler: () => OK }), OK);
        c.pos.x++; Game.time++;
    }
    assert.strictEqual(searches, 1);
});
console.log('Logistics audit scenarios passed: ' + passed);
