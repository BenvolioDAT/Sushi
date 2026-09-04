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
    global.BODYPART_COST = { [WORK]: 100, [CARRY]: 50, [MOVE]: 50 };
    global.CREEP_LIFE_TIME = 1500;
    global.HARVEST_POWER = 2;
    global.CARRY_CAPACITY = 50;
    global.SOURCE_ENERGY_CAPACITY = 3000;
    global.SOURCE_ENERGY_KEEPER_CAPACITY = 4000;
    global.ENERGY_REGEN_TIME = 300;
    global.TERRAIN_MASK_SWAMP = 2;
    global.OBSTACLE_OBJECT_TYPES = [STRUCTURE_SPAWN, STRUCTURE_EXTENSION, STRUCTURE_WALL];
    Memory.config = { remote: { maxRoomRange: 2, allowKeeperRooms: false, routeValidationInterval: 251 } };
}

function room(name, level = 0) {
    const value = {
        name, energyAvailable: 550, energyCapacityAvailable: 550, _structures: [], _hostiles: [],
        controller: level ? { my: true, level, ticksToDowngrade: 16000,
            pos: new RoomPosition(25, 25, name) } : null,
        find(kind, options) {
            let values = [];
            if (kind === FIND_STRUCTURES || kind === FIND_HOSTILE_STRUCTURES) values = this._structures;
            else if (kind === FIND_HOSTILE_CREEPS) values = this._hostiles;
            else if (kind === FIND_MY_SPAWNS) values = this._spawns || [];
            return options && options.filter ? values.filter(options.filter) : values;
        }
    };
    Game.rooms[name] = value;
    Memory.rooms[name] = Memory.rooms[name] || {};
    return value;
}

function home() {
    const value = room('W1N1', 3);
    const spawn = { id: 'spawn', name: 'Spawn1', my: true, owner: { username: 'me' }, room: value,
        structureType: STRUCTURE_SPAWN, pos: new RoomPosition(25, 25, value.name), spawning: null };
    value._spawns = [spawn];
    Game.spawns.Spawn1 = spawn;
    Memory.rooms.W1N1.spawn = { queue: [] };
    Memory.rooms.W1N1.economy = { state: 'STABLE', harvest: { workActive: 5, workRequired: 5 },
        haul: { localCarry: 10, requiredCarry: 5 }, growth: { spawnPressure: 0,
            energyAboveReserve: 300, controllerBudget: 5, remote: { backlog: 0,
                reservedCarry: 0, requiredCarry: 0, availableCarry: 10 } } };
    return value;
}

function routeInfo() {
    const segments = [
        { room: 'W1N1', coords: [1275, 1276] },
        { room: 'W1N2', coords: [510, 511] }
    ];
    return { sourceId: 'remote', roomName: 'W1N2', parentRoomName: 'W1N1', parentHome: 'W1N1',
        active: true, state: 'ACTIVE', numOpen: 1, distance: 4, containerCoord: 511,
        grossEnergyPerTick: 10, effectiveEnergyPerTick: 10, netIncome: 8, score: 8, risk: 0,
        roadCoords: { W1N1: [1275, 1276], W1N2: [510, 511] },
        route: { version: 1, valid: true, calculatedAt: Game.time, lastValidatedAt: 0,
            length: 4, targetCoord: 511, terrain: { road: 0, plain: 4, swamp: 0 },
            segments, roomSequence: ['W1N1', 'W1N2'] } };
}

function installRoute() {
    home();
    room('W1N2');
    const info = routeInfo();
    Memory.rooms.W1N1.remotePlanner = { pathVersion: 1, activeSourceIds: ['remote'], remotes: {},
        sourceInfos: { remote: info } };
    Memory.rooms.W1N2.sources = { remote: { id: 'remote', pos: { x: 12, y: 10, roomName: 'W1N2' } } };
    return info;
}

function test(name, fn) { fn(); console.log('PASS ' + name); }

test('1 permanent structure invalidates a canonical route', () => {
    reset();
    const info = installRoute();
    Game.rooms.W1N2._structures.push({ structureType: STRUCTURE_SPAWN, my: false,
        pos: new RoomPosition(10, 10, 'W1N2') });
    const result = fresh('Planner.Remote.js').validateRemoteRoute('W1N1', 'remote', true);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(info.route.invalidReason, 'BLOCKED_STRUCTURE');
    assert.notStrictEqual(info.route.lastValidatedAt, Game.time);
});

test('2 temporary creep occupancy does not invalidate the route', () => {
    reset();
    const info = installRoute();
    Game.creeps.blocker = { pos: new RoomPosition(10, 10, 'W1N2'), memory: {} };
    const result = fresh('Planner.Remote.js').validateRemoteRoute('W1N1', 'remote', true);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(info.route.lastValidatedAt, Game.time);
});

test('3 swamp route has a longer model ETA than equal road route', () => {
    reset();
    const planner = fresh('Planner.Remote.js');
    const body = [CARRY, CARRY, MOVE];
    const road = planner.estimateRouteTravelTicks({ length: 10, terrain: { road: 10, plain: 0, swamp: 0 } }, body, true);
    const swamp = planner.estimateRouteTravelTicks({ length: 10, terrain: { road: 0, plain: 0, swamp: 10 } }, body, true);
    assert.ok(swamp > road);
});

test('4 poor MOVE balance increases modeled travel time', () => {
    reset();
    const planner = fresh('Planner.Remote.js');
    const route = { length: 10, terrain: { road: 0, plain: 10, swamp: 0 } };
    const mobile = planner.estimateRouteTravelTicks(route, [CARRY, CARRY, MOVE, MOVE], true);
    const poor = planner.estimateRouteTravelTicks(route, [CARRY, CARRY, CARRY, CARRY, MOVE], true);
    assert.ok(poor > mobile);
});

test('5 empty outbound and loaded return estimates differ', () => {
    reset();
    const planner = fresh('Planner.Remote.js');
    const route = { length: 10, terrain: { road: 0, plain: 10, swamp: 0 } };
    assert.ok(planner.estimateRouteTravelTicks(route, [CARRY, CARRY, MOVE], true) >
        planner.estimateRouteTravelTicks(route, [CARRY, CARRY, MOVE], false));
});

test('6 observed slow trips increase blended ETA', () => {
    reset();
    const info = installRoute();
    const planner = fresh('Planner.Remote.js');
    const creep = { memory: { homeRoom: 'W1N1' } };
    const before = planner.getRouteTravelEstimate(info, [CARRY, CARRY, MOVE], true).roundTripTicks;
    for (let i = 0; i < 5; i++) {
        planner.startRemoteTrip(creep, info);
        Game.time += 40;
        planner.recordRemoteTripLeg(creep, 'OUTBOUND');
        Game.time += 50;
        planner.recordRemoteTripLeg(creep, 'RETURN');
    }
    const after = planner.getRouteTravelEstimate(info, [CARRY, CARRY, MOVE], true).roundTripTicks;
    assert.ok(after > before);
    assert.strictEqual(info.route.travelSamples, 5);
});

test('7 completed roads decay stale observed timing weight', () => {
    reset();
    const info = installRoute();
    info.route.travelSamples = 10;
    info.route.outboundSamples = 10;
    info.route.returnSamples = 10;
    for (const segment of info.route.segments) {
        for (const packed of segment.coords) {
            const x = packed % 50;
            const y = Math.floor(packed / 50);
            Game.rooms[segment.room]._structures.push({ structureType: STRUCTURE_ROAD,
                pos: new RoomPosition(x, y, segment.room) });
        }
    }
    fresh('Planner.Remote.js').validateRemoteRoute('W1N1', 'remote', true);
    assert.strictEqual(info.route.terrain.road, 4);
    assert.strictEqual(info.route.travelSamples, 5);
    assert.strictEqual(info.route.observationDecayedAt, Game.time);
});

test('8 safe profitable second-ring room can be planned', () => {
    reset();
    home();
    room('W1N2');
    const remote = room('W1N3');
    Game.map.getRoomLinearDistance = (a, b) => b === 'W1N3' ? 2 : 1;
    Game.map.getRoomTerrain = () => ({ get: () => 0 });
    Memory.rooms.W1N3.sources = { second: { id: 'second', seatCount: 1,
        pos: { x: 10, y: 10, roomName: 'W1N3' } } };
    PathFinder.search = () => ({ incomplete: false, path: [
        new RoomPosition(26, 25, 'W1N1'), new RoomPosition(25, 25, 'W1N2'),
        new RoomPosition(25, 24, 'W1N2'), new RoomPosition(10, 11, 'W1N3')
    ] });
    const planner = fresh('Planner.Remote.js');
    assert.strictEqual(planner.generateRemotePlan('W1N1', remote), true);
    assert.ok(Memory.rooms.W1N1.remotePlanner.sourceInfos.second);
    assert.deepStrictEqual(Memory.rooms.W1N1.remotePlanner.sourceInfos.second.route.roomSequence,
        ['W1N1', 'W1N2', 'W1N3']);
});

test('9 hostile transit makes a second-ring source uneconomic', () => {
    reset();
    home();
    room('W1N2');
    const remote = room('W1N3');
    Memory.rooms.W1N2.controller = { owner: 'enemy' };
    Game.map.getRoomLinearDistance = (a, b) => b === 'W1N3' ? 2 : 1;
    Game.map.getRoomTerrain = () => ({ get: () => 0 });
    Memory.rooms.W1N3.sources = { second: { id: 'second', seatCount: 1,
        pos: { x: 10, y: 10, roomName: 'W1N3' } } };
    PathFinder.search = () => ({ incomplete: false, path: [new RoomPosition(25, 25, 'W1N2'),
        new RoomPosition(10, 11, 'W1N3')] });
    const planner = fresh('Planner.Remote.js');
    planner.generateRemotePlan('W1N1', remote);
    assert.ok(Memory.rooms.W1N1.remotePlanner.sourceInfos.second.score < 0);
    assert.strictEqual(planner.validateRemoteRoute('W1N1', 'second', true).reason, 'HOSTILE_TRANSIT_ROOM');
});

test('10 configured range rejects farther remote rooms', () => {
    reset();
    Game.map.getRoomLinearDistance = () => 3;
    assert.strictEqual(fresh('Planner.Remote.js').isWithinRemoteRange('W1N1', 'W1N4'), false);
});

test('11 delivery honors destinationRoom without changing home ownership', () => {
    reset();
    home();
    let movedRoom = null;
    const travel = fresh('utility.Travel.Creep.js');
    travel.moveToRoom = (creep, destination) => { movedRoom = destination; return OK; };
    const role = fresh('role.Freighter.js');
    const creep = { room: { name: 'W1N1' }, memory: { homeRoom: 'W1N1', destinationRoom: 'W5N5',
        remoteDeliverySourceId: 'remote', freighterJob: 'remoteDelivery' }, store: { [RESOURCE_ENERGY]: 100 } };
    role._test.deliverRemoteEnergy(creep);
    assert.strictEqual(movedRoom, 'W5N5');
    assert.strictEqual(creep.memory.homeRoom, 'W1N1');
});

test('12 normal remote destination defaults to homeRoom', () => {
    reset();
    assert.strictEqual(fresh('Planner.Remote.js').getLogisticsDestinationRoom(
        { memory: { homeRoom: 'W1N1' } }), 'W1N1');
});

test('13 cleanup removes transient logistics fields but preserves homeRoom', () => {
    reset();
    const creep = { name: 'haul', memory: { homeRoom: 'W1N1', role: 'Freighter',
        freighterJob: 'remoteDelivery', destinationRoom: 'W5N5', logisticsPurpose: 'FOB_SUPPLY',
        remoteTrip: { departureTick: 1 } } };
    fresh('Planner.Remote.js').clearRemoteFreighterMemory(creep);
    assert.strictEqual(creep.memory.homeRoom, 'W1N1');
    assert.strictEqual(creep.memory.destinationRoom, undefined);
    assert.strictEqual(creep.memory.logisticsPurpose, undefined);
    assert.strictEqual(creep.memory.remoteTrip, undefined);
});

test('14 exact multi-room route reverses into the prior transit segment', () => {
    reset();
    const info = installRoute();
    info.roomName = 'W1N3';
    info.containerCoord = 511;
    info.roadCoords = { W1N1: [1275], W1N2: [1275], W1N3: [510, 511] };
    info.route = { version: 1, valid: true, lastValidatedAt: Game.time, length: 4,
        targetCoord: 511, terrain: { road: 0, plain: 4, swamp: 0 }, roomSequence: ['W1N1', 'W1N2', 'W1N3'],
        segments: [{ room: 'W1N1', coords: [1275] }, { room: 'W1N2', coords: [1275] },
            { room: 'W1N3', coords: [510, 511] }] };
    Game.map.getRoomLinearDistance = () => 2;
    const travel = fresh('utility.Travel.Creep.js');
    let target = null;
    travel.move = (creep, destination) => { target = destination; return OK; };
    const planner = fresh('Planner.Remote.js');
    planner.moveFreighterAlongRemotePath({ pos: new RoomPosition(10, 10, 'W1N3') }, 'W1N1', 'remote', true);
    assert.strictEqual(target.roomName, 'W1N2');
});

test('15 long variable route dispatches earlier than a short stable route', () => {
    reset();
    const predict = fresh('role.Freighter.js')._test.predictRemotePickup;
    const haul = { amount: 100, capacity: 2000, targetType: 'container' };
    const creep = { store: { getFreeCapacity: () => 1000 } };
    const short = predict({ effectiveEnergyPerTick: 10, distance: 10,
        route: { length: 10, terrain: { road: 10 }, travelSamples: 10, travelDeviation: 0 } }, haul, creep, 0, 0);
    const long = predict({ effectiveEnergyPerTick: 10, distance: 100,
        route: { length: 100, terrain: { swamp: 50, plain: 50 }, travelSamples: 5,
            travelDeviation: 30 } }, haul, creep, 0, 0);
    assert.strictEqual(short.shouldDispatch, false);
    assert.strictEqual(long.shouldDispatch, true);
    assert.ok(long.dispatchSafetyTicks > short.dispatchSafetyTicks);
});

test('16 explicit FOB transport job retains ownership and assigns generic endpoints', () => {
    reset();
    const creep = { memory: { role: 'Freighter', homeRoom: 'W1N1' } };
    assert.strictEqual(fresh('Logistics.Jobs.js').assign(creep, { originRoom: 'W1N1',
        destinationRoom: 'W5N5', resourceType: RESOURCE_ENERGY, amount: 1000,
        purpose: 'FOB_SUPPLY', priority: 50 }), true);
    assert.strictEqual(creep.memory.homeRoom, 'W1N1');
    assert.strictEqual(creep.memory.destinationRoom, 'W5N5');
    assert.strictEqual(creep.memory.freighterJob, 'transport');
});

test('17 explicit FOB transport job is consumed from origin through destination cleanup', () => {
    reset();
    const origin = home();
    const destination = room('W5N5', 3);
    const originStore = { [RESOURCE_ENERGY]: 1000 };
    originStore.getFreeCapacity = () => 0;
    origin.storage = { id: 'origin-storage', store: originStore, pos: new RoomPosition(20, 20, origin.name) };
    const destinationStore = { [RESOURCE_ENERGY]: 0, getFreeCapacity: () => 10000 };
    destination.storage = { id: 'destination-storage', store: destinationStore,
        pos: new RoomPosition(20, 20, destination.name) };
    const carried = { [RESOURCE_ENERGY]: 0, getFreeCapacity: () => 100 - carried[RESOURCE_ENERGY] };
    const creep = { memory: { role: 'Freighter', homeRoom: 'W1N1' }, room: origin,
        store: carried, withdraw(target, resource, amount) {
            carried[resource] += amount; target.store[resource] -= amount; return OK;
        }, transfer(target, resource) {
            target.store[resource] += carried[resource]; carried[resource] = 0; return OK;
        } };
    const jobs = fresh('Logistics.Jobs.js');
    jobs.assign(creep, { originRoom: 'W1N1', destinationRoom: 'W5N5', amount: 100,
        resourceType: RESOURCE_ENERGY, purpose: 'FOB_SUPPLY' });
    const role = fresh('role.Freighter.js');
    role._test.collectTransportJob(creep);
    assert.strictEqual(creep.memory.freighterJob, 'transportDelivery');
    creep.room = destination;
    role._test.deliverTransportJob(creep);
    assert.strictEqual(destinationStore[RESOURCE_ENERGY], 100);
    assert.strictEqual(creep.memory.freighterJob, undefined);
    assert.strictEqual(creep.memory.homeRoom, 'W1N1');
});

console.log('Remote route and logistics regression tests passed.');
