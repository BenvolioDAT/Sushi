const assert = require('assert');
const fs = require('fs');
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

function reset(options = {}) {
    mocks.installGlobals({ limit: 100, tickLimit: 500, bucket: 10000, getUsed: () => 0 });
    global.FIND_REACTORS = options.api === false ? undefined : 10051;
    global.RESOURCE_THORIUM = options.api === false ? undefined : 'T';
    global.FIND_MINERALS = 116;
    global.FIND_HOSTILE_CREEPS = 103;
    global.FIND_HOSTILE_STRUCTURES = 109;
    global.FIND_STRUCTURES = 107;
    if (options.api !== false) Creep.prototype.claimReactor = function() { return OK; };
    else delete Creep.prototype.claimReactor;
    delete global.__sushiSeason11Ops;
    mocks.clearLocalModules();
}

function seasonModules() {
    const Season11 = fresh('Logic.Season11.js');
    return {
        Season11,
        Adapter: fresh('Season11.Adapter.js'),
        Operations: fresh('Season11.Operations.js'),
        Policy: fresh('Combat.Policy.js'),
        HiveMemory: fresh('HiveMind.Memory.js')
    };
}

function store(amount, capacity = 1000) {
    return {
        T: amount,
        getUsedCapacity(resource) { return resource === 'T' ? amount : 0; },
        getCapacity(resource) { return resource === 'T' ? capacity : 0; }
    };
}

function seedReactor(Season11, options = {}) {
    const memory = Season11.ensureMemory();
    memory.mode = 'active';
    const reactor = {
        id: options.id || 'reactor1',
        roomName: options.roomName || 'W5N5',
        owner: options.owner === undefined ? 'Sushi' : options.owner,
        my: options.my === undefined ? true : options.my,
        thorium: options.thorium === undefined ? 500 : options.thorium,
        capacity: 1000,
        continuousWork: options.continuousWork === undefined ? 1000 : options.continuousWork,
        hostileCreeps: options.hostileCreeps || 0,
        threatParts: options.threatParts || 0,
        lastSeen: Game.time
    };
    memory.reactors[reactor.id] = reactor;
    memory.assignments.selectedReactorId = reactor.id;
    memory.assignments.selectedReactorRoom = reactor.roomName;
    memory.assignments.rankedReactors = [{
        id: reactor.id,
        roomName: reactor.roomName,
        homeRoom: 'W1N1',
        routeDistance: 4
    }];
    return { memory, reactor };
}

function diagnostics(reactor, overrides = {}) {
    return {
        operating: true,
        knownThoriumRemaining: 2000,
        depletedRooms: 0,
        storedThorium: 500,
        inTransit: 0,
        availableReserve: 500,
        deliverableReserve: 500,
        selectedReactor: reactor,
        nextDeliveryEta: 50,
        miners: 0,
        haulers: 0,
        claimers: 0,
        alerts: [],
        ...overrides
    };
}

test('adapter is inert when the seasonal API is missing', function() {
    reset({ api: false });
    const { Adapter, Operations } = seasonModules();
    assert.strictEqual(Adapter.isAvailable(), false);
    assert.deepStrictEqual(Adapter.findReactors({ find() { throw new Error('must be contained'); } }), []);
    assert.strictEqual(Adapter.claim({}, {}), ERR_INVALID_TARGET);
    assert.doesNotThrow(() => Operations.run({ operating: false }));
    assert.strictEqual(Memory.hive, undefined, 'missing API should not create HiveMind operations');
});

test('adapter exposes only verified seasonal constants and calls', function() {
    reset();
    const { Adapter } = seasonModules();
    let foundConstant = null;
    const reactor = { id: 'r1', pos: new RoomPosition(25, 25, 'W5N5'), my: true, owner: { username: 'Sushi' }, continuousWork: 99, store: store(123) };
    const room = { find(constant) { foundConstant = constant; return [reactor]; } };
    assert.deepStrictEqual(Adapter.findReactors(room), [reactor]);
    assert.strictEqual(foundConstant, FIND_REACTORS);
    let claimed = null;
    const claimer = { claimReactor(target) { claimed = target; return OK; } };
    assert.strictEqual(Adapter.claim(claimer, reactor), OK);
    assert.strictEqual(claimed, reactor);
    let harvested = null;
    const miner = { harvest(target) { harvested = target; return OK; } };
    const mineral = { id: 't1', mineralType: RESOURCE_THORIUM };
    assert.strictEqual(Adapter.harvestThorium(miner, mineral), OK);
    assert.strictEqual(harvested, mineral);
    assert.deepStrictEqual(Adapter.snapshot(reactor), {
        id: 'r1', roomName: 'W5N5', x: 25, y: 25, my: true,
        owner: 'Sushi', thorium: 123, capacity: 1000, continuousWork: 99
    });
});

test('Season 11 schema migration preserves prior intel and custom configuration', function() {
    reset();
    Memory.season11 = {
        schemaVersion: 1,
        mode: 'observe',
        config: { startupReserve: 777, customOperatorNote: 'keep' },
        rooms: { W9N9: { lastSeen: 42, customIntel: true } },
        reactors: { old: { id: 'old', roomName: 'W10N10' } },
        assignments: { mining: {}, selectedReactorId: 'old' },
        routes: {},
        alerts: {},
        stats: { events: [{ tick: 1, code: 'KEEP' }] }
    };
    const { Season11 } = seasonModules();
    const migrated = Season11.ensureMemory();
    assert.strictEqual(migrated.schemaVersion, 2);
    assert.strictEqual(migrated.mode, 'observe');
    assert.strictEqual(migrated.config.startupReserve, 777);
    assert.strictEqual(migrated.config.customOperatorNote, 'keep');
    assert.strictEqual(migrated.rooms.W9N9.customIntel, true);
    assert.strictEqual(migrated.reactors.old.id, 'old');
    assert.strictEqual(migrated.stats.events[0].code, 'KEEP');
});

test('HiveMind migration adds Season 11 operation memory without replacing data', function() {
    reset();
    Memory.hive = { schemaVersion: 4, season: { keep: 7 }, operations: {}, settings: {} };
    const { HiveMemory } = seasonModules();
    const hive = HiveMemory.migrate();
    assert.strictEqual(hive.schemaVersion, HiveMemory.SCHEMA_VERSION);
    assert.strictEqual(hive.season.keep, 7);
    assert.deepStrictEqual(hive.season.activeOperationIds, []);
    assert.deepStrictEqual(hive.season.deliveryEvents, []);
});

test('operation utility declines with distance and exhausted finite supply', function() {
    reset();
    const { Operations } = seasonModules();
    const near = Operations.utilityFor({ remaining: 5000, routeDistance: 1 });
    const far = Operations.utilityFor({ remaining: 5000, routeDistance: 12 });
    const empty = Operations.utilityFor({ remaining: 0, routeDistance: 1, depleted: true });
    assert.ok(near.score.total > far.score.total, `${near.score.total} should exceed ${far.score.total}`);
    assert.ok(near.score.total > empty.score.total, `${near.score.total} should exceed ${empty.score.total}`);
    assert.strictEqual(empty.metrics.finiteSupply, 0);
    assert.ok(far.metrics.routeMaintenanceCost > near.metrics.routeMaintenanceCost);
});

test('Thorium aging changes route loss and loaded replacement lifetime', function() {
    reset();
    const { Operations } = seasonModules();
    const light = Operations.agingMetrics(2, 10);
    const heavy = Operations.agingMetrics(2, 1000);
    const long = Operations.agingMetrics(10, 1000);
    assert.ok(heavy.agingMultiplier > light.agingMultiplier);
    assert.ok(heavy.effectiveLifetime < light.effectiveLifetime);
    assert.ok(long.estimatedAgingLoss > heavy.estimatedAgingLoss);
});

test('Reactor continuity increases strategic value and score projection', function() {
    reset();
    const { Operations } = seasonModules();
    const freshReactor = Operations.utilityFor({ kind: 'reactor', remaining: 1000, buffer: 500, continuousWork: 1, currentReactor: true });
    const continuous = Operations.utilityFor({ kind: 'reactor', remaining: 1000, buffer: 500, continuousWork: 10000, currentReactor: true });
    assert.ok(continuous.score.components.strategicValue > freshReactor.score.components.strategicValue);
    assert.ok(continuous.metrics.projectedScoreValue > freshReactor.metrics.projectedScoreValue);
    assert.strictEqual(continuous.metrics.scoreRate, 5);
});

test('mining and hauling operations use stable assignment-compatible IDs', function() {
    reset();
    const { Season11, Operations, HiveMemory } = seasonModules();
    const { memory, reactor } = seedReactor(Season11);
    memory.rooms.W2N2 = {
        roomName: 'W2N2', threatParts: 0,
        thorium: { id: 'thorium1', x: 10, y: 11, remaining: 2000, depleted: false }
    };
    memory.assignments.mining.W2N2 = {
        key: 'mine:W2N2', roomName: 'W2N2', mineralId: 'thorium1',
        homeRoom: 'W1N1', routeDistance: 2, remaining: 2000,
        stagingId: 'staging1', ready: true, reason: 'READY'
    };
    const staging = { id: 'staging1', store: store(250, 10000) };
    Game.getObjectById = id => id === 'staging1' ? staging : null;
    const report = Operations.run(diagnostics(reactor));
    const hive = HiveMemory.ensure();
    assert.strictEqual(hive.operations['season11:mine:W2N2'].state, 'HARVESTING');
    assert.strictEqual(hive.operations['season11:haul:W2N2:reactor1'].state, 'HAULING');
    assert.strictEqual(hive.operations['season11:reactor:reactor1'].state, 'HOLDING');
    assert.ok(report.activeOperations >= 3);
    assert.ok(memory.rooms.W2N2.thorium.operationMetrics.expectedNetValue !== undefined);
});

test('projected starvation changes an owned Reactor from holding to supplying', function() {
    reset();
    const { Season11, Operations, HiveMemory } = seasonModules();
    const { memory, reactor } = seedReactor(Season11, { thorium: 500 });
    Operations.run(diagnostics(reactor));
    const operation = HiveMemory.ensure().operations['season11:reactor:reactor1'];
    assert.strictEqual(operation.state, 'HOLDING');
    Game.time++;
    reactor.thorium = 50;
    memory.reactors.reactor1.thorium = 50;
    Operations.run(diagnostics(reactor, { deliverableReserve: 50 }));
    assert.strictEqual(operation.state, 'SUPPLYING');
    assert.strictEqual(operation.utility.components.urgency, 100);
});

test('ownership loss chooses recovery unless explicit policy permits contest', function() {
    reset();
    const { Season11, Operations, Policy, HiveMemory } = seasonModules();
    const { memory, reactor } = seedReactor(Season11);
    Operations.run(diagnostics(reactor));
    const operation = HiveMemory.ensure().operations['season11:reactor:reactor1'];
    assert.strictEqual(operation.state, 'HOLDING');

    Game.time++;
    reactor.my = false;
    reactor.owner = 'Enemy';
    memory.reactors.reactor1.my = false;
    memory.reactors.reactor1.owner = 'Enemy';
    Operations.run(diagnostics(reactor));
    assert.strictEqual(operation.state, 'RECOVERING');

    Game.time++;
    memory.config.recapture = true;
    Policy.setClassification('Enemy', Policy.CLASSIFICATIONS.ALLY);
    Operations.run(diagnostics(reactor));
    assert.strictEqual(operation.state, 'RECOVERING', 'allies must never be contested');

    Game.time++;
    Policy.setClassification('Enemy', Policy.CLASSIFICATIONS.HOSTILE);
    Operations.run(diagnostics(reactor));
    assert.strictEqual(operation.state, 'CONTESTING');
    assert.ok(HiveMemory.ensure().squads['duo:season11:reactor:reactor1']);
});

test('finite deposits remain depleted and operations retire safely', function() {
    reset();
    const { Season11, Operations, HiveMemory } = seasonModules();
    const { memory, reactor } = seedReactor(Season11);
    memory.rooms.W2N2 = { roomName: 'W2N2', thorium: { id: 't1', remaining: 0, depleted: true } };
    memory.assignments.mining.W2N2 = {
        key: 'mine:W2N2', roomName: 'W2N2', mineralId: 't1', homeRoom: 'W1N1',
        routeDistance: 2, remaining: 0, stagingId: 'empty', ready: false, depleted: true
    };
    Game.getObjectById = () => ({ id: 'empty', store: store(0) });
    Operations.run(diagnostics(reactor, { knownThoriumRemaining: 0, deliverableReserve: 0 }));
    assert.strictEqual(HiveMemory.ensure().operations['season11:mine:W2N2'].state, 'DEPLETED');
    assert.strictEqual(memory.rooms.W2N2.thorium.depleted, true);
});

test('delivery events produce bounded explainable throughput', function() {
    reset();
    const { Operations } = seasonModules();
    assert.strictEqual(Operations.noteDelivery(50, { creepName: 'hauler', sourceRoom: 'W2N2', reactorId: 'r1' }), true);
    Game.time += 10;
    assert.strictEqual(Operations.noteDelivery(25, { creepName: 'hauler2', sourceRoom: 'W3N3', reactorId: 'r1' }), true);
    const flow = Operations.deliveryThroughput(100);
    assert.deepStrictEqual(flow, { window: 100, amount: 75, deliveries: 2, perTick: 0.75 });
    assert.strictEqual(Operations.noteDelivery(0), false);
    assert.strictEqual(Memory.hive.season.deliveryEvents.length, 2);
});

test('season code contains no market calls or portal routing assumptions', function() {
    const files = [
        'Logic.Season11.js', 'Season11.Adapter.js', 'Season11.Operations.js',
        'role.ThoriumMiner.js', 'role.ThoriumHauler.js', 'role.ReactorClaimer.js'
    ];
    const source = files.map(file => fs.readFileSync(path.join(mocks.root, file), 'utf8')).join('\n');
    assert.strictEqual(source.includes('Game.' + 'market'), false);
    assert.strictEqual(source.includes('STRUCTURE_' + 'PORTAL'), false);
});

console.log(`Phase 7 tests passed: ${passed}`);
