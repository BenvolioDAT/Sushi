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

console.log('RESULT ' + passed + ' passed, ' + failed + ' failed');

if (failed > 0) {
    process.exitCode = 1;
}
