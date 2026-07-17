/* Lightweight Node tests for pure or narrowly mocked Sushi logic. */

var path = require('path');
var Module = require('module').Module;

process.env.NODE_PATH = path.resolve(__dirname, '..');
Module._initPaths();

var passed = 0;
var failed = 0;

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(
            message + ': expected ' + expected + ', received ' + actual
        );
    }
}

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('PASS ' + name);
    }
    catch (error) {
        failed++;
        console.log('FAIL ' + name + ': ' + error.message);
    }
}

function loadFreshCpuStatus() {
    var modulePath = path.resolve(__dirname, '..', 'CPU.Status.js');
    delete require.cache[modulePath];
    return require(modulePath);
}

function defineScreepsBodyGlobals() {
    global.MOVE = 'move';
    global.WORK = 'work';
    global.CARRY = 'carry';
    global.ATTACK = 'attack';
    global.RANGED_ATTACK = 'ranged_attack';
    global.HEAL = 'heal';
    global.TOUGH = 'tough';
    global.CLAIM = 'claim';
    global.BODYPART_COST = {};
    BODYPART_COST[MOVE] = 50;
    BODYPART_COST[WORK] = 100;
    BODYPART_COST[CARRY] = 50;
    BODYPART_COST[ATTACK] = 80;
    BODYPART_COST[RANGED_ATTACK] = 150;
    BODYPART_COST[HEAL] = 250;
    BODYPART_COST[TOUGH] = 10;
    BODYPART_COST[CLAIM] = 600;
    global.OK = 0;
    global.ERR_NOT_ENOUGH_ENERGY = -6;
    global.ERR_BUSY = -4;
    global.ERR_NAME_EXISTS = -3;
    global.ERR_INVALID_ARGS = -10;
    global.ERR_NO_PATH = -2;
    global.ERR_INVALID_TARGET = -7;
    global.TOP = 1;
    global.TOP_RIGHT = 2;
    global.RIGHT = 3;
    global.BOTTOM_RIGHT = 4;
    global.BOTTOM = 5;
    global.BOTTOM_LEFT = 6;
    global.LEFT = 7;
    global.TOP_LEFT = 8;
}

function defineDefenseGlobals() {
    defineScreepsBodyGlobals();
    global.RESOURCE_ENERGY = 'energy';
    global.FIND_STRUCTURES = 1;
    global.FIND_MY_STRUCTURES = 2;
    global.FIND_HOSTILE_CREEPS = 3;
    global.FIND_MY_CREEPS = 4;
    global.STRUCTURE_SPAWN = 'spawn';
    global.STRUCTURE_TOWER = 'tower';
    global.STRUCTURE_STORAGE = 'storage';
    global.STRUCTURE_TERMINAL = 'terminal';
    global.STRUCTURE_RAMPART = 'rampart';
    global.STRUCTURE_WALL = 'constructedWall';
    global.STRUCTURE_CONTAINER = 'container';
    global.STRUCTURE_EXTENSION = 'extension';
    global.BOOSTS = {
        tough: {
            XGHO2: { damage: 0.3 }
        },
        heal: {},
        attack: {},
        ranged_attack: {},
        work: {}
    };
}

function makePos(x, y, roomName) {
    return {
        x: x,
        y: y,
        roomName: roomName,
        getRangeTo: function(target) {
            var pos = target.pos || target;
            return Math.max(Math.abs(x - pos.x), Math.abs(y - pos.y));
        }
    };
}

function makeBody(parts) {
    var body = [];
    for (var i = 0; i < parts.length; i++) {
        body.push({
            type: parts[i].type || parts[i],
            hits: parts[i].hits === undefined ? 100 : parts[i].hits,
            boost: parts[i].boost || null
        });
    }
    return body;
}

function makeHostile(id, parts, x, y, hits) {
    var body = makeBody(parts);
    return {
        id: id,
        name: id,
        body: body,
        hits: hits === undefined ? body.length * 100 : hits,
        hitsMax: body.length * 100,
        pos: makePos(x, y, 'W1N1'),
        owner: { username: 'Enemy' }
    };
}

function loadFreshSpawnManager() {
    var names = [
        'spawn.manager.js',
        'utility.spawn.js',
        'role.creepBodyConfig.js'
    ];

    for (var i = 0; i < names.length; i++) {
        var modulePath = path.resolve(__dirname, '..', names[i]);
        delete require.cache[modulePath];
    }

    return require(path.resolve(__dirname, '..', 'spawn.manager.js'));
}

function loadFreshModule(fileName) {
    var modulePath = path.resolve(__dirname, '..', fileName);
    delete require.cache[modulePath];
    return require(modulePath);
}

test('CPU mode thresholds and hysteresis', function() {
    var cpuStatus = loadFreshCpuStatus();

    assertEqual(cpuStatus.chooseMode(20, 900, 0.10, 'normal'), 'critical', 'low bucket');
    assertEqual(cpuStatus.chooseMode(20, 6000, 0.96, 'normal'), 'critical', 'high usage');
    assertEqual(cpuStatus.chooseMode(20, 4500, 0.50, 'low'), 'low', 'low hysteresis');
    assertEqual(cpuStatus.chooseMode(40, 8000, 0.40, 'normal'), 'high', 'healthy high CPU');
});

test('CPU strategy uses the previous finalized tick', function() {
    var used = 0.2;
    global.Memory = {
        cpuStatus: {
            tick: 100,
            mode: 'normal',
            modeSince: 90,
            limit: 20,
            used: 19.5,
            finalized: true
        }
    };
    global.Game = {
        time: 101,
        cpu: {
            limit: 20,
            tickLimit: 500,
            bucket: 6000,
            getUsed: function() {
                return used;
            }
        }
    };

    var cpuStatus = loadFreshCpuStatus();
    var status = cpuStatus.getCpuStatus();

    assertEqual(status.mode, 'critical', 'prior overuse enters critical');
    assertEqual(status.strategicUsed, 19.5, 'completed usage is strategic sample');
    assertEqual(status.used, 0.2, 'current usage remains current');
    assertEqual(Memory.cpuStatus.finalized, false, 'new tick begins unfinalized');

    used = 12;
    status = cpuStatus.getCpuStatus();
    assertEqual(status.mode, 'critical', 'mode remains stable during tick');
    assertEqual(status.used, 12, 'current usage refreshes during tick');

    cpuStatus.finalizeCpuStatus();
    assertEqual(Memory.cpuStatus.used, 12, 'final usage is persisted');
    assertEqual(Memory.cpuStatus.usageRatio, 0.6, 'final ratio is persisted');
    assertEqual(Memory.cpuStatus.finalized, true, 'completed tick is marked finalized');
});

test('unfinalized prior ticks are not trusted as completed usage', function() {
    global.Memory = {
        cpuStatus: {
            tick: 200,
            mode: 'normal',
            limit: 20,
            used: 19.9,
            finalized: false
        }
    };
    global.Game = {
        time: 201,
        cpu: {
            limit: 20,
            tickLimit: 500,
            bucket: 6000,
            getUsed: function() {
                return 0.1;
            }
        }
    };

    var status = loadFreshCpuStatus().getCpuStatus();
    assertEqual(status.mode, 'normal', 'partial prior tick is ignored');
    assertEqual(status.strategicUsed, 0.1, 'fallback uses current sample');
});

test('normal spawn requests wait for their planned body', function() {
    defineScreepsBodyGlobals();
    global.Memory = { rooms: {}, creeps: {} };
    global.Game = { time: 1, creeps: {}, spawns: {} };

    var spawnManager = loadFreshSpawnManager();
    var room = {
        energyAvailable: 200,
        energyCapacityAvailable: 800
    };
    var request = {
        role: 'Tech',
        body: [WORK, WORK, CARRY, MOVE]
    };
    var result = spawnManager.selectAffordableQueuedBodyForSpawn(
        { room: room },
        request
    );

    assertEqual(result.affordable, false, 'normal body waits for energy');
    assertEqual(result.waitingForPlannedEnergy, true, 'wait reason is explicit');
    assertEqual(request.body.length, 4, 'planned body remains unchanged');
});

test('emergency and impossible requests may adapt their body', function() {
    defineScreepsBodyGlobals();
    global.Memory = { rooms: {}, creeps: {} };
    global.Game = { time: 1, creeps: {}, spawns: {} };

    var spawnManager = loadFreshSpawnManager();
    var emergencyRequest = {
        role: 'Tech',
        body: [WORK, WORK, CARRY, MOVE],
        emergency: true,
        maxWorkParts: 2
    };
    var emergencyResult = spawnManager.selectAffordableQueuedBodyForSpawn(
        { room: { energyAvailable: 200, energyCapacityAvailable: 800 } },
        emergencyRequest
    );

    assertEqual(emergencyResult.affordable, true, 'emergency body is affordable');
    assertEqual(emergencyResult.newCost, 200, 'emergency body shrinks to current energy');
    assertEqual(emergencyRequest.body.length, 3, 'emergency request receives minimum Tech body');

    var impossibleRequest = {
        role: 'Foreman',
        body: [CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE]
    };
    var impossibleResult = spawnManager.selectAffordableQueuedBodyForSpawn(
        { room: { energyAvailable: 300, energyCapacityAvailable: 300 } },
        impossibleRequest
    );

    assertEqual(impossibleResult.affordable, true, 'impossible stale body is repaired');
    assertEqual(impossibleResult.newCost, 300, 'stale request is capped by room capacity');
});

test('all idle spawns in a room can consume the shared queue', function() {
    defineScreepsBodyGlobals();
    var spawnedNames = [];
    var room = {
        name: 'W1N1',
        energyAvailable: 300,
        energyCapacityAvailable: 300
    };

    function makeSpawn() {
        return {
            room: room,
            spawning: null,
            spawnCreep: function(body, name, options) {
                this.spawning = { name: name };
                room.energyAvailable -= 50;
                Game.creeps[name] = {
                    name: name,
                    memory: options.memory,
                    room: room
                };
                spawnedNames.push(name);
                return OK;
            }
        };
    }

    global.Memory = {
        creeps: {},
        rooms: {
            W1N1: {
                spawnQueue: [
                    { role: 'Scout', body: [MOVE], priority: 10, requestedAt: 1, memory: { role: 'Scout', homeRoom: 'W1N1' } },
                    { role: 'Scout', body: [MOVE], priority: 10, requestedAt: 2, memory: { role: 'Scout', homeRoom: 'W1N1' } }
                ]
            }
        }
    };
    global.Game = {
        time: 10,
        creeps: {},
        spawns: {
            Spawn1: makeSpawn(),
            Spawn2: makeSpawn()
        }
    };

    var result = loadFreshSpawnManager().runAllIdleSpawns('W1N1');
    assertEqual(result.spawned, 2, 'two idle spawns start creeps');
    assertEqual(spawnedNames.length, 2, 'two unique spawn calls occur');
    assertEqual(Memory.rooms.W1N1.spawnQueue.length, 0, 'both requests are consumed');
});

test('tick cache indexes creeps once per tick', function() {
    global.Game = {
        time: 300,
        rooms: {
            W1N1: { name: 'W1N1', controller: { my: true } }
        },
        creeps: {
            A: {
                name: 'A',
                memory: { role: 'Tech', homeRoom: 'W1N1' },
                body: [{ type: WORK, hits: 100 }],
                room: { name: 'W1N1' }
            }
        },
        spawns: {}
    };

    var tickCache = loadFreshModule('Tick.Cache.js');
    var firstStats = tickCache.getDebugStats();
    assertEqual(tickCache.getAllCreeps().length, 1, 'creep index is available');
    assertEqual(
        tickCache.getCreepsByHomeRoomAndRole('W1N1', 'Tech').length,
        1,
        'home and role index is available'
    );
    assertEqual(
        tickCache.getDebugStats().buildsThisGlobal,
        firstStats.buildsThisGlobal,
        'repeated queries reuse one build'
    );

    Game.time = 301;
    tickCache.getAllCreeps();
    assertEqual(
        tickCache.getDebugStats().buildsThisGlobal,
        firstStats.buildsThisGlobal + 1,
        'new tick rebuilds once'
    );
});

test('tick cache reuses room structure scans', function() {
    global.FIND_STRUCTURES = 1;
    var findCalls = 0;
    var room = {
        name: 'W2N2',
        find: function() {
            findCalls++;
            return [{ id: 'road1' }];
        }
    };
    global.Game = { time: 400, rooms: { W2N2: room }, creeps: {}, spawns: {} };

    var tickCache = loadFreshModule('Tick.Cache.js');
    tickCache.getRoomStructures(room);
    tickCache.getRoomStructures(room);
    assertEqual(findCalls, 1, 'room.find runs once for the cached type');
});

test('disabled profiler does not sample Game.cpu', function() {
    var cpuCalls = 0;
    global.Memory = { settings: { enableCpuProfiling: false } };
    global.Game = {
        time: 500,
        cpu: {
            getUsed: function() {
                cpuCalls++;
                return 1;
            }
        }
    };

    var profiler = loadFreshModule('CPU.Profiler.js');
    var start = profiler.start();
    profiler.end('disabled', start);
    profiler.flush();
    assertEqual(start, null, 'disabled profiler returns no token');
    assertEqual(cpuCalls, 0, 'disabled profiler does not call getUsed');
});

test('Score route budget counts unique destination rooms', function() {
    global.FIND_SCORES = 99;
    global.Memory = {
        settings: {
            scoreSeasonEnabled: true,
            scoreRunnerMaximumRoomRange: 5,
            scoreRunnerDecaySafetyTicks: 25,
            scoreRunnerAllowSourceKeeperRooms: true
        },
        scoreSeason: { targets: {}, hostileRooms: {} },
        rooms: {}
    };
    for (var i = 0; i < 8; i++) {
        Memory.scoreSeason.targets['bad' + i] = {
            id: 'bad' + i,
            roomName: 'W9N9',
            x: 20,
            y: 20,
            score: 1000 - i,
            decayTime: 2000,
            seenAt: 700
        };
    }
    Memory.scoreSeason.targets.good = {
        id: 'good',
        roomName: 'W2N1',
        x: 20,
        y: 20,
        score: 10,
        decayTime: 2000,
        seenAt: 700
    };

    var routeCalls = 0;
    global.Game = {
        time: 700,
        rooms: {},
        creeps: {},
        spawns: {},
        map: {
            getRoomLinearDistance: function() { return 1; },
            findRoute: function(fromRoom, toRoom) {
                routeCalls++;
                return toRoom === 'W9N9' ? ERR_NO_PATH : [{ room: toRoom }];
            }
        }
    };
    var creep = {
        name: 'Runner',
        room: { name: 'W1N1' },
        pos: { getRangeTo: function() { return 10; } }
    };

    var scoreSeason = loadFreshModule('Season.Score.js');
    var ranked = scoreSeason.getBestTarget(creep, {});
    assertEqual(routeCalls, 2, 'one failed room and one valid room are checked');
    assertEqual(ranked.target.id, 'good', 'later valid room remains selectable');
});

test('high CPU without Score targets requests no new runners', function() {
    global.FIND_SCORES = 99;
    global.Creep = function() {};
    global.RoomPosition = function(x, y, roomName) {
        this.x = x;
        this.y = y;
        this.roomName = roomName;
    };
    global.Memory = {
        settings: {
            scoreSeasonEnabled: true,
            scoreRunnerMinimum: 1,
            scoreRunnerMaximumPerRoom: 5,
            scoreRunnerCpuScaling: true,
            scoreRunnerMaximumRoomRange: 5,
            scoreRunnerDecaySafetyTicks: 25,
            scoreRunnerAllowSourceKeeperRooms: true
        },
        scoreSeason: { targets: {}, hostileRooms: {} },
        rooms: { W1N1: { spawnQueue: [] } }
    };
    var room = {
        name: 'W1N1',
        controller: { my: true, level: 8, ticksToDowngrade: 100000 },
        energyCapacityAvailable: 3000,
        storage: { store: { energy: 100000 } }
    };
    global.Game = {
        time: 710,
        rooms: { W1N1: room },
        creeps: {},
        spawns: {},
        map: { getRoomLinearDistance: function() { return 1; } }
    };

    var requestManager = loadFreshModule('spawn.request.manager.js');
    var demand = requestManager.getScoreRunnerDemand(room, {
        mode: 'high',
        limit: 100,
        remaining: 90
    });
    assertEqual(demand.desired, 0, 'no target means no new runner demand');
    assertEqual(demand.reason, 'no reachable Score targets', 'reason is explicit');
});

test('ScoreRunner fleeing uses the Season route safety callback', function() {
    global.FIND_SCORES = 99;
    global.Memory = {
        settings: {
            scoreSeasonEnabled: true,
            scoreRunnerAllowSourceKeeperRooms: true
        },
        scoreSeason: {
            targets: {},
            hostileRooms: {
                W3N3: { until: 900, reason: 'test' }
            }
        },
        rooms: {}
    };
    global.Game = {
        time: 720,
        rooms: {},
        creeps: {},
        spawns: {},
        map: { describeExits: function() { return {}; } }
    };

    var travel = require(path.resolve(__dirname, '..', 'utility.Travel.Creep.js'));
    var originalMoveToRoom = travel.moveToRoom;
    var capturedOptions = null;
    travel.moveToRoom = function(creep, roomName, options) {
        capturedOptions = options;
        return OK;
    };

    try {
        var scoreRunner = loadFreshModule('role.scorerunner.js');
        scoreRunner.fleeHostileRoom({
            memory: { homeRoom: 'W2N2' },
            room: { name: 'W1N1' }
        });
        assertEqual(
            typeof capturedOptions.routeCallback,
            'function',
            'flee travel receives a route callback'
        );
        assertEqual(
            capturedOptions.routeCallback('W3N3'),
            Infinity,
            'Season-marked hostile room is rejected'
        );
    }
    finally {
        travel.moveToRoom = originalMoveToRoom;
    }
});

test('unarmed Scout has low cached threat', function() {
    defineDefenseGlobals();
    var spawn = { id: 'spawn1', structureType: STRUCTURE_SPAWN, pos: makePos(25, 25, 'W1N1') };
    var room = {
        name: 'W1N1',
        controller: { my: true, pos: makePos(20, 20, 'W1N1') },
        find: function(type) { return type === FIND_STRUCTURES ? [spawn] : []; }
    };
    global.Game = { time: 800, rooms: { W1N1: room }, creeps: {}, spawns: {} };
    var threat = loadFreshModule('Combat.Threat.js');
    var scout = makeHostile('scout', [MOVE], 25, 24);
    var first = threat.analyze(scout, room);
    var builds = threat.getDebugStats().analysesBuiltThisGlobal;
    var second = threat.analyze(scout, room);

    assertEqual(first.category, 'scout', 'unarmed creep is a Scout');
    assertEqual(first.dangerous, false, 'Scout is not offensive');
    assertEqual(first.totalThreat < 50, true, 'Scout threat stays low');
    assertEqual(second, first, 'same hostile returns cached analysis');
    assertEqual(
        threat.getDebugStats().analysesBuiltThisGlobal,
        builds,
        'hostile analysis builds once per tick'
    );
});

test('attackers and dismantlers near critical structures score high', function() {
    defineDefenseGlobals();
    var spawn = { id: 'spawn1', structureType: STRUCTURE_SPAWN, pos: makePos(25, 25, 'W1N1') };
    var rampart = { id: 'ramp1', structureType: STRUCTURE_RAMPART, pos: makePos(24, 25, 'W1N1') };
    var room = {
        name: 'W1N1',
        controller: { my: true, pos: makePos(20, 20, 'W1N1') },
        find: function(type) { return type === FIND_STRUCTURES ? [spawn, rampart] : []; }
    };
    global.Game = { time: 801, rooms: { W1N1: room }, creeps: {}, spawns: {} };
    var threat = loadFreshModule('Combat.Threat.js');
    var attacker = threat.analyze(makeHostile('attacker', [ATTACK, MOVE], 25, 24), room);
    var dismantler = threat.analyze(makeHostile('dismantler', [WORK, WORK, MOVE], 23, 25), room);

    assertEqual(attacker.category, 'attacker', 'ATTACK creep is classified');
    assertEqual(attacker.totalThreat > 500, true, 'attacker near spawn scores high');
    assertEqual(dismantler.category, 'dismantler', 'WORK creep is classified');
    assertEqual(dismantler.strategicThreat >= 500, true, 'nearby dismantler has strategic threat');
});

test('boosted TOUGH increases effective durability', function() {
    defineDefenseGlobals();
    var room = { name: 'W1N1', find: function() { return []; } };
    global.Game = { time: 802, rooms: { W1N1: room }, creeps: {}, spawns: {} };
    var threat = loadFreshModule('Combat.Threat.js');
    var plain = threat.analyze(makeHostile('plain', [TOUGH, MOVE], 10, 10), room);
    var boosted = threat.analyze(makeHostile(
        'boosted',
        [{ type: TOUGH, boost: 'XGHO2' }, MOVE],
        10,
        10
    ), room);
    assertEqual(boosted.durability > plain.durability, true, 'boosted TOUGH is more durable');
    assertEqual(boosted.boostedToughParts, 1, 'boost is recorded');
});

test('tower target selection prefers a killable supported threat', function() {
    defineDefenseGlobals();
    global.Memory = { rooms: { W1N1: {} } };
    var room = { name: 'W1N1', controller: { my: true }, find: function() { return []; } };
    global.Game = { time: 810, rooms: { W1N1: room }, creeps: {}, spawns: {} };
    var tower = {
        id: 'tower1',
        pos: makePos(20, 20, 'W1N1'),
        store: { getUsedCapacity: function() { return 1000; } }
    };
    var tank = makeHostile('tank', [ATTACK, ATTACK, ATTACK, ATTACK, MOVE], 21, 20, 500);
    tank.hitsMax = 5000;
    tank.hits = 5000;
    var healer = makeHostile('healer', [HEAL, MOVE], 21, 21, 100);
    var towerLogic = loadFreshModule('Logic.Tower.js');
    var evaluation = towerLogic.chooseTowerTarget(room, [tower], [tank, healer]);

    assertEqual(evaluation.target.id, 'healer', 'vulnerable healer is focused first');
    assertEqual(evaluation.killable, true, 'selected target is killable through healing');
});

test('towers heal a critical defender and never repair during danger', function() {
    defineDefenseGlobals();
    global.Memory = { rooms: { W1N1: {} } };
    var attacks = 0;
    var heals = 0;
    var repairs = 0;
    var tower = {
        id: 'tower1',
        structureType: STRUCTURE_TOWER,
        pos: makePos(20, 20, 'W1N1'),
        store: { getUsedCapacity: function() { return 1000; } },
        attack: function() { attacks++; },
        heal: function() { heals++; },
        repair: function() { repairs++; }
    };
    var healerParts = [];
    for (var i = 0; i < 50; i++) {
        healerParts.push(HEAL);
    }
    var hostile = makeHostile('healwall', healerParts, 21, 20, 5000);
    var defender = {
        id: 'defender',
        hits: 100,
        hitsMax: 1000,
        memory: { role: 'Ronin' },
        pos: makePos(20, 21, 'W1N1')
    };
    var room = {
        name: 'W1N1',
        controller: { my: true, level: 8 },
        find: function(type) {
            if (type === FIND_MY_STRUCTURES) { return [tower]; }
            if (type === FIND_HOSTILE_CREEPS) { return [hostile]; }
            if (type === FIND_MY_CREEPS) { return [defender]; }
            return [];
        }
    };
    defender.room = room;
    hostile.room = room;
    global.Game = {
        time: 811,
        rooms: { W1N1: room },
        creeps: {},
        spawns: {},
        getObjectById: function() { return null; }
    };

    loadFreshModule('Logic.Tower.js').run(room);
    assertEqual(heals, 1, 'tower heals critical defender in a stalemate');
    assertEqual(attacks, 0, 'tower does not waste fire into the stalemate');
    assertEqual(repairs, 0, 'tower never repairs during danger');
});

test('tower target lock breaks for a critical new threat', function() {
    defineDefenseGlobals();
    global.Memory = { rooms: { W1N1: {} } };
    var spawn = { structureType: STRUCTURE_SPAWN, pos: makePos(25, 25, 'W1N1') };
    var room = {
        name: 'W1N1',
        controller: { my: true },
        find: function(type) { return type === FIND_STRUCTURES ? [spawn] : []; }
    };
    var tower = {
        pos: makePos(20, 20, 'W1N1'),
        store: { getUsedCapacity: function() { return 1000; } }
    };
    var first = makeHostile('first', [ATTACK, MOVE], 10, 10);
    global.Game = { time: 812, rooms: { W1N1: room }, creeps: {}, spawns: {} };
    var towerLogic = loadFreshModule('Logic.Tower.js');
    towerLogic.chooseTowerTarget(room, [tower], [first]);

    Game.time = 813;
    var critical = makeHostile('critical', [WORK, WORK, WORK, WORK, MOVE], 25, 24);
    var selected = towerLogic.chooseTowerTarget(room, [tower], [first, critical]);
    assertEqual(selected.target.id, 'critical', 'critical dismantler breaks short lock');
});

test('defensive demand is room-local and ignores peaceful rooms', function() {
    defineDefenseGlobals();
    global.Memory = { rooms: { W1N1: {}, W2N2: {} } };
    var hostile = makeHostile(
        'localThreat',
        [ATTACK, ATTACK, ATTACK, ATTACK, MOVE, MOVE],
        24,
        24
    );
    var roomA = {
        name: 'W1N1',
        controller: { my: true, safeMode: 1, pos: makePos(25, 25, 'W1N1') },
        find: function(type) {
            if (type === FIND_HOSTILE_CREEPS) { return [hostile]; }
            return [];
        }
    };
    var roomB = {
        name: 'W2N2',
        controller: { my: true, pos: makePos(25, 25, 'W2N2') },
        find: function() { return []; }
    };
    hostile.room = roomA;
    global.Game = {
        time: 820,
        rooms: { W1N1: roomA, W2N2: roomB },
        creeps: {},
        spawns: {}
    };
    var defenseDemand = loadFreshModule('Defense.Demand.js');
    var threatened = defenseDemand.getDemand(roomA);
    var peaceful = defenseDemand.getDemand(roomB);

    assertEqual(threatened.harmfulHostileCount, 1, 'local threat is detected');
    assertEqual(
        threatened.desiredMelee + threatened.desiredRanged > 0,
        true,
        'threatened room asks for a fighter'
    );
    assertEqual(peaceful.harmfulHostileCount, 0, 'other room stays peaceful');
    assertEqual(peaceful.desiredMelee + peaceful.desiredRanged, 0, 'other room asks for no defense');
});

test('defense requests deduplicate and expire when vision is safe', function() {
    defineDefenseGlobals();
    global.Creep = function() {};
    global.RoomPosition = function(x, y, roomName) {
        this.x = x;
        this.y = y;
        this.roomName = roomName;
    };
    var hostile = makeHostile(
        'queueThreat',
        [ATTACK, ATTACK, ATTACK, MOVE, MOVE],
        24,
        24
    );
    var hostiles = [hostile];
    var room = {
        name: 'W1N1',
        energyAvailable: 800,
        energyCapacityAvailable: 800,
        controller: { my: true, level: 5, safeMode: 1, pos: makePos(25, 25, 'W1N1') },
        find: function(type) {
            if (type === FIND_HOSTILE_CREEPS) { return hostiles; }
            return [];
        }
    };
    hostile.room = room;
    global.Memory = {
        rooms: { W1N1: { spawnQueue: [] } },
        creeps: {},
        settings: {}
    };
    global.Game = {
        time: 821,
        rooms: { W1N1: room },
        creeps: {},
        spawns: {}
    };
    var requestManager = loadFreshModule('spawn.request.manager.js');
    requestManager.requestDefendersForRoom(room, null);
    var firstLength = Memory.rooms.W1N1.spawnQueue.length;
    requestManager.requestDefendersForRoom(room, null);
    var secondLength = Memory.rooms.W1N1.spawnQueue.length;

    assertEqual(firstLength > 0, true, 'threat creates a defense request');
    assertEqual(secondLength, firstLength, 'second plan does not duplicate requests');
    assertEqual(
        Memory.rooms.W1N1.spawnQueue[0].memory.defendedRoom,
        'W1N1',
        'request is explicitly room-local'
    );

    hostiles = [];
    Game.time = 822;
    requestManager.requestDefendersForRoom(room, null);
    assertEqual(Memory.rooms.W1N1.spawnQueue.length, 0, 'safe live vision removes stale defense requests');
});

test('main module loads without Game.rooms or populated Memory', function() {
    defineScreepsBodyGlobals();
    global.RESOURCE_ENERGY = 'energy';
    global.Creep = function() {};
    global.RoomPosition = function(x, y, roomName) {
        this.x = x;
        this.y = y;
        this.roomName = roomName;
    };
    global.Memory = {};
    global.Game = {
        time: 600,
        cpu: { getUsed: function() { return 0; } },
        creeps: {},
        spawns: {},
        flags: {},
        map: {}
    };

    var trafficPath = path.resolve(__dirname, '..', 'traffic_manager.js');
    var travelPath = path.resolve(__dirname, '..', 'utility.Travel.Creep.js');
    var travelerPath = path.resolve(__dirname, '..', 'Traveler.js');
    delete require.cache[trafficPath];
    delete require.cache[travelPath];
    delete require.cache[travelerPath];
    var main = loadFreshModule('main.js');
    assertEqual(typeof main.loop, 'function', 'main exports the tick loop');
    assertEqual(typeof main.getStartupState, 'function', 'startup state is inspectable');
});

console.log('RESULT ' + passed + ' passed, ' + failed + ' failed');

if (failed > 0) {
    process.exitCode = 1;
}
