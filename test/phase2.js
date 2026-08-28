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
    Memory.rooms.W1N1 = { spawnQueue: [{ demandId: 'd1' }] };
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
    assert.strictEqual(Memory.stats.cpu.tick, Game.time);
    assert.strictEqual(Memory.settings.cpuTelemetry.debug, false);
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

console.log(`Phase 2 tests passed: ${passed}`);
