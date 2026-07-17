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
