const assert = require('assert');
const path = require('path');
const mocks = require('./mock-screeps');

function fresh(file) {
    const resolved = path.join(mocks.root, file);
    delete require.cache[require.resolve(resolved)];
    return require(resolved);
}

function reset() {
    mocks.installGlobals({ limit: 100, tickLimit: 500, bucket: 10000, getUsed: () => 0 });
    mocks.clearLocalModules();
    global.BODYPART_COST = {
        [WORK]: 100, [CARRY]: 50, [MOVE]: 50, [CLAIM]: 600
    };
    global.CREEP_LIFE_TIME = 1500;
    global.CREEP_CLAIM_LIFE_TIME = 600;
    global.HARVEST_POWER = 2;
    global.CARRY_CAPACITY = 50;
}

function makeRoom(level, capacity) {
    const room = {
        name: 'W1N1',
        energyAvailable: capacity,
        energyCapacityAvailable: capacity,
        controller: {
            my: true, level, ticksToDowngrade: 16000,
            progress: 1000, progressTotal: 10000,
            pos: new RoomPosition(25, 25, 'W1N1')
        },
        _sites: [],
        _spawns: [],
        find(kind) {
            if (kind === FIND_CONSTRUCTION_SITES || kind === FIND_MY_CONSTRUCTION_SITES) return this._sites;
            if (kind === FIND_MY_SPAWNS) return this._spawns;
            return [];
        }
    };
    const spawn = {
        id: 'spawn1', name: 'Spawn1', my: true, owner: { username: 'me' }, room,
        pos: new RoomPosition(24, 25, room.name), spawning: null
    };
    room._spawns.push(spawn);
    Game.rooms[room.name] = room;
    Game.spawns.Spawn1 = spawn;
    Memory.rooms[room.name] = { spawn: { queue: [] } };
    return room;
}

function creep(name, role, body, memory, roomName = 'W1N1') {
    const unit = new Creep();
    unit.name = name;
    unit.id = name;
    unit.my = true;
    unit.memory = { role, homeRoom: 'W1N1', ...memory };
    unit.body = body.map(type => ({ type, hits: 100 }));
    unit.pos = new RoomPosition(10, 10, roomName);
    unit.room = { name: roomName };
    unit.ticksToLive = 1000;
    Game.creeps[name] = unit;
    Memory.creeps[name] = unit.memory;
    return unit;
}

function growthSnapshot(capacity, overrides = {}) {
    return {
        state: 'STABLE', energyAvailable: capacity, storageEnergy: 0, terminalEnergy: 0,
        energyTrend: 0, spawnFill: 1, replacementRisk: 0, protectedStockpileEnergy: 0,
        harvest: { actualOrEstimatedIncome: 10, workActive: 5, workRequired: 5 },
        haul: { localCarry: 10, requiredCarry: 5, backlog: 0, remoteCarry: 0, activeCarry: 10 },
        spawnPressure: { queued: 0, busy: 0 },
        ...overrides
    };
}

function test(name, fn) {
    fn();
    console.log('PASS ' + name);
}

test('healthy RCL2 and RCL3 pre-storage reserves are attainable and can become aggressive', () => {
    for (const [level, capacity] of [[2, 550], [3, 800]]) {
        reset();
        const room = makeRoom(level, capacity);
        const workers = [
            creep('miner', 'Extractor', [WORK, WORK, WORK, WORK, MOVE, CARRY], { sourceRoom: room.name }),
            creep('hauler', 'Freighter', [CARRY, CARRY, MOVE], {}),
            creep('foreman', 'Foreman', [CARRY, MOVE], {})
        ];
        const policy = fresh('HiveMind.Economy.js').buildGrowthPolicy(
            room, growthSnapshot(capacity), workers, room._spawns
        );
        assert.ok(policy.reserveTarget < capacity, `RCL${level} reserve must leave growth headroom`);
        assert.strictEqual(policy.mode, 'GROWTH_AGGRESSIVE');
        assert.ok(policy.controllerBudget > 1, JSON.stringify(policy));
    }
});

test('RCL2 remote capacity is planned but only observed production raises proven controller income', () => {
    reset();
    const room = makeRoom(2, 550);
    Memory.rooms.W1N2 = {
        sources: { remote: { pos: { x: 10, y: 10, roomName: 'W1N2' }, haul: { amount: 0, lastSeen: 0 } } }
    };
    Memory.rooms.W1N1.remotePlanner = {
        activeSourceIds: ['remote'], remotes: {},
        sourceInfos: { remote: {
            sourceId: 'remote', roomName: 'W1N2', parentRoomName: 'W1N1', active: true,
            effectiveEnergyPerTick: 5, netIncome: 4, distance: 40, score: 4
        } }
    };
    const workers = [creep('local-miner', 'Extractor', [WORK, WORK, WORK, MOVE], { sourceRoom: room.name })];
    const Economy = fresh('HiveMind.Economy.js');
    const bootstrap = Economy.buildGrowthPolicy(room, growthSnapshot(550), workers, room._spawns);
    assert.strictEqual(bootstrap.remote.plannedIncome, 5);
    assert.strictEqual(bootstrap.remote.provenIncome, 0);
    assert.strictEqual(bootstrap.remoteGrossIncome, 0);

    const remoteMiner = creep('remote-miner', 'Extractor', [WORK, WORK, WORK, CARRY, MOVE], {
        remoteMining: true, sourceRoom: 'W1N2', targetRoom: 'W1N2', sourceId: 'remote'
    }, 'W1N2');
    const remoteHauler = creep('remote-hauler', 'Freighter', [CARRY, CARRY, MOVE], {
        freighterJob: 'remote', pickupRoom: 'W1N2', pickupSourceId: 'remote'
    }, 'W1N2');
    Memory.rooms.W1N2.sources.remote.haul = {
        amount: 300, lastSeen: Game.time, lastAdvertisedAt: Game.time, lastDeliveryAt: Game.time
    };
    const proven = Economy.buildGrowthPolicy(
        room, growthSnapshot(550, { haul: { localCarry: 10, requiredCarry: 5, backlog: 0,
            remoteCarry: 2, activeCarry: 12 } }),
        workers.concat(remoteMiner, remoteHauler), room._spawns
    );
    assert.strictEqual(proven.remote.provenIncome, 5);
    assert.ok(proven.controllerBudget > bootstrap.controllerBudget);
    assert.ok(proven.reserveTarget < room.energyCapacityAvailable);
});

test('twenty-five road sites do not independently halve authoritative Tech WORK', () => {
    reset();
    const room = makeRoom(3, 800);
    Game.map.describeExits = name => name === 'W1N1' ? { 1: 'W1N2' } : { 5: 'W1N1' };
    room._sites = Array.from({ length: 25 }, (_, i) => ({
        id: 'road-' + i, my: true, structureType: STRUCTURE_ROAD,
        progress: 0, progressTotal: 300, pos: new RoomPosition(10, 10, room.name)
    }));
    Memory.rooms.W1N1.economy = {
        state: 'STABLE', growth: {
            mode: 'GROWTH_AGGRESSIVE', blockedReason: 'CONTROLLER_GROWTH_ACTIVE',
            affordableWork: 14, energyAboveReserve: 300
        }
    };
    assert.strictEqual(fresh('spawn.request.manager.js').getDesiredTechWork(room), 14);
});

test('critical construction is represented once in the Economy infrastructure budget', () => {
    reset();
    const room = makeRoom(4, 1300);
    room.storage = { store: { [RESOURCE_ENERGY]: 30000, getUsedCapacity: () => 30000 } };
    const Economy = fresh('HiveMind.Economy.js');
    let policy = Economy.buildGrowthPolicy(room, growthSnapshot(1300, { storageEnergy: 30000 }), [], room._spawns);
    const baseBudget = policy.infrastructureBudget;
    room._sites = [{
        id: 'storage-site', my: true, structureType: STRUCTURE_STORAGE,
        progress: 0, progressTotal: 30000, pos: new RoomPosition(20, 20, room.name)
    }];
    delete global.__sushiTickIndex;
    policy = Economy.buildGrowthPolicy(room, growthSnapshot(1300, { storageEnergy: 30000 }), [], room._spawns);
    assert.strictEqual(policy.criticalConstructionSites, 1);
    assert.ok(policy.infrastructureBudget > baseBudget);
});

test('remote portfolio replaces a much worse incumbent but retains hysteresis', () => {
    reset();
    const room = makeRoom(2, 550);
    Game.map.describeExits = name => name === 'W1N1' ? { 1: 'W1N2', 3: 'W2N1', 5: 'W1N0' } : { 5: 'W1N1' };
    Memory.rooms.W1N1.economy = {
        state: 'STABLE', replacementRisk: 0,
        harvest: { workActive: 5, workRequired: 5 }, haul: { localCarry: 10, requiredCarry: 5 },
        growth: { spawnPressure: 0, energyAboveReserve: 200, controllerBudget: 3,
            remote: { backlog: 0, reservedCarry: 0, requiredCarry: 0, availableCarry: 10,
                activeSources: 2, provenSources: 2 } }
    };
    const infos = {
        a: { sourceId: 'a', roomName: 'W1N2', parentRoomName: 'W1N1', active: true,
            grossEnergyPerTick: 10, distance: 140, numOpen: 1, risk: 0, score: 1 },
        b: { sourceId: 'b', roomName: 'W2N1', parentRoomName: 'W1N1', active: true,
            grossEnergyPerTick: 10, distance: 100, numOpen: 1, risk: 0, score: 2 },
        c: { sourceId: 'c', roomName: 'W1N0', parentRoomName: 'W1N1', active: false,
            grossEnergyPerTick: 10, distance: 20, numOpen: 1, risk: 0, score: 9 }
    };
    Memory.rooms.W1N1.remotePlanner = { pathVersion: 1, activeSourceIds: ['a', 'b'], remotes: {}, sourceInfos: infos };
    for (const id of ['a', 'b', 'c']) {
        Memory.rooms[infos[id].roomName] = {
            controller: id === 'c' ? { reservation: { username: 'me', ticksToEnd: 1000 } } : null,
            sources: { [id]: { containerPlanned: true, haul: { amount: 200, lastSeen: Game.time } } }
        };
    }
    creep('miner-a', 'Extractor', [WORK, WORK, WORK, MOVE], {
        remoteMining: true, sourceRoom: 'W1N2', targetRoom: 'W1N2', sourceId: 'a', targetSourceId: 'a'
    }, 'W1N2');
    creep('miner-b', 'Extractor', [WORK, WORK, WORK, MOVE], {
        remoteMining: true, sourceRoom: 'W2N1', targetRoom: 'W2N1', sourceId: 'b', targetSourceId: 'b'
    }, 'W2N1');
    const planner = fresh('Planner.Remote.js');
    planner.selectActiveSources('W1N1');
    assert.ok(Memory.rooms.W1N1.remotePlanner.activeSourceIds.includes('c'),
        JSON.stringify(Memory.rooms.W1N1.remotePlanner));
    assert.strictEqual(Memory.rooms.W1N1.remotePlanner.activeSourceIds.length, 2);
    assert.ok(Memory.rooms.W1N1.remotePlanner.lastRebalance.gain >
        Memory.rooms.W1N1.remotePlanner.lastRebalance.requiredGain);
});

test('later healthy rooms can exceed four remotes only with proven logistics', () => {
    reset();
    const room = makeRoom(6, 2300);
    room._spawns.push({ name: 'Spawn2', room, spawning: null });
    const planner = fresh('Planner.Remote.js');
    const healthy = { state: 'STABLE', replacementRisk: 0, growth: {
        spawnPressure: 0.1, remote: {
            activeSources: 4, provenSources: 4, backlog: 100, reservedCarry: 0,
            requiredCarry: 20, availableCarry: 25
        }
    } };
    assert.strictEqual(planner.getEffectiveRemoteSourceCap(room, healthy), 6);
    healthy.growth.remote.provenSources = 3;
    assert.strictEqual(planner.getEffectiveRemoteSourceCap(room, healthy), 4);
});

test('remoteBootstrap Artificer queues ahead of ordinary Tech growth but below core logistics', () => {
    reset();
    const room = makeRoom(3, 800);
    Memory.rooms.W1N1.economy = { state: 'STABLE', growth: { mode: 'GROWTH_NORMAL' } };
    const missing = {
        criticalMaintenance: 0, criticalInfrastructure: 0, remoteBootstrap: 4,
        construction: 0, remote: 0
    };
    const demand = {
        desiredWork: 4, livingWork: 0, spawningWork: 0, queuedWork: 0,
        missingWork: 4, mode: 'remote-container-build', economyCategory: 'remoteBootstrap',
        hasCriticalWork: true, missingWorkByEconomyCategory: missing
    };
    const result = fresh('spawn.request.manager.js').requestDynamicArtificersForRoom(room, demand);
    assert.strictEqual(result.requested, 1, JSON.stringify(result));
    const request = Memory.rooms.W1N1.spawn.queue[0];
    assert.ok(request.priority > 30);
    assert.ok(request.priority < 60);
});

test('RCL3 Annex replacement is queued using spawn plus route lead time', () => {
    reset();
    const room = makeRoom(3, 800);
    Game.map.describeExits = name => name === 'W1N1' ? { 1: 'W1N2' } : { 5: 'W1N1' };
    Memory.rooms.W1N1.economy = { state: 'STABLE', growth: { mode: 'GROWTH_NORMAL' } };
    Memory.rooms.W1N1.remotePlanner = {
        pathVersion: 1, activeSourceIds: ['remote'], remotes: {}, sourceInfos: {
            remote: { sourceId: 'remote', roomName: 'W1N2', parentRoomName: 'W1N1', active: true, distance: 60 }
        }
    };
    Memory.rooms.W1N2 = {
        controller: { pos: { x: 25, y: 25, roomName: 'W1N2' }, reservation: { username: 'me', ticksToEnd: 1 } },
        sources: { remote: { pos: { x: 10, y: 10, roomName: 'W1N2' } } }
    };
    const old = creep('old-annex', 'Annex', [CLAIM, MOVE], {
        targetRoom: 'W1N2', annexMode: 'reserve'
    }, 'W1N2');
    old.ticksToLive = 100;
    const result = fresh('spawn.request.manager.js').requestAnnexForRoom(room);
    assert.strictEqual(result.requested, 1, JSON.stringify(result));
    assert.ok(result.replacementLeadTicks > old.ticksToLive);
    assert.strictEqual(Memory.rooms.W1N1.spawn.queue[0].memory.claimParts, 1);
    assert.ok(Memory.rooms.W1N1.spawn.queue[0].priority > 30);
});

test('controller telemetry separates plan from EMA actuals and ignores RCL reset', () => {
    reset();
    const room = makeRoom(3, 800);
    Memory.rooms.W1N1.economy = {
        state: 'STABLE', growth: {
            controllerBudget: 14.2, affordableWork: 14, localGrossIncome: 10,
            remoteGrossIncome: 5, estimatedNetIncome: 12, reserveTarget: 300,
            storedEnergy: 800, energyAboveReserve: 500, mode: 'GROWTH_AGGRESSIVE',
            blockedReason: 'CONTROLLER_GROWTH_ACTIVE', remote: {
                activeSources: 1, candidateSources: 1, reservedSources: 1, unreservedSources: 0,
                backlog: 0, reservedCarry: 0, requiredCarry: 2, availableCarry: 2,
                oldestHaulAge: 0, plannedIncome: 5, provenIncome: 5, provenSources: 1
            }
        }
    };
    const telemetry = fresh('HiveMind.Telemetry.js');
    telemetry.sampleControllerProgress();
    Game.time += 10;
    room.controller.progress += 118;
    telemetry.sampleControllerProgress();
    let view = telemetry.getView().growth.W1N1;
    assert.strictEqual(view.plannedUpgradePerTick, 14.2);
    assert.strictEqual(view.actualControllerProgressPerTick, 11.8);
    assert.ok(view.controllerUtilization > 0);
    assert.ok(view.estimatedTicksToNextRcl > 0);
    Game.time++;
    room.controller.level = 4;
    room.controller.progress = 0;
    telemetry.sampleControllerProgress();
    view = telemetry.getView().growth.W1N1;
    assert.ok(view.actualControllerProgressPerTick >= 0);
});

console.log('Growth correction regression tests passed.');
