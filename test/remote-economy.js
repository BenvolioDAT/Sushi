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
    global.BODYPART_COST = { [WORK]: 100, [CARRY]: 50, [MOVE]: 50, [CLAIM]: 600 };
    global.CREEP_LIFE_TIME = 1500;
    global.HARVEST_POWER = 2;
    global.CARRY_CAPACITY = 50;
    global.SOURCE_ENERGY_CAPACITY = 3000;
    global.SOURCE_ENERGY_KEEPER_CAPACITY = 4000;
    global.ENERGY_REGEN_TIME = 300;
}

function home(name, level, capacity) {
    const room = {
        name, energyAvailable: capacity, energyCapacityAvailable: capacity,
        controller: { my: true, level, ticksToDowngrade: 16000, pos: new RoomPosition(25, 25, name) },
        _spawns: [],
        find(kind) { return kind === FIND_MY_SPAWNS ? this._spawns : []; }
    };
    const spawn = { id: 'spawn-' + name, name: 'Spawn-' + name, my: true,
        owner: { username: 'me' }, room, pos: new RoomPosition(24, 25, name), spawning: null };
    room._spawns.push(spawn);
    Game.rooms[name] = room;
    Game.spawns[spawn.name] = spawn;
    Memory.rooms[name] = { spawn: { queue: [] } };
    return room;
}

function economy(state, localHealthy = true) {
    return {
        state, replacementRisk: 0,
        harvest: { workActive: localHealthy ? 5 : 0, workRequired: 5 },
        haul: { localCarry: 10, requiredCarry: 5 },
        growth: { spawnPressure: 0, energyAboveReserve: 200, controllerBudget: 3,
            remote: { backlog: 0, reservedCarry: 0, requiredCarry: 0,
                availableCarry: 10, activeSources: 0, provenSources: 0 } }
    };
}

function sourceInfo(id, roomName, active = false) {
    return { sourceId: id, roomName, parentRoomName: 'W1N1', parentHome: 'W1N1',
        active, state: active ? 'ACTIVE' : 'PLANNED', grossEnergyPerTick: 10,
        effectiveEnergyPerTick: 5, distance: 40, numOpen: 1, risk: 0, score: 4,
        roadCoords: { W1N1: [1275, 1276], [roomName]: [510, 511] } };
}

function installRemote(id = 'remote', roomName = 'W1N2', active = false) {
    const info = sourceInfo(id, roomName, active);
    Memory.rooms.W1N1.remotePlanner = { pathVersion: 1,
        activeSourceIds: active ? [id] : [], remotes: {}, sourceInfos: { [id]: info } };
    Memory.rooms[roomName] = { controller: {}, sources: {
        [id]: { id, pos: { x: 10, y: 10, roomName }, containerPlanned: true,
            haul: { targetId: 'container-' + id, targetType: 'container', amount: 500,
                capacity: 2000, lastSeen: Game.time } }
    } };
    return info;
}

function test(name, fn) {
    fn();
    console.log('PASS ' + name);
}

test('1 first remote can bootstrap during RECOVERY with healthy local mining', () => {
    reset();
    home('W1N1', 2, 550);
    Game.map.describeExits = name => name === 'W1N1' ? { 1: 'W1N2' } : { 5: 'W1N1' };
    Memory.rooms.W1N1.economy = economy('RECOVERY');
    installRemote();
    const planner = fresh('Planner.Remote.js');
    planner.selectActiveSources('W1N1');
    assert.deepStrictEqual(Memory.rooms.W1N1.remotePlanner.activeSourceIds, ['remote']);
    assert.strictEqual(Memory.rooms.W1N1.remotePlanner.lastDecision.category, 'remoteBootstrap');
});

test('2 low RCL remote cap follows affordable economics instead of an RCL2 lock', () => {
    reset();
    const room = home('W1N1', 1, 300);
    assert.strictEqual(fresh('Planner.Remote.js').getEffectiveRemoteSourceCap(room, economy('STABLE')), 1);
    room.energyCapacityAvailable = 200;
    assert.strictEqual(fresh('Planner.Remote.js').getEffectiveRemoteSourceCap(room, economy('STABLE')), 0);
});

test('3 established remote remains active across STABLE to healthy RECOVERY', () => {
    reset();
    home('W1N1', 2, 550);
    Game.map.describeExits = name => name === 'W1N1' ? { 1: 'W1N2' } : { 5: 'W1N1' };
    Memory.rooms.W1N1.economy = economy('RECOVERY');
    installRemote('remote', 'W1N2', true);
    const planner = fresh('Planner.Remote.js');
    planner.selectActiveSources('W1N1');
    assert.deepStrictEqual(Memory.rooms.W1N1.remotePlanner.activeSourceIds, ['remote']);
    assert.strictEqual(Memory.rooms.W1N1.remotePlanner.sourceInfos.remote.active, true);
});

test('4 true SURVIVAL suspends but preserves remote portfolio and route data', () => {
    reset();
    home('W1N1', 2, 550);
    Memory.rooms.W1N1.economy = economy('SURVIVAL', false);
    installRemote('remote', 'W1N2', true);
    fresh('Planner.Remote.js').selectActiveSources('W1N1');
    const remote = Memory.rooms.W1N1.remotePlanner;
    assert.deepStrictEqual(remote.activeSourceIds, ['remote']);
    assert.strictEqual(remote.sourceInfos.remote.active, false);
    assert.strictEqual(remote.sourceInfos.remote.state, 'SUSPENDED_ECONOMY');
    assert.ok(remote.sourceInfos.remote.roadCoords);
});

test('5 predictive dispatch leaves before a 1300/2000 container fills', () => {
    reset();
    const predict = fresh('role.Freighter.js')._test.predictRemotePickup;
    const result = predict({ effectiveEnergyPerTick: 10, distance: 55 },
        { amount: 1300, capacity: 2000, targetType: 'container' },
        { store: { getFreeCapacity: () => 1000 } }, 0);
    assert.strictEqual(result.ticksToFull, 70);
    assert.strictEqual(result.shouldDispatch, true);
});

test('6 future energy at arrival makes a long trip worthwhile', () => {
    reset();
    const predict = fresh('role.Freighter.js')._test.predictRemotePickup;
    const result = predict({ effectiveEnergyPerTick: 10, distance: 120 },
        { amount: 500, capacity: 2000, targetType: 'container' },
        { store: { getFreeCapacity: () => 1000 } }, 0);
    assert.strictEqual(result.projectedEnergyAtArrival, 1700);
    assert.strictEqual(result.shouldDispatch, true);
});

test('7 projected supply subtracts existing inbound reservations', () => {
    reset();
    const predict = fresh('role.Freighter.js')._test.predictRemotePickup;
    const result = predict({ effectiveEnergyPerTick: 10, distance: 120 },
        { amount: 500, capacity: 2000, targetType: 'container' },
        { store: { getFreeCapacity: () => 1000 } }, 1000);
    assert.strictEqual(result.projectedEnergyAtArrival, 1700);
    assert.strictEqual(result.unreservedProjectedEnergy, 700);
});

test('8 valid packed route is decoded once and reused from heap', () => {
    reset();
    home('W1N1', 2, 550);
    installRemote('remote', 'W1N2', true);
    const planner = fresh('Planner.Remote.js');
    const first = planner.getRemotePath('W1N1', 'remote');
    Memory.rooms.W1N1.remotePlanner.sourceInfos.remote.roadCoords = { W1N1: [1] };
    const second = planner.getRemotePath('W1N1', 'remote');
    assert.strictEqual(second, first);
    assert.strictEqual(second.length, 4);
});

test('9 reverse route selects the previous canonical lane coordinate', () => {
    reset();
    home('W1N1', 2, 550);
    installRemote('remote', 'W1N2', true);
    const travel = fresh('utility.Travel.Creep.js');
    let movedTo = null;
    travel.move = (creep, target) => { movedTo = target; return OK; };
    const planner = fresh('Planner.Remote.js');
    const creep = { pos: new RoomPosition(11, 10, 'W1N2') };
    assert.strictEqual(planner.moveFreighterAlongRemotePath(creep, 'W1N1', 'remote', true), true);
    assert.strictEqual(movedTo.x, 10);
    assert.strictEqual(movedTo.y, 10);
});

test('10 separate home portfolios retain authoritative parentHome', () => {
    reset();
    home('W1N1', 2, 550);
    home('W2N2', 2, 550);
    Memory.rooms.W1N1.economy = economy('STABLE');
    Memory.rooms.W2N2.economy = economy('STABLE');
    installRemote('a', 'W1N2', true);
    Memory.rooms.W2N2.remotePlanner = { pathVersion: 1, activeSourceIds: ['b'], remotes: {},
        sourceInfos: { b: { ...sourceInfo('b', 'W2N3', true), parentRoomName: 'W2N2', parentHome: 'W2N2' } } };
    const planner = fresh('Planner.Remote.js');
    planner.ensurePlannerMemory('W1N1');
    planner.ensurePlannerMemory('W2N2');
    assert.strictEqual(Memory.rooms.W1N1.remotePlanner.sourceInfos.a.parentHome, 'W1N1');
    assert.strictEqual(Memory.rooms.W2N2.remotePlanner.sourceInfos.b.parentHome, 'W2N2');
});

test('11 memory migration preserves source, ownership and portfolio data', () => {
    reset();
    home('W1N1', 2, 550);
    installRemote('remote', 'W1N2', true);
    Memory.rooms.W1N1.remotePlanner.pathVersion = 0;
    Memory.rooms.W1N1.remotePlanner.remotes.W1N2 = { status: 'candidate' };
    const migrated = fresh('Planner.Remote.js').ensurePlannerMemory('W1N1');
    assert.deepStrictEqual(migrated.activeSourceIds, ['remote']);
    assert.ok(migrated.sourceInfos.remote);
    assert.ok(migrated.remotes.W1N2);
    assert.strictEqual(migrated.sourceInfos.remote.parentHome, 'W1N1');
    assert.strictEqual(migrated.sourceInfos.remote.routeInvalidReason, 'path version changed');
});

console.log('Remote economy regression tests passed.');
