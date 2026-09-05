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

function prepareReplan() {
    reset();
    const info = installRoute();
    Memory.rooms.W1N2.sources.remote.seatCount = 1;
    Memory.rooms.W1N2.sources.remote.containerPlannedPos = { x: 11, y: 10, roomName: 'W1N2' };
    PathFinder.search = () => ({ incomplete: false, path: info.route.segments.flatMap(segment =>
        segment.coords.map(coord => new RoomPosition(coord % 50, Math.floor(coord / 50), segment.room))) });
    fresh('utility.js').planSourceContainers = () => {};
    return { info, planner: fresh('Planner.Remote.js') };
}

test('A/B established RECOVERY replan preserves lifecycle, ownership, history and calibration', () => {
    const { info, planner } = prepareReplan();
    Memory.rooms.W1N1.economy.state = 'RECOVERY';
    const economy = require('HiveMind.Economy');
    const original = economy.checkSpend;
    const categories = [];
    economy.checkSpend = (home, category) => {
        if (new Error().stack.includes('shouldUseRemoteSource')) categories.push(category);
        return original(home, category);
    };
    assert.strictEqual(economy.checkSpend('W1N1', 'remoteMaintenance').allowed, true);
    assert.strictEqual(economy.checkSpend('W1N1', 'remoteExpansion').allowed, false);
    info.lastParentChangeAt = 0;
    info.telemetry = { delivered: 12000, lastPickup: 10, lastDelivery: 20 };
    Object.assign(info.route, { observedOutboundTicks: 20, observedReturnTicks: 30,
        observedRoundTripTicks: 50, travelSamples: 10, outboundSamples: 10, returnSamples: 10,
        travelDeviation: 3, lastObservedAt: 1 });
    const path = planner.getRemotePath('W1N1', 'remote');
    const revision = info.route.revision;
    assert.strictEqual(planner.generateRemotePlan('W1N1', Game.rooms.W1N2), true);
    assert.strictEqual(Memory.rooms.W1N1.remotePlanner.sourceInfos.remote, info);
    assert.strictEqual(info.active, true);
    assert.strictEqual(info.state, 'ACTIVE');
    assert.deepStrictEqual(Memory.rooms.W1N1.remotePlanner.activeSourceIds, ['remote']);
    assert.ok(categories.length && categories.every(category => category === 'remoteMaintenance'));
    assert.strictEqual(info.lastParentChangeAt, 0);
    assert.strictEqual(info.telemetry.delivered, 12000);
    assert.strictEqual(info.telemetry.lastPickup, 10);
    assert.strictEqual(info.telemetry.lastDelivery, 20);
    assert.strictEqual(info.route.travelSamples, 10);
    assert.strictEqual(info.route.observedRoundTripTicks, 50);
    assert.strictEqual(info.route.revision, revision);
    assert.strictEqual(planner.getRemotePath('W1N1', 'remote'), path);
});

test('C/D changed geometry invalidates heap and ignores old in-flight timing', () => {
    const { info, planner } = prepareReplan();
    const oldPath = planner.getRemotePath('W1N1', 'remote');
    const creep = { memory: { role: 'Freighter', homeRoom: 'W1N1' }, pos: oldPath[0] };
    planner.startRemoteTrip(creep, info);
    const oldRevision = info.route.revision;
    info.route.travelSamples = 10;
    info.route.observedOutboundTicks = 50;
    PathFinder.search = () => ({ incomplete: false, path: [oldPath[0], new RoomPosition(27, 25, 'W1N1'), ...oldPath.slice(2)] });
    planner.generateRemotePlan('W1N1', Game.rooms.W1N2);
    assert.strictEqual(info.route.revision, oldRevision + 1);
    assert.strictEqual(info.route.travelSamples, undefined);
    assert.strictEqual(info.route.observedOutboundTicks, undefined);
    const newPath = planner.getRemotePath('W1N1', 'remote');
    assert.notStrictEqual(newPath, oldPath);
    assert.strictEqual(newPath[1].x, 27);
    creep.pos = oldPath[oldPath.length - 1];
    Game.time += 20;
    assert.strictEqual(planner.recordRemoteTripLeg(creep, 'OUTBOUND'), false);
    assert.strictEqual(info.route.outboundSamples, undefined);
});

function movementSetup(role) {
    reset();
    const info = installRoute();
    const moves = [];
    const travel = fresh('utility.Travel.Creep.js');
    travel.move = (creep, target) => { moves.push(target.pos || target); return OK; };
    travel.moveToRoom = () => { throw Error('canonical lane bypassed'); };
    const creep = { name: 'traveler', memory: { role, homeRoom: 'W1N1', pickupRoom: 'W1N2',
        pickupSourceId: 'remote', pickupTargetId: 'container', freighterJob: 'remote' },
        room: Game.rooms.W1N1, pos: new RoomPosition(25, 25, 'W1N1'),
        store: { energy: 0, getFreeCapacity: () => 100 } };
    Game.getObjectById = id => id === 'container' ? { id, store: { energy: 1000 },
        pos: new RoomPosition(11, 10, 'W1N2') } : id === 'remote' ? { id, pos: new RoomPosition(12, 10, 'W1N2') } : null;
    return { info, moves, creep, planner: fresh('Planner.Remote.js') };
}

test('E visible Freighter pickup still follows the canonical HOME lane', () => {
    const { creep, moves } = movementSetup('Freighter');
    creep.withdraw = () => { throw Error('pickup before endpoint'); };
    fresh('role.Freighter.js')._test.handleRemoteCollection(creep);
    assert.strictEqual(moves[0].roomName, 'W1N1');
    assert.strictEqual(moves[0].x, 26);
});

test('F visible source Extractor still follows the canonical HOME lane', () => {
    const { creep, moves } = movementSetup('Extractor');
    creep.memory.remoteMining = true;
    creep.memory.sourceId = 'remote';
    fresh('role.Extractor.js').run(creep);
    assert.strictEqual(moves[0].roomName, 'W1N1');
    assert.strictEqual(moves[0].x, 26);
});

test('G return continues inside HOME and timing ends only at anchor', () => {
    const { creep, moves, planner, info } = movementSetup('Freighter');
    planner.startRemoteTrip(creep, info);
    creep.pos = new RoomPosition(11, 10, 'W1N2');
    Game.time += 20;
    planner.recordRemoteTripLeg(creep, 'OUTBOUND');
    Game.time += 7; // Waiting for cargo must not enter the return sample.
    planner.moveFreighterAlongRemotePath(creep, 'W1N1', 'remote', true);
    const departed = Game.time;
    creep.memory.remoteDeliverySourceId = 'remote';
    creep.memory.freighterJob = 'remoteDelivery';
    creep.store.energy = 100;
    creep.pos = new RoomPosition(26, 25, 'W1N1');
    Game.time += 10;
    fresh('role.Freighter.js')._test.deliverRemoteEnergy(creep);
    assert.strictEqual(moves[moves.length - 1].x, 25);
    assert.strictEqual(info.route.returnSamples, undefined);
    creep.pos = new RoomPosition(25, 25, 'W1N1');
    Game.time++;
    assert.strictEqual(planner.moveFreighterAlongRemotePath(creep, 'W1N1', 'remote', true), false);
    assert.strictEqual(info.route.observedReturnTicks, Game.time - departed);
    assert.strictEqual(info.route.observedOutboundTicks, 20);
    assert.strictEqual(info.route.travelSamples, 1);
    // Delivery tails must not re-enter the canonical leg.
    creep.pos = new RoomPosition(30, 25, 'W1N1');
    assert.strictEqual(planner.moveFreighterAlongRemotePath(creep, 'W1N1', 'remote', true), false);
});

test('H planner validates two due routes per tick and shares visible structure scans', () => {
    reset();
    installRoute();
    const memory = Memory.rooms.W1N1.remotePlanner;
    for (let i = 1; i < 5; i++) {
        memory.sourceInfos['remote' + i] = JSON.parse(JSON.stringify(memory.sourceInfos.remote));
        memory.sourceInfos['remote' + i].sourceId = 'remote' + i;
    }
    Game.time = 1001;
    let scans = 0;
    for (const room of Object.values(Game.rooms)) {
        const find = room.find;
        room.find = function(kind, options) { if (kind === FIND_STRUCTURES) scans++; return find.call(this, kind, options); };
    }
    const planner = fresh('Planner.Remote.js');
    planner.run();
    assert.strictEqual(Object.values(memory.sourceInfos).filter(info => info.route.lastValidatedAt === Game.time).length, 2);
    assert.strictEqual(scans, 2);
    Game.time++;
    planner.run();
    assert.strictEqual(Object.values(memory.sourceInfos).filter(info => info.route.lastValidatedAt === Game.time).length, 2);
    Game.time++;
    planner.run();
    assert.ok(Object.values(memory.sourceInfos).every(info => info.route.lastValidatedAt >= 1001));
});

test('endpoint changes make a recently validated route due without a role path read', () => {
    const { info, planner } = prepareReplan();
    planner.validateRemoteRoute('W1N1', 'remote', true);
    Memory.rooms.W1N2.sources.remote.containerPlannedPos.x = 13;
    info.lastRebuildAttemptAt = Game.time; // Observe invalidation before the bounded repair retry.
    planner.run();
    assert.strictEqual(info.route.invalidReason, 'DESTINATION_CHANGED');
    assert.strictEqual(info.operational, false);
    assert.deepStrictEqual(planner.getActiveRemoteSourcesForHome('W1N1'), []);
});

test('I hostile route removes demand and road eligibility while preserving portfolio/history', () => {
    const { info, planner } = prepareReplan();
    info.telemetry = { delivered: 900 };
    info.roadEligible = true;
    Memory.rooms.W1N1.roadPlanner = { rooms: { W1N2: { roadCoords: [510, 511] } }, lastPlanned: Game.time };
    Memory.rooms.W1N2.controller = { owner: 'enemy' };
    Game.rooms.W1N2.controller = { owner: { username: 'enemy' }, pos: new RoomPosition(25, 25, 'W1N2') };
    assert.strictEqual(planner.validateRemoteRoute('W1N1', 'remote', true).reason, 'HOSTILE_TRANSIT_ROOM');
    assert.deepStrictEqual(planner.getActiveRemoteSourcesForHome('W1N1'), []);
    assert.strictEqual(planner.getRemoteExtractorDemand('W1N1', [WORK, MOVE], []).length, 0);
    assert.strictEqual(planner.claimRemotePickupTarget({ memory: {}, room: Game.rooms.W1N1 },
        { homeRoomName: 'W1N1', pickupRoom: 'W1N2', sourceId: 'remote', targetId: 'container' }), false);
    assert.strictEqual(info.roadEligible, false);
    assert.deepStrictEqual(Memory.rooms.W1N1.roadPlanner.rooms, {});
    assert.strictEqual(info.state, 'SUSPENDED_DANGER');
    planner.selectActiveSources('W1N1');
    assert.deepStrictEqual(Memory.rooms.W1N1.remotePlanner.activeSourceIds, []);
    assert.strictEqual(info.telemetry.delivered, 900);
});

test('invalid remembered Artificer work is released without breaking another source in the room', () => {
    const { info, planner } = prepareReplan();
    const other = JSON.parse(JSON.stringify(info));
    other.sourceId = 'other';
    other.containerCoord = 1530;
    other.roadCoords = { W1N2: [1530] };
    Memory.rooms.W1N1.remotePlanner.sourceInfos.other = other;
    info.route.targetCoord++;
    planner.validateRemoteRoute('W1N1', 'remote', true);
    const creep = { memory: { homeRoom: 'W1N1', remoteWorkTargetId: 'site', remoteWorkRoomName: 'W1N2',
        remoteWorkX: 11, remoteWorkY: 10 }, room: Game.rooms.W1N1 };
    const artificer = fresh('role.Artificer.js')._test;
    assert.strictEqual(artificer.getRememberedRemoteWorkTarget(creep), null);
    assert.strictEqual(creep.memory.remoteWorkTargetId, undefined);
    assert.strictEqual(artificer.remoteWorkRouteAvailable(creep, 'W1N2', { pos: new RoomPosition(30, 30, 'W1N2') }), true);
});

test('danger retreat rejects hostile transit and keeps carried energy', () => {
    const { creep, planner, moves } = movementSetup('Freighter');
    creep.room = Game.rooms.W1N2;
    creep.pos = new RoomPosition(10, 10, 'W1N2');
    creep.store.energy = 75;
    Memory.rooms.W1N2.controller = { owner: 'enemy' };
    Game.rooms.W1N2.controller = { owner: { username: 'enemy' }, pos: new RoomPosition(25, 25, 'W1N2') };
    Memory.rooms.W2N2 = { controller: { owner: 'enemy' } };
    let searched = false;
    PathFinder.search = (pos, goal, options) => {
        searched = true;
        assert.strictEqual(options.roomCallback('W2N2'), false);
        assert.notStrictEqual(options.roomCallback('W1N2'), false); // Must be able to leave current room.
        return { incomplete: true, path: [] };
    };
    planner.moveFreighterAlongRemotePath(creep, 'W1N1', 'remote', false);
    assert.strictEqual(searched, true);
    assert.deepStrictEqual(moves, []);
    assert.strictEqual(creep.store.energy, 75);
    assert.ok(creep.memory.freighterReservedUntil < Game.time);
});

test('permanent obstacle holds travel and planner rebuilds without losing establishment', () => {
    const { info, planner } = prepareReplan();
    const originalPath = planner.getRemotePath('W1N1', 'remote');
    Game.time = 101;
    Game.rooms.W1N1._structures.push({ structureType: STRUCTURE_EXTENSION, pos: new RoomPosition(26, 25, 'W1N1') });
    planner.validateRemoteRoute('W1N1', 'remote', true);
    const travel = require('utility.Travel.Creep');
    travel.moveToRoom = () => { throw Error('unsafe generic fallback'); };
    travel.move = () => { throw Error('blocked route must wait for rebuild'); };
    planner.moveExtractorAlongRemotePath({ memory: { role: 'Extractor' }, pos: originalPath[0] }, 'W1N1', 'remote');
    PathFinder.search = () => ({ incomplete: false, path: [originalPath[0], new RoomPosition(27, 25, 'W1N1'), ...originalPath.slice(2)] });
    planner.run();
    assert.strictEqual(info.operational, true);
    assert.strictEqual(info.active, true);
    assert.strictEqual(info.state, 'ACTIVE');
    assert.strictEqual(planner.getRemotePath('W1N1', 'remote')[1].x, 27);
});

test('J multi-load job counts ten resolved deliveries, including a failed intent retry', () => {
    reset();
    const origin = home(), destination = room('W5N5', 3);
    origin.storage = { id: 'origin', store: { energy: 1000 } };
    destination.storage = { id: 'destination', store: { energy: 0, getFreeCapacity: () => 10000 } };
    const store = { energy: 0, getFreeCapacity: () => 100 - store.energy };
    let intent;
    const creep = { memory: { role: 'Freighter', homeRoom: origin.name }, room: origin, store,
        withdraw(target, resource, amount) { intent = () => { target.store.energy -= amount; store.energy += amount; }; return OK; },
        transfer(target, resource, amount) { intent = () => { target.store.energy += amount; store.energy -= amount; }; return OK; } };
    const jobs = fresh('Logistics.Jobs.js');
    assert.strictEqual(jobs.assign(creep, { originRoom: origin.name, destinationRoom: destination.name, amount: 1000 }), true);
    const role = fresh('role.Freighter.js')._test;
    for (let i = 0; i < 10; i++) {
        creep.room = origin;
        role.collectTransportJob(creep);
        intent(); Game.time++;
        role.updateWorkingState(creep);
        creep.room = destination;
        role.deliverTransportJob(creep);
        assert.strictEqual(creep.memory.logisticsRemaining, 1000 - i * 100);
        if (i === 0) { // Accepted intent that fails at resolution must not count.
            Game.time++;
            role.updateWorkingState(creep);
            assert.strictEqual(creep.memory.logisticsRemaining, 1000);
            role.deliverTransportJob(creep);
        }
        intent(); Game.time++;
        role.updateWorkingState(creep);
        if (i < 9) {
            assert.strictEqual(creep.memory.logisticsDelivered, (i + 1) * 100);
            assert.strictEqual(creep.memory.freighterJob, 'transport');
        }
    }
    assert.strictEqual(destination.storage.store.energy, 1000);
    assert.strictEqual(creep.memory.freighterJob, undefined);
    assert.strictEqual(creep.memory.homeRoom, origin.name);
});

test('K/L zero amount and busy or loaded Freighters are rejected without mutation', () => {
    reset();
    const jobs = fresh('Logistics.Jobs.js');
    const job = { originRoom: 'W1N1', destinationRoom: 'W5N5', amount: 1000 };
    for (const extra of [{}, { FreighterWorking: true }, { freighterJob: 'local' },
        { freighterJob: 'transportDelivery' }, { pickupTargetId: 'old' }]) {
        const creep = { memory: Object.assign({ role: 'Freighter', homeRoom: 'W1N1' }, extra), store: { energy: 100 } };
        const before = JSON.stringify(creep.memory);
        assert.strictEqual(jobs.assign(creep, job), false);
        creep.store.energy = 0;
        if (Object.keys(extra).length) assert.strictEqual(jobs.assign(creep, job), false);
        assert.strictEqual(jobs.assign(creep, Object.assign({}, job, { amount: 0 })), false);
        assert.strictEqual(JSON.stringify(creep.memory), before);
    }
});

test('claims build once per tick and same-tick updates change reservations immediately', () => {
    reset(); home();
    const creep = { name: 'a', room: Game.rooms.W1N1, memory: { role: 'Freighter', homeRoom: 'W1N1',
        freighterJob: 'remote', pickupRoom: 'W1N2', pickupSourceId: 'remote', pickupTargetId: 'container',
        freighterReservedUntil: Game.time + 25, freighterReservedCarry: 100 }, store: { getFreeCapacity: () => 100 } };
    let scans = 0;
    Game.creeps = new Proxy({ a: creep }, { ownKeys(target) { scans++; return Reflect.ownKeys(target); } });
    const index = fresh('Logistics.Index.js');
    const reader = { name: 'b', room: creep.room };
    for (let i = 0; i < 50; i++) assert.strictEqual(index.reservations(reader, true).byTargetEnergy['W1N2|remote|container'], 100);
    creep.memory.freighterReservedCarry = 50;
    index.update(creep);
    assert.strictEqual(index.remoteClaim('W1N2', 'remote', 'container').energy, 50);
    index.remove(creep);
    assert.strictEqual(index.remoteClaim('W1N2', 'remote', 'container').energy, 0);
    assert.strictEqual(scans, 1);
});

test('long outbound travel renews its claim before the original reservation expires', () => {
    const { creep, planner } = movementSetup('Freighter');
    Game.creeps.traveler = creep;
    Memory.rooms.W1N2.sources.remote.haul = { targetId: 'container', targetType: 'container',
        amount: 1000, capacity: 2000, lastSeen: Game.time };
    assert.strictEqual(planner.claimRemotePickupTarget(creep, { homeRoomName: 'W1N1',
        pickupRoom: 'W1N2', sourceId: 'remote', targetId: 'container', type: 'container' }), true);
    Game.time += 30;
    planner.moveFreighterAlongRemotePath(creep, 'W1N1', 'remote', false);
    assert.ok(creep.memory.freighterReservedUntil > Game.time);
    assert.strictEqual(require('Logistics.Index').remoteClaim('W1N2', 'remote', 'container').energy, 100);
});

test('economics use assigned remote bodies, then the planned body, independent of creep order', () => {
    const { info, planner } = prepareReplan();
    const local = { name: 'local', memory: { role: 'Freighter', homeRoom: 'W1N1', freighterJob: 'local' }, body: [CARRY, MOVE] };
    const remote = { name: 'remoteHauler', memory: { role: 'Freighter', homeRoom: 'W1N1',
        freighterJob: 'remoteDelivery', remoteDeliverySourceId: 'remote' }, body: [...Array(8).fill(CARRY), MOVE] };
    Game.creeps = { local, remote };
    planner.scoreRemoteSource('W1N1', 'remote');
    const assignedTicks = info.roundTripTicks;
    Game.time++;
    Game.creeps = { remote, local };
    planner.scoreRemoteSource('W1N1', 'remote');
    assert.strictEqual(info.roundTripTicks, assignedTicks);
    Game.time++;
    Game.creeps = { local };
    let planned = 0;
    require('role.creepBodyConfig').getFreighterBody = () => { planned++; return [CARRY, CARRY, MOVE, MOVE]; };
    planner.scoreRemoteSource('W1N1', 'remote');
    assert.ok(planned > 0);
    assert.ok(info.roundTripTicks < assignedTicks);
});
