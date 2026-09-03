/* Lightweight Node mock harness: run with the repository on NODE_PATH. */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var Module = require('module');
process.env.NODE_PATH = [__dirname, process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
Module._initPaths();
/* Constants needed by modules reached through the shared demand board. */
global.MOVE = 'move';
global.WORK = 'work';
global.CARRY = 'carry';
global.ATTACK = 'attack';
global.RANGED_ATTACK = 'ranged_attack';
global.HEAL = 'heal';
global.TOUGH = 'tough';
global.CLAIM = 'claim';
global.RESOURCE_ENERGY = 'energy';
global.STRUCTURE_EXTRACTOR = 'extractor';
global.STRUCTURE_CONTAINER = 'container';
global.STRUCTURE_STORAGE = 'storage';
global.STRUCTURE_TERMINAL = 'terminal';
global.STRUCTURE_ROAD = 'road';
global.Creep = function() {};
var Season11 = require('./Logic.Season11');
var Season11Operations = require('./Season11.Operations');
var ResourceMinerals = require('./Resource.Minerals');
var ResourceManager = require('./Resource.Manager');
var ResourceTerminals = require('./Resource.Terminals');
var ResourceObserver = require('./Resource.Observer');
var DemandBoard = require('./Spawn.DemandBoard');

var passed = 0;

function test(name, fn) {
    fn();
    passed++;
    console.log('PASS ' + name);
}

function resetWorld() {
    delete global.RESOURCE_THORIUM;
    delete global.FIND_REACTORS;
    delete global.FIND_MINERALS;
    delete global.FIND_HOSTILE_CREEPS;
    delete global.FIND_HOSTILE_STRUCTURES;
    delete global.FIND_STRUCTURES;
    delete global.Creep;
    global.Memory = {};
    global.Game = {
        time: 1,
        rooms: {},
        creeps: {},
        spawns: {},
        cpu: { limit: 12, bucket: 10000, getUsed: function() { return 0; } },
        map: {
            getRoomLinearDistance: function() { return 1; },
            findRoute: function() { return [{ room: 'W1N1' }]; }
        },
        getObjectById: function() { return null; }
    };
    Season11.resetCacheForTests();
    Season11Operations.resetForTests();
    delete global.__sushiDemandBoard;
    delete global.__sushiTickIndex;
    delete global.__sushiResourceJobs;
}

function enableSeasonApi() {
    global.RESOURCE_THORIUM = 'T';
    global.FIND_REACTORS = 10051;
    global.FIND_MINERALS = 6;
    global.FIND_HOSTILE_CREEPS = 101;
    global.FIND_HOSTILE_STRUCTURES = 102;
    global.FIND_STRUCTURES = 107;
    global.Creep = function() {};
    global.Creep.prototype.claimReactor = function() { return 0; };
}

test('normal shard feature detection is safe', function() {
    resetWorld();
    assert.strictEqual(Season11.isApiAvailable(), false);
    assert.doesNotThrow(function() { Season11.run(); });
    assert.strictEqual(Memory.hive.season.season11.stats.apiAvailable, false);
});

test('Season 11 API detection works', function() {
    resetWorld();
    enableSeasonApi();
    assert.strictEqual(Season11.isApiAvailable(), true);
    assert.strictEqual(Season11.isClaimApiAvailable(), true);
});

test('visible Thorium and Reactor intel is persisted as plain data', function() {
    resetWorld();
    enableSeasonApi();
    var mineral = {
        id: 'mineral1',
        mineralType: 'T',
        mineralAmount: 4321,
        density: 3,
        ticksToRegeneration: undefined,
        pos: { x: 10, y: 11 }
    };
    var reactor = {
        id: 'reactor1',
        my: false,
        owner: null,
        continuousWork: 99,
        pos: { x: 25, y: 25 },
        store: {
            getUsedCapacity: function(resource) { return resource === 'T' ? 123 : 0; },
            getCapacity: function() { return 1000; }
        }
    };
    var room = {
        name: 'W5N5',
        controller: { my: true, level: 6, owner: { username: 'Sushi' } },
        find: function(type) {
            if (type === global.FIND_MINERALS) { return [mineral]; }
            if (type === global.FIND_REACTORS) { return [reactor]; }
            return [];
        }
    };

    Season11.observeRoom(room, 'W5N5', true);
    assert.strictEqual(Memory.hive.season.season11.rooms.W5N5.thorium.id, 'mineral1');
    assert.strictEqual(Memory.hive.season.season11.rooms.W5N5.thorium.remaining, 4321);
    assert.strictEqual(Memory.hive.season.season11.rooms.W5N5.thorium.density, 3);
    assert.strictEqual(Memory.hive.season.season11.reactors.reactor1.thorium, 123);
    assert.strictEqual(Memory.hive.season.season11.reactors.reactor1.continuousWork, 99);
    assert.doesNotThrow(function() { JSON.stringify(Memory.hive.season.season11); });
});

test('stale intel is eventually cleaned', function() {
    resetWorld();
    enableSeasonApi();
    Season11.ensureMemory();
    Memory.config.season11.intelMaxAge = 10;
    Memory.hive.season.season11.rooms.W1N1 = {
        roomName: 'W1N1',
        lastSeen: 1,
        thorium: { id: 'old', remaining: 10, depleted: false }
    };
    Game.time = 100;
    Season11.cleanupStaleIntel(true);
    assert.strictEqual(Memory.hive.season.season11.rooms.W1N1, undefined);
});

test('depleted Thorium is not ranked or scheduled', function() {
    resetWorld();
    enableSeasonApi();
    Season11.ensureMemory();
    Memory.hive.season.season11.rooms.W2N2 = {
        roomName: 'W2N2',
        lastSeen: Game.time,
        thorium: { id: 'empty', remaining: 0, depleted: true }
    };
    assert.strictEqual(Season11.rankMiningTargets().length, 0);
});

test('generic mineral pipeline excludes Thorium but keeps normal minerals', function() {
    resetWorld();
    enableSeasonApi();
    var room = { name: 'W1N1' };
    var thoriumState = { mineral: {
        id: 'thorium', mineralType: 'T', active: true, containerId: 'container'
    } };
    assert.deepStrictEqual(ResourceMinerals.emitDemands(room, thoriumState), []);
    assert.deepStrictEqual(ResourceMinerals.jobs(room, thoriumState), []);
    assert.strictEqual(DemandBoard.getDemands().length, 0);

    var normalState = { mineral: {
        id: 'normal', mineralType: 'H', active: true, containerId: null,
        extractorId: 'extractor', debugReason: 'active'
    } };
    var demands = ResourceMinerals.emitDemands(room, normalState);
    assert.deepStrictEqual(demands.map(function(item) { return item.role; }).sort(),
        ['MineralMiner', 'ResourceCourier']);
});

test('stale generic Thorium demands are cancelled without duplicate work', function() {
    resetWorld();
    enableSeasonApi();
    DemandBoard.emit({
        id: 'legacy-thorium-miner', operationId: 'mineral:W1N1', role: 'MineralMiner',
        count: 1, originRoom: 'W1N1', memory: { mineralType: 'T' }
    });
    DemandBoard.emit({
        id: 'legacy-thorium-courier', operationId: 'mineral:W1N1', role: 'ResourceCourier',
        count: 1, originRoom: 'W1N1', memory: { mineralType: 'T' }
    });
    DemandBoard.emit({
        id: 'normal-mineral-miner', operationId: 'mineral:W2N2', role: 'MineralMiner',
        count: 1, originRoom: 'W2N2', memory: { mineralType: 'H' }
    });
    assert.strictEqual(ResourceManager.scrubGenericThoriumDemands(), 2);
    assert.deepStrictEqual(DemandBoard.getDemands().map(function(item) { return item.id; }),
        ['normal-mineral-miner']);
});

test('legacy generic Thorium miner migrates only into a ready Season 11 assignment', function() {
    resetWorld();
    enableSeasonApi();
    var memory = Season11.ensureMemory();
    memory.assignments.mining.W1N1 = {
        key: 'mine:W1N1', roomName: 'W1N1', mineralId: 'thorium',
        stagingId: 'staging', routeDistance: 1, remaining: 100, ready: true, depleted: false
    };
    Game.rooms.W1N1 = { name: 'W1N1', controller: { my: true } };
    var staging = {
        id: 'staging', my: true, structureType: STRUCTURE_CONTAINER,
        pos: { roomName: 'W1N1' }, store: { getFreeCapacity: function() { return 1000; } }
    };
    Game.getObjectById = function(id) { return id === 'staging' ? staging : null; };
    var role = require('./role.MineralMiner');
    var creep = { room: { name: 'W1N1' }, memory: { role: 'MineralMiner', mineralId: 'thorium' } };
    assert.strictEqual(role.migrateThoriumMiner(creep, {
        id: 'thorium', mineralType: 'T', pos: { roomName: 'W1N1' }
    }), true);
    assert.strictEqual(creep.memory.role, 'ThoriumMiner');
    assert.strictEqual(creep.memory.season11StagingId, 'staging');
    assert.strictEqual(creep.memory.mineralId, undefined);
});

test('legacy Thorium migration rejects stale, depleted, and not-ready assignments', function() {
    resetWorld();
    enableSeasonApi();
    var memory = Season11.ensureMemory();
    Game.rooms.W1N1 = { name: 'W1N1', controller: { my: true } };
    var staging = {
        id: 'staging', my: true, structureType: STRUCTURE_CONTAINER,
        pos: { roomName: 'W1N1' }, store: { getFreeCapacity: function() { return 1000; } }
    };
    Game.getObjectById = function(id) { return id === 'staging' ? staging : null; };
    var role = require('./role.MineralMiner');
    function attempt(overrides, mineralId) {
        memory.assignments.mining = { W1N1: Object.assign({
            key: 'mine:W1N1', roomName: 'W1N1', mineralId: 'thorium', stagingId: 'staging',
            routeDistance: 1, remaining: 100, ready: true, depleted: false
        }, overrides) };
        var creep = { room: Game.rooms.W1N1, memory: { role: 'MineralMiner', mineralId: mineralId || 'thorium' } };
        return role.migrateThoriumMiner(creep, {
            id: mineralId || 'thorium', mineralType: 'T', pos: { roomName: 'W1N1' }
        });
    }
    assert.strictEqual(attempt({ mineralId: 'old-thorium' }, 'thorium'), false, 'stale mineral id');
    assert.strictEqual(attempt({ remaining: 0, depleted: true }), false, 'depleted assignment');
    assert.strictEqual(attempt({ ready: false }), false, 'not-ready assignment');
    assert.strictEqual(attempt({ stagingId: 'missing' }), false, 'invalid staging');
});

test('rejected legacy Thorium cargo retires and returns only to owned storage', function() {
    resetWorld();
    enableSeasonApi();
    global.OK = 0;
    global.ERR_NOT_IN_RANGE = -9;
    var transfers = 0;
    var storage = {
        id: 'storage', my: true, structureType: STRUCTURE_STORAGE,
        pos: { roomName: 'W1N1' }, store: { getFreeCapacity: function() { return 1000; } }
    };
    var room = { name: 'W1N1', controller: { my: true }, storage: storage };
    Game.rooms.W1N1 = room;
    var mineral = { id: 'thorium', mineralType: 'T', mineralAmount: 100, pos: {} };
    Game.getObjectById = function(id) { return id === 'thorium' ? mineral : id === 'storage' ? storage : null; };
    var creep = {
        spawning: false, room: room, store: { T: 25 },
        memory: { role: 'MineralMiner', mineralId: 'thorium', mineralType: 'T', demandId: 'old', operationId: 'old', resourceJobId: 'old' },
        transfer: function(target, resource) { transfers++; assert.strictEqual(target, storage); assert.strictEqual(resource, 'T'); return OK; }
    };
    require('./role.MineralMiner').run(creep);
    assert.strictEqual(creep.memory.role, 'ResourceCourier');
    assert.strictEqual(transfers, 1);
    assert.strictEqual(creep.memory.demandId, undefined);
    assert.strictEqual(creep.memory.operationId, undefined);
    assert.strictEqual(creep.memory.resourceJobId, undefined);
});

test('stale generic Thorium miner without a live target retires into safe logistics', function() {
    resetWorld();
    enableSeasonApi();
    var role = require('./role.MineralMiner');
    var creep = {
        spawning: false, room: { name: 'W1N1' }, store: { T: 0 },
        memory: { role: 'MineralMiner', mineralId: 'gone', mineralType: 'T', demandId: 'old' }
    };
    role.run(creep);
    assert.strictEqual(creep.memory.role, 'ResourceCourier');
    assert.strictEqual(creep.memory.mineralId, undefined);
    assert.strictEqual(creep.memory.demandId, undefined);
});

test('partial Season API availability does not disable ordinary mineral handling', function() {
    resetWorld();
    global.RESOURCE_THORIUM = 'T';
    assert.strictEqual(ResourceMinerals.isDedicatedThorium('T'), false);
    var demands = ResourceMinerals.emitDemands({ name: 'W1N1' }, { mineral: {
        id: 'ordinary-until-api-complete', mineralType: 'T', active: true,
        extractorId: 'extractor', containerId: null, debugReason: 'active'
    } });
    assert.strictEqual(demands.length, 2);
});

test('Thorium depletion is permanent when later observations disagree', function() {
    resetWorld();
    enableSeasonApi();
    var mineral = { id: 'finite', mineralType: 'T', mineralAmount: 0, density: 2, pos: { x: 10, y: 10 } };
    var room = {
        name: 'W2N2', controller: { my: true, owner: { username: 'Sushi' } },
        find: function(type) { return type === global.FIND_MINERALS ? [mineral] : []; }
    };
    Season11.observeRoom(room, room.name, true);
    mineral.mineralAmount = 500;
    Game.time++;
    Season11.observeRoom(room, room.name, true);
    assert.strictEqual(Memory.hive.season.season11.rooms.W2N2.thorium.remaining, 0);
    assert.strictEqual(Memory.hive.season.season11.rooms.W2N2.thorium.depleted, true);
});

test('score rate follows logarithmic thresholds', function() {
    resetWorld();
    assert.strictEqual(Season11.scoreRate(0), 0);
    assert.strictEqual(Season11.scoreRate(1), 1);
    assert.strictEqual(Season11.scoreRate(9), 1);
    assert.strictEqual(Season11.scoreRate(10), 2);
    assert.strictEqual(Season11.scoreRate(99), 2);
    assert.strictEqual(Season11.scoreRate(100), 3);
    assert.strictEqual(Season11.scoreRate(1000), 4);
});

test('Reactor starvation estimate compares one-per-tick reserve to ETA', function() {
    resetWorld();
    assert.strictEqual(Season11.estimateStarvation(200, 50).starving, false);
    assert.strictEqual(Season11.estimateStarvation(50, 50).starving, true);
    assert.strictEqual(Season11.estimateStarvation(50, null).starving, true);
    assert.strictEqual(Season11.estimateStarvation(123, 50).ticksUntilEmpty, 123);
});

test('hauler demand increases with distance and falls with capacity', function() {
    resetWorld();
    var nearby = Season11.calculateHaulerDemand(50, 500, 1500, 1.25);
    var distant = Season11.calculateHaulerDemand(500, 500, 1500, 1.25);
    var small = Season11.calculateHaulerDemand(500, 100, 1500, 1.25);
    assert.ok(distant > nearby);
    assert.ok(small > distant);
});

test('aging thresholds use total Thorium on the tile', function() {
    resetWorld();
    enableSeasonApi();
    var thresholds = [[0, 0], [1, 0], [9, 0], [10, 1], [99, 1], [100, 2], [999, 2], [1000, 3]];
    thresholds.forEach(function(pair) {
        assert.strictEqual(Season11.thoriumAgingMultiplier(pair[0]), pair[1]);
    });
    var tile = Season11.observeTileThorium({
        look: function() { return [
            { creep: { name: 'carrier', store: { T: 90 } } },
            { resource: { id: 'drop', resourceType: 'T', amount: 10 } },
            { mineral: { id: 'thorium-mineral', mineralType: 'T', mineralAmount: 900, store: { T: 5000 } } },
            { mineral: { id: 'thorium-mineral', mineralType: 'T', mineralAmount: 900 } },
            { mineral: { id: 'other-mineral', mineralType: 'O', mineralAmount: 5000, store: { T: 5000 } } },
            { structure: { id: 'road', store: {} } }
        ]; }
    });
    assert.strictEqual(tile.total, 1000);
    assert.strictEqual(tile.multiplier, 3);
    assert.strictEqual(tile.observable, true);
});

test('aging fallback is explicitly estimated and independent of carry capacity', function() {
    resetWorld();
    enableSeasonApi();
    Season11.ensureMemory().config.agingFallbackThorium = 1000;
    var fallback = Season11.observeTileThorium(null);
    assert.deepStrictEqual({ total: fallback.total, multiplier: fallback.multiplier, source: fallback.source },
        { total: 1000, multiplier: 3, source: 'fallbackEstimate' });
    var exact = Season11Operations.agingMetrics(2, 10);
    var planned = Season11Operations.agingMetrics(2);
    assert.strictEqual(exact.agingMultiplier, 1);
    assert.strictEqual(exact.agingEstimateSource, 'providedTileTotal');
    assert.strictEqual(planned.agingMultiplier, 3);
    assert.strictEqual(planned.agingEstimateSource, 'fallbackEstimate');
    var source = fs.readFileSync(path.join(__dirname, 'Logic.Season11.js'), 'utf8');
    assert.strictEqual(source.indexOf('Math.log10(expectedCarryCapacity)'), -1);
});

test('live route Thorium observations replace the configured aging fallback', function() {
    resetWorld();
    enableSeasonApi();
    Game.creeps.hauler = { memory: {
        role: 'ThoriumHauler', season11SourceRoom: 'W1N1', season11ReactorId: 'reactor',
        season11ObservedTileThorium: 99, season11AgingEstimateSource: 'tileLook'
    } };
    var estimate = Season11.getRouteAgingEstimate({ roomName: 'W1N1' }, { id: 'reactor' });
    assert.deepStrictEqual({ total: estimate.total, multiplier: estimate.multiplier, source: estimate.source },
        { total: 99, multiplier: 1, source: 'liveRouteObservation' });
});

test('known Season 11 rooms are included in observer priorities', function() {
    resetWorld();
    enableSeasonApi();
    Season11.ensureMemory().rooms.W5N5 = { roomName: 'W5N5', lastSeen: Game.time };
    assert.ok(ResourceObserver.priorityRooms('W1N1').includes('W5N5'));
    delete global.FIND_REACTORS;
    assert.ok(!ResourceObserver.priorityRooms('W1N1').includes('W5N5'));
});

test('Season 11 maintenance leases an idle home Artificer across owned rooms', function() {
    resetWorld();
    enableSeasonApi();
    var memory = Season11.ensureMemory();
    memory.rooms.W2N2 = { roomName: 'W2N2', threatParts: 0 };
    var mineral = { id: 'thorium', pos: { x: 10, y: 10, roomName: 'W2N2' } };
    var staging = {
        id: 'staging', my: true, structureType: STRUCTURE_CONTAINER, hits: 700, hitsMax: 1000,
        pos: { x: 11, y: 10, roomName: 'W2N2' }
    };
    var road = {
        id: 'road', my: true, structureType: STRUCTURE_ROAD, hits: 500, hitsMax: 1000,
        pos: { x: 12, y: 10, roomName: 'W2N2' }
    };
    Game.rooms.W1N1 = { name: 'W1N1', controller: { my: true } };
    Game.rooms.W2N2 = {
        name: 'W2N2', controller: { my: true },
        find: function(kind) { return kind === FIND_HOSTILE_CREEPS ? [] : [road, staging]; }
    };
    Game.getObjectById = function(id) {
        return id === 'thorium' ? mineral : id === 'staging' ? staging : id === 'road' ? road : null;
    };
    function idleArtificer(name) {
        return {
            name: name, room: Game.rooms.W1N1, ticksToLive: 1000,
            body: [{ type: WORK, hits: 100 }, { type: CARRY, hits: 100 }, { type: MOVE, hits: 100 }],
            memory: { role: 'Artificer', homeRoom: 'W1N1', artificerTask: 'IDLE' }
        };
    }
    Game.creeps.beta = idleArtificer('beta');
    Game.creeps.alpha = idleArtificer('alpha');
    var assignment = {
        roomName: 'W2N2', homeRoom: 'W1N1', mineralId: 'thorium', stagingId: 'staging',
        ready: true, depleted: false, remaining: 100
    };
    assert.strictEqual(Season11Operations.findSeason11MaintenanceTarget(assignment, memory), staging);
    memory.assignments.mining.W2N2 = Object.assign({ key: 'mine:W2N2', routeDistance: 1 }, assignment);
    Season11Operations.run({ operating: true, selectedReactor: null, knownThoriumRemaining: 100 });
    var operation = Memory.hive.operations['season11:mine:W2N2'];
    assert.strictEqual(operation.season11MaintenanceTarget.id, 'staging');
    assert.strictEqual(operation.season11MaintenanceLease.creepName, 'alpha');
    assert.strictEqual(Game.creeps.alpha.memory.operationId, 'season11:mine:W2N2');
    assert.strictEqual(Game.creeps.alpha.memory.demandId, 'season11:mine:W2N2:maintenance');
    assert.strictEqual(Game.creeps.alpha.memory.season11RepairTargetId, 'staging');
    assert.strictEqual(Game.creeps.alpha.memory.season11SupportRoom, 'W2N2');
    assert.strictEqual(operation.spawnDemands[0].memory.remoteWorkTargetId, 'staging');
    assert.strictEqual(Game.creeps.alpha.memory.remoteWorkTargetId, 'staging');
    assert.strictEqual(Game.creeps.alpha.memory.remoteWorkRoomName, 'W2N2');
    assert.strictEqual(Game.creeps.alpha.memory.remoteWorkX, 11);
    assert.strictEqual(Game.creeps.alpha.memory.remoteWorkY, 10);
    assert.strictEqual(Game.creeps.beta.memory.operationId, undefined, 'only one Artificer owns the target');

    staging.hits = 900;
    Game.time++;
    delete global.__sushiTickIndex;
    Season11Operations.run({ operating: true, selectedReactor: null, knownThoriumRemaining: 100 });
    assert.strictEqual(operation.season11MaintenanceTarget.id, 'staging', 'lease continues until fully repaired');

    delete Game.creeps.alpha;
    staging.hits = staging.hitsMax;
    Game.time++;
    delete global.__sushiTickIndex;
    Season11Operations.run({ operating: true, selectedReactor: null, knownThoriumRemaining: 100 });
    assert.strictEqual(operation.season11MaintenanceTarget.id, 'road');
    assert.strictEqual(operation.season11MaintenanceLease.creepName, 'beta');
    assert.strictEqual(Game.creeps.beta.memory.remoteWorkTargetId, 'road');

    Game.creeps.beta.ticksToLive = 1;
    Game.time++;
    delete global.__sushiTickIndex;
    Season11Operations.run({ operating: true, selectedReactor: null, knownThoriumRemaining: 100 });
    assert.strictEqual(operation.season11MaintenanceLease, null, 'invalid owner releases the lease');
    assert.strictEqual(operation.spawnDemands.length, 1, 'missing owner preserves replacement demand');
    assert.strictEqual(Game.creeps.beta.memory.operationId, undefined);

    road.hits = road.hitsMax;
    Game.time++;
    delete global.__sushiTickIndex;
    Season11Operations.run({ operating: true, selectedReactor: null, knownThoriumRemaining: 100 });
    assert.strictEqual(operation.season11MaintenanceTarget, null);
    assert.strictEqual(operation.season11MaintenanceLease, null);
    assert.strictEqual(operation.spawnDemands.length, 0);
    assert.strictEqual(Game.creeps.beta.memory.operationId, undefined);
    assert.ok(!DemandBoard.getDemands().some(function(demand) {
        return demand.id === 'season11:mine:W2N2:maintenance';
    }));

    road.hits = 500;
    memory.rooms.W2N2.threatParts = 1;
    assert.strictEqual(Season11Operations.findSeason11MaintenanceTarget(assignment, memory), null);
    memory.rooms.W2N2.threatParts = 0;
    assignment.ready = false;
    assert.strictEqual(Season11Operations.findSeason11MaintenanceTarget(assignment, memory), null);
});

function installRankingWorld() {
    var home = {
        name: 'W1N1', controller: { my: true, owner: { username: 'Sushi' } },
        find: function() { return []; }
    };
    Game.rooms.W1N1 = home;
    Game.spawns.Spawn1 = { my: true, room: home };
    Season11.resetCacheForTests();
    return Season11.ensureMemory();
}

function targetIntel(roomName, remaining, density, hostile) {
    return {
        roomName: roomName, lastSeen: Game.time,
        controllerOwner: null, controllerReservation: null,
        hostileCreeps: hostile ? 1 : 0,
        hostileStructures: 0, threatParts: hostile ? 5 : 0,
        thorium: { id: 'mineral:' + roomName, remaining: remaining, density: density, depleted: false }
    };
}

test('density and northern position influence comparable safe target ranking', function() {
    resetWorld();
    enableSeasonApi();
    var memory = installRankingWorld();
    memory.rooms.W2N2 = targetIntel('W2N2', 100, 1, false);
    memory.rooms.W2N3 = targetIntel('W2N3', 100, 3, false);
    memory.rooms.W3N4 = targetIntel('W3N4', 100, 3, false);
    var ranked = Season11.rankMiningTargets();
    assert.strictEqual(ranked[0].density, 3);
    assert.strictEqual(ranked[0].northernTieBreaker, 4);
    assert.ok(ranked[0].yieldScore > ranked.filter(function(item) { return item.density === 1; })[0].yieldScore);
});

test('season scouting uses north only as an equal-cost secondary preference', function() {
    resetWorld();
    enableSeasonApi();
    assert.ok(Season11.scoutPriority('W1N9') > Season11.scoutPriority('W1S9'));
    delete global.FIND_REACTORS;
    assert.strictEqual(Season11.scoutPriority('W1N9'), 0);
});

test('safe accessible targets outrank richer hostile northern targets', function() {
    resetWorld();
    enableSeasonApi();
    var memory = installRankingWorld();
    memory.rooms.W9N9 = targetIntel('W9N9', 10000, 10, true);
    memory.rooms.W2S2 = targetIntel('W2S2', 100, 1, false);
    var ranked = Season11.rankMiningTargets();
    assert.strictEqual(ranked[0].roomName, 'W2S2');
    assert.strictEqual(ranked[0].accessible, true);
    assert.strictEqual(ranked[1].accessible, false);
});

test('terminal balancing rejects dedicated Thorium and still enforces ownership', function() {
    resetWorld();
    enableSeasonApi();
    assert.strictEqual(ResourceTerminals.requestTransfer({
        fromRoom: 'W1N1', toRoom: 'W2N2', resourceType: 'T', amount: 100
    }), null);
    var transfer = { validUntil: 10, fromRoom: 'W1N1', toRoom: 'W2N2', resourceType: 'H' };
    Game.rooms.W1N1 = { controller: { my: true }, terminal: { my: true } };
    Game.rooms.W2N2 = { controller: { my: false }, terminal: { my: false } };
    assert.strictEqual(ResourceTerminals.validate(transfer).reason, 'both rooms must be mine and visible');
});

test('Reactor ownership and starvation reset are taken from fresh game state', function() {
    resetWorld();
    enableSeasonApi();
    var reactor = {
        id: 'reactor-live', my: true, owner: { username: 'Sushi' }, continuousWork: 100,
        pos: { x: 25, y: 25 }, store: { T: 20, getUsedCapacity: function() { return this.T; }, getCapacity: function() { return 1000; } }
    };
    var room = {
        name: 'W5N5', controller: null,
        find: function(type) { return type === global.FIND_REACTORS ? [reactor] : []; }
    };
    Season11.observeRoom(room, null, true);
    reactor.my = false;
    reactor.owner = { username: 'Enemy' };
    reactor.continuousWork = 0;
    reactor.store.T = 0;
    Game.time++;
    Season11.observeRoom(room, null, true);
    var record = Memory.hive.season.season11.reactors['reactor-live'];
    assert.strictEqual(record.my, false);
    assert.strictEqual(record.owner, 'Enemy');
    assert.strictEqual(record.continuousWork, 0);
    assert.strictEqual(Season11.scoreRate(record.continuousWork), 0);
});

test('assignment counting includes exact queued work and ignores dying creeps', function() {
    resetWorld();
    enableSeasonApi();
    Game.creeps.live = {
        ticksToLive: 1000,
        body: [{ type: 'carry' }],
        memory: { season11AssignmentKey: 'haul:A:R', role: 'ThoriumHauler' }
    };
    Game.creeps.dying = {
        ticksToLive: 5,
        body: [{ type: 'carry' }],
        memory: { season11AssignmentKey: 'haul:A:R', role: 'ThoriumHauler' }
    };
    Memory.rooms = {
        W1N1: {
            spawn: { queue: [{ memory: { season11AssignmentKey: 'haul:A:R' } }] }
        }
    };
    assert.strictEqual(Season11.getAssignmentCount('haul:A:R', true), 2);
});

test('claimer calls claimReactor only while adjacent', function() {
    resetWorld();
    enableSeasonApi();
    var moves = 0;
    var claims = 0;
    var adjacent = false;
    var reactor = { id: 'reactor1', my: false, owner: null };
    Game.getObjectById = function() { return reactor; };
    var travelMock = {
        move: function() { moves++; return 0; },
        moveToRoom: function() { moves++; return 0; }
    };
    var originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
        if (request === 'utility.Travel.Creep') {
            return travelMock;
        }
        if (request === 'Logic.Season11') {
            return Season11;
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    var rolePath = require.resolve('./role.ReactorClaimer');
    delete require.cache[rolePath];
    var role;
    try {
        role = require('./role.ReactorClaimer');
    }
    finally {
        Module._load = originalLoad;
    }

    var creep = {
        name: 'claimer',
        spawning: false,
        memory: {
            season11ReactorId: 'reactor1',
            season11ReactorRoom: 'W5N5'
        },
        room: { name: 'W5N5' },
        pos: {
            isNearTo: function() { return adjacent; },
            getRangeTo: function() { return adjacent ? 1 : 3; }
        },
        claimReactor: function() { claims++; return 0; }
    };

    role.run(creep);
    assert.strictEqual(claims, 0);
    assert.strictEqual(moves, 1);
    adjacent = true;
    role.run(creep);
    assert.strictEqual(claims, 1);
});

test('season roles use Sushi travel and do not use market or portals', function() {
    var files = [
        'Logic.Season11.js',
        'role.ThoriumMiner.js',
        'role.ThoriumHauler.js',
        'role.ReactorClaimer.js'
    ];
    var combined = '';
    for (var i = 0; i < files.length; i++) {
        combined += fs.readFileSync(path.join(__dirname, files[i]), 'utf8');
    }
    assert.ok(combined.indexOf("require('utility.Travel.Creep')") >= 0);
    assert.strictEqual(combined.indexOf('Game.' + 'market'), -1);
    assert.strictEqual(combined.indexOf('STRUCTURE_' + 'PORTAL'), -1);
});

test('existing and Season 11 roles remain in tick dispatch', function() {
    var source = fs.readFileSync(path.join(__dirname, 'Tick.Creeps.js'), 'utf8');
    var roles = [
        'Foreman', 'Extractor', 'Freighter', 'Annex', 'Tech', 'Artificer',
        'Pioneer', 'SupplyRunner', 'Scout', 'Ronin', 'Volley', 'Cleric',
        'ThoriumMiner', 'ThoriumHauler', 'ReactorClaimer'
    ];
    for (var i = 0; i < roles.length; i++) {
        assert.ok(source.indexOf(roles[i] + ':') >= 0,
            'missing dispatch for ' + roles[i]);
    }
});

console.log('Season 11 tests passed: ' + passed);
