const path = require('path');
const assert = require('assert');
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

function reset() {
    mocks.installGlobals({ limit: 100, tickLimit: 500, bucket: 10000, getUsed: () => 0 });
    mocks.clearLocalModules();
    Object.assign(BODYPART_COST, { [WORK]: 100, [CARRY]: 50, [MOVE]: 50 });
}

function makeRoom(name = 'W5N8', rcl = 1) {
    const room = {
        name,
        energyAvailable: 300,
        energyCapacityAvailable: 300,
        controller: {
            my: true,
            level: rcl,
            ticksToDowngrade: 16000,
            pos: new RoomPosition(25, 25, name)
        },
        find: () => []
    };
    Game.rooms[name] = room;
    Memory.rooms[name] = {
        spawn: { queue: [] },
        economy: {
            state: 'RECOVERY',
            rawState: 'RECOVERY',
            reason: 'harvest restored, logistics below demand',
            harvest: { workActive: 10, workQueued: 0 },
            haul: { localCarry: 9, queuedCarry: 0, requiredCarry: 13 },
            bootstrap: { floorReachable: true, unrecoverable: false },
            spawnFill: 1,
            protectedStockpileEnergy: 150
        }
    };
    Game.spawns.Spawn1 = {
        id: 'spawn1', name: 'Spawn1', my: true, room,
        pos: new RoomPosition(24, 25, name), spawning: null
    };
    return room;
}

function addCreep(room, name, role, body, memory = {}) {
    const unit = new Creep();
    unit.name = name;
    unit.room = room;
    unit.pos = new RoomPosition(24, 24, room.name);
    unit.memory = { role, homeRoom: room.name, ...memory };
    unit.body = (body || [MOVE]).map(type => ({ type, hits: 100 }));
    unit.store = { [RESOURCE_ENERGY]: 0, getUsedCapacity: () => 0, getFreeCapacity: () => 50 };
    unit.ticksToLive = 1000;
    Game.creeps[name] = unit;
    Memory.creeps[name] = unit.memory;
    return unit;
}

function addRcl1CoreAtCap(room) {
    addCreep(room, 'foreman', 'Foreman', [CARRY, MOVE]);
    addCreep(room, 'extractor-a', 'Extractor', [WORK, WORK, MOVE]);
    addCreep(room, 'extractor-b', 'Extractor', [WORK, WORK, MOVE]);
    addCreep(room, 'freighter', 'Freighter', [CARRY, CARRY, MOVE]);
    for (let i = 0; i < 6; i++) addCreep(room, `worker-${i}`, 'Artificer', [WORK, CARRY, MOVE]);
}

function refreshColony(room) {
    delete global.__sushiTickIndex;
    return fresh('HiveMind.ColonyState.js').update(room);
}

test('RCL1 RECOVERY admits exactly one bounded baseline-growth Tech at the ordinary cap', () => {
    reset();
    const room = makeRoom();
    addRcl1CoreAtCap(room);
    const raw = fresh('HiveMind.Economy.js').rawState({
        harvest: { workRequired: 10, workActive: 10, workIncoming: 0,
            expectedIncome: 10, actualOrEstimatedIncome: 10 },
        haul: { requiredCarry: 13, localCarry: 9, backlog: 150, activeCarry: 9, linkBackpressure: 0 },
        storageEnergy: 0, terminalEnergy: 0, spawnFill: 1, replacementRisk: 0,
        spawnPressure: { busy: 0 }, bootstrap: { unrecoverable: false }
    });
    assert.strictEqual(raw.state, 'RECOVERY');
    assert.match(raw.reason, /logistics/i);
    const colony = refreshColony(room);
    assert.strictEqual(colony.lifecycle, 'BOOTSTRAP');
    assert.strictEqual(colony.growthAllowed, true);
    assert.strictEqual(colony.baselineTechWork, 1);

    const requests = fresh('spawn.request.manager.js');
    const demand = { desiredWork: 1, livingWork: 0, queuedWork: 0, missingWork: 1 };
    const first = requests.requestTechWorkForRoom(room, demand, { controllerGrowthFloor: true });
    const second = requests.requestTechWorkForRoom(room, demand, { controllerGrowthFloor: true });
    assert.strictEqual(first.requested, 1);
    assert.strictEqual(second.requested, 0);
    assert.strictEqual(Memory.rooms.W5N8.spawn.queue.length, 1);
    const queued = Memory.rooms.W5N8.spawn.queue[0];
    assert.strictEqual(queued.economyCategory, 'controllerGrowth');
    assert.strictEqual(queued.memory.controllerGrowthFloor, true);
    assert.ok(queued.body.includes(WORK));
    assert.ok(queued.body.includes(CARRY));
    assert.ok(queued.body.includes(MOVE));
    assert.ok(queued.body.reduce((sum, part) => sum + BODYPART_COST[part], 0) <= 300);
    assert.strictEqual(Memory.rooms.W5N8.spawn.governor.mandatoryFloorBypassUsed, true);
});

test('RECOVERY allows baseline growth but continues to reject surplus upgrading', () => {
    reset();
    const room = makeRoom();
    addRcl1CoreAtCap(room);
    refreshColony(room);
    const arbiter = fresh('Spawn.Arbiter.js');
    const result = arbiter.admit(room.name, {
        role: 'Tech', body: [WORK, CARRY, MOVE], economyCategory: 'upgradeSurplus',
        memory: { role: 'Tech', homeRoom: room.name }
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /RECOVERY|surplus/i);
});

test('a blocked optional Tech queue entry is promoted instead of hiding or duplicating the floor', () => {
    reset();
    const room = makeRoom();
    addRcl1CoreAtCap(room);
    const optional = {
        role: 'Tech', body: [WORK, CARRY, MOVE], economyCategory: 'upgradeSurplus',
        priority: 30, requestedAt: Game.time,
        memory: { role: 'Tech', homeRoom: room.name }
    };
    optional.requestId = fresh('Spawn.Arbiter.js').fingerprint(room.name, optional, 'legacy');
    optional.memory.requestId = optional.requestId;
    Memory.rooms[room.name].spawn.queue.push(optional);
    const colony = refreshColony(room);
    assert.strictEqual(colony.baselineTechRequired, true);
    const result = fresh('spawn.request.manager.js').requestTechWorkForRoom(room, {
        desiredWork: 1, livingWork: 0, queuedWork: 0, missingWork: 1
    }, { controllerGrowthFloor: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(Memory.rooms[room.name].spawn.queue.length, 1);
    assert.strictEqual(Memory.rooms[room.name].spawn.queue[0].memory.controllerGrowthFloor, true);
    assert.strictEqual(Memory.rooms[room.name].spawn.queue[0].economyCategory, 'controllerGrowth');
});

test('baseline growth is blocked during a true mining collapse or unreachable miner floor', () => {
    reset();
    const room = makeRoom();
    addCreep(room, 'foreman', 'Foreman', [CARRY, MOVE]);
    addCreep(room, 'freighter', 'Freighter', [CARRY, MOVE]);
    Memory.rooms[room.name].economy.harvest.workActive = 0;
    Memory.rooms[room.name].economy.state = 'SURVIVAL';
    Memory.rooms[room.name].economy.bootstrap.floorReachable = false;
    Memory.rooms[room.name].economy.bootstrap.unrecoverable = true;
    const colony = refreshColony(room);
    assert.strictEqual(colony.growthAllowed, false);
    assert.match(colony.blockedReason, /miner|energy floor/i);
    assert.strictEqual(colony.nextMandatoryRole, 'Extractor');
});

test('combat creeps do not consume the non-combat RCL1 governor cap', () => {
    reset();
    const room = makeRoom();
    addRcl1CoreAtCap(room);
    for (let i = 0; i < 3; i++) addCreep(room, `defender-${i}`, 'Volley', [RANGED_ATTACK, MOVE], {
        defenseRequest: true, defendedRoom: room.name
    });
    const context = fresh('Spawn.Context.js').snapshot(room.name);
    assert.strictEqual(context.total, 13);
    assert.strictEqual(context.nonCombatTotal, 10);
});

test('existing controller downgrade emergency remains admissible', () => {
    reset();
    const room = makeRoom();
    addRcl1CoreAtCap(room);
    room.controller.ticksToDowngrade = 4999;
    refreshColony(room);
    const result = fresh('spawn.request.manager.js').requestTechWorkForRoom(room, {
        desiredWork: 2, livingWork: 0, queuedWork: 0, missingWork: 2
    }, { emergency: true, bypassRoleCap: true });
    assert.strictEqual(result.requested, 1);
    assert.strictEqual(Memory.rooms.W5N8.spawn.queue[0].memory.controllerEmergency, true);
});

test('minimum-growth Tech can collect the protected spawn pile and upgrade during RECOVERY', () => {
    reset();
    const room = makeRoom();
    addRcl1CoreAtCap(room);
    refreshColony(room);
    const drop = {
        id: 'drop1', resourceType: RESOURCE_ENERGY, amount: 150,
        pos: new RoomPosition(23, 25, room.name)
    };
    const tech = addCreep(room, 'tech', 'Tech', [WORK, CARRY, MOVE], { controllerGrowthFloor: true });
    tech.pos.findClosestByPath = (kind, options) => kind === FIND_DROPPED_RESOURCES && options.filter(drop) ? drop : null;
    let picked = false;
    tech.pickup = target => { picked = target === drop; return OK; };
    const role = fresh('role.Tech.js');
    assert.strictEqual(role.getEnergyForTech(tech), true);
    assert.strictEqual(picked, true);

    tech.store = { [RESOURCE_ENERGY]: 50, getUsedCapacity: () => 50, getFreeCapacity: () => 0 };
    let upgraded = false;
    tech.upgradeController = target => { upgraded = target === room.controller; return OK; };
    role.run(tech);
    assert.strictEqual(upgraded, true);
});

test('protected stockpile energy is measured from the shared tick index scan', () => {
    reset();
    const room = makeRoom();
    const near = { resourceType: RESOURCE_ENERGY, amount: 150, pos: new RoomPosition(22, 25, room.name) };
    const far = { resourceType: RESOURCE_ENERGY, amount: 500, pos: new RoomPosition(10, 10, room.name) };
    room.find = kind => kind === FIND_DROPPED_RESOURCES ? [near, far] : [];
    delete global.__sushiTickIndex;
    assert.strictEqual(fresh('HiveMind.Economy.js').protectedSpawnStockpileEnergy(room), 150);
});

test('minimum Freighter is the final core floor before baseline Tech growth', () => {
    reset();
    const room = makeRoom();
    addCreep(room, 'foreman', 'Foreman', [CARRY, MOVE]);
    addCreep(room, 'extractor-a', 'Extractor', [WORK, WORK, MOVE]);
    addCreep(room, 'extractor-b', 'Extractor', [WORK, WORK, MOVE]);
    const colony = refreshColony(room);
    assert.strictEqual(colony.nextMandatoryRole, 'Freighter');
    assert.strictEqual(colony.baselineTechRequired, false);
    assert.match(colony.blockedReason, /logistics/i);
});

test('zero-miner collapse queues an affordable Extractor ahead of Foreman or Tech', () => {
    reset();
    const room = makeRoom();
    Memory.rooms[room.name].economy.state = 'SURVIVAL';
    Memory.rooms[room.name].economy.harvest.workActive = 0;
    Memory.rooms[room.name].economy.bootstrap.floorReachable = false;
    Memory.rooms[room.name].economy.bootstrap.unrecoverable = true;
    refreshColony(room);
    const report = fresh('spawn.request.manager.js').runForRoom(room);
    assert.strictEqual(report.ok, true);
    assert.ok(Memory.rooms[room.name].spawn.queue.length >= 1);
    assert.strictEqual(Memory.rooms[room.name].spawn.queue[0].role, 'Extractor');
    assert.ok(Memory.rooms[room.name].spawn.queue[0].body.reduce((sum, part) => sum + BODYPART_COST[part], 0) <= 300);
    assert.strictEqual(Memory.rooms[room.name].spawn.queue.some(request => request.role === 'Tech'), false);
});

test('funded zero-miner startup keeps Foreman first when the Extractor floor is recoverable', () => {
    reset();
    const room = makeRoom();
    Memory.rooms[room.name].economy.state = 'SURVIVAL';
    Memory.rooms[room.name].economy.harvest.workActive = 0;
    Memory.rooms[room.name].economy.bootstrap.floorReachable = true;
    Memory.rooms[room.name].economy.bootstrap.unrecoverable = false;
    refreshColony(room);
    fresh('spawn.request.manager.js').runForRoom(room);
    assert.strictEqual(Memory.rooms[room.name].spawn.queue[0].role, 'Foreman');
});

test('siege alert pauses baseline growth while owned-room defense remains policy-exempt', () => {
    reset();
    const room = makeRoom();
    addRcl1CoreAtCap(room);
    fresh('HiveMind.Memory.js').ensure().threats[room.name] = {
        harmfulHostileCount: 2, totalThreat: 1200, emergency: true
    };
    const colony = refreshColony(room);
    assert.strictEqual(colony.alert, 'SIEGE');
    assert.strictEqual(colony.growthAllowed, false);
    assert.match(colony.blockedReason, /defense/i);
});

console.log(`Controller-growth regression tests passed: ${passed}`);
