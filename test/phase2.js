const assert = require('assert');
const path = require('path');
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

function position(x, y, roomName = 'W1N1') {
    return {
        x,
        y,
        roomName,
        getDirectionTo(tx, ty) {
            const target = typeof tx === 'object' ? tx : { x: tx, y: ty };
            const dx = Math.sign(target.x - this.x);
            const dy = Math.sign(target.y - this.y);
            const directions = {
                '0:-1': TOP, '1:-1': TOP_RIGHT, '1:0': RIGHT, '1:1': BOTTOM_RIGHT,
                '0:1': BOTTOM, '-1:1': BOTTOM_LEFT, '-1:0': LEFT, '-1:-1': TOP_LEFT
            };
            return directions[`${dx}:${dy}`];
        },
        getRangeTo(target, targetY) {
            const pos = typeof target === 'number' ? { x: target, y: targetY } : (target.pos || target);
            return Math.max(Math.abs(this.x - pos.x), Math.abs(this.y - pos.y));
        }
    };
}

function creep(name, x, y, role = 'Tech') {
    const result = new Creep();
    result.name = name;
    result.my = true;
    result.memory = { role, homeRoom: 'W1N1' };
    result.pos = position(x, y);
    result.room = { name: 'W1N1' };
    result.fatigue = 0;
    result.body = [{ type: MOVE, hits: 100 }];
    result.moves = [];
    result.move = function(direction) { this.moves.push(direction); return OK; };
    return result;
}

function trafficWorld() {
    mocks.installGlobals();
    Game.map.getRoomTerrain = () => ({ get: () => 0 });
    const traffic = fresh('traffic_manager.js');
    traffic.init();
    return traffic;
}

test('TickIndex builds one creep pass and rebuilds after the tick', function() {
    mocks.installGlobals();
    const worker = creep('worker', 10, 10, 'Tech');
    const squad = creep('fighter', 11, 10, 'Volley');
    squad.memory.squadId = 'sq1';
    squad.memory.operationId = 'op1';
    const hostile = { name: 'bad', body: [{ type: ATTACK, hits: 100 }], pos: position(20, 20) };
    const road = { id: 'road1', structureType: STRUCTURE_ROAD, pos: position(5, 5) };
    const site = { id: 'site1', structureType: STRUCTURE_EXTENSION, pos: position(6, 5) };
    const room = {
        name: 'W1N1',
        controller: { my: true },
        find(type) {
            if (type === FIND_STRUCTURES) return [road];
            if (type === FIND_CONSTRUCTION_SITES) return [site];
            if (type === FIND_HOSTILE_CREEPS) return [hostile];
            return [];
        }
    };
    worker.room = room;
    squad.room = room;
    Game.rooms.W1N1 = room;
    Game.creeps = { worker, fighter: squad };
    Game.spawns.Spawn1 = { name: 'Spawn1', my: true, room, spawning: { name: 'newbie' } };
    Memory.rooms.W1N1 = { spawn: { queue: [{ demandId: 'd1' }] } };
    const indexApi = fresh('HiveMind.Index.js');
    const first = indexApi.build();
    assert.strictEqual(first, indexApi.build());
    assert.strictEqual(first.allCreeps.length, 2);
    assert.strictEqual(first.creepsByRole.get('Volley')[0], squad);
    assert.strictEqual(first.creepsBySquadId.get('sq1')[0], squad);
    assert.strictEqual(first.combatHostilesByRoom.get('W1N1')[0], hostile);
    assert.strictEqual(first.activeThreatRooms.has('W1N1'), true);
    assert.strictEqual(first.spawnRequests.length, 1);
    assert.strictEqual(first.spawnedAndSpawningNames.has('newbie'), true);
    assert.doesNotThrow(() => JSON.stringify(Memory), 'heap game objects leaked into Memory');
    Game.time++;
    assert.notStrictEqual(indexApi.build(), first);
});

test('scheduler defers optional work under critical pressure but not emergencies', function() {
    mocks.installGlobals({ limit: 100, bucket: 500, getUsed: () => 1 });
    mocks.clearLocalModules();
    const scheduler = require(path.join(mocks.root, 'HiveMind.Scheduler.js'));
    assert.strictEqual(scheduler.shouldRun('economy', { interval: 1 }), false);
    assert.strictEqual(scheduler.shouldRun('defense', { interval: 1, emergency: true }), true);
    Game.cpu.bucket = 10000;
    Game.time++;
    scheduler.markDirty('strategy');
    assert.strictEqual(scheduler.shouldRun('strategy', { interval: 25 }), true);
});

test('telemetry remains heap-first and periodically persists rolling values', function() {
    let used = 0;
    mocks.installGlobals({ limit: 100, bucket: 9000, getUsed: () => used });
    const telemetry = fresh('HiveMind.Telemetry.js');
    telemetry.startTick();
    telemetry.measure('planning', () => { used += 2.5; });
    used += 1;
    const result = telemetry.finish();
    assert.strictEqual(result.phases.planning, 2.5);
    assert.strictEqual(result.total, 3.5);
    assert.strictEqual(Memory.hive.telemetry.cpu.tick, Game.time);
    assert.strictEqual(Memory.config.cpu.telemetry.debug, false);
});

test('traffic resolves a two-creep swap', function() {
    const traffic = trafficWorld();
    const a = creep('a', 10, 10);
    const b = creep('b', 11, 10);
    a.registerMove(RIGHT);
    b.registerMove(LEFT);
    const result = traffic.run({ name: 'W1N1' }, new PathFinder.CostMatrix(), 20, { creeps: [a, b] });
    assert.strictEqual(result.moved, 2);
    assert.deepStrictEqual(a.moves, [RIGHT]);
    assert.deepStrictEqual(b.moves, [LEFT]);
});

test('traffic resolves a three-creep movement chain', function() {
    const traffic = trafficWorld();
    const a = creep('a', 10, 10);
    const b = creep('b', 11, 10);
    const c = creep('c', 12, 10);
    a.registerMove(RIGHT);
    b.registerMove(RIGHT);
    c.registerMove(RIGHT);
    const result = traffic.run({ name: 'W1N1' }, new PathFinder.CostMatrix(), 20, { creeps: [a, b, c] });
    assert.strictEqual(result.moved, 3);
});

test('higher-priority movement wins a contested tile deterministically', function() {
    const traffic = trafficWorld();
    const high = creep('high', 10, 10);
    const low = creep('low', 12, 10);
    high.registerMove(RIGHT, { priority: 100, operationId: 'defense' });
    low.registerMove(LEFT, { priority: 1 });
    traffic.run({ name: 'W1N1' }, new PathFinder.CostMatrix(), 20, { creeps: [low, high] });
    assert.deepStrictEqual(high.moves, [RIGHT]);
    assert.deepStrictEqual(low.moves, []);
    assert.strictEqual(traffic.getMovementIntents('W1N1')[0].roomName, 'W1N1');
});

test('hostile and power-creep occupancy blocks movement', function() {
    for (const blockerType of ['hostile', 'power']) {
        const traffic = trafficWorld();
        const mover = creep(`mover-${blockerType}`, 10, 10);
        mover.registerMove(RIGHT, { priority: 100 });
        const blocker = { id: blockerType, pos: position(11, 10) };
        const result = traffic.run({ name: 'W1N1' }, new PathFinder.CostMatrix(), 20, {
            creeps: [mover], blockers: [blocker]
        });
        assert.strictEqual(result.moved, 0);
    }
});

test('locked stationary creeps are not shoved', function() {
    const traffic = trafficWorld();
    const mover = creep('mover', 10, 10);
    const miner = creep('miner', 11, 10, 'Extractor');
    miner.memory.sourceId = 'source1';
    miner.setTrafficLock(true);
    mover.registerMove(RIGHT, { priority: 100 });
    const result = traffic.run({ name: 'W1N1' }, new PathFinder.CostMatrix(), 20, { creeps: [mover, miner] });
    assert.strictEqual(result.moved, 0);
});

test('ordered fallback tiles are used when the intended tile is blocked', function() {
    const traffic = trafficWorld();
    const mover = creep('fallback', 10, 10);
    mover.registerMove(RIGHT, { priority: 100, fallbackPositions: [position(10, 11)] });
    const blocker = { id: 'hostile', pos: position(11, 10) };
    const result = traffic.run({ name: 'W1N1' }, new PathFinder.CostMatrix(), 20, {
        creeps: [mover], blockers: [blocker]
    });
    assert.strictEqual(result.moved, 1);
    assert.deepStrictEqual(mover.moves, [BOTTOM]);
});

test('travel wrapper forwards traffic metadata without owning final movement', function() {
    mocks.installGlobals();
    let registered = null;
    const mover = creep('wrapper', 10, 10);
    mover.registerMove = function(direction, options) { registered = { direction, options }; return OK; };
    const travel = fresh('utility.Travel.Creep.js');
    assert.strictEqual(travel.requestMove(mover, RIGHT, {
        trafficPriority: 90,
        squadId: 'sq1',
        operationId: 'op1',
        fallbackPositions: [position(10, 11)]
    }), OK);
    assert.strictEqual(registered.direction, RIGHT);
    assert.strictEqual(registered.options.priority, 90);
    assert.strictEqual(registered.options.squadId, 'sq1');
    assert.strictEqual(mover.moves.length, 0);
});

test('static traffic matrices are reused and invalidated by structure changes', function() {
    mocks.installGlobals();
    OBSTACLE_OBJECT_TYPES = [STRUCTURE_EXTENSION];
    const finalize = fresh('Tick.Finalize.js');
    const road = { id: 'road', structureType: STRUCTURE_ROAD, pos: position(5, 5), my: true };
    const byType = new Map([[STRUCTURE_ROAD, [road]]]);
    const index = {
        structuresByRoom: new Map([['W1N1', byType]]),
        constructionSitesByRoom: new Map([['W1N1', []]])
    };
    const room = { name: 'W1N1' };
    const first = finalize.buildTrafficCostMatrix(room, index);
    assert.strictEqual(finalize.buildTrafficCostMatrix(room, index), first);
    const extension = { id: 'ext', structureType: STRUCTURE_EXTENSION, pos: position(6, 5), my: true };
    byType.set(STRUCTURE_EXTENSION, [extension]);
    const changed = finalize.buildTrafficCostMatrix(room, index);
    assert.notStrictEqual(changed, first);
    assert.strictEqual(changed.get(6, 5), 255);
});




test('mission priorities precede idle and only seated stationary Extractors are protected', () => {
    const traffic = trafficWorld();
    for (const role of ['Volley', 'Ronin', 'Cleric', 'ReactorClaimer', 'ThoriumMiner', 'ThoriumHauler']) {
        assert.ok(traffic.defaultPriority({ memory: { role } }) > 5);
    }
    assert.strictEqual(traffic.defaultPriority({ memory: { squadId: 'squad' } }), 80);
    const miner = creep('miner', 11, 10, 'Extractor');
    miner.memory.sourceId = 'source';
    miner.memory.extractorState = 'miningRemoteSource';
    Memory.rooms.W1N1 = { sources: { source: { pos: { x: 12, y: 10, roomName: 'W1N1' },
        containerPlannedPos: { x: 11, y: 10, roomName: 'W1N1' }, seats: [{ x: 11, y: 11 }] } } };
    assert.strictEqual(traffic.isProtectedStationaryMiner(miner), true);
    miner.pos = position(11, 11);
    miner.memory.miningSeat = { sourceId: 'source', x: 11, y: 11, roomName: 'W1N1' };
    assert.strictEqual(traffic.isProtectedStationaryMiner(miner), true);
    miner.pos = position(10, 10);
    assert.strictEqual(traffic.isProtectedStationaryMiner(miner), false);
    assert.ok(traffic.getPossibleMoves(miner).length > 0);
    miner.pos = position(11, 10);
    miner.memory.extractorState = 'remoteRetreat';
    assert.strictEqual(traffic.isProtectedStationaryMiner(miner), false);
    miner.memory.extractorState = 'remoteContainerOperational';
    const hauler = creep('loaded', 10, 10, 'Freighter');
    hauler.registerMove(RIGHT, { priority: 90 });
    traffic.run(hauler.room, new PathFinder.CostMatrix(), 20, { creeps: [hauler, miner] });
    assert.deepStrictEqual(miner.moves, []);
    assert.deepStrictEqual(hauler.moves, []);
});

test('loaded highway Freighter gets head-on right of way and records real push/sidestep events', () => {
    for (const role of ['Annex', 'Extractor', 'Tech']) {
        const traffic = trafficWorld();
        const loaded = creep('loaded', 10, 10, 'Freighter');
        loaded.store = { getUsedCapacity: () => 100 };
        const worker = creep('worker', 11, 10, role);
        if (role === 'Extractor') { worker.memory.sourceId = 'remote'; worker.memory.extractorState = 'movingToRemoteSource'; }
        const route = { revision: 1 };
        Memory.rooms.W1N1 = { remotePlanner: { sourceInfos: { remote: { route } } } };
        const metadata = { homeRoom: 'W1N1', sourceId: 'remote', routeRevision: 1, direction: 'RETURN' };
        loaded.registerMove(RIGHT, { remoteRoute: metadata });
        if (role !== 'Tech') worker.registerMove(LEFT, { remoteRoute: { ...metadata, direction: 'OUTBOUND' } });
        traffic.run(loaded.room, new PathFinder.CostMatrix(), 20, { creeps: [worker, loaded] });
        assert.deepStrictEqual(loaded.moves, [RIGHT]);
        assert.strictEqual(worker.moves.length, 1);
        if (role !== 'Tech') assert.ok(![LEFT, RIGHT].includes(worker.moves[0]), 'head-on yield must leave the lane');
        assert.strictEqual(route.traffic.moves, 1);
        assert.strictEqual(route.traffic.pushes, 1);
        assert.strictEqual(route.traffic.sidesteps, 1);
        assert.ok(!route.dirty);
    }
});

test('canonical fallbacks reject source seats, walls, structures, exits and hostile reach', () => {
    const traffic = trafficWorld();
    global.OBSTACLE_OBJECT_TYPES = [STRUCTURE_SPAWN, STRUCTURE_EXTENSION];
    const worker = creep('worker', 10, 10);
    Memory.rooms.W1N1 = { sources: { source: { pos: { x: 12, y: 10, roomName: 'W1N1' },
        containerPlannedPos: { x: 11, y: 10, roomName: 'W1N1' }, seats: [{ x: 11, y: 9 }] } } };
    Game.map.getRoomTerrain = () => ({ get: (x, y) => x === 9 && y === 9 ? TERRAIN_MASK_WALL : 0 });
    worker.room.find = kind => kind === FIND_STRUCTURES ? [
        { structureType: STRUCTURE_SPAWN, pos: position(9, 10) }
    ] : kind === FIND_HOSTILE_CREEPS ? [
        { body: [{ type: ATTACK, hits: 100 }], pos: position(10, 13) }
    ] : [];
    worker.registerMove(TOP, { remoteRoute: { sourceId: 'remote' }, fallbackPositions: [{ x: 0, y: 10 }] });
    const possible = traffic.getPossibleMoves(worker, new PathFinder.CostMatrix(), 20);
    assert.deepStrictEqual(possible.map(traffic.packCoordinates), ['10:9']);
});




test('route rejoin and observed stuck events use transient intent metadata and reject stale revisions', () => {
    const traffic = trafficWorld();
    const worker = creep('rejoining', 10, 11, 'Annex');
    const route = { revision: 1 };
    Memory.rooms.W1N1 = { remotePlanner: { sourceInfos: { remote: { route } } } };
    const metadata = { homeRoom: 'W1N1', sourceId: 'remote', routeRevision: 1, direction: 'OUTBOUND', rejoin: true };
    worker.registerMove(TOP, { remoteRoute: metadata });
    traffic.run(worker.room, new PathFinder.CostMatrix(), 20, { creeps: [worker] });
    assert.strictEqual(route.traffic.rejoins, 1);
    Game.time++; // Engine kept the creep in place despite an accepted move.
    worker.registerMove(TOP, { remoteRoute: metadata });
    traffic.run(worker.room, new PathFinder.CostMatrix(), 20, { creeps: [worker] });
    assert.strictEqual(route.traffic.stuckEvents, 1);
    route.revision++;
    const snapshot = JSON.stringify(route.traffic);
    Game.time++;
    worker.registerMove(TOP, { remoteRoute: metadata });
    traffic.run(worker.room, new PathFinder.CostMatrix(), 20, { creeps: [worker] });
    assert.strictEqual(JSON.stringify(route.traffic), snapshot);
    assert.strictEqual(worker.memory.remoteRoute, undefined);
});

console.log(`Phase 2 tests passed: ${passed}`);
