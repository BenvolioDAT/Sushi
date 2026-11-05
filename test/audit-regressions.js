const assert = require('assert');
const mocks = require('./mock-screeps');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}
function reset() {
    for (const key of Object.keys(global)) if (key.startsWith('__sushi')) delete global[key];
    mocks.installGlobals();
    mocks.clearLocalModules();
    global.ERR_NO_BODYPART = -12;
    RoomPosition.prototype.getDirectionTo = function(target, y) {
        const pos = typeof target === 'number' ? { x: target, y } : target.pos || target;
        const dx = Math.sign(pos.x - this.x), dy = Math.sign(pos.y - this.y);
        return { '0:-1': TOP, '1:-1': TOP_RIGHT, '1:0': RIGHT, '1:1': BOTTOM_RIGHT,
            '0:1': BOTTOM, '-1:1': BOTTOM_LEFT, '-1:0': LEFT, '-1:-1': TOP_LEFT }[dx + ':' + dy];
    };
    global.OBSTACLE_OBJECT_TYPES = [STRUCTURE_SPAWN, STRUCTURE_EXTENSION];
    return require('HiveMind.Memory').ensure();
}
function store(values = {}, capacity = 100) {
    const result = { ...values };
    Object.defineProperties(result, {
        getUsedCapacity: { value(type) { return type ? this[type] || 0 :
            Object.values(this).reduce((sum, value) => sum + value, 0); } },
        getFreeCapacity: { value() { return Math.max(0, capacity - this.getUsedCapacity()); } },
        getCapacity: { value() { return capacity; } }
    });
    return result;
}
function room() {
    const result = { name: 'W1N1', controller: { my: true, level: 3, ticksToDowngrade: 10000 },
        energyAvailable: 300, energyCapacityAvailable: 800, structures: [], sources: [],
        find(kind) { return kind === FIND_STRUCTURES ? this.structures : kind === FIND_SOURCES ? this.sources : []; },
        lookForAt(kind, x, y) { return kind === LOOK_STRUCTURES ? this.structures.filter(item =>
            item.pos.x === x && item.pos.y === y) : []; } };
    Game.rooms[result.name] = result;
    Memory.rooms[result.name] = { spawn: { queue: [] }, sources: {}, economy: { state: 'STABLE' } };
    return result;
}
function creep(home, name = 'worker', role = 'Tech', x = 10, y = 10) {
    const result = new Creep();
    Object.assign(result, { name, my: true, room: home, pos: new RoomPosition(x, y, home.name),
        memory: { role, homeRoom: home.name }, body: [{ type: MOVE, hits: 100 }],
        store: store(), ticksToLive: 1000, fatigue: 0, moves: [] });
    result.move = direction => { result.moves.push(direction); return OK; };
    Game.creeps[name] = result;
    Memory.creeps[name] = result.memory;
    return result;
}

test('emergency miner completes a delivery across ticks before returning to its seat', () => {
    reset();
    const home = room();
    const miner = creep(home, 'miner', 'Extractor');
    miner.body.push({ type: WORK, hits: 100 }, { type: CARRY, hits: 100 });
    miner.store = store({ energy: 50 }, 50);
    const source = { id: 'source', pos: new RoomPosition(9, 10, home.name) };
    const seat = new RoomPosition(10, 10, home.name);
    const spawn = { id: 'spawn', structureType: STRUCTURE_SPAWN, pos: new RoomPosition(14, 10, home.name),
        store: store({}, 300) };
    const memory = Memory.rooms[home.name];
    memory.sources.source = { id: source.id, pos: source.pos };
    memory.economy = { state: 'SURVIVAL', haul: { localCarry: 0, queuedCarry: 0 } };
    const utility = require('utility');
    utility.planSourceContainers = () => {};
    utility.ensureSourceHaulMemory = () => null;
    const helpers = require('utility.Creep');
    helpers.getAssignedSource = () => source;
    helpers.getAssignedMiningSeat = () => seat;
    let pendingMove = null, pendingTransfer = false;
    require('utility.Travel.Creep').move = (unit, target) => { pendingMove = target.pos || target; return OK; };
    miner.pos.findClosestByPath = () => spawn;
    miner.transfer = () => {
        if (miner.pos.getRangeTo(spawn) > 1) return ERR_NOT_IN_RANGE;
        pendingTransfer = true;
        return OK;
    };
    miner.harvest = () => OK;
    miner.drop = () => { throw new Error('Emergency cargo must reach the spawn'); };
    const role = require('role.Extractor');
    for (let tick = 0; tick < 5 && !spawn.store.energy; tick++) {
        role.run(miner);
        if (pendingMove) miner.pos.x += Math.sign(pendingMove.x - miner.pos.x);
        if (pendingTransfer) { spawn.store.energy = miner.store.energy; miner.store.energy = 0; }
        pendingMove = null; pendingTransfer = false;
        Game.time++;
    }
    assert.strictEqual(spawn.store.energy, 50, 'seat correction interrupted the delivery');
    role.run(miner);
    assert.strictEqual(pendingMove, seat, 'empty miner should resume its station');
});

test('queued hauling does not stop emergency self-delivery', () => {
    reset(); room();
    Memory.rooms.W1N1.economy = { state: 'SURVIVAL', haul: { localCarry: 0, queuedCarry: 2 } };
    const economy = require('HiveMind.Economy');
    assert.strictEqual(economy.shouldBootstrapSelfDeliver('W1N1'), true);
    Memory.rooms.W1N1.economy.haul.localCarry = 2;
    assert.strictEqual(economy.shouldBootstrapSelfDeliver('W1N1'), false);
});

test('spawning haulers are incoming capacity rather than active local hauling', () => {
    reset();
    const home = room();
    const incoming = creep(home, 'incoming', 'Freighter');
    incoming.spawning = true;
    incoming.body.push({ type: CARRY, hits: 100 });
    incoming.memory.freighterSpawnCarryParts = 1;
    Game.spawns.Spawn1 = { name: 'Spawn1', room: home, spawning: { name: incoming.name } };
    const snapshot = require('HiveMind.Economy').updateRoom(home);
    assert.strictEqual(snapshot.haul.localCarryLiving, 0);
    assert.strictEqual(snapshot.haul.localCarrySpawning, 1);
});

test('a new tick replaces old demand maxima while same-tick emissions still merge', () => {
    reset();
    const board = require('Spawn.DemandBoard');
    board.emit({ id: 'defenders', role: 'Volley', count: 4, priority: 90, emergency: true, deadline: 120 });
    Game.time++;
    let demand = board.emit({ id: 'defenders', role: 'Volley', count: 1, priority: 30, deadline: 200 });
    assert.strictEqual(demand.count, 1);
    assert.strictEqual(demand.priority, 30);
    assert.strictEqual(demand.emergency, false);
    assert.strictEqual(demand.deadline, 200);
    demand = board.emit({ id: 'defenders', role: 'Volley', count: 2, priority: 50, deadline: 180 });
    assert.strictEqual(demand.count, 2);
    assert.strictEqual(demand.priority, 50);
    assert.strictEqual(demand.deadline, 180);
    Game.time++;
    assert.strictEqual(board.emit({ id: 'defenders', role: 'Volley', count: 0 }).count, 0);
});

test('lower demand retires excess queued slots without touching living assignments', () => {
    reset();
    const home = room();
    const board = require('Spawn.DemandBoard');
    const live = creep(home, 'defender', 'Volley');
    Object.assign(live.memory, { demandId: 'defenders', demandSlot: 0 });
    const queue = Memory.rooms.W1N1.spawn.queue;
    for (let slot = 1; slot <= 3; slot++) queue.push({ role: 'Volley', body: [MOVE, RANGED_ATTACK],
        requestId: 'slot-' + slot, requestedAt: Game.time, expiresAt: Game.time + 50,
        memory: { role: 'Volley', demandId: 'defenders', demandSlot: slot } });
    board.emit({ id: 'defenders', role: 'Volley', count: 1, priority: 90 });
    board.flush();
    assert.strictEqual(queue.length, 0);
    assert.strictEqual(Game.creeps.defender, live);
});

test('retained demand requests lose obsolete emergency priority and classification', () => {
    reset(); const home = room();
    const board = require('Spawn.DemandBoard');
    const queued = { role: 'Volley', body: [MOVE, RANGED_ATTACK], emergency: true, priority: 99,
        requestId: 'defender', expiresAt: Game.time + 50,
        memory: { role: 'Volley', demandId: 'defenders', demandSlot: 0,
            defenseRequest: true, defendedRoom: home.name, emergencyDefense: true } };
    Memory.rooms[home.name].spawn.queue.push(queued);
    board.emit({ id: 'defenders', role: 'Volley', count: 1, priority: 20 });
    board.flush();
    assert.strictEqual(queued.emergency, false);
    assert.strictEqual(queued.priority, 20);
    assert.strictEqual(require('Spawn.Policy').isOwnedDefense(queued), false);
});

test('bounded GC eventually reaches every domain behind retained squads', () => {
    const hive = reset();
    const config = require('HiveMind.Memory').getConfig('memoryGC');
    config.workBudget = 2;
    for (let i = 0; i < 7; i++) hive.squads['active-' + i] = { state: 'FORMING' };
    hive.operations.old = { state: 'COMPLETE', completedTick: 1 };
    hive.players.old = { manual: false, incidentScore: 0, updatedTick: 1 };
    config.operationRetention = config.playerRetention = 1;
    Memory.rooms.W9N9 = { identity: { type: 'INTEL' }, lastScanned: 1,
        sources: { old: {} }, custom: { keep: true } };
    config.intelRetention = 1;
    const gc = require('HiveMind.MemoryGC');
    for (let i = 0; i < 30; i++) {
        assert.ok(gc.run({ force: true }).work <= 2);
        Game.time++;
    }
    assert.strictEqual(hive.operations.old, undefined);
    assert.strictEqual(hive.players.old, undefined);
    assert.strictEqual(Memory.rooms.W9N9.sources, undefined);
    assert.deepStrictEqual(Memory.rooms.W9N9.custom, { keep: true });
    assert.strictEqual(Object.keys(hive.squads).length, 7);
});

test('GC progress survives Memory deserialization and module reloads', () => {
    let hive = reset();
    const config = require('HiveMind.Memory').getConfig('memoryGC');
    config.workBudget = 1; config.operationRetention = 1;
    for (let i = 0; i < 5; i++) hive.squads['active-' + i] = { state: 'FORMING' };
    hive.operations.old = { state: 'COMPLETE', completedTick: 1 };
    for (let i = 0; i < 12; i++) {
        require('HiveMind.MemoryGC').run({ force: true });
        Game.time++;
        global.Memory = JSON.parse(JSON.stringify(Memory));
        mocks.clearLocalModules();
    }
    assert.strictEqual(Memory.hive.operations.old, undefined);
    assert.strictEqual(Object.keys(Memory.hive.squads).length, 5);
});

test('immobile and spawning creeps cannot be displaced out of a reserved tile', () => {
    for (const condition of ['spawning', 'noMove', 'destroyedMove', 'fatigue']) {
        reset(); const home = room();
        const traffic = require('traffic_manager'); traffic.init();
        const mover = creep(home, 'mover');
        const blocker = creep(home, 'blocker', 'Tech', 11, 10);
        if (condition === 'spawning') blocker.spawning = true;
        if (condition === 'noMove') blocker.body = [{ type: WORK, hits: 100 }];
        if (condition === 'destroyedMove') blocker.body[0].hits = 0;
        if (condition === 'fatigue') blocker.fatigue = 1;
        mover.registerMove(RIGHT);
        traffic.run(home, new PathFinder.CostMatrix(), 20, { creeps: [mover, blocker] });
        assert.deepStrictEqual(blocker.moves, [], condition);
        assert.deepStrictEqual(mover.moves, [], condition);
    }
});

test('traffic rejects permanently blocked primary steps and may use a legal fallback', () => {
    reset(); const home = room();
    const traffic = require('traffic_manager'); traffic.init();
    const mover = creep(home);
    const costs = new PathFinder.CostMatrix(); costs.set(11, 10, 255);
    mover.registerMove(RIGHT);
    traffic.run(home, costs, 20, { creeps: [mover] });
    assert.deepStrictEqual(mover.moves, []);
    Game.time++;
    mover.registerMove(RIGHT, { fallbackPositions: [{ x: 10, y: 9 }] });
    traffic.run(home, costs, 20, { creeps: [mover] });
    assert.strictEqual(mover.moves.length, 1);
});

test('traffic invalidates positional paths after a sidestep but keeps movement guards', () => {
    reset(); const home = room();
    const traffic = require('traffic_manager'); traffic.init();
    const mover = creep(home);
    Object.assign(mover.memory, { _trav: { path: '333' }, _move: { path: '333' },
        _sushiRoute: { routeKey: 'old-lane' }, _sushiMoveTick: Game.time });
    mover.registerMove(RIGHT, { fallbackPositions: [{ x: 10, y: 9 }] });
    traffic.run(home, new PathFinder.CostMatrix(), 20, { creeps: [mover],
        blockers: [{ id: 'hostile', pos: new RoomPosition(11, 10, home.name) }] });
    assert.strictEqual(mover.memory._trav, undefined);
    assert.strictEqual(mover.memory._move, undefined);
    assert.strictEqual(mover.memory._sushiRoute, undefined);
    assert.strictEqual(mover.memory._sushiMoveTick, Game.time);
});

test('private ramparts stay blocked when a road shares the tile', () => {
    reset(); const home = room();
    home.structures = [
        { id: 'rampart', structureType: STRUCTURE_RAMPART, my: false, isPublic: false, pos: new RoomPosition(11, 10, home.name) },
        { id: 'road', structureType: STRUCTURE_ROAD, pos: new RoomPosition(11, 10, home.name) }
    ];
    assert.strictEqual(require('Tick.Finalize').buildTrafficCostMatrix(home).get(11, 10), 255);
});

test('shared range-zero routes reach the exact target and preserve blocked overlays', () => {
    reset(); const home = room(); const mover = creep(home);
    const target = { id: 'container', structureType: STRUCTURE_CONTAINER,
        pos: new RoomPosition(11, 10, home.name) };
    home.structures = [
        { id: 'private', structureType: STRUCTURE_RAMPART, my: false, pos: new RoomPosition(15, 15, home.name) },
        { id: 'road', structureType: STRUCTURE_ROAD, pos: new RoomPosition(15, 15, home.name) }
    ];
    let range, blocked;
    PathFinder.search = (origin, goal, options) => {
        range = goal.range;
        blocked = options.roomCallback(home.name).get(15, 15);
        return { path: [target.pos], incomplete: false };
    };
    require('traffic_manager').init();
    assert.strictEqual(require('utility.Travel.Creep').move(mover, target, { range: 0 }), OK);
    assert.strictEqual(range, 0);
    assert.strictEqual(blocked, 255);
    assert.strictEqual(mover._trafficIntent.packedTarget, '11:10');
});

test('traffic preserves an explicit room crossing but rejects a wall tile', () => {
    reset(); const home = room();
    const traffic = require('traffic_manager'); traffic.init();
    const mover = creep(home, 'border', 'Scout', 49, 25);
    mover.registerMove(RIGHT);
    assert.deepStrictEqual(traffic.getPossibleMoves(mover), [{ x: 50, y: 25 }]);
    Game.time++; mover.pos = new RoomPosition(10, 10, home.name);
    Game.map.getRoomTerrain = () => ({ get: (x, y) => x === 11 && y === 10 ? TERRAIN_MASK_WALL : 0 });
    mover.registerMove(RIGHT);
    traffic.run(home, new PathFinder.CostMatrix(), 20, { creeps: [mover] });
    assert.deepStrictEqual(mover.moves, []);
});

test('Traveler refreshes each room independently during the same tick', () => {
    reset();
    const Traveler = require('Traveler').Traveler;
    const first = { name: 'W1N1' }, second = { name: 'W2N1' };
    let structures = 0, creeps = 0;
    Traveler.addStructuresToMatrix = (r, matrix) => { matrix.version = ++structures; return matrix; };
    Traveler.addCreepsToMatrix = (r, matrix) => { matrix.creepVersion = ++creeps; return matrix; };
    Traveler.getStructureMatrix(first); Traveler.getStructureMatrix(second);
    Game.time++;
    const a = Traveler.getStructureMatrix(first, true);
    const b = Traveler.getStructureMatrix(second, true);
    assert.strictEqual(structures, 4);
    assert.strictEqual(Traveler.getStructureMatrix(second, true), b);
    Traveler.getCreepMatrix(first); Traveler.getCreepMatrix(second);
    Game.time++;
    Traveler.getCreepMatrix(first); Traveler.getCreepMatrix(second);
    assert.strictEqual(creeps, 4);
    assert.notStrictEqual(a, Traveler.getStructureMatrix(first, true));
});

test('courier delivers the final source batch after its heap job disappears', () => {
    reset(); const home = room();
    const vault = { id: 'vault', pos: new RoomPosition(10, 11, home.name), store: store({ H: 50 }, 10000) };
    const lab = { id: 'lab', pos: new RoomPosition(11, 10, home.name), store: store({}, 3000) };
    home.storage = vault;
    const objects = { vault, lab };
    Game.getObjectById = id => objects[id] || null;
    const unit = creep(home, 'courier', 'ResourceCourier');
    let pending = null;
    unit.withdraw = (target, type, amount) => { pending = { target, type, amount }; return OK; };
    unit.transfer = (target, type) => { unit.deliveredTo = target.id; return OK; };
    const manager = require('Resource.Manager');
    manager.addJobs([{ id: 'fill-lab', roomName: home.name, sourceId: 'vault', targetId: 'lab',
        resourceType: 'H', amount: 50, priority: 50 }]);
    const role = require('role.ResourceCourier');
    role.run(unit);
    assert.strictEqual(pending.amount, 50);
    pending.target.store.H -= pending.amount;
    unit.store.H = pending.amount;
    Game.time++;
    // No source stock remains, so fillJob emits no row in the next tick.
    role.run(unit);
    assert.strictEqual(unit.deliveredTo, 'lab');
});

test('a full courier destination releases the job and uses owned fallback storage', () => {
    reset(); const home = room();
    const vault = { id: 'vault', pos: new RoomPosition(10, 11, home.name), store: store({ H: 50 }, 10000) };
    const lab = { id: 'lab', pos: new RoomPosition(11, 10, home.name), store: store({ H: 100 }, 100) };
    home.storage = vault;
    Game.getObjectById = id => ({ vault, lab })[id] || null;
    const unit = creep(home, 'courier', 'ResourceCourier'); unit.store.H = 50;
    unit.transfer = target => { unit.deliveredTo = target.id; return target === lab ? ERR_FULL : OK; };
    require('Resource.Manager').addJobs([{ id: 'fill-lab', roomName: home.name,
        sourceId: 'vault', targetId: 'lab', resourceType: 'H', amount: 50, priority: 50 }]);
    require('role.ResourceCourier').run(unit);
    assert.strictEqual(unit.deliveredTo, 'vault');
    assert.strictEqual(unit.memory.resourceJobId, undefined);
});

test('an unreachable repair releases its claim and permits construction fallback', () => {
    reset(); const home = room();
    const unit = creep(home, 'builder', 'Artificer'); unit.store = store({ energy: 50 }, 50);
    unit.memory.builderWorking = true;
    const damaged = { id: 'damaged', structureType: STRUCTURE_CONTAINER, hits: 1, hitsMax: 1000,
        pos: new RoomPosition(30, 30, home.name) };
    const site = { id: 'site', structureType: STRUCTURE_EXTENSION, my: true, progress: 0, progressTotal: 1000,
        pos: new RoomPosition(11, 10, home.name) };
    Memory.rooms.W1N1.RepairStructure = [damaged.id];
    home.find = kind => kind === FIND_MY_CONSTRUCTION_SITES ? [site] : [];
    Game.getObjectById = id => ({ damaged, site })[id] || null;
    require('utility.Creep').shouldRepairStructure = () => true;
    let attempts = 0, builds = 0;
    unit.repair = () => { attempts++; return ERR_NOT_IN_RANGE; };
    unit.build = () => { builds++; return OK; };
    require('utility.Travel.Creep').move = () => ERR_NO_PATH;
    const role = require('role.Artificer');
    role.run(unit);
    assert.strictEqual(unit.memory.repairTargetId, undefined);
    assert.strictEqual(Memory.rooms.W1N1.ArtificerRepairClaims.damaged, undefined);
    assert.strictEqual(builds, 1);
    Game.time++; role.run(unit);
    assert.strictEqual(attempts, 1, 'failed repair path should back off');
    assert.strictEqual(builds, 2);
});

test('one throwing role does not skip other creeps, traffic or end-of-tick telemetry', () => {
    reset(); const home = room();
    creep(home, 'broken', 'Tech'); creep(home, 'healthy', 'Foreman');
    const execution = require('Tick.Creeps');
    execution.roles.Tech.run = () => { throw new Error('simulated role failure'); };
    let ran = false, traffic = false;
    execution.roles.Foreman.run = () => { ran = true; };
    require('Tick.Bootstrap').run = () => {};
    const planning = require('Tick.Planning');
    for (const key of ['refreshIntelAndThreats', 'runStrategy', 'generateSpawnRequests', 'runSpawning']) planning[key] = () => {};
    require('Tick.Rooms').runStructures = () => {};
    require('Tick.Finalize').resolveTraffic = () => { traffic = true; };
    require('Tick.Finalize').runOptionalWork = () => {};
    const main = require('main');
    const logs = [], original = console.log;
    console.log = (...values) => logs.push(values.join(' '));
    try { main.loop(); Game.time++; main.loop(); } finally { console.log = original; }
    assert.strictEqual(ran, true);
    assert.strictEqual(traffic, true);
    assert.strictEqual(logs.filter(line => line.includes('simulated role failure')).length, 1);
    assert.strictEqual(require('HiveMind.Telemetry').getView().tick, Game.time);
    assert.strictEqual(Memory.hive.telemetry.creepErrors.Tech.creepName, 'broken');
});

test('spawning creeps are skipped before role execution', () => {
    reset(); const home = room();
    const incoming = creep(home); incoming.spawning = true;
    require('Tick.Creeps').roles.Tech.run = () => { throw new Error('spawning creep dispatched'); };
    require('Tick.Creeps').run();
    assert.strictEqual(Memory.hive.telemetry.creepErrors && Memory.hive.telemetry.creepErrors.Tech, undefined);
});

test('repair indexing reuses the tick structure scan and preserves an unchanged id list', () => {
    reset(); const home = room();
    home.structures = [{ id: 'damaged', hits: 10, hitsMax: 100, structureType: STRUCTURE_ROAD },
        { id: 'healthy', hits: 100, hitsMax: 100, structureType: STRUCTURE_CONTAINER }];
    const originalFind = home.find;
    let scans = 0;
    home.find = function(kind) { if (kind === FIND_STRUCTURES) scans++; return originalFind.call(this, kind); };
    require('HiveMind.Index').get();
    const rooms = require('Tick.Rooms');
    rooms.updateRepairStructureMemory(home);
    const ids = Memory.rooms.W1N1.RepairStructure;
    rooms.updateRepairStructureMemory(home);
    assert.strictEqual(scans, 1);
    assert.deepStrictEqual(ids, ['damaged']);
    assert.strictEqual(Memory.rooms.W1N1.RepairStructure, ids);
});

test('an explicit zero strategy budget blocks discretionary operation activation', () => {
    reset(); const home = room();
    Game.spawns.Spawn1 = { name: 'Spawn1', room: home };
    const config = require('HiveMind.Memory').getConfig('combat').strategy;
    config.maxActiveNonEmergency = config.maxActivePerColony = 0;
    const operations = require('HiveMind.Operations');
    const operation = operations.create('SCOUT_INTEL', { id: 'scout', originRoom: home.name, targetRoom: 'W2N1' });
    operations.run();
    assert.strictEqual(operation.state, 'PENDING');
    assert.strictEqual(operation.strategyDecision, 'wait');
});

test('operations outside the tick budget cannot spawn from an old allow decision', () => {
    reset(); const home = room();
    Game.spawns.Spawn1 = { name: 'Spawn1', room: home };
    const operations = require('HiveMind.Operations');
    for (let i = 0; i < 26; i++) operations.create('SCOUT_INTEL', {
        id: 'scout-' + i, priority: 100 - i, originRoom: home.name, targetRoom: 'W2N1' });
    const stale = operations.get('scout-25');
    stale.strategyDecision = 'allow'; stale.strategyTick = Game.time;
    stale.spawnDemands = [{ id: 'stale-demand', role: 'Scout', count: 1 }];
    const board = require('Spawn.DemandBoard');
    board.emit({ id: 'stale-demand', role: 'Scout', count: 1, operationId: stale.id });
    Game.time++;
    operations.run();
    assert.strictEqual(board.flush().demands['stale-demand'], undefined);
});

test('bounded strategy rescoring eventually reaches candidates after the first id', () => {
    const hive = reset();
    require('HiveMind.Memory').getConfig('combat').strategy.maxCandidates = 1;
    const operations = require('HiveMind.Operations');
    for (const id of ['a', 'b', 'c']) operations.create('SCOUT_INTEL', { id });
    const strategy = require('HiveMind.Strategy');
    for (let i = 0; i < 3; i++) { Game.time++; strategy.scoreOperations(); }
    assert.ok(Object.values(hive.operations).every(op => op.updatedTick > 100));
});

console.log(`Audit regressions: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
