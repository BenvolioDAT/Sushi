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

function core(level = 3, state = 'RECOVERY') {
    reset();
    const value = home();
    value.controller.level = level;
    Memory.rooms.W1N1.economy.state = state;
    const roles = ['Foreman', 'Extractor', 'Extractor', 'Freighter', 'Tech'];
    roles.forEach((role, i) => {
        Game.creeps['core' + i] = { name: 'core' + i, room: value, ticksToLive: 1000,
            memory: { role, homeRoom: value.name }, body: [MOVE, role === 'Extractor' || role === 'Tech' ? WORK : CARRY] };
    });
    require('HiveMind.ColonyState').update(value);
    return value;
}

test('RECOVERY with no remotes admits remoteIntel and revalidates its own one-Scout cap', () => {
    const value = core();
    const manager = require('spawn.request.manager');
    assert.strictEqual(manager.requestEconomicScout(value).requested, 1);
    const request = Memory.rooms.W1N1.spawn.queue[0];
    assert.strictEqual(require('HiveMind.Economy').categoryForRequest(request), 'remoteIntel');
    assert.deepStrictEqual(request.body, [MOVE]);
    assert.strictEqual(request.memory.homeRoom, value.name);
    assert.strictEqual(require('Spawn.Arbiter').revalidate(value, request).allowed, true);
    assert.strictEqual(manager.requestEconomicScout(value).requested, 0);
    value.energyAvailable = 50;
    let spawned = null;
    Game.spawns.Spawn1.spawnCreep = (body, name, options) => { spawned = { body, memory: options.memory }; return OK; };
    assert.strictEqual(require('spawn.manager').runRoom(value.name).ok, true);
    assert.deepStrictEqual(spawned.body, [MOVE]);
    assert.strictEqual(spawned.memory.homeRoom, value.name);
});

test('RECOVERY and SURVIVAL without working miners block Scout demand', () => {
    for (const state of ['RECOVERY', 'SURVIVAL']) {
        const value = core(3, state);
        Game.creeps.core1.body = [MOVE];
        Game.creeps.core2.body = [MOVE];
        const result = require('spawn.request.manager').requestEconomicScout(value);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(Memory.rooms.W1N1.spawn.queue.length, 0);
    }
});

test('RCL1 BOOTSTRAP admits exactly one 50-energy Scout after the living floor', () => {
    const value = core(1);
    assert.strictEqual(Memory.rooms.W1N1.colony.phase, 'BOOTSTRAP');
    const manager = require('spawn.request.manager');
    assert.strictEqual(manager.requestEconomicScout(value).requested, 1);
    assert.strictEqual(manager.requestEconomicScout(value).requested, 0);
    assert.deepStrictEqual(Memory.rooms.W1N1.spawn.queue[0].body, [MOVE]);
});

test('early BOOTSTRAP cannot substitute queued miners or controller work for a living floor', () => {
    const value = core(1);
    delete Game.creeps.core2;
    Memory.rooms.W1N1.spawn.queue.push({ role: 'Extractor', body: [WORK, MOVE] });
    assert.strictEqual(require('spawn.request.manager').requestEconomicScout(value).ok, false);
    assert.match(Memory.rooms.W1N1.scout.blockedReason, /Extractor floor/);
});

test('full optional queue and exhausted admission budget cannot starve economic intel', () => {
    const value = core();
    const queue = Memory.rooms.W1N1.spawn.queue;
    for (let i = 0; i < 8; i++) queue.push({ role: ['Artificer', 'Tech', 'ThoriumMiner'][i % 3],
        body: [MOVE], priority: 20, requestedAt: Game.time, memory: { homeRoom: value.name } });
    const result = require('spawn.request.manager').requestEconomicScout(value);
    assert.strictEqual(result.requested, 1, result.reason);
    assert.strictEqual(queue.length, 8);
    assert.strictEqual(queue[0].role, 'Scout');
    assert.strictEqual(require('Spawn.Arbiter').revalidate(value, queue[0]).allowed, true);
});

test('high priority intel refresh raises existing-portfolio Scout demand and diagnostics', () => {
    const value = core();
    Memory.rooms.W1N1.remotePlanner = { sourceInfos: { r: { roomName: 'W1N2', score: 8 } } };
    Memory.rooms.W1N2 = { lastIntelRefreshAt: Game.time };
    assert.strictEqual(require('Scout.Economy').status(value).priority, 50);
    require('Remote.Intel').request('W1N2', 'STALE_CONTROLLER_OWNERSHIP', 100);
    assert.strictEqual(require('spawn.request.manager').requestEconomicScout(value).requested, 1);
    assert.strictEqual(Memory.rooms.W1N1.scout.priority, 55);
    assert.strictEqual(Memory.rooms.W1N1.scout.intelRefreshPending, 1);
});

test('Scout visibility scans sources and builds its HOME remote candidates', () => {
    const { planner } = prepareReplan();
    delete Memory.rooms.W1N1.remotePlanner;
    const remote = Game.rooms.W1N2;
    remote.getTerrain = () => ({ get: () => 0 });
    const source = { id: 'remote', pos: new RoomPosition(12, 10, 'W1N2'), energyCapacity: 3000 };
    const find = remote.find;
    remote.find = function(kind, options) { return kind === FIND_SOURCES ? [source] : find.call(this, kind, options); };
    const creep = { room: remote, memory: { homeRoom: 'W1N1' } };
    require('utility').scanRoom(creep);
    assert.ok(Memory.rooms.W1N2.sources.remote);
    assert.strictEqual(planner.onScoutRoom(creep), true);
    assert.ok(Memory.rooms.W1N1.remotePlanner.sourceInfos.remote);
});

test('Annex waits on hostile reservation and resumes immediately after fresh safe intel', () => {
    reset(); const value = home(); const remote = room('W1N2');
    remote.controller = { id: 'controller', pos: new RoomPosition(25, 25, remote.name),
        reservation: { username: 'enemy', ticksToEnd: 50 } };
    let reserved = 0;
    const creep = { room: value, owner: { username: 'me' },
        memory: { role: 'Annex', homeRoom: value.name, targetRoom: remote.name },
        pos: { getRangeTo: () => 1, inRangeTo: () => false },
        reserveController: () => { reserved++; return OK; } };
    const annex = require('role.Annex');
    annex.run(creep);
    assert.strictEqual(creep.memory.annexState, 'blockedHostileReservation');
    assert.ok(creep.memory.nextRetryAt > Game.time);
    annex.run(creep);
    assert.strictEqual(reserved, 0);
    delete remote.controller.reservation;
    Game.time++;
    annex.run(creep);
    assert.strictEqual(reserved, 1);
    assert.strictEqual(creep.memory.annexState, 'reserving');
});

test('five active reservation rooms admit a fifth Annex through enabled policy', () => {
    const { planner, info } = prepareReplan();
    const value = Game.rooms.W1N1;
    value.energyAvailable = value.energyCapacityAvailable = 800;
    BODYPART_COST[CLAIM] = 600;
    const hive = require('HiveMind.Memory').ensure(); hive.identity.username = 'me';
    require('HiveMind.ColonyState').get = () => ({ phase: 'GROWTH' });
    const memory = Memory.rooms.W1N1.remotePlanner;
    memory.sourceInfos = {}; memory.activeSourceIds = [];
    for (let i = 0; i < 5; i++) {
        const name = ['W1N2', 'W1N3', 'W2N1', 'W2N2', 'W2N3'][i];
        room(name).controller = { pos: new RoomPosition(25, 25, name) };
        const id = 'remote' + i;
        memory.sourceInfos[id] = { ...info, sourceId: id, roomName: name, state: 'ACTIVE', operational: true };
        memory.activeSourceIds.push(id);
        if (i < 4) Game.creeps['annex' + i] = { name: 'annex' + i, room: value, ticksToLive: 500,
            memory: { role: 'Annex', homeRoom: value.name, targetRoom: name }, body: [CLAIM, MOVE] };
    }
    const result = require('spawn.request.manager').requestAnnexForRoom(value);
    assert.strictEqual(result.requested, 1, result.reason);
    assert.strictEqual(Memory.rooms.W1N1.spawn.queue[0].memory.targetRoom, 'W2N3');
});

test('owned second HOME is excluded from generation and existing remote use', () => {
    const { planner, info } = prepareReplan();
    Game.rooms.W1N2.controller = { my: true, level: 1, pos: new RoomPosition(25, 25, 'W1N2') };
    Game.spawns.Spawn2 = { name: 'Spawn2', my: true, room: Game.rooms.W1N2 };
    assert.strictEqual(planner.generateRemotePlan('W1N1', Game.rooms.W1N2), false);
    assert.strictEqual(planner.onScoutRoom({ room: Game.rooms.W1N2, memory: { homeRoom: 'W1N1' } }), false);
    assert.strictEqual(planner.shouldUseRemoteSource('W1N1', 'remote'), false);
    assert.strictEqual(info.operational, false);
});

test('protected full queue remains intact when Scout admission is denied', () => {
    const value = core();
    const queue = Memory.rooms.W1N1.spawn.queue;
    for (let i = 0; i < 8; i++) queue.push({ role: 'Extractor', body: [WORK, MOVE], priority: 80, memory: {} });
    const before = JSON.stringify(queue);
    assert.strictEqual(require('spawn.request.manager').requestEconomicScout(value).ok, false);
    assert.strictEqual(JSON.stringify(queue), before);
});

test('CPU suppression and missing controller floor explain absent discovery', () => {
    const value = core(1);
    delete Game.creeps.core4;
    const manager = require('spawn.request.manager');
    assert.strictEqual(manager.requestEconomicScout(value).ok, false);
    assert.match(Memory.rooms.W1N1.scout.blockedReason, /controller/);
    const diagnostic = require('Planner.Remote').getDiagnostics(value.name);
    assert.strictEqual(diagnostic.scoutPresent, false);
    assert.strictEqual(diagnostic.discoveryBlockedReason, 'REMOTE_DISCOVERY_HAS_NO_SCOUT');
    Game.cpu.bucket = 500;
    assert.strictEqual(manager.requestEconomicScout(value).ok, false);
    assert.match(Memory.rooms.W1N1.scout.blockedReason, /CPU/);
});

test('normal light planning admits Scout without waiting for optional full planning', () => {
    const value = core(1);
    const manager = require('spawn.request.manager');
    manager.runForRoom(value);
    assert.strictEqual(Memory.rooms.W1N1.spawn.queue.filter(q => q.role === 'Scout').length, 1);
    assert.strictEqual(Memory.rooms.W1N1.scout.allowed, true);
});

