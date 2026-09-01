const assert = require('assert');
const path = require('path');
const mocks = require('./mock-screeps');

function fresh(file) {
    const resolved = path.join(mocks.root, file);
    delete require.cache[require.resolve(resolved)];
    return require(resolved);
}

function snapshot(overrides = {}) {
    const base = {
        roomName: 'W1N1',
        sampleTick: Game.time,
        state: 'STABLE',
        stateSince: Game.time,
        stateChangedAt: Game.time,
        healthyTicks: 0,
        spawnFill: 1,
        energyAvailable: 800,
        energyCapacity: 800,
        storageEnergy: 20000,
        terminalEnergy: 0,
        liquidEnergy: 20800,
        energyTrend: 0,
        harvest: {
            expectedIncome: 20,
            actualOrEstimatedIncome: 20,
            workRequired: 10,
            workActive: 10,
            workQueued: 0,
            sources: []
        },
        haul: {
            requiredCarry: 10,
            activeCarry: 10,
            localCarry: 10,
            queuedCarry: 0,
            remoteCarry: 0,
            backlog: 0
        },
        replacementRisk: 0,
        remoteCommitments: 0,
        spawnPressure: { queued: 0, busy: 0 }
    };
    return {
        ...base,
        ...overrides,
        harvest: { ...base.harvest, ...(overrides.harvest || {}) },
        haul: { ...base.haul, ...(overrides.haul || {}) },
        spawnPressure: { ...base.spawnPressure, ...(overrides.spawnPressure || {}) }
    };
}

function test(name, fn) {
    fn();
    console.log('PASS ' + name);
}

mocks.installGlobals();
mocks.clearLocalModules();
const Economy = fresh('HiveMind.Economy.js');

test('A healthy room remains stable', function() {
    assert.deepStrictEqual(Economy.rawState(snapshot()), {
        state: 'STABLE', reason: 'local income and logistics sustainable'
    });
});

test('B predictive replacement risk holds a low-reserve room in recovery', function() {
    const result = Economy.rawState(snapshot({ storageEnergy: 0, replacementRisk: 1 }));
    assert.strictEqual(result.state, 'RECOVERY');
    assert.strictEqual(result.reason, 'critical economy replacement at risk');
});

test('C loss of all miners enters survival immediately', function() {
    const result = Economy.rawState(snapshot({ harvest: { workActive: 0, actualOrEstimatedIncome: 0 } }));
    assert.strictEqual(result.state, 'SURVIVAL');
    assert.strictEqual(result.reason, 'zero functional local source miners');
});

test('D 200 energy builds the minimum viable Extractor without waiting for room capacity', function() {
    global.BODYPART_COST = { [WORK]: 100, [MOVE]: 50, [CARRY]: 50 };
    const bodies = fresh('role.creepBodyConfig.js');
    const room = { energyAvailable: 200, energyCapacityAvailable: 800 };
    assert.deepStrictEqual(bodies.getExtractorBodyForAvailableEnergy(room, 5), [WORK, MOVE, CARRY]);
    room.energyAvailable = 199;
    assert.strictEqual(bodies.getExtractorBodyForAvailableEnergy(room, 5), null);
});

test('E source backlog with insufficient local CARRY diagnoses logistics', function() {
    const result = Economy.rawState(snapshot({ haul: { activeCarry: 0, localCarry: 0, backlog: 1500 } }));
    assert.strictEqual(result.state, 'RECOVERY');
    assert.strictEqual(result.reason, 'harvest restored, logistics below demand');
});

test('F excess CARRY cannot hide a harvesting deficit', function() {
    const result = Economy.rawState(snapshot({
        harvest: { workActive: 3, actualOrEstimatedIncome: 6 },
        haul: { activeCarry: 30, localCarry: 30 }
    }));
    assert.strictEqual(result.state, 'RECOVERY');
    assert.strictEqual(result.reason, 'harvesting below sustainable local demand');
});

test('G remote spending is suppressed during home recovery', function() {
    Memory.hive = { economy: { rooms: { W1N1: snapshot({ state: 'RECOVERY' }) } } };
    assert.strictEqual(Economy.canSpend('W1N1', 'remote'), false);
});

test('H discretionary combat demand cannot consume recovery energy', function() {
    Memory.hive.economy.rooms.W1N1.state = 'RECOVERY';
    const room = { name: 'W1N1', controller: { my: true } };
    Game.rooms.W1N1 = room;
    const check = Economy.canSpawnRequest(room, {
        role: 'Volley', memory: { role: 'Volley', homeRoom: 'W1N1', targetRoom: 'W9N9' }
    });
    assert.strictEqual(check.allowed, false);
});

test('I owned-room emergency defense bypasses recovery restrictions', function() {
    const room = Game.rooms.W1N1;
    const check = Economy.canSpawnRequest(room, {
        role: 'Volley',
        memory: { role: 'Volley', homeRoom: 'W1N1', targetRoom: 'W1N1', defendedRoom: 'W1N1', defenseRequest: true }
    });
    assert.strictEqual(check.allowed, true);
});

test('J an expensive active spawn does not turn healthy income into survival', function() {
    const result = Economy.rawState(snapshot({
        spawnFill: 0.05,
        energyAvailable: 40,
        storageEnergy: 0,
        spawnPressure: { busy: 1 }
    }));
    assert.strictEqual(result.state, 'STABLE');
});

test('J hysteresis requires sustained improvement before leaving survival', function() {
    let previous = snapshot({ state: 'SURVIVAL', stateSince: Game.time, reason: 'collapse' });
    for (let tick = 1; tick < 12; tick++) {
        Game.time++;
        const next = snapshot({ sampleTick: Game.time });
        previous = Economy.applyHysteresis(next, previous);
        assert.strictEqual(previous.state, 'SURVIVAL');
    }
    Game.time++;
    previous = Economy.applyHysteresis(snapshot({ sampleTick: Game.time }), previous);
    assert.strictEqual(previous.state, 'RECOVERY');
});

test('K full-wipe policy admits the bootstrap miner and blocks optional work', function() {
    Memory.hive.economy.rooms.W1N1 = snapshot({
        state: 'SURVIVAL', energyAvailable: 200, spawnFill: 0.25,
        storageEnergy: 0, harvest: { workActive: 0, actualOrEstimatedIncome: 0 }
    });
    const room = Game.rooms.W1N1;
    assert.strictEqual(Economy.canSpawnRequest(room, {
        role: 'Extractor', memory: { role: 'Extractor', homeRoom: 'W1N1', sourceRoom: 'W1N1' }
    }).allowed, true);
    assert.strictEqual(Economy.canSpawnRequest(room, {
        role: 'Tech', memory: { role: 'Tech', homeRoom: 'W1N1' }
    }).allowed, false);
});

test('K spawn consumer skips a higher-priority optional request for the bootstrap miner', function() {
    const room = Game.rooms.W1N1;
    room.energyAvailable = 200;
    room.energyCapacityAvailable = 800;
    let spawned = null;
    Game.spawns.Spawn1 = {
        name: 'Spawn1', my: true, room, spawning: null,
        spawnCreep(body, name, options) {
            spawned = { body, name, memory: options.memory };
            return OK;
        }
    };
    Memory.rooms.W1N1 = Memory.rooms.W1N1 || {};
    Memory.rooms.W1N1.spawnQueue = [
        {
            role: 'Tech', body: [WORK, CARRY, MOVE], priority: 200, requestedAt: 1,
            memory: { role: 'Tech', homeRoom: 'W1N1' }
        },
        {
            role: 'Extractor', body: [WORK, WORK, WORK, WORK, MOVE, MOVE, CARRY],
            requestedWorkParts: 4, maxWorkParts: 4, priority: 120, requestedAt: 2,
            memory: { role: 'Extractor', homeRoom: 'W1N1', sourceRoom: 'W1N1' }
        }
    ];
    const result = fresh('spawn.manager.js').runRoom('W1N1');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.role, 'Extractor');
    assert.deepStrictEqual(spawned.body, [WORK, MOVE, CARRY]);
    assert.strictEqual(Memory.rooms.W1N1.spawnQueue.length, 1);
    assert.strictEqual(Memory.rooms.W1N1.spawnQueue[0].role, 'Tech');
});

console.log('Economy recovery scenarios passed: A-K');
