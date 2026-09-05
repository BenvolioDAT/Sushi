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

test('actual hashed scheduler repeatedly plans, rescores and validates across 2100 ticks', () => {
    const { planner, info } = prepareReplan();
    const scheduler = fresh('HiveMind.Scheduler.js');
    const memory = Memory.rooms.W1N1.remotePlanner;
    const heavy = new Set(), rescores = new Set(), validations = new Set();
    const log = console.log;
    console.log = () => {};
    try {
        for (Game.time = 1; Game.time <= 2101; Game.time++) {
            if (Game.time === 333) info.route.dirty = true;
            scheduler.run('remotePlanning', () => planner.run(), { interval: 5 });
            if (memory.lastHeavyPlanAt !== undefined) heavy.add(memory.lastHeavyPlanAt);
            if (memory.lastRescoreAt !== undefined) rescores.add(memory.lastRescoreAt);
            if (info.route.lastValidationAttemptAt !== undefined) validations.add(info.route.lastValidationAttemptAt);
        }
    } finally { console.log = log; }
    assert.ok(heavy.size >= 27, 'heavy work must not starve on the hashed phase');
    assert.ok(rescores.size >= 3);
    assert.ok(validations.size >= 27);
    assert.ok([...heavy].some(tick => tick % 75 !== 0));
});

test('safe live vision clears old threat and immediately restarts a suspended remote', () => {
    const { planner, info } = prepareReplan();
    const hive = require('HiveMind.Memory').ensure();
    hive.threats.W1N2 = { harmfulHostileCount: 1, lastSeen: Game.time - 10 };
    Object.assign(info, { active: false, operational: false, established: true, state: 'SUSPENDED_DANGER' });
    Object.assign(info.route, { valid: false, invalidReason: 'HOSTILE_TRANSIT_ROOM', lastValidationAttemptAt: Game.time });
    Memory.rooms.W1N1.remotePlanner.activeSourceIds = [];
    const intel = fresh('Remote.Intel.js');
    intel.request('W1N2', 'STALE_TRANSIT_SAFETY', 90);
    fresh('Combat.ThreatLedger.js').run();
    assert.strictEqual(hive.threats.W1N2.harmfulHostileCount, 0);
    assert.strictEqual(Memory.rooms.W1N2.intelRefreshRequestedAt, undefined);
    planner.run();
    assert.strictEqual(info.route.valid, true);
    assert.strictEqual(info.active, true);
});

test('invalid-only portfolio admits a new RECOVERY remote as bootstrap', () => {
    const { planner, info } = prepareReplan();
    info.operational = false;
    info.route.valid = false;
    info.state = 'DEGRADED';
    const replacement = room('W1N3');
    Memory.rooms.W1N3.sources = { next: { id: 'next', seatCount: 1, pos: { x: 12, y: 10, roomName: 'W1N3' } } };
    Memory.rooms.W1N1.economy.state = 'RECOVERY';
    PathFinder.search = () => ({ incomplete: false, path: [new RoomPosition(26, 25, 'W1N1'), new RoomPosition(11, 10, 'W1N3')] });
    planner.generateRemotePlan('W1N1', replacement);
    const memory = Memory.rooms.W1N1.remotePlanner;
    assert.strictEqual(memory.sourceInfos.next.spendCategory, 'remoteBootstrap');
    assert.deepStrictEqual(memory.activeSourceIds, ['next']);
    assert.strictEqual(memory.sourceInfos.remote, info);
});

test('economy distinguishes portfolio, selected and operational source counts', () => {
    const { info } = prepareReplan();
    const memory = Memory.rooms.W1N1.remotePlanner;
    memory.sourceInfos.invalid = Object.assign({}, info, { sourceId: 'invalid', operational: false });
    memory.activeSourceIds.push('invalid'); // Legacy memory must not inflate live economics.
    const economy = fresh('HiveMind.Economy.js').remoteEconomy('W1N1');
    assert.strictEqual(economy.portfolioSources, 2);
    assert.strictEqual(economy.selectedSources, 2);
    assert.strictEqual(economy.operationalSources, 1);
    assert.strictEqual(economy.activeSources, 1);
});

function annexHome() {
    const setup = prepareReplan();
    const home = Game.rooms.W1N1;
    home.energyAvailable = home.energyCapacityAvailable = 800;
    BODYPART_COST[CLAIM] = 600;
    Game.rooms.W1N2.controller = { pos: new RoomPosition(25, 25, 'W1N2'), reservation: { username: 'me', ticksToEnd: 5 } };
    require('HiveMind.Memory').getConfig('spawn').enabled = false;
    require('HiveMind.ColonyState').get = () => ({ phase: 'MATURE' });
    return Object.assign(setup, { home });
}

test('RECOVERY admits reservation replacement as remoteMaintenance', () => {
    const { home } = annexHome();
    Memory.rooms.W1N1.economy.state = 'RECOVERY';
    const result = fresh('spawn.request.manager.js').requestAnnexForRoom(home);
    assert.strictEqual(result.requested, 1, result.reason);
    const queued = Memory.rooms.W1N1.spawn.queue.find(request => request.role === 'Annex');
    assert.strictEqual(queued.economyCategory || queued.memory.economyCategory, 'remoteMaintenance');
});

test('unseen reservation ages and expires while stale ownership is retained for scouting', () => {
    reset();
    Game.time = 2000;
    Memory.rooms.W1N2 = { controller: { owner: 'enemy', lastObservedAt: 1000,
        reservation: { username: 'me', ticksToEnd: 3000, observedAt: 1000 } } };
    const intel = fresh('Remote.Intel.js');
    assert.strictEqual(intel.getEffectiveReservation('W1N2').ticksToEnd, 2000);
    Game.time = 4000;
    assert.strictEqual(intel.getEffectiveReservation('W1N2'), null);
    assert.strictEqual(intel.controller('W1N2').owner, 'enemy');
    assert.strictEqual(Memory.rooms.W1N2.controller.ownershipIntelStale, true);
    assert.strictEqual(Memory.rooms.W1N2.intelRefreshReason, 'STALE_CONTROLLER_OWNERSHIP');
});

test('Scout selects blocking intel before the normal rescan interval', () => {
    reset(); home();
    Game.map.getRoomStatus = () => ({ status: 'normal' });
    const creep = { memory: { homeRoom: 'W1N1' }, room: Game.rooms.W1N1 };
    const scout = fresh('role.Scout.js')._test;
    const plan = scout.ensureScoutPlan(creep);
    for (const value of Object.values(plan.rooms)) value.lastScanTick = Game.time;
    fresh('Remote.Intel.js').request('W1N2', 'STALE_CONTROLLER_OWNERSHIP', 100);
    assert.strictEqual(scout.chooseNextScoutRoom(creep), true);
    assert.strictEqual(creep.memory.targetRoom, 'W1N2');
});

test('cheap visible refresh rotates over three remotes without route searches', () => {
    const { planner } = prepareReplan();
    for (const name of ['W1N3', 'W2N1']) {
        room(name);
        Memory.rooms[name].sources = {};
    }
    const memory = Memory.rooms.W1N1.remotePlanner;
    memory.lastHeavyPlanAt = memory.lastRescoreAt = memory.lastDebugAt = Game.time;
    PathFinder.search = () => { throw Error('metadata refresh must not rebuild geometry'); };
    planner.run();
    Game.time += 5;
    planner.run();
    for (const name of ['W1N2', 'W1N3', 'W2N1']) assert.ok(Memory.rooms[name].lastIntelRefreshAt > 0);
});

test('two local sources plus five operational remotes admit a seventh Extractor', () => {
    const { home, info } = annexHome();
    const memory = Memory.rooms.W1N1;
    memory.sources = { local1: {}, local2: {} };
    memory.remotePlanner.activeSourceIds = [];
    for (let i = 0; i < 5; i++) {
        memory.remotePlanner.sourceInfos['r' + i] = Object.assign({}, info, { sourceId: 'r' + i, requiredWork: 3 });
        memory.remotePlanner.activeSourceIds.push('r' + i);
    }
    const config = require('HiveMind.Memory').getConfig('spawn');
    config.enabled = true;
    config.roleCaps.Extractor = 6;
    const request = { role: 'Extractor', economyCategory: 'remoteMaintenance', body: [WORK, WORK, WORK, CARRY, MOVE] };
    const decision = fresh('Spawn.Policy.js').evaluate(home, request,
        { byRole: { Extractor: 6, Freighter: 1 }, nonCombatTotal: 7, queue: [] });
    assert.strictEqual(decision.allowed, true, decision.reason);
});

test('affordable positive reservation ROI starts RESERVING and requests Annex', () => {
    const { home, info, planner } = annexHome();
    delete Game.rooms.W1N2.controller.reservation;
    Memory.rooms.W1N1.economy.growth.energyAboveReserve = 10000;
    info.risk = 4.8;
    planner.scoreRemoteSource('W1N1', 'remote');
    assert.ok(info.currentNetEPT < 0);
    assert.ok(info.projectedReservedNetEPT > 1);
    assert.strictEqual(info.reservationBootstrap, true);
    planner.selectActiveSources('W1N1');
    assert.strictEqual(info.active, true);
    assert.strictEqual(info.state, 'BOOTSTRAPPING');
    const result = fresh('spawn.request.manager.js').requestAnnexForRoom(home);
    assert.strictEqual(result.requested, 1, result.reason);
    assert.strictEqual(Memory.rooms.W1N1.spawn.queue[0].economyCategory, 'remoteBootstrap');
    assert.strictEqual(info.state, 'RESERVING');
    Memory.rooms.W1N1.economy.growth.energyAboveReserve = 0;
    home.energyAvailable = 0;
    planner.scoreRemoteSource('W1N1', 'remote');
    assert.strictEqual(info.reservationBootstrap, true, 'funded Annex must survive temporary liquidity loss');
    Game.rooms.W1N2.controller.reservation = { username: 'me', ticksToEnd: 1000 };
    planner.selectActiveSources('W1N1');
    assert.strictEqual(info.state, 'ACTIVE');
    const diagnostics = planner.getDiagnostics('W1N1');
    assert.strictEqual(diagnostics.operationalActiveCount, 1);
    assert.strictEqual(diagnostics.sources.remote.estimatedReservationTicks, 1000);
});

test('projected profit alone cannot bypass insufficient bootstrap liquidity', () => {
    const { info, planner } = annexHome();
    delete Game.rooms.W1N2.controller.reservation;
    info.risk = 4.8;
    Memory.rooms.W1N1.economy.growth.energyAboveReserve = 0;
    planner.scoreRemoteSource('W1N1', 'remote');
    assert.ok(info.projectedReservedNetEPT > 1);
    assert.strictEqual(info.reservationBootstrap, false);
    assert.ok(info.netIncome < 0);
});

test('historical sources cannot subsidize projected Annex upkeep', () => {
    const { info, planner } = annexHome();
    delete Game.rooms.W1N2.controller.reservation;
    planner.scoreRemoteSource('W1N1', 'remote');
    const projected = info.projectedReservedNetEPT;
    Memory.rooms.W1N1.remotePlanner.sourceInfos.dead = Object.assign({}, info,
        { sourceId: 'dead', active: false, operational: false });
    planner.scoreRemoteSource('W1N1', 'remote');
    assert.strictEqual(info.projectedReservedNetEPT, projected);
});

test('Freighter cap covers approved carry demand and one replacement', () => {
    const { home, info } = annexHome();
    info.requiredCarry = 30;
    const policy = fresh('Spawn.Policy.js');
    const config = { roleCaps: { Freighter: 3 } };
    assert.strictEqual(policy.economyRoleCap(home, 'Freighter', { body: [CARRY, CARRY, MOVE] }, config), 19);
    info.operational = false;
    assert.strictEqual(policy.economyRoleCap(home, 'Freighter', { body: [CARRY, CARRY, MOVE] }, config), 4);
});

test('diagnostics checks current spending instead of cached admission', () => {
    const { info, planner } = prepareReplan();
    info.spendAllowed = true;
    Memory.rooms.W1N1.economy.state = 'SURVIVAL';
    const source = planner.getDiagnostics('W1N1').sources.remote;
    assert.strictEqual(source.spendAllowed, false);
    assert.strictEqual(source.blockedReason, 'blocked during SURVIVAL');
});

test('unselected diagnostics identifies the current local harvest blocker', () => {
    const { info, planner } = prepareReplan();
    info.active = false;
    Memory.rooms.W1N1.remotePlanner.activeSourceIds = [];
    Memory.rooms.W1N1.economy.harvest.workActive = 1;
    assert.strictEqual(planner.getDiagnostics('W1N1').sources.remote.blockedReason, 'LOCAL_HARVEST_SHORTAGE');
});
