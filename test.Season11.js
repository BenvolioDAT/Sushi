/* Lightweight Node mock harness: run with the repository on NODE_PATH. */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var Module = require('module');
var Season11 = require('./Logic.Season11');

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
    assert.strictEqual(Memory.season11.stats.apiAvailable, false);
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
    assert.strictEqual(Memory.season11.rooms.W5N5.thorium.id, 'mineral1');
    assert.strictEqual(Memory.season11.rooms.W5N5.thorium.remaining, 4321);
    assert.strictEqual(Memory.season11.rooms.W5N5.thorium.density, 3);
    assert.strictEqual(Memory.season11.reactors.reactor1.thorium, 123);
    assert.strictEqual(Memory.season11.reactors.reactor1.continuousWork, 99);
    assert.doesNotThrow(function() { JSON.stringify(Memory.season11); });
});

test('stale intel is eventually cleaned', function() {
    resetWorld();
    enableSeasonApi();
    Season11.ensureMemory();
    Memory.season11.config.intelMaxAge = 10;
    Memory.season11.rooms.W1N1 = {
        roomName: 'W1N1',
        lastSeen: 1,
        thorium: { id: 'old', remaining: 10, depleted: false }
    };
    Game.time = 100;
    Season11.cleanupStaleIntel(true);
    assert.strictEqual(Memory.season11.rooms.W1N1, undefined);
});

test('depleted Thorium is not ranked or scheduled', function() {
    resetWorld();
    enableSeasonApi();
    Season11.ensureMemory();
    Memory.season11.rooms.W2N2 = {
        roomName: 'W2N2',
        lastSeen: Game.time,
        thorium: { id: 'empty', remaining: 0, depleted: true }
    };
    assert.strictEqual(Season11.rankMiningTargets().length, 0);
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
            spawnQueue: [{ memory: { season11AssignmentKey: 'haul:A:R' } }]
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

test('existing and Season 11 roles remain in main dispatch', function() {
    var source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    var roles = [
        'Foreman', 'Extractor', 'Freighter', 'Annex', 'Tech', 'Artificer',
        'Pioneer', 'SupplyRunner', 'Scout', 'Ronin', 'Volley', 'Cleric',
        'ThoriumMiner', 'ThoriumHauler', 'ReactorClaimer'
    ];
    for (var i = 0; i < roles.length; i++) {
        assert.ok(source.indexOf("creep.memory.role == '" + roles[i] + "'") >= 0,
            'missing dispatch for ' + roles[i]);
    }
});

console.log('Season 11 tests passed: ' + passed);
