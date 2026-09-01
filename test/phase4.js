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

function reset() {
    mocks.installGlobals({ limit: 100, tickLimit: 500, bucket: 10000, getUsed: () => 0 });
    Game.gcl = { level: 10 };
    mocks.clearLocalModules();
}

function room(name, energy = 800) {
    const result = {
        name,
        energyAvailable: energy,
        energyCapacityAvailable: energy,
        controller: { my: true, level: 8 },
        find: () => []
    };
    Game.rooms[name] = result;
    Memory.rooms[name] = { spawn: { queue: [] } };
    return result;
}

function ownCreep(name, role, homeRoom, memory = {}) {
    const result = new Creep();
    result.name = name;
    result.my = true;
    result.room = Game.rooms[homeRoom];
    result.memory = Object.assign({ role, homeRoom }, memory);
    result.body = [{ type: MOVE, hits: 100 }];
    result.ticksToLive = 1000;
    return result;
}

function addSpawn(name, spawnRoom, spawningName) {
    Game.spawns[name] = {
        name,
        my: true,
        room: spawnRoom,
        spawning: spawningName ? { name: spawningName } : null
    };
}

function addSurvivalCreeps(spawnRoom) {
    for (const role of ['Foreman', 'Extractor', 'Freighter']) {
        const name = `${spawnRoom.name}-${role}`;
        Game.creeps[name] = ownCreep(name, role, spawnRoom.name);
    }
}

test('utility scoring is normalized, explainable, and deterministic', function() {
    reset();
    const utility = fresh('HiveMind.Utility.js');
    const input = {
        urgency: 120,
        expectedValue: 40,
        strategicValue: 20,
        energyCost: 10,
        spawnCost: 5,
        travelTime: 7,
        risk: 3,
        opportunityCost: 2
    };
    const first = utility.score(input);
    const second = utility.score(input);
    assert.deepStrictEqual(first, second);
    assert.strictEqual(first.components.urgency, 100);
    assert.strictEqual(first.total, 133);
});

test('operation registry supports every requested type and durable schema fields', function() {
    reset();
    const operations = fresh('HiveMind.Operations.js');
    const required = [
        'DEFEND_OWNED_ROOM', 'DEFEND_REMOTE', 'RECOVER_ROOM', 'EXPAND',
        'MINE_REMOTE', 'SCOUT_INTEL', 'FORTIFY', 'PRODUCE_BOOSTS',
        'ATTACK_PLAYER', 'RAID_REMOTE', 'HARVEST_THORIUM', 'SUPPLY_REACTOR',
        'HOLD_REACTOR', 'CAPTURE_REACTOR', 'CONTEST_REACTOR'
    ];
    assert.deepStrictEqual(Array.from(operations.TYPES), required);
    const operation = operations.create('SCOUT_INTEL', {
        id: 'scout:test', targetRoom: 'W9N9', originRoom: 'W1N1',
        priority: 45, utility: { urgency: 20, expectedValue: 30 },
        desiredCapabilities: { vision: 1 }, timeoutTick: Game.time + 100
    });
    for (const field of [
        'id', 'type', 'state', 'priority', 'originRoom', 'targetRoom',
        'createdTick', 'updatedTick', 'utility', 'desiredCapabilities',
        'spawnDemands', 'assignedCreeps', 'assignedSquads', 'timeoutTick',
        'abortConditions', 'completionConditions', 'debugReason'
    ]) assert.notStrictEqual(operation[field], undefined, field);
    mocks.clearLocalModules();
    assert.strictEqual(require(path.join(mocks.root, 'HiveMind.Operations.js')).get('scout:test').targetRoom, 'W9N9');
});

test('operation transitions are guarded and timeouts abort safely', function() {
    reset();
    const operations = fresh('HiveMind.Operations.js');
    const operation = operations.create('FORTIFY', { id: 'fortify:test', targetRoom: 'W1N1' });
    assert.strictEqual(operations.transition(operation, 'ACTIVE', 'ready'), true);
    assert.strictEqual(operations.transition(operation, 'PENDING', 'invalid reverse'), false);
    operation.timeoutTick = Game.time - 1;
    operations.run();
    assert.strictEqual(operation.state, 'ABORTED');
    assert.strictEqual(operation.debugReason, 'Operation timed out');
});

test('equivalent spawn demands merge instead of multiplying', function() {
    reset();
    const board = fresh('Spawn.DemandBoard.js');
    board.beginTick();
    board.emit({ id: 'd1', operationId: 'op1', role: 'Volley', count: 1, priority: 70 });
    board.emit({ id: 'd1', operationId: 'op1', role: 'Volley', count: 3, priority: 80 });
    const demands = board.getDemands();
    assert.strictEqual(demands.length, 1);
    assert.strictEqual(demands[0].count, 3);
    assert.strictEqual(demands[0].priority, 80);
    assert.strictEqual(Object.keys(Memory.hive.demands).length, 1);
});

test('living, spawning, and queued assignments are each counted once', function() {
    reset();
    const home = room('W1N1');
    const demandMemory = { demandId: 'count:test', operationId: 'op:test' };
    Game.creeps.live = ownCreep('live', 'Volley', home.name, demandMemory);
    Memory.creeps.spawning = { role: 'Volley', homeRoom: home.name, ...demandMemory };
    addSpawn('Spawn1', home, 'spawning');
    Memory.rooms.W1N1.spawn.queue.push({
        role: 'Volley', requestedAt: Game.time,
        memory: { role: 'Volley', homeRoom: home.name, ...demandMemory }
    });
    delete global.__sushiTickIndex;
    const board = fresh('Spawn.DemandBoard.js');
    const demand = board.emit({
        id: 'count:test', operationId: 'op:test', role: 'Volley', count: 4,
        bodyRequirements: { body: [MOVE] }
    });
    assert.strictEqual(board.assignmentCount(demand), 3);
});

test('the best capable spawn is deterministic and queues no duplicates', function() {
    reset();
    const roomA = room('W1N1', 800);
    const roomB = room('W2N2', 800);
    addSpawn('SpawnA', roomA);
    addSpawn('SpawnB', roomB);
    addSurvivalCreeps(roomA);
    addSurvivalCreeps(roomB);
    delete global.__sushiTickIndex;
    const board = fresh('Spawn.DemandBoard.js');
    board.emit({
        id: 'expand:test:Pioneer', operationId: 'expand:test', role: 'Pioneer', count: 1,
        priority: 60, originRoom: roomA.name, preferredSpawnRoom: roomB.name,
        targetRoom: 'W3N3', bodyRequirements: { body: [WORK, CARRY, MOVE] },
        validUntil: Game.time + 10
    });
    const first = board.flush();
    assert.strictEqual(first.demands['expand:test:Pioneer'].spawnRoom, roomB.name);
    assert.strictEqual(Memory.rooms.W2N2.spawn.queue.length, 1);
    board.flush();
    assert.strictEqual(Memory.rooms.W2N2.spawn.queue.length, 1);
});

test('bootstrap survival gates optional demands but emergency defense may proceed', function() {
    reset();
    const recoveryRoom = room('W1N1');
    addSpawn('Spawn1', recoveryRoom);
    delete global.__sushiTickIndex;
    const board = fresh('Spawn.DemandBoard.js');
    const optional = board.emit({
        id: 'optional', role: 'Scout', count: 1,
        bodyRequirements: { body: [MOVE] }, targetRoom: 'W2N2'
    });
    assert.strictEqual(board.chooseSpawnRoom(optional), null);
    const emergency = board.emit({
        id: 'emergency', operationId: 'defend:W1N1', role: 'Volley', count: 1,
        emergency: true, bodyRequirements: { body: [RANGED_ATTACK, MOVE] },
        preferredSpawnRoom: 'W1N1', targetRoom: 'W1N1'
    });
    assert.strictEqual(board.chooseSpawnRoom(emergency).name, 'W1N1');
});

test('Expansion emits shared demands without pushing its queue directly', function() {
    reset();
    room('W1N1');
    const board = fresh('Spawn.DemandBoard.js');
    const expansion = fresh('Logic.Expansion.js');
    expansion.ensureExpansionCreepCount(
        'W1N1', 'W2N2', 'Annex', 1, [CLAIM, MOVE], 95, { annexMode: 'expand' }
    );
    assert.strictEqual(Memory.rooms.W1N1.spawn.queue.length, 0);
    const demand = board.getDemands().find(item => item.id === 'expand:W2N2:Annex');
    assert.ok(demand);
    assert.strictEqual(demand.memory.expansionId, 'W2N2');
    assert.strictEqual(demand.memory.annexMode, 'expand');
});

test('operation demand emission records stable demand IDs', function() {
    reset();
    const operations = fresh('HiveMind.Operations.js');
    const operation = operations.create('RECOVER_ROOM', {
        id: 'recover:W1N1', targetRoom: 'W1N1', originRoom: 'W2N2', priority: 90,
        spawnDemands: [{ role: 'Pioneer', count: 2, bodyRequirements: { body: [WORK, CARRY, MOVE] } }]
    });
    operations.emitDemands();
    assert.deepStrictEqual(operation.spawnDemandIds, ['recover:W1N1:Pioneer']);
    const demand = fresh('Spawn.DemandBoard.js').getDemands()[0];
    assert.strictEqual(demand.operationId, operation.id);
});

console.log(`Phase 4 tests passed: ${passed}`);
