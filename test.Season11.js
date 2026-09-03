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
global.Creep = function() {};
var Season11 = require('./Logic.Season11');
var Season11Operations = require('./Season11.Operations');
var ResourceMinerals = require('./Resource.Minerals');
var ResourceManager = require('./Resource.Manager');
var ResourceTerminals = require('./Resource.Terminals');
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
        stagingId: 'staging', routeDistance: 1
    };
    var role = require('./role.MineralMiner');
    var creep = { room: { name: 'W1N1' }, memory: { role: 'MineralMiner', mineralId: 'thorium' } };
    assert.strictEqual(role.migrateThoriumMiner(creep, { id: 'thorium', mineralType: 'T' }), true);
    assert.strictEqual(creep.memory.role, 'ThoriumMiner');
    assert.strictEqual(creep.memory.season11StagingId, 'staging');
    assert.strictEqual(creep.memory.mineralId, undefined);
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
            { structure: { id: 'road', store: {} } }
        ]; }
    });
    assert.strictEqual(tile.total, 100);
    assert.strictEqual(tile.multiplier, 2);
    assert.strictEqual(tile.observable, true);
});

test('aging fallback is conservative and independent of carry capacity', function() {
    resetWorld();
    enableSeasonApi();
    Season11.ensureMemory().config.agingFallbackThorium = 1000;
    var fallback = Season11.observeTileThorium(null);
    assert.deepStrictEqual({ total: fallback.total, multiplier: fallback.multiplier, source: fallback.source },
        { total: 1000, multiplier: 3, source: 'conservativeFallback' });
    var exact = Season11Operations.agingMetrics(2, 10);
    var planned = Season11Operations.agingMetrics(2);
    assert.strictEqual(exact.agingMultiplier, 1);
    assert.strictEqual(exact.agingEstimateSource, 'providedTileTotal');
    assert.strictEqual(planned.agingMultiplier, 3);
    assert.strictEqual(planned.agingEstimateSource, 'conservativeFallback');
    var source = fs.readFileSync(path.join(__dirname, 'Logic.Season11.js'), 'utf8');
    assert.strictEqual(source.indexOf('Math.log10(expectedCarryCapacity)'), -1);
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
