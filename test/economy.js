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
    Memory.rooms.W1N1 = { economy: snapshot({ state: 'RECOVERY' }) };
    assert.strictEqual(Economy.canSpend('W1N1', 'remote'), false);
});

test('H discretionary combat demand cannot consume recovery energy', function() {
    Memory.rooms.W1N1.economy.state = 'RECOVERY';
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
    Memory.rooms.W1N1.economy = snapshot({
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
    Memory.rooms.W1N1.spawn = { queue: [
        {
            role: 'Tech', body: [WORK, CARRY, MOVE], priority: 200, requestedAt: 1,
            memory: { role: 'Tech', homeRoom: 'W1N1' }
        },
        {
            role: 'Extractor', body: [WORK, WORK, WORK, WORK, MOVE, MOVE, CARRY],
            requestedWorkParts: 4, maxWorkParts: 4, priority: 120, requestedAt: 2,
            memory: { role: 'Extractor', homeRoom: 'W1N1', sourceRoom: 'W1N1' }
        }
    ] };
    const result = fresh('spawn.manager.js').runRoom('W1N1');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.role, 'Extractor');
    assert.deepStrictEqual(spawned.body, [WORK, MOVE, CARRY]);
    assert.strictEqual(Memory.rooms.W1N1.spawn.queue.length, 1);
    assert.strictEqual(Memory.rooms.W1N1.spawn.queue[0].role, 'Tech');
});

function runSpawnQueueAtEnergy(energy, queue, spawnResult) {
    const room = Game.rooms.W1N1;
    room.energyAvailable = energy;
    room.energyCapacityAvailable = 800;
    let spawned = null;
    Game.spawns.Spawn1 = {
        name: 'Spawn1', my: true, room, spawning: null,
        spawnCreep(body, name, options) {
            spawned = { body, name, memory: options.memory };
            return spawnResult === undefined ? OK : spawnResult;
        }
    };
    Memory.rooms.W1N1.spawn = Memory.rooms.W1N1.spawn || {};
    Memory.rooms.W1N1.spawn.queue = queue;
    return { result: fresh('spawn.manager.js').runRoom('W1N1'), spawned };
}

test('L affordable lower-priority recovery logistics bypasses an unaffordable miner', function() {
    Memory.rooms.W1N1.economy = snapshot({ state: 'SURVIVAL', energyAvailable: 150 });
    const queue = [
        {
            role: 'Extractor', body: [WORK, MOVE, CARRY], requestedWorkParts: 1,
            priority: 120, requestedAt: 1,
            memory: { role: 'Extractor', homeRoom: 'W1N1', sourceRoom: 'W1N1' }
        },
        {
            role: 'Freighter', body: [CARRY, MOVE], requestedCarryParts: 1,
            priority: 110, requestedAt: 2,
            memory: { role: 'Freighter', homeRoom: 'W1N1' }
        }
    ];
    const attempt = runSpawnQueueAtEnergy(150, queue);
    assert.strictEqual(attempt.result.ok, true);
    assert.strictEqual(attempt.result.role, 'Freighter');
    assert.deepStrictEqual(attempt.spawned.body, [CARRY, MOVE]);
    assert.strictEqual(queue.length, 1);
    assert.strictEqual(queue[0].role, 'Extractor');
});

test('M an affordable discretionary request cannot bypass survival policy', function() {
    Memory.rooms.W1N1.economy = snapshot({ state: 'SURVIVAL', energyAvailable: 150 });
    const queue = [
        {
            role: 'Extractor', body: [WORK, MOVE, CARRY], requestedWorkParts: 1,
            priority: 120, requestedAt: 1,
            memory: { role: 'Extractor', homeRoom: 'W1N1', sourceRoom: 'W1N1' }
        },
        {
            role: 'Scout', body: [MOVE], priority: 110, requestedAt: 2,
            memory: { role: 'Scout', homeRoom: 'W1N1' }
        }
    ];
    const attempt = runSpawnQueueAtEnergy(150, queue);
    assert.strictEqual(attempt.result.result, ERR_NOT_ENOUGH_ENERGY);
    assert.strictEqual(attempt.spawned, null);
    assert.strictEqual(queue.length, 2);
});

test('N the highest-priority miner wins again once its minimum body is affordable', function() {
    Memory.rooms.W1N1.economy = snapshot({ state: 'SURVIVAL', energyAvailable: 200 });
    const queue = [
        {
            role: 'Extractor', body: [WORK, MOVE, CARRY], requestedWorkParts: 1,
            priority: 120, requestedAt: 1,
            memory: { role: 'Extractor', homeRoom: 'W1N1', sourceRoom: 'W1N1' }
        },
        {
            role: 'Freighter', body: [CARRY, MOVE], requestedCarryParts: 1,
            priority: 110, requestedAt: 2,
            memory: { role: 'Freighter', homeRoom: 'W1N1' }
        }
    ];
    const attempt = runSpawnQueueAtEnergy(200, queue);
    assert.strictEqual(attempt.result.role, 'Extractor');
    assert.strictEqual(queue.length, 1);
    assert.strictEqual(queue[0].role, 'Freighter');
});

test('O fatal spawn failure removes the selected index, not a blocked queue head', function() {
    Memory.rooms.W1N1.economy = snapshot({ state: 'SURVIVAL', energyAvailable: 200 });
    const queue = [
        {
            role: 'Volley', body: [MOVE], priority: 200, requestedAt: 1,
            memory: { role: 'Volley', homeRoom: 'W1N1', targetRoom: 'W9N9' }
        },
        {
            role: 'Extractor', body: [WORK, MOVE, CARRY], requestedWorkParts: 1,
            priority: 120, requestedAt: 2,
            memory: { role: 'Extractor', homeRoom: 'W1N1', sourceRoom: 'W1N1' }
        }
    ];
    const attempt = runSpawnQueueAtEnergy(200, queue, ERR_INVALID_ARGS);
    assert.strictEqual(attempt.result.result, ERR_INVALID_ARGS);
    assert.strictEqual(queue.length, 1);
    assert.strictEqual(queue[0].role, 'Volley');
});

function energyStore(used, capacity = 800) {
    return {
        [RESOURCE_ENERGY]: used,
        getUsedCapacity(type) { return type === RESOURCE_ENERGY ? used : 0; },
        getFreeCapacity(type) { return type === RESOURCE_ENERGY ? capacity - used : 0; }
    };
}

function economyLink(id, x, y, used, cooldown = 0) {
    return { id, pos: new mocks.RoomPosition(x, y, 'W1N1'), store: energyStore(used), cooldown };
}

test('P healthy source Links satisfy local transport without Freighter CARRY', function() {
    const source = { id: 'sourceA', pos: new mocks.RoomPosition(10, 10, 'W1N1') };
    const sourceLink = economyLink('source-link', 11, 10, 400, 5);
    const storageLink = economyLink('storage-link', 20, 20, 0);
    const transport = Economy.analyzeSourceTransport(source, 10,
        { energy: 0, containers: 0 },
        { roles: { sources: [sourceLink], storage: storageLink, controller: null } });
    assert.strictEqual(transport.linkServedIncome, 10);
    assert.strictEqual(transport.creepIncome, 0);
    assert.strictEqual(transport.linkBackpressure, 0);
    const state = Economy.rawState(snapshot({
        haul: { requiredCarry: 0, creepRequiredCarry: 0, activeCarry: 0, localCarry: 0,
            linkServedIncome: 20, linkBackpressure: 0 }
    }));
    assert.strictEqual(state.state, 'STABLE');
});

test('Q a saturated source Link with blocked destinations reports logistics pressure', function() {
    const source = { id: 'sourceA', pos: new mocks.RoomPosition(10, 10, 'W1N1') };
    const sourceLink = economyLink('source-link', 11, 10, 800);
    const storageLink = economyLink('storage-link', 20, 20, 800);
    const transport = Economy.analyzeSourceTransport(source, 10,
        { energy: 0, containers: 0 },
        { roles: { sources: [sourceLink], storage: storageLink, controller: null } });
    assert.strictEqual(transport.destinationBlocked, true);
    assert.strictEqual(transport.linkServedIncome, 0);
    assert.strictEqual(transport.creepIncome, 10);
    assert.strictEqual(transport.linkBackpressure, 800);
    assert.strictEqual(Economy.rawState(snapshot({ haul: { linkBackpressure: 800 } })).state, 'RECOVERY');
});

test('R a source without a Link retains normal creep-hauling demand', function() {
    const source = { id: 'sourceA', pos: new mocks.RoomPosition(10, 10, 'W1N1') };
    const transport = Economy.analyzeSourceTransport(source, 10,
        { energy: 0, containers: 1 },
        { roles: { sources: [], storage: null, controller: null } });
    assert.strictEqual(transport.linkServedIncome, 0);
    assert.strictEqual(transport.creepIncome, 10);
});

test('S a hybrid Link source charges only spill flow to creep hauling', function() {
    const source = { id: 'sourceA', pos: new mocks.RoomPosition(10, 10, 'W1N1') };
    const sourceLink = economyLink('source-link', 11, 10, 200);
    const storageLink = economyLink('storage-link', 20, 20, 0);
    const transport = Economy.analyzeSourceTransport(source, 10,
        { energy: 100, containers: 1 },
        { roles: { sources: [sourceLink], storage: storageLink, controller: null } });
    assert.strictEqual(transport.mode, 'HYBRID');
    assert.strictEqual(transport.linkServedIncome, 8);
    assert.strictEqual(transport.creepIncome, 2);
});

function extractor(name, work, ttl, sourceId, spawning = false) {
    return {
        name, ticksToLive: ttl, spawning,
        memory: { role: 'Extractor', homeRoom: 'W1N1', sourceId },
        body: Array.from({ length: work }, () => ({ type: WORK, hits: 100 })),
        getActiveBodyparts(type) { return type === WORK ? work : 0; }
    };
}

function extractorRequest(work, sourceId) {
    return {
        role: 'Extractor',
        body: Array.from({ length: work }, () => WORK).concat([MOVE, CARRY]),
        memory: { role: 'Extractor', homeRoom: 'W1N1', sourceId }
    };
}

test('T an on-time full source replacement clears uncovered risk', function() {
    const source = { id: 'sourceA' };
    const coverage = Economy.sourceReplacementCoverage(source, 5, 10,
        [extractor('old', 5, 40, 'sourceA')], [extractorRequest(5, 'sourceA')], []);
    assert.strictEqual(coverage.replacementPending, true);
    assert.strictEqual(coverage.replacementRisk, false);
});

test('U an undersized replacement leaves source WORK uncovered', function() {
    const source = { id: 'sourceA' };
    const coverage = Economy.sourceReplacementCoverage(source, 5, 10,
        [extractor('old', 5, 40, 'sourceA')], [extractorRequest(1, 'sourceA')], []);
    assert.strictEqual(coverage.replacementRisk, true);
    assert.strictEqual(coverage.replacementUncoveredWork, 4);
});

test('V a replacement for another source cannot cover this source', function() {
    const source = { id: 'sourceA' };
    const coverage = Economy.sourceReplacementCoverage(source, 5, 10,
        [extractor('old', 5, 40, 'sourceA')], [extractorRequest(5, 'sourceB')], []);
    assert.strictEqual(coverage.replacementRisk, true);
});

test('W no source replacement leaves uncovered risk', function() {
    const source = { id: 'sourceA' };
    const coverage = Economy.sourceReplacementCoverage(source, 5, 10,
        [extractor('old', 5, 40, 'sourceA')], [], []);
    assert.strictEqual(coverage.replacementRisk, true);
});

test('X mobile mining capacity in transit diagnoses recovery, not immediate survival', function() {
    const state = Economy.rawState(snapshot({
        harvest: { workActive: 5, workQueued: 0, actualOrEstimatedIncome: 0 }
    }));
    assert.strictEqual(state.state, 'RECOVERY');
});

test('Y a true sub-200 total wipe exposes the unreachable bootstrap floor', function() {
    const state = Economy.rawState(snapshot({
        energyAvailable: 150,
        spawnFill: 0.1875,
        storageEnergy: 0,
        harvest: { workActive: 0, workQueued: 0, actualOrEstimatedIncome: 0 },
        bootstrap: { extractorFloor: 200, floorReachable: false, recoverableStoredEnergy: 0, unrecoverable: true }
    }));
    assert.strictEqual(state.state, 'SURVIVAL');
    assert.strictEqual(state.reason, 'bootstrap energy floor not reachable');
});

test('Z a source-specific creep already spawning counts as incoming replacement WORK', function() {
    const source = { id: 'sourceA' };
    const incoming = extractor('new', 5, undefined, 'sourceA', true);
    const spawns = [{ spawning: { name: 'new', remainingTime: 15 } }];
    const coverage = Economy.sourceReplacementCoverage(source, 5, 10,
        [extractor('old', 5, 40, 'sourceA'), incoming], [], spawns);
    assert.strictEqual(coverage.replacementPending, true);
    assert.strictEqual(coverage.replacementRisk, false);
});

test('AA an incoming spawning miner avoids false survival during a funded handoff', function() {
    const state = Economy.rawState(snapshot({
        harvest: { workActive: 0, workQueued: 0, workIncoming: 5, actualOrEstimatedIncome: 0 }
    }));
    assert.strictEqual(state.state, 'RECOVERY');
});

console.log('Economy recovery scenarios passed: A-AA');
