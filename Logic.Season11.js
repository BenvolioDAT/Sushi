/*
 * Logic.Season11.js
 *
 * Guarded Thorium/Reactor orchestration for Screeps World Season 11. Every
 * access to a seasonal constant happens through a feature-detection helper so
 * this module is safe to load on the persistent shards and private servers.
 */

var Season11Adapter = require('Season11.Adapter');
var CombatPolicy = require('Combat.Policy');
var TickIndex = require('HiveMind.Index');
var HiveMemory = require('HiveMind.Memory');
var Portfolio = require('Season11.Portfolio');
var Economy = require('HiveMind.Economy');
var BodyConfig = require('role.creepBodyConfig');

var SCHEMA_VERSION = 3;
var REACTOR_CAPACITY = 1000;
var DEFAULT_MODE = 'auto';
var VALID_MODES = {
    disabled: true,
    observe: true,
    auto: true,
    active: true
};

var DEFAULT_CONFIG = {
    scoutRadius: 8,
    visibleScanInterval: 25,
    planningInterval: 50,
    cleanupInterval: 1000,
    intelMaxAge: 50000,
    depletedIntelMaxAge: 500000,
    routeCacheTtl: 2500,
    routeFailureCooldown: 500,
    maxRouteCacheEntries: 100,
    maxEvents: 20,
    maxMiningRooms: 5,
    maxActiveReactors: 1,
    portfolioInterval: 17,
    maxPortfolioCandidates: 12,
    minimumStartupReserve: null,
    maximumStartupReserve: 1000,
    recaptureMode: 'auto',
    maximumRecaptureDefense: 12,
    recaptureFailureWindow: 10000,
    maximumClaimBackoff: 8000,
    supplyHorizon: 1500,
    maximumMiningRouteRooms: 12,
    maximumReactorRouteRooms: 20,
    startupReserve: 500,
    reactorSafetyStock: 150,
    starvationWarningTicks: 200,
    haulerSafetyMargin: 1.25,
    haulerReplacementMargin: 100,
    agingFallbackThorium: 1000,
    maxHaulersPerRoute: 4,
    claimCooldown: 500,
    recapture: false,
    minimumCpuBucket: 2500,
    minimumStorageEnergy: 30000
};

var observedTick = -1;
var observedRooms = {};
var routeTick = -1;
var routeOps = 0;
var diagnosticsTick = -1;
var diagnosticsCache = null;
var agingRouteTick = -1;
var agingRoutes = {};

function getTime() {
    return typeof Game !== 'undefined' && typeof Game.time === 'number' ?
        Game.time : 0;
}

function getThoriumResourceType() {
    return Season11Adapter.resourceType();
}

function getReactorFindConstant() {
    return Season11Adapter.reactorFindConstant();
}

function getMineralFindConstant() {
    return typeof FIND_MINERALS !== 'undefined' ? FIND_MINERALS : null;
}

function getHostileCreepFindConstant() {
    return typeof FIND_HOSTILE_CREEPS !== 'undefined' ? FIND_HOSTILE_CREEPS : null;
}

function getHostileStructureFindConstant() {
    return typeof FIND_HOSTILE_STRUCTURES !== 'undefined' ? FIND_HOSTILE_STRUCTURES : null;
}

function isApiAvailable() {
    return Season11Adapter.isAvailable();
}

function isClaimApiAvailable() {
    if (Season11Adapter.canClaim()) return true;

    var creeps = TickIndex.get().allCreeps;
    for (var i = 0; i < creeps.length; i++) {
        if (Season11Adapter.canClaim(creeps[i])) return true;
    }

    return false;
}

function copyDefaults(target, defaults) {
    for (var key in defaults) {
        if (defaults.hasOwnProperty(key) && target[key] === undefined) {
            target[key] = defaults[key];
        }
    }
}

function makeInitialMemory() {
    return {
        schemaVersion: SCHEMA_VERSION,
        rooms: {},
        reactors: {},
        assignments: {
            mining: {},
            selectedReactorId: null,
            selectedReactorRoom: null,
            plannedAt: 0
        },
        routes: {},
        alerts: {},
        stats: {
            apiAvailable: false,
            claimApiAvailable: false,
            lastCleanup: 0,
            lastPlan: 0,
            events: []
        }
    };
}

function ensureMemory() {
    if (typeof Memory === 'undefined') {
        return makeInitialMemory();
    }

    var memory = HiveMemory.getSeasonState();
    var config = HiveMemory.getConfig('season11');
    if (config.recaptureMode === undefined && config.recapture === true) config.recaptureMode = 'manual';
    copyDefaults(config, DEFAULT_CONFIG);
    if (['disabled', 'manual', 'auto'].indexOf(config.recaptureMode) < 0) config.recaptureMode = 'disabled';
    config.maxActiveReactors = Math.max(0, Math.min(5, Math.floor(Number(config.maxActiveReactors) || 0)));
    config.portfolioInterval = Math.max(10, Math.min(25, Number(config.portfolioInterval) || 17));
    if (!VALID_MODES[config.mode]) config.mode = DEFAULT_MODE;
    Object.defineProperty(memory, 'config', {
        configurable: true, enumerable: false, value: config
    });
    Object.defineProperty(memory, 'mode', {
        configurable: true, enumerable: false,
        get: function() { return config.mode; },
        set: function(value) { config.mode = value; }
    });
    memory.rooms = memory.rooms || {};
    memory.reactors = memory.reactors || {};
    memory.assignments = memory.assignments || {};
    memory.assignments.mining = memory.assignments.mining || {};
    memory.routes = memory.routes || {};
    memory.alerts = memory.alerts || {};
    memory.stats = memory.stats || {};
    memory.stats.events = Array.isArray(memory.stats.events) ?
        memory.stats.events : [];
    memory.reactorPortfolio = memory.reactorPortfolio || {
        reactors: {}, activeReactorIds: [], desiredActiveCount: 1, plannedAt: 0
    };
    memory.thoriumReservations = memory.thoriumReservations || { tick: 0, stores: {} };
    memory.schemaVersion = SCHEMA_VERSION;

    return memory;
}

function getMode() {
    return ensureMemory().mode;
}

function setMode(mode) {
    var memory = ensureMemory();

    if (!VALID_MODES[mode]) {
        return {
            ok: false,
            mode: memory.mode,
            reason: 'Expected disabled, observe, auto, or active'
        };
    }

    if (memory.mode !== mode) {
        var oldMode = memory.mode;
        memory.mode = mode;
        logEvent('MODE', oldMode + ' -> ' + mode);
    }

    invalidateDiagnostics();
    return { ok: true, mode: mode };
}

function configure(values) {
    var memory = ensureMemory();

    if (!values || typeof values !== 'object') {
        return { ok: false, reason: 'Expected a plain settings object' };
    }

    for (var key in values) {
        if (values.hasOwnProperty(key) && DEFAULT_CONFIG[key] !== undefined) {
            memory.config[key] = values[key];
        }
    }

    invalidateDiagnostics();
    return { ok: true, config: memory.config };
}

function isObserving() {
    return getMode() !== 'disabled' && isApiAvailable();
}

function isOperatingMode() {
    var mode = getMode();
    return isApiAvailable() && (mode === 'auto' || mode === 'active');
}

function getScoutRadius(fallback) {
    if (!isObserving()) {
        return fallback;
    }

    var configured = Number(ensureMemory().config.scoutRadius);
    return Math.max(fallback, Math.min(12, isFinite(configured) ?
        Math.floor(configured) : fallback));
}

function invalidateDiagnostics() {
    diagnosticsTick = -1;
    diagnosticsCache = null;
}

function logEvent(code, detail) {
    var memory = ensureMemory();
    var events = memory.stats.events;
    var last = events.length > 0 ? events[events.length - 1] : null;

    if (
        last &&
        last.code === code &&
        last.detail === detail &&
        getTime() - last.tick < 100
    ) {
        return;
    }

    events.push({ tick: getTime(), code: code, detail: detail || '' });

    while (events.length > memory.config.maxEvents) {
        events.shift();
    }

    if (typeof console !== 'undefined' && console.log) {
        console.log('[Season11] ' + code + (detail ? ': ' + detail : ''));
    }
}

function setAlert(code, detail, ttl) {
    var memory = ensureMemory();
    var previous = memory.alerts[code];
    memory.alerts[code] = {
        code: code,
        detail: detail || '',
        tick: getTime(),
        until: getTime() + Math.max(1, ttl || 100)
    };

    if (!previous || previous.detail !== detail) {
        logEvent(code, detail);
    }
    invalidateDiagnostics();
}

function clearAlert(code) {
    var memory = ensureMemory();
    if (memory.alerts[code]) {
        delete memory.alerts[code];
        invalidateDiagnostics();
    }
}

function safeFind(room, findConstant, options) {
    if (!room || typeof room.find !== 'function' || findConstant === null) {
        return [];
    }

    try {
        return room.find(findConstant, options) || [];
    }
    catch (error) {
        return [];
    }
}

function getOwnerName(owner) {
    return owner && typeof owner.username === 'string' ? owner.username : null;
}

function getMyUsername() {
    if (typeof Game === 'undefined') {
        return null;
    }

    var index = TickIndex.get();
    for (var spawnIndex = 0; spawnIndex < index.ownedSpawns.length; spawnIndex++) {
        var spawn = index.ownedSpawns[spawnIndex];
        if (spawn && spawn.owner && spawn.owner.username) {
            return spawn.owner.username;
        }
    }

    for (var roomIndex = 0; roomIndex < index.ownedRooms.length; roomIndex++) {
        var controller = index.ownedRooms[roomIndex].controller;
        if (controller && controller.owner) {
            return getOwnerName(controller.owner);
        }
    }

    return null;
}

function getStoreAmount(target, resourceType) {
    var store = target && target.store ? target.store : target;

    if (!store || !resourceType) {
        return 0;
    }

    if (typeof store.getUsedCapacity === 'function') {
        var amount = store.getUsedCapacity(resourceType);
        return typeof amount === 'number' && isFinite(amount) ? amount : 0;
    }

    return typeof store[resourceType] === 'number' ? store[resourceType] : 0;
}

function getStoreCapacity(target, resourceType, fallback) {
    var store = target && target.store ? target.store : target;

    if (store && typeof store.getCapacity === 'function') {
        var capacity = store.getCapacity(resourceType);
        if (typeof capacity === 'number' && isFinite(capacity)) {
            return capacity;
        }
    }

    return fallback || 0;
}

function countThreatParts(creeps) {
    var threatParts = 0;

    for (var i = 0; i < creeps.length; i++) {
        var creep = creeps[i];
        if (!creep || typeof creep.getActiveBodyparts !== 'function') {
            threatParts++;
            continue;
        }

        var attackType = typeof ATTACK !== 'undefined' ? ATTACK : 'attack';
        var rangedType = typeof RANGED_ATTACK !== 'undefined' ?
            RANGED_ATTACK : 'ranged_attack';
        var healType = typeof HEAL !== 'undefined' ? HEAL : 'heal';
        var workType = typeof WORK !== 'undefined' ? WORK : 'work';
        threatParts += creep.getActiveBodyparts(attackType) +
            creep.getActiveBodyparts(rangedType) +
            creep.getActiveBodyparts(healType) +
            creep.getActiveBodyparts(workType);
    }

    return threatParts;
}

function observeRoom(room, homeRoomName, force) {
    var memory = ensureMemory();

    if (!room || !room.name || !isObserving()) {
        return null;
    }

    var tick = getTime();
    if (observedTick !== tick) {
        observedTick = tick;
        observedRooms = {};
    }

    var existing = memory.rooms[room.name];
    var interval = Math.max(1, Number(memory.config.visibleScanInterval) || 25);

    if (
        !force &&
        (observedRooms[room.name] ||
            (existing && tick - (existing.lastSeen || 0) < interval))
    ) {
        refreshVisibleReactor(room);
        return existing || null;
    }

    observedRooms[room.name] = true;
    var hostiles = safeFind(room, getHostileCreepFindConstant());
    var hostileStructures = safeFind(room, getHostileStructureFindConstant());
    var controller = room.controller;
    var roomIntel = existing || {};
    roomIntel.roomName = room.name;
    roomIntel.lastSeen = tick;
    roomIntel.controllerOwner = controller ? getOwnerName(controller.owner) : null;
    roomIntel.controllerReservation = controller && controller.reservation ?
        getOwnerName(controller.reservation) : null;
    roomIntel.controllerLevel = controller ? (controller.level || 0) : null;
    roomIntel.controllerMy = !!(controller && controller.my);
    roomIntel.hostileCreeps = hostiles.length;
    roomIntel.hostileStructures = hostileStructures.length;
    roomIntel.threatParts = countThreatParts(hostiles);

    var mineralConstant = getMineralFindConstant();
    var thoriumType = getThoriumResourceType();
    var minerals = safeFind(room, mineralConstant);
    var thorium = null;

    for (var i = 0; i < minerals.length; i++) {
        if (minerals[i] && minerals[i].mineralType === thoriumType) {
            thorium = minerals[i];
            break;
        }
    }

    if (thorium) {
        var wasDepleted = !!(roomIntel.thorium && roomIntel.thorium.depleted);
        var remaining = wasDepleted ? 0 : Math.max(0, Number(thorium.mineralAmount) || 0);
        roomIntel.thorium = {
            id: thorium.id,
            x: thorium.pos ? thorium.pos.x : null,
            y: thorium.pos ? thorium.pos.y : null,
            remaining: remaining,
            density: typeof thorium.density === 'number' ? thorium.density : null,
            ticksToRegeneration: typeof thorium.ticksToRegeneration === 'number' ?
                thorium.ticksToRegeneration : null,
            depleted: remaining <= 0,
            lastSeen: tick
        };

        if (remaining <= 0) {
            setAlert('DEPLETED', room.name, 250);
        }
    }

    if (homeRoomName && homeRoomName !== room.name) {
        roomIntel.routeDistance = getRouteDistance(homeRoomName, room.name);
        roomIntel.routeFrom = homeRoomName;
    }
    else if (homeRoomName === room.name) {
        roomIntel.routeDistance = 0;
        roomIntel.routeFrom = homeRoomName;
    }

    memory.rooms[room.name] = roomIntel;
    observeReactors(room, hostiles.length, roomIntel.threatParts);
    invalidateDiagnostics();
    return roomIntel;
}

function observeReactors(room, hostileCount, threatParts) {
    var memory = ensureMemory();
    var reactors = safeFind(room, getReactorFindConstant());
    var thoriumType = getThoriumResourceType();
    var defenseStructures = reactors.length ? safeFind(room, getHostileStructureFindConstant()) : [];

    for (var i = 0; i < reactors.length; i++) {
        var reactor = reactors[i];
        if (!reactor || !reactor.id) {
            continue;
        }

        var previous = memory.reactors[reactor.id];
        var ownerName = getOwnerName(reactor.owner);
        var record = previous || {};
        var wasMine = previous && previous.my === true;
        if (wasMine) record.priorContinuousWork = Math.max(record.priorContinuousWork || 0, record.continuousWork || 0);
        record.id = reactor.id;
        record.roomName = room.name;
        record.x = reactor.pos ? reactor.pos.x : null;
        record.y = reactor.pos ? reactor.pos.y : null;
        record.owner = ownerName;
        record.my = reactor.my === true;
        record.thorium = getStoreAmount(reactor, thoriumType);
        record.capacity = getStoreCapacity(reactor, thoriumType, REACTOR_CAPACITY) ||
            REACTOR_CAPACITY;
        record.continuousWork = Math.max(0, Number(reactor.continuousWork) || 0);
        record.hostileCreeps = hostileCount || 0;
        record.threatParts = threatParts || 0;
        record.hostileDefenseStructures = defenseStructures.filter(function(structure) {
            return structure.id !== reactor.id && !CombatPolicy.isAlly(structure);
        }).length;
        record.reactorThreat = Portfolio.classifyThreat(
            TickIndex.get().hostilesByRoom.get(room.name) || safeFind(room, getHostileCreepFindConstant()),
            reactor, CombatPolicy.isAlly);
        if (record.reactorThreat.ownershipThreat > 0) record.lastHostileTraffic = getTime();
        record.lastSeen = getTime();

        if (record.my) {
            record.everMine = true;
            clearAlert('STOLEN');
        }
        else if (wasMine && ownerName) {
            record.ownershipLosses = Math.min(10, (record.ownershipLosses || 0) + 1);
            record.lastOwnershipLoss = getTime();
            if (!CombatPolicy.isAlly(ownerName)) CombatPolicy.recordIncident(ownerName, 100,
                { roomName: room.name, type: 'reactor-theft', targetId: reactor.id });
            setAlert('STOLEN', room.name + ' by ' + ownerName, 1000);
        }

        memory.reactors[reactor.id] = record;
    }
}

function refreshVisibleReactor(room) {
    if (room && isObserving()) {
        var intel = ensureMemory().rooms[room.name] || {};
        observeReactors(
            room,
            intel.hostileCreeps || 0,
            intel.threatParts || 0
        );
    }
}

function getCpuLimit() {
    return typeof Game !== 'undefined' && Game.cpu &&
        typeof Game.cpu.limit === 'number' ? Math.max(1, Game.cpu.limit) : 1;
}

function getCpuBucket() {
    return typeof Game !== 'undefined' && Game.cpu &&
        typeof Game.cpu.bucket === 'number' ? Game.cpu.bucket : 10000;
}

function getRouteBudget() {
    var limit = getCpuLimit();
    var bucket = getCpuBucket();
    var config = ensureMemory().config;

    if (bucket < config.minimumCpuBucket) {
        return 0;
    }

    return Math.max(1, Math.min(6, Math.floor(limit / 15) + 1));
}

function routeKey(fromRoom, toRoom) {
    return fromRoom + '>' + toRoom;
}

function getLinearDistance(fromRoom, toRoom) {
    if (
        typeof Game !== 'undefined' &&
        Game.map &&
        typeof Game.map.getRoomLinearDistance === 'function'
    ) {
        try {
            return Game.map.getRoomLinearDistance(fromRoom, toRoom);
        }
        catch (error) {
            return null;
        }
    }

    return null;
}

function getRouteDistance(fromRoom, toRoom, force) {
    if (!fromRoom || !toRoom) {
        return null;
    }
    if (fromRoom === toRoom) {
        return 0;
    }

    var memory = ensureMemory();
    var key = routeKey(fromRoom, toRoom);
    var cached = memory.routes[key];
    var tick = getTime();

    if (
        cached &&
        !force &&
        cached.unreachableUntil > tick
    ) {
        return null;
    }
    if (
        cached &&
        !force &&
        typeof cached.distance === 'number' &&
        tick - cached.checkedAt < memory.config.routeCacheTtl
    ) {
        return cached.distance;
    }

    if (routeTick !== tick) {
        routeTick = tick;
        routeOps = 0;
    }

    if (
        routeOps >= getRouteBudget() ||
        typeof Game === 'undefined' ||
        !Game.map ||
        typeof Game.map.findRoute !== 'function'
    ) {
        return cached && typeof cached.distance === 'number' ?
            cached.distance : getLinearDistance(fromRoom, toRoom);
    }

    routeOps++;
    var route;
    try {
        var myUsername = getMyUsername();
        route = Game.map.findRoute(fromRoom, toRoom, {
            routeCallback: function(roomName) {
                var intel = memory.rooms[roomName];
                if (!intel) {
                    return 1;
                }
                if ((intel.threatParts || 0) > 0) {
                    return Infinity;
                }
                if (intel.controllerOwner &&
                    intel.controllerOwner !== myUsername) {
                    return 8;
                }
                return 1;
            }
        });
    }
    catch (error) {
        route = null;
    }

    var noPathCode = typeof ERR_NO_PATH !== 'undefined' ? ERR_NO_PATH : -2;
    if (!Array.isArray(route) || route === noPathCode) {
        memory.routes[key] = {
            fromRoom: fromRoom,
            toRoom: toRoom,
            distance: null,
            checkedAt: tick,
            unreachableUntil: tick + memory.config.routeFailureCooldown
        };
        setAlert('NO ROUTE', fromRoom + ' -> ' + toRoom,
            memory.config.routeFailureCooldown);
        return null;
    }

    memory.routes[key] = {
        fromRoom: fromRoom,
        toRoom: toRoom,
        distance: route.length,
        checkedAt: tick,
        unreachableUntil: 0
    };
    return route.length;
}

function noteRouteFailure(fromRoom, toRoom, detail) {
    var memory = ensureMemory();
    var key = routeKey(fromRoom, toRoom);
    memory.routes[key] = memory.routes[key] || {
        fromRoom: fromRoom,
        toRoom: toRoom
    };
    memory.routes[key].checkedAt = getTime();
    memory.routes[key].distance = null;
    memory.routes[key].unreachableUntil =
        getTime() + memory.config.routeFailureCooldown;
    setAlert('NO ROUTE', detail || (fromRoom + ' -> ' + toRoom),
        memory.config.routeFailureCooldown);
}

function getOwnedSpawnRooms() {
    var result = TickIndex.get().ownedSpawnRooms.slice();

    result.sort(function(a, b) {
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return result;
}

function chooseHomeRoom(targetRoomName, maximumDistance) {
    var rooms = getOwnedSpawnRooms();
    var best = null;

    for (var i = 0; i < rooms.length; i++) {
        var distance = getRouteDistance(rooms[i].name, targetRoomName);
        if (distance === null || distance > maximumDistance) {
            continue;
        }
        if (!best || distance < best.distance ||
            (distance === best.distance && rooms[i].name < best.roomName)) {
            best = { roomName: rooms[i].name, distance: distance };
        }
    }

    return best;
}

function northernTieBreaker(roomName) {
    var match = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName || '');
    if (!match) {
        return 0;
    }
    var amount = parseInt(match[4], 10) || 0;
    return match[3] === 'N' ? amount : -amount;
}

function scoutPriority(roomName) {
    if (!isObserving()) return 0;
    return northernTieBreaker(roomName);
}

function rankMiningTargets() {
    var memory = ensureMemory();
    var targets = [];
    var myUsername = getMyUsername();

    for (var roomName in memory.rooms) {
        if (!memory.rooms.hasOwnProperty(roomName)) {
            continue;
        }
        var roomIntel = memory.rooms[roomName];
        var thorium = roomIntel && roomIntel.thorium;
        if (!thorium || thorium.depleted || thorium.remaining <= 0) {
            continue;
        }

        var home = chooseHomeRoom(roomName, memory.config.maximumMiningRouteRooms);
        var hostilePenalty = (roomIntel.hostileCreeps || 0) * 100000 +
            (roomIntel.threatParts || 0) * 10000 +
            (roomIntel.hostileStructures || 0) * 1000;
        var ownedByOther = roomIntel.controllerOwner &&
            roomIntel.controllerOwner !== myUsername;
        var reservedByOther = roomIntel.controllerReservation &&
            roomIntel.controllerReservation !== myUsername;
        var intelAge = Math.max(0, getTime() - (roomIntel.lastSeen || 0));
        var completeSafetyIntel = typeof roomIntel.hostileCreeps === 'number' &&
            typeof roomIntel.hostileStructures === 'number' && typeof roomIntel.threatParts === 'number';
        var fresh = !!roomIntel.lastSeen && intelAge <= memory.config.intelMaxAge;
        var accessible = !!home && !ownedByOther && !reservedByOther && fresh && completeSafetyIntel &&
            roomIntel.hostileCreeps === 0 && roomIntel.hostileStructures === 0 && roomIntel.threatParts === 0;
        var routeDistance = home ? home.distance : null;
        var density = typeof thorium.density === 'number' && isFinite(thorium.density) ?
            Math.max(0, thorium.density) : null;
        var yieldScore = thorium.remaining * (1 + (density === null ? 0 : Math.min(10, density) * 0.1));

        targets.push({
            roomName: roomName,
            mineralId: thorium.id,
            remaining: thorium.remaining,
            density: density,
            depleted: false,
            accessible: accessible,
            homeRoom: home ? home.roomName : null,
            routeDistance: routeDistance,
            hostileCreeps: roomIntel.hostileCreeps || 0,
            threatParts: roomIntel.threatParts || 0,
            intelAge: intelAge,
            intelFresh: fresh,
            northernTieBreaker: northernTieBreaker(roomName),
            yieldScore: yieldScore,
            score: (accessible ? 1000000000000 : 0) + (yieldScore * 1000000) - hostilePenalty -
                ((routeDistance === null ? 1000 : routeDistance) * 1000) +
                northernTieBreaker(roomName)
        });
    }

    targets.sort(function(a, b) {
        if (a.accessible !== b.accessible) {
            return a.accessible ? -1 : 1;
        }
        if (a.threatParts !== b.threatParts) {
            return a.threatParts - b.threatParts;
        }
        if (b.yieldScore !== a.yieldScore) {
            return b.yieldScore - a.yieldScore;
        }
        if (b.remaining !== a.remaining) {
            return b.remaining - a.remaining;
        }
        if (a.routeDistance !== b.routeDistance) {
            if (a.routeDistance === null) {
                return 1;
            }
            if (b.routeDistance === null) {
                return -1;
            }
            return a.routeDistance - b.routeDistance;
        }
        if (b.northernTieBreaker !== a.northernTieBreaker) {
            return b.northernTieBreaker - a.northernTieBreaker;
        }
        return a.roomName < b.roomName ? -1 : 1;
    });
    return targets;
}

function findStagingStructure(room, mineral) {
    if (!room) {
        return null;
    }

    if (room.storage && room.storage.my !== false) {
        return room.storage;
    }
    if (room.terminal && room.terminal.my !== false) {
        return room.terminal;
    }

    var structureConstant = typeof FIND_STRUCTURES !== 'undefined' ?
        FIND_STRUCTURES : null;
    var containerType = typeof STRUCTURE_CONTAINER !== 'undefined' ?
        STRUCTURE_CONTAINER : 'container';
    var containers = safeFind(room, structureConstant, {
        filter: function(structure) {
            return structure && structure.structureType === containerType &&
                structure.store;
        }
    });

    if (mineral && mineral.pos && typeof mineral.pos.findClosestByRange === 'function') {
        return mineral.pos.findClosestByRange(containers) || null;
    }
    return containers.length > 0 ? containers[0] : null;
}

function hasActiveExtractor(room, mineral) {
    if (!room || !mineral || !mineral.pos) {
        return false;
    }

    var structures = [];
    if (typeof mineral.pos.lookFor === 'function' &&
        typeof LOOK_STRUCTURES !== 'undefined') {
        structures = mineral.pos.lookFor(LOOK_STRUCTURES) || [];
    }
    else {
        var findStructures = typeof FIND_STRUCTURES !== 'undefined' ?
            FIND_STRUCTURES : null;
        structures = safeFind(room, findStructures);
    }

    var extractorType = typeof STRUCTURE_EXTRACTOR !== 'undefined' ?
        STRUCTURE_EXTRACTOR : 'extractor';
    for (var i = 0; i < structures.length; i++) {
        var structure = structures[i];
        if (structure && structure.structureType === extractorType &&
            (!structure.pos || !structure.pos.isEqualTo ||
                structure.pos.isEqualTo(mineral.pos)) &&
            (typeof structure.isActive !== 'function' || structure.isActive())) {
            return true;
        }
    }
    return false;
}

function refreshMiningAssignments() {
    var memory = ensureMemory();
    var ranked = rankMiningTargets();
    var previousAssignments = memory.assignments.mining || {};
    var assignments = {};
    var maximum = Math.max(0, Math.min(5,
        Math.floor(Number(memory.config.maxMiningRooms) || 0)));
    var selected = 0;
    var healthyHomes = getOwnedSpawnRooms().filter(function(room) { return homeReadiness(room.name).healthy; }).length;
    var targetCount = Math.max(0, Math.min(Number(memory.config.maxActiveReactors) || 1,
        Object.keys(memory.reactors).length, healthyHomes));
    var desiredIncome = targetCount > 0 ? targetCount * 1.15 + 0.25 : 0;
    var selectedIncome = 0;

    for (var i = 0; i < ranked.length && selected < maximum && selectedIncome < desiredIncome; i++) {
        var target = ranked[i];
        if (!target.accessible || !target.homeRoom) {
            continue;
        }

        var visibleRoom = typeof Game !== 'undefined' && Game.rooms ?
            Game.rooms[target.roomName] : null;
        var mineral = visibleRoom && typeof Game.getObjectById === 'function' ?
            Game.getObjectById(target.mineralId) : null;
        var staging = visibleRoom ? findStagingStructure(visibleRoom, mineral) : null;
        var controllerReady = !!(
            visibleRoom &&
            visibleRoom.controller &&
            visibleRoom.controller.my
        );
        if (!controllerReady) {
            continue;
        }
        var extractorReady = controllerReady && hasActiveExtractor(visibleRoom, mineral);

        assignments[target.roomName] = {
            key: 'mine:' + target.roomName,
            roomName: target.roomName,
            mineralId: target.mineralId,
            homeRoom: target.homeRoom,
            routeDistance: target.routeDistance,
            remaining: target.remaining,
            stagingId: staging ? staging.id : null,
            ready: !!(controllerReady && extractorReady && staging),
            reason: !visibleRoom ? 'NO VISION' :
                !controllerReady ? 'NEEDS OWNED ROOM' :
                !extractorReady ? 'NO EXTRACTOR' :
                !staging ? 'NO STAGING' : 'READY',
            plannedAt: getTime()
        };
        selected++;
        selectedIncome += miningRate(assignments[target.roomName]);
    }

    /* Keep depleted routes only while their staging store still has cargo. */
    var thoriumType = getThoriumResourceType();
    for (var oldRoomName in previousAssignments) {
        if (!previousAssignments.hasOwnProperty(oldRoomName) ||
            assignments[oldRoomName]) {
            continue;
        }
        var oldAssignment = previousAssignments[oldRoomName];
        var oldStaging = oldAssignment && getObjectById(oldAssignment.stagingId);
        if (oldStaging && getStoreAmount(oldStaging, thoriumType) > 0) {
            oldAssignment.remaining = 0;
            oldAssignment.ready = false;
            oldAssignment.depleted = true;
            oldAssignment.reason = 'DRAINING STAGING';
            assignments[oldRoomName] = oldAssignment;
        }
    }

    memory.assignments.mining = assignments;
    memory.assignments.rankedMiningTargets = ranked.slice(0, 10);
    memory.reactorPortfolio.desiredMiningRooms = selected;
    memory.reactorPortfolio.desiredThoriumIncome = desiredIncome;
}

function rankReactors() {
    var memory = ensureMemory();
    var reactors = [];

    for (var id in memory.reactors) {
        if (!memory.reactors.hasOwnProperty(id)) {
            continue;
        }
        var record = memory.reactors[id];
        if (!record || !record.roomName) {
            continue;
        }
        var home = chooseHomeRoom(record.roomName,
            memory.config.maximumReactorRouteRooms);
        reactors.push({
            id: id,
            roomName: record.roomName,
            owner: record.owner,
            my: record.my === true,
            thorium: record.thorium || 0,
            continuousWork: record.continuousWork || 0,
            hostileCreeps: record.hostileCreeps || 0,
            threatParts: record.threatParts || 0,
            homeRoom: home ? home.roomName : null,
            routeDistance: home ? home.distance : null
        });
    }

    reactors.sort(function(a, b) {
        if (a.my !== b.my) {
            return a.my ? -1 : 1;
        }
        if (!!a.owner !== !!b.owner) {
            return a.owner ? 1 : -1;
        }
        if (a.threatParts !== b.threatParts) {
            return a.threatParts - b.threatParts;
        }
        if (a.routeDistance !== b.routeDistance) {
            if (a.routeDistance === null) {
                return 1;
            }
            if (b.routeDistance === null) {
                return -1;
            }
            return a.routeDistance - b.routeDistance;
        }
        return a.roomName < b.roomName ? -1 : 1;
    });
    return reactors;
}

function refreshSelectedReactor() {
    var memory = ensureMemory();
    var ranked = rankReactors();
    var selected = null;

    if (memory.config.reactorId && memory.reactors[memory.config.reactorId]) {
        selected = memory.reactors[memory.config.reactorId];
    }
    else if (memory.config.reactorRoom) {
        for (var i = 0; i < ranked.length; i++) {
            if (ranked[i].roomName === memory.config.reactorRoom) {
                selected = memory.reactors[ranked[i].id];
                break;
            }
        }
    }
    else if (ranked.length > 0) {
        selected = memory.reactors[ranked[0].id];
    }

    var oldId = memory.assignments.selectedReactorId;
    memory.assignments.selectedReactorId = selected ? selected.id : null;
    memory.assignments.selectedReactorRoom = selected ? selected.roomName : null;
    memory.assignments.rankedReactors = ranked.slice(0, 10);

    if (selected && oldId !== selected.id) {
        logEvent('REACTOR', 'selected ' + selected.roomName + ' (' + selected.id + ')');
    }
}

function selectReactor(idOrRoom) {
    var memory = ensureMemory();

    if (!idOrRoom || typeof idOrRoom !== 'string') {
        return { ok: false, reason: 'Expected a Reactor id or room name' };
    }

    if (memory.reactors[idOrRoom]) {
        memory.config.reactorId = idOrRoom;
        delete memory.config.reactorRoom;
    }
    else {
        memory.config.reactorRoom = idOrRoom;
        delete memory.config.reactorId;
    }

    refreshSelectedReactor();
    invalidateDiagnostics();
    return {
        ok: true,
        selectedReactorId: memory.assignments.selectedReactorId,
        selectedReactorRoom: memory.assignments.selectedReactorRoom
    };
}

function clearReactorSelection() {
    var memory = ensureMemory();
    delete memory.config.reactorId;
    delete memory.config.reactorRoom;
    memory.assignments.selectedReactorId = null;
    memory.assignments.selectedReactorRoom = null;
    invalidateDiagnostics();
    return { ok: true };
}

function cleanupStaleIntel(force) {
    var memory = ensureMemory();
    var tick = getTime();

    if (!force && tick - (memory.stats.lastCleanup || 0) <
        memory.config.cleanupInterval) {
        return;
    }

    memory.stats.lastCleanup = tick;
    for (var roomName in memory.rooms) {
        if (!memory.rooms.hasOwnProperty(roomName)) {
            continue;
        }
        var roomIntel = memory.rooms[roomName];
        var depleted = !!(roomIntel && roomIntel.thorium &&
            roomIntel.thorium.depleted);
        var maxAge = depleted ? memory.config.depletedIntelMaxAge :
            memory.config.intelMaxAge;
        if (!roomIntel || tick - (roomIntel.lastSeen || 0) > maxAge) {
            delete memory.rooms[roomName];
        }
    }

    for (var reactorId in memory.reactors) {
        if (
            memory.reactors.hasOwnProperty(reactorId) &&
            !memory.reactors[reactorId].everMine &&
            tick - (memory.reactors[reactorId].lastSeen || 0) >
                memory.config.intelMaxAge
        ) {
            delete memory.reactors[reactorId];
        }
    }

    var routes = [];
    for (var key in memory.routes) {
        if (!memory.routes.hasOwnProperty(key)) {
            continue;
        }
        var route = memory.routes[key];
        if (tick - (route.checkedAt || 0) > memory.config.routeCacheTtl * 4) {
            delete memory.routes[key];
        }
        else {
            routes.push({ key: key, checkedAt: route.checkedAt || 0 });
        }
    }

    routes.sort(function(a, b) { return b.checkedAt - a.checkedAt; });
    for (var i = memory.config.maxRouteCacheEntries; i < routes.length; i++) {
        delete memory.routes[routes[i].key];
    }

    for (var alertCode in memory.alerts) {
        if (
            memory.alerts.hasOwnProperty(alertCode) &&
            memory.alerts[alertCode].until <= tick
        ) {
            delete memory.alerts[alertCode];
        }
    }
    invalidateDiagnostics();
}

function getPlanningInterval() {
    var config = ensureMemory().config;
    var interval = Math.max(5, Number(config.planningInterval) || 50);
    var bucket = getCpuBucket();
    var limit = getCpuLimit();

    if (bucket < config.minimumCpuBucket) {
        return interval * 5;
    }
    if (limit >= 50 && bucket >= 7000) {
        return Math.max(5, Math.floor(interval / 2));
    }
    if (limit < 10 || bucket < 5000) {
        return interval * 2;
    }
    return interval;
}

function plan(force) {
    var memory = ensureMemory();
    if (!isObserving() || getCpuBucket() < memory.config.minimumCpuBucket) {
        return;
    }
    if (!force && getTime() - (memory.stats.lastPlan || 0) <
        getPlanningInterval()) {
        return;
    }

    memory.stats.lastPlan = getTime();
    refreshMiningAssignments();
    refreshSelectedReactor();
    refreshPortfolio(true);
    memory.assignments.plannedAt = getTime();
    invalidateDiagnostics();
}

function run() {
    var memory = ensureMemory();
    memory.stats.apiAvailable = isApiAvailable();
    memory.stats.claimApiAvailable = isClaimApiAvailable();

    cleanupStaleIntel(false);
    if (!isObserving()) {
        return getDiagnostics();
    }

    var rooms = TickIndex.get().visibleRooms.slice();
    var selectedReactorRoom = memory.assignments.selectedReactorRoom;
    rooms.sort(function(a, b) {
        var aSelected = a.name === selectedReactorRoom;
        var bSelected = b.name === selectedReactorRoom;
        if (aSelected !== bSelected) {
            return aSelected ? -1 : 1;
        }
        var aOwned = !!(a.controller && a.controller.my);
        var bOwned = !!(b.controller && b.controller.my);
        if (aOwned !== bOwned) {
            return aOwned ? -1 : 1;
        }
        var aSeen = memory.rooms[a.name] ? memory.rooms[a.name].lastSeen || 0 : 0;
        var bSeen = memory.rooms[b.name] ? memory.rooms[b.name].lastSeen || 0 : 0;
        if (aSeen !== bSeen) {
            return aSeen - bSeen;
        }
        return a.name < b.name ? -1 : 1;
    });

    var cpuUsed = typeof Game !== 'undefined' && Game.cpu &&
        typeof Game.cpu.getUsed === 'function' ? Game.cpu.getUsed() : 0;
    var cpuPressured = cpuUsed >= getCpuLimit() * 0.75;
    var scanBudget = Math.max(1, Math.min(rooms.length,
        Math.floor(getCpuLimit() / 10) + 1));
    if (getCpuBucket() < memory.config.minimumCpuBucket || cpuPressured) {
        scanBudget = Math.min(scanBudget, 1);
    }
    for (var i = 0; i < scanBudget; i++) {
        observeRoom(rooms[i], null, false);
    }

    // Ownership and CLAIM intel for every portfolio Reactor survive the scan budget.
    var refreshed = {};
    for (var knownId in memory.reactors) {
        var knownRoom = memory.reactors[knownId].roomName;
        if (!refreshed[knownRoom] && Game.rooms[knownRoom]) {
            refreshVisibleReactor(Game.rooms[knownRoom]);
            refreshed[knownRoom] = true;
        }
    }
    if (!cpuPressured) {
        plan(false);
    }
    refreshPortfolio(false, cpuPressured);
    updateOperationalAlerts();
    return getDiagnostics();
}

function scoreRate(continuousWork) {
    var work = Math.floor(Number(continuousWork) || 0);
    return work > 0 ? 1 + Math.floor(Math.log10(work)) : 0;
}

function thoriumAgingMultiplier(totalThoriumOnTile) {
    var total = Math.max(0, Math.floor(Number(totalThoriumOnTile) || 0));
    return total > 0 ? Math.max(0, Math.floor(Math.log10(total))) : 0;
}

function observeTileThorium(pos, fallbackAmount) {
    var fallback = Math.max(1, Math.floor(Number(fallbackAmount) ||
        Number(ensureMemory().config.agingFallbackThorium) || 1000));
    var thorium = getThoriumResourceType();
    if (!thorium || !pos || typeof pos.look !== 'function') {
        return { total: fallback, multiplier: thoriumAgingMultiplier(fallback), observable: false, source: 'fallbackEstimate' };
    }
    var entries;
    try { entries = pos.look() || []; }
    catch (error) {
        return { total: fallback, multiplier: thoriumAgingMultiplier(fallback), observable: false, source: 'fallbackEstimate' };
    }
    var total = 0;
    var seen = {};
    for (var i = 0; i < entries.length; i++) {
        var entry = entries[i] || {};
        var target = entry.resource || entry.mineral || entry.creep || entry.structure || entry.tombstone || entry.ruin;
        if (!target) continue;
        var key = target.id || target.name || ('entry:' + i);
        if (seen[key]) continue;
        seen[key] = true;
        if (target.mineralType !== undefined) {
            if (target.mineralType === thorium) {
                total += Math.max(0, Number(target.mineralAmount) || 0);
            }
        }
        else if (target.resourceType === thorium) total += Math.max(0, Number(target.amount) || 0);
        else total += getStoreAmount(target, thorium);
    }
    return { total: total, multiplier: thoriumAgingMultiplier(total), observable: true, source: 'tileLook' };
}

function estimateStarvation(reactorThorium, deliveryEta) {
    var ticksUntilEmpty = Math.max(0, Math.floor(Number(reactorThorium) || 0));
    var eta = typeof deliveryEta === 'number' && isFinite(deliveryEta) ?
        Math.max(0, Math.floor(deliveryEta)) : null;
    return {
        ticksUntilEmpty: ticksUntilEmpty,
        deliveryEta: eta,
        starving: ticksUntilEmpty <= 0 || eta === null || eta >= ticksUntilEmpty
    };
}

function calculateHaulerDemand(routeDistance, carryCapacity, lifetime, safetyMargin) {
    var oneWay = Math.max(1, Math.floor(Number(routeDistance) || 0));
    var capacity = Math.max(1, Math.floor(Number(carryCapacity) || 0));
    var life = Math.max(1, Math.floor(Number(lifetime) || 1500));
    var margin = Math.max(1, Number(safetyMargin) || 1);
    var roundTrip = (oneWay * 2) + 10;
    var throughputDemand = Math.ceil((roundTrip * margin) / capacity);
    var usableLife = Math.max(1, life - oneWay - 100);
    var trips = Math.max(1, Math.floor(usableLife / roundTrip));
    var lifetimeDemand = Math.ceil((life * margin) / (trips * capacity));

    return Math.max(1, throughputDemand, lifetimeDemand);
}

function getAssignmentCount(assignmentKey, includeQueued) {
    var count = 0;
    var index = TickIndex.get();
    var role = assignmentKey.indexOf('mine:') === 0 ? 'ThoriumMiner' :
        assignmentKey.indexOf('haul:') === 0 ? 'ThoriumHauler' : 'ReactorClaimer';
    var scopedCreeps = index.creepsByRole.get(role) || [];
    for (var creepIndex = 0; creepIndex < scopedCreeps.length; creepIndex++) {
        var creep = scopedCreeps[creepIndex];
        if (creep && creep.memory &&
            creep.memory.season11AssignmentKey === assignmentKey) {
            var routeDistance = Number(
                creep.memory.season11RouteDistance
            ) || 0;
            if (creep.memory.role === 'ThoriumMiner') {
                routeDistance *= 50;
            }
            var spawnTime = Array.isArray(creep.body) ?
                creep.body.length * 3 : 0;
            var observedAging = Math.max(1, Number(creep.memory.season11AgingMultiplier) ||
                thoriumAgingMultiplier(ensureMemory().config.agingFallbackThorium));
            var replacementLead = spawnTime + (routeDistance * observedAging) +
                ensureMemory().config.haulerReplacementMargin;
            if (creep.ticksToLive === undefined ||
                creep.ticksToLive > replacementLead) {
                count++;
            }
        }
    }

    if (!includeQueued) {
        return count;
    }
    for (var requestIndex = 0;
        requestIndex < index.spawnRequests.length;
        requestIndex++) {
        var request = index.spawnRequests[requestIndex];
        if (request && request.memory &&
            request.memory.season11AssignmentKey === assignmentKey) {
            count++;
        }
    }
    return count;
}

function roomHasEssentialEconomy(room) {
    if (!room || !room.controller || !room.controller.my || !room.storage) {
        return false;
    }

    var energyType = typeof RESOURCE_ENERGY !== 'undefined' ?
        RESOURCE_ENERGY : 'energy';
    if (getStoreAmount(room.storage, energyType) <
        ensureMemory().config.minimumStorageEnergy) {
        return false;
    }

    var roles = { Foreman: 0, Extractor: 0, Freighter: 0 };
    var creeps = TickIndex.get().creepsByHomeRoom.get(room.name) || [];
    for (var creepIndex = 0; creepIndex < creeps.length; creepIndex++) {
        var creep = creeps[creepIndex];
        if (!creep || !creep.memory || !roles.hasOwnProperty(creep.memory.role)) {
            continue;
        }
        if (!creep.spawning && (!creep.ticksToLive || creep.ticksToLive > 100)) {
            roles[creep.memory.role]++;
        }
    }
    return roles.Foreman > 0 && roles.Extractor > 0 && roles.Freighter > 0;
}

function getSelectedReactorRecord() {
    var memory = ensureMemory();
    return memory.assignments.selectedReactorId ?
        memory.reactors[memory.assignments.selectedReactorId] || null : null;
}

function mayClaimReactor(reactor) {
    if (!reactor || reactor.my === true) {
        return false;
    }
    var memory = ensureMemory();
    var entry = memory.reactorPortfolio.reactors[reactor.id];
    var record = memory.reactors[reactor.id];
    if (record && getTime() < (record.recaptureCooldownUntil || 0)) return false;
    if (entry) {
        if (!entry.active || !entry.claimReady) return false;
        if (reactor.owner) return !!(entry.recapture && entry.recapture.approved &&
            CombatPolicy.mayLaunchOffense(reactor, memory.config.recaptureMode === 'manual' && memory.config.recapture === true));
        return true;
    }
    // Legacy console/role compatibility before the first portfolio plan.
    return !reactor.owner || memory.config.recapture === true &&
        memory.config.recaptureMode === 'manual' && CombatPolicy.mayLaunchOffense(reactor, true);
}

function makeMinerPlan(assignment) {
    return {
        role: 'ThoriumMiner',
        desired: 1,
        priority: 35,
        assignmentKey: assignment.key,
        memory: {
            season11AssignmentKey: assignment.key,
            season11SourceRoom: assignment.roomName,
            season11MineralId: assignment.mineralId,
            season11StagingId: assignment.stagingId,
            season11RouteDistance: assignment.routeDistance
        }
    };
}

function makeClaimerPlan(homeRoom, reactor) {
    var key = 'claim:' + reactor.id;
    return {
        role: 'ReactorClaimer',
        desired: 1,
        priority: 86,
        assignmentKey: key,
        memory: {
            season11AssignmentKey: key,
            season11ReactorId: reactor.id,
            season11ReactorRoom: reactor.roomName
        },
        homeRoom: homeRoom
    };
}

function getRouteAgingEstimate(assignment, reactor) {
    if (agingRouteTick !== getTime()) {
        agingRouteTick = getTime();
        agingRoutes = {};
        var creeps = TickIndex.get().allCreeps;
        for (var i = 0; i < creeps.length; i++) {
            var cm = creeps[i] && creeps[i].memory;
            if (!cm || cm.role !== 'ThoriumHauler' || cm.season11AgingEstimateSource !== 'tileLook') continue;
            var key = cm.season11SourceRoom + '>' + cm.season11ReactorId;
            var observed = Number(cm.season11ObservedTileThorium);
            if (isFinite(observed) && observed >= 0) agingRoutes[key] = Math.max(agingRoutes[key] || 0, observed);
        }
    }
    var maximumObserved = agingRoutes[assignment.roomName + '>' + reactor.id];
    if (maximumObserved !== undefined) {
        return {
            total: maximumObserved,
            multiplier: thoriumAgingMultiplier(maximumObserved),
            observable: true,
            source: 'liveRouteObservation'
        };
    }
    return observeTileThorium(null, ensureMemory().config.agingFallbackThorium);
}

function makeHaulerPlan(homeRoom, assignment, reactor, emergency) {
    var routeRooms = getRouteDistance(assignment.roomName, reactor.roomName);
    if (routeRooms === null) {
        return null;
    }
    var routeTiles = Math.max(25, routeRooms * 50);
    var requestedCarryParts = Math.min(25, Math.max(2,
        Math.ceil((routeTiles * 2 *
            ensureMemory().config.haulerSafetyMargin) / 50)));
    var expectedCarryCapacity = requestedCarryParts * 50;
    /* Reuse the highest current live observation from this route when one is
       available. Otherwise use the configured estimate; carry capacity is not
       a proxy for tile Thorium. Live Season 11 observations are required to
       tune this fallback for the shard. */
    var agingEstimate = getRouteAgingEstimate(assignment, reactor);
    var thoriumAging = agingEstimate.multiplier;
    var effectiveLifetime = Math.max(1,
        Math.floor(1500 / Math.max(1, thoriumAging)));
    if (routeTiles + ensureMemory().config.haulerReplacementMargin >=
        effectiveLifetime) {
        setAlert('NO ROUTE', assignment.roomName + ' -> ' +
            reactor.roomName + ' exceeds loaded creep life', 500);
        return null;
    }
    var desired = calculateHaulerDemand(
        routeTiles,
        expectedCarryCapacity,
        effectiveLifetime,
        ensureMemory().config.haulerSafetyMargin
    );
    desired = Math.min(ensureMemory().config.maxHaulersPerRoute, desired);
    var key = 'haul:' + assignment.roomName + ':' + reactor.id;

    return {
        role: 'ThoriumHauler',
        desired: desired,
        priority: emergency ? 72 : 42,
        emergency: emergency,
        requestedCarryParts: requestedCarryParts,
        assignmentKey: key,
        memory: {
            season11AssignmentKey: key,
            season11SourceRoom: assignment.roomName,
            season11StagingId: assignment.stagingId,
            season11ReactorId: reactor.id,
            season11ReactorRoom: reactor.roomName,
            season11RouteDistance: routeTiles,
            season11AgingThorium: agingEstimate.total,
            season11AgingMultiplier: thoriumAging,
            season11AgingEstimateSource: agingEstimate.source
        },
        homeRoom: homeRoom
    };
}

function hasViableHaulRoute(reactor) {
    var assignments = ensureMemory().assignments.mining;

    for (var sourceRoom in assignments) {
        if (!assignments.hasOwnProperty(sourceRoom)) {
            continue;
        }
        var assignment = assignments[sourceRoom];
        if (!assignment || !assignment.stagingId) {
            continue;
        }
        var home = chooseHomeRoom(
            assignment.roomName,
            ensureMemory().config.maximumMiningRouteRooms
        );
        if (home && makeHaulerPlan(home.roomName, assignment, reactor, false)) {
            return true;
        }
    }
    return false;
}

function homeReadiness(roomName) {
    var room = Game.rooms[roomName];
    var index = TickIndex.get();
    var snapshot = Economy.get(roomName);
    var healthy = roomHasEssentialEconomy(room) && Economy.canSpend(roomName, 'special') &&
        (!snapshot || !snapshot.harvest || !snapshot.harvest.workRequired ||
            Economy.localHarvestCoverage(snapshot).status === 'HEALTHY') &&
        (!room.controller || !room.controller.ticksToDowngrade || room.controller.ticksToDowngrade > 3000);
    var spawns = index.ownedSpawnsByRoom.get(roomName) || [];
    var queued = (index.spawnRequestsByRoom.get(roomName) || []).reduce(function(sum, request) {
        return sum + (request.body ? request.body.length * 3 : 150);
    }, 0);
    var busy = spawns.reduce(function(sum, spawn) { return sum + (spawn.spawning ? spawn.spawning.remainingTime || 150 : 0); }, 0);
    var pressure = Math.min(1, (queued + busy) / Math.max(1, spawns.length * 600));
    var combatCommitted = (index.creepsByHomeRoom.get(roomName) || []).filter(function(creep) {
        var cm = creep.memory || {};
        var op = cm.operationId && HiveMemory.ensure().operations[cm.operationId];
        return ['Volley', 'Cleric', 'Ronin'].indexOf(cm.role) >= 0 && !cm.season11ReactorGuard && !(op && op.season11);
    }).length;
    var defenseSlots = Math.max(0, spawns.length - Math.floor(combatCommitted / 4));
    return { healthy: !!healthy, spawnPressure: pressure,
        combatReady: !!(healthy && spawns.length && room.energyCapacityAvailable >= 1300 &&
            Economy.canSpend(roomName, 'combat') && pressure < 0.75 && defenseSlots > 0), defenseSlots: defenseSlots };
}

function miningRate(assignment) {
    var room = Game.rooms[assignment.homeRoom];
    if (!room || !assignment.ready || assignment.remaining <= 0) return 0;
    var body = BodyConfig.getBody('ThoriumMiner', room) || [];
    var work = body.filter(function(p) { return p === 'work'; }).length;
    var carry = body.filter(function(p) { return p === 'carry'; }).length * 50;
    var mineral = getObjectById(assignment.mineralId);
    var staging = getObjectById(assignment.stagingId);
    var distance = mineral && mineral.pos && staging && staging.pos ?
        Math.max(Math.abs(mineral.pos.x - staging.pos.x), Math.abs(mineral.pos.y - staging.pos.y)) : 25;
    var cooldown = typeof EXTRACTOR_COOLDOWN !== 'undefined' ? EXTRACTOR_COOLDOWN : 5;
    var power = typeof HARVEST_MINERAL_POWER !== 'undefined' ? HARVEST_MINERAL_POWER : 1;
    var production = work * power / (cooldown + 1);
    var cycle = carry / Math.max(0.01, production);
    return Math.min(assignment.remaining / ensureMemory().config.supplyHorizon,
        production * cycle / Math.max(1, cycle + distance * 2 + 2));
}

function recordClaimFailure(record, reason) {
    var config = ensureMemory().config;
    record.recaptureFailures = Math.min(10, (record.recaptureFailures || 0) + 1);
    record.lastFailureTick = getTime();
    record.recaptureCooldownUntil = getTime() + Math.min(config.maximumClaimBackoff,
        config.claimCooldown * Math.pow(2, record.recaptureFailures));
    record.failureReason = reason;
    if (record.claimantName) record.failedClaimantName = record.claimantName;
    delete record.claimantName;
    delete record.claimAttemptDeadline;
}

function refreshPortfolio(force, cpuPressured) {
    var memory = ensureMemory(), config = memory.config, p = memory.reactorPortfolio;
    var index = TickIndex.get(), tick = getTime();
    var cpuSafe = !cpuPressured && getCpuBucket() >= config.minimumCpuBucket;
    var rescore = cpuSafe && (force || !p.plannedAt || tick - p.plannedAt >= config.portfolioInterval);
    var homes = {}, candidates = [], assignments = Object.values(memory.assignments.mining);
    if (rescore) {
        p.candidateIds = Object.keys(memory.reactors).filter(function(id) {
            var record = memory.reactors[id];
            return record.my || tick - (record.lastSeen || 0) <= config.intelMaxAge;
        }).sort(function(a, b) {
            var left = memory.reactors[a], right = memory.reactors[b];
            return Number(!!right.my) - Number(!!left.my) ||
                Number(b === config.reactorId || right.roomName === config.reactorRoom) -
                Number(a === config.reactorId || left.roomName === config.reactorRoom) ||
                Number(!!right.everMine) - Number(!!left.everMine) ||
                (p.reactors[b] && p.reactors[b].continuityValue || 0) -
                (p.reactors[a] && p.reactors[a].continuityValue || 0) ||
                (right.lastSeen || 0) - (left.lastSeen || 0) || a.localeCompare(b);
        }).slice(0, Math.max(5, Math.min(24, Number(config.maxPortfolioCandidates) || 12)));
        Object.keys(p.reactors).forEach(function(id) { if (p.candidateIds.indexOf(id) < 0) delete p.reactors[id]; });
    }
    var cargo = {}, eta = {}, claimants = {}, liveMiners = {}, liveHaulers = {};
    // One indexed creep pass, never one empire scan per Reactor.
    index.allCreeps.forEach(function(creep) {
        var cm = creep && creep.memory;
        if (!cm) return;
        var id = cm.season11ReactorId;
        if (cm.role === 'ThoriumMiner' && !creep.spawning && creep.ticksToLive > 100 &&
            creep.room && creep.room.name === cm.season11SourceRoom) {
            liveMiners[cm.season11SourceRoom] = (liveMiners[cm.season11SourceRoom] || 0) +
                (creep.body || []).filter(function(part) { return part.type === 'work' && part.hits !== 0; }).length;
        }
        if (cm.role === 'ReactorClaimer' && id) claimants[id] = creep.name;
        if (cm.role !== 'ThoriumHauler' || !id) return;
        if (!creep.spawning && creep.ticksToLive > (cm.season11RouteDistance || 0) + 100) {
            if (!liveHaulers[id]) liveHaulers[id] = {};
            liveHaulers[id][cm.season11SourceRoom] = (liveHaulers[id][cm.season11SourceRoom] || 0) +
                (creep.body || []).filter(function(part) { return part.type === 'carry' && part.hits !== 0; }).length * 50;
        }
        var amount = getStoreAmount(creep, getThoriumResourceType());
        cargo[id] = (cargo[id] || 0) + amount;
        if (amount > 0 && tick - (cm.season11EtaTick || 0) <= 2 && typeof cm.season11DeliveryEta === 'number') {
            eta[id] = Math.min(eta[id] === undefined ? Infinity : eta[id], cm.season11DeliveryEta);
        }
    });
    if (rescore) index.ownedSpawnRooms.forEach(function(room) { homes[room.name] = homeReadiness(room.name); });
    for (var id of p.candidateIds || []) {
        var r = memory.reactors[id];
        if (!r) continue;
        if (!r.my && tick - (r.lastSeen || 0) > config.intelMaxAge) {
            delete p.reactors[id];
            continue;
        }
        var entry = p.reactors[id] || { reactorId: id, roomName: r.roomName, routes: [], active: false };
        if (!p.reactors[id] && !rescore) continue;
        if (r.my) {
            r.recaptureFailures = 0; r.recaptureCooldownUntil = 0;
            delete r.claimAttemptDeadline; delete r.claimantName;
            delete r.failedClaimantName;
        }
        else {
            if (r.lastFailureTick && tick - r.lastFailureTick > config.recaptureFailureWindow) {
                r.recaptureFailures = 0; delete r.lastFailureTick; delete r.failureReason;
            }
            if (r.failedClaimantName && claimants[id] !== r.failedClaimantName) delete r.failedClaimantName;
            if (claimants[id] && claimants[id] !== r.failedClaimantName) {
                if (!r.claimantName) {
                    r.lastRecaptureAttempt = tick;
                    r.claimAttemptDeadline = tick + 900;
                }
                r.claimantName = claimants[id];
            }
            else if (r.claimantName) recordClaimFailure(r, 'claimant disappeared before ownership confirmed');
            if (r.claimAttemptDeadline && tick > r.claimAttemptDeadline) recordClaimFailure(r, 'claim attempt timed out');
        }
        var fresh = tick - (r.lastSeen || 0) <= 2 && !!Game.rooms[r.roomName];
        var threat = fresh ? r.reactorThreat || {} : {};
        Object.assign(entry, Portfolio.continuity(r.my ? r.continuousWork : r.priorContinuousWork || 0));
        entry.owned = r.my === true; entry.owner = r.owner; entry.continuousWork = r.continuousWork || 0;
        entry.thoriumBuffer = r.thorium || 0; entry.ticksUntilEmpty = Math.max(0, entry.thoriumBuffer - (tick - (r.lastSeen || tick)));
        entry.threat = threat; entry.fresh = fresh; entry.inTransit = cargo[id] || 0;
        entry.defenseStructures = r.hostileDefenseStructures === undefined ?
            (memory.rooms[r.roomName] || {}).hostileStructures || 0 : r.hostileDefenseStructures;
        if (rescore) {
            var home = chooseHomeRoom(r.roomName, config.maximumReactorRouteRooms);
            entry.homeRoom = home && home.roomName;
            entry.responseTicks = home ? home.distance * 50 : 1000;
            var exits = Game.map && typeof Game.map.describeExits === 'function' ? Game.map.describeExits(r.roomName) : null;
            entry.nearbyHostileOwners = Object.values(exits || {}).filter(function(roomName) {
                var intel = memory.rooms[roomName];
                return intel && intel.controllerOwner && CombatPolicy.isExplicitHostile(intel.controllerOwner);
            }).length;
            entry.routes = [];
            assignments.forEach(function(a) {
                if (!a.stagingId || !homes[a.homeRoom] || !homes[a.homeRoom].healthy) return;
                var plan = makeHaulerPlan(a.homeRoom, a, r, false);
                if (!plan) return;
                var verified = memory.routes[routeKey(a.roomName, r.roomName)];
                if (a.roomName !== r.roomName && (!verified || verified.distance === null ||
                    verified.unreachableUntil > tick || tick - verified.checkedAt > config.routeCacheTtl * 2)) return;
                var body = BodyConfig.getThoriumHaulerBodyForCarry(Game.rooms[a.homeRoom], plan.requestedCarryParts) || [];
                var capacity = body.filter(function(part) { return part === 'carry'; }).length * 50;
                var tiles = plan.memory.season11RouteDistance;
                var life = Math.floor(1500 / Math.max(1, plan.memory.season11AgingMultiplier));
                var replacement = body.length * 3 + config.haulerReplacementMargin +
                    Math.ceil(homes[a.homeRoom].spawnPressure * 600);
                var reliability = Math.max(0.25, 1 - tiles / Math.max(1, life) * 0.4 -
                    ((r.lastHostileTraffic || 0) > tick - 1000 ? 0.2 : 0) -
                    (entry.nearbyHostileOwners > 0 ? 0.1 : 0));
                var throughput = Math.min(miningRate(a), plan.desired * capacity / (tiles * 2 + 10)) * reliability;
                var stored = getStoreAmount(getObjectById(a.stagingId), getThoriumResourceType());
                if (capacity <= 0 || throughput <= 0 && stored <= 0) return;
                entry.routes.push({ sourceRoom: a.roomName, stagingId: a.stagingId, homeRoom: a.homeRoom,
                    throughput: throughput, remaining: Math.max(0, a.remaining || 0), deliveryEta: tiles,
                    replacementDelay: replacement, roundTrip: tiles * 2 + 10, reliability: reliability,
                    defenseRisk: threat.ownershipThreat || 0, capacity: capacity, haulerCount: plan.desired,
                    minerWork: (BodyConfig.getBody('ThoriumMiner', Game.rooms[a.homeRoom]) || []).filter(function(part) {
                        return part === 'work'; }).length });
            });
            entry.routes.sort(function(a, b) { return a.deliveryEta - b.deliveryEta || a.sourceRoom.localeCompare(b.sourceRoom); });
            entry.lastEvaluated = tick;
        }
        var readiness = homes[entry.homeRoom] || (entry.homeRoom ?
            (homes[entry.homeRoom] = homeReadiness(entry.homeRoom)) : {});
        entry.healthy = !!readiness.healthy; entry.combatReady = !!readiness.combatReady;
        entry.spawnPressure = readiness.spawnPressure || 0;
        entry.deliveryEta = eta[id] === undefined ? null : eta[id];
        entry.starvationRisk = estimateStarvation(entry.ticksUntilEmpty, entry.deliveryEta).starving;
        entry.defenseTier = Portfolio.defense(Object.assign({}, entry, threat, {
            previousLosses: r.ownershipLosses || 0,
            routeThreat: entry.nearbyHostileOwners > 0 || tick - (r.lastHostileTraffic || -10000) < 1000 ? 1 : 0 }));
        p.reactors[id] = entry;
        candidates.push(entry);
    }
    // Drop obsolete entries; the underlying everMine intel is retained separately.
    Object.keys(p.reactors).forEach(function(id) { if (!memory.reactors[id]) delete p.reactors[id]; });
    candidates.sort(function(a, b) {
        var aPinned = a.reactorId === config.reactorId || a.roomName === config.reactorRoom;
        var bPinned = b.reactorId === config.reactorId || b.roomName === config.reactorRoom;
        return Number(b.owned) - Number(a.owned) || (!a.owned ? Number(bPinned) - Number(aPinned) : 0) || Portfolio.fuelOrder(a, b);
    });
    var ledger = {}, sourceIncome = {}, sourceRemaining = {}, protectedCount = 0;
    var maximum = Math.max(0, Math.min(5, Math.floor(config.maxActiveReactors)));
    var healthyCount = rescore ? Object.values(homes).filter(function(h) { return h.healthy && h.combatReady; }).length : p.healthyColonies || 0;
    if (rescore) p.healthyColonies = healthyCount;
    // Source budgets are shared across the portfolio: never count one miner twice.
    candidates.forEach(function(e) { (e.routes || []).forEach(function(route) {
        var assignment = memory.assignments.mining[route.sourceRoom];
        var sourceIntel = memory.rooms[route.sourceRoom] || {};
        var cachedRoute = memory.routes[routeKey(route.sourceRoom, e.roomName)];
        if (!assignment || !assignment.ready || assignment.remaining <= 0 || sourceIntel.threatParts > 0 ||
            cachedRoute && cachedRoute.unreachableUntil > tick) route.throughput = 0;
        route.remaining = assignment ? Math.max(0, assignment.remaining || 0) : 0;
        sourceIncome[route.sourceRoom] = Math.max(sourceIncome[route.sourceRoom] || 0, route.throughput);
        sourceRemaining[route.sourceRoom] = Math.max(sourceRemaining[route.sourceRoom] || 0, route.remaining);
    }); });
    var totalThroughput = Object.values(sourceIncome).reduce(function(sum, n) { return sum + n; }, 0);
    var totalRemaining = Object.values(sourceRemaining).reduce(function(sum, n) { return sum + n; }, 0);
    var capacity = Portfolio.sustainableCount({ throughput: totalThroughput, remaining: totalRemaining,
        opportunities: candidates.length, healthyColonies: healthyCount, spawnCapacity: healthyCount,
        defenseCapacity: healthyCount, maximum: maximum, cpuSafe: cpuSafe, horizon: config.supplyHorizon });
    // Low CPU freezes optional growth, but current supply allocation and ownership still change.
    if (!cpuSafe) capacity = Math.min(p.sustainableCount || 0, Math.floor(totalThroughput));
    p.sustainableCount = capacity;
    p.sustainableThoriumDeliveryPerTick = Math.round(totalThroughput * 1000) / 1000;
    p.desiredActiveCount = Math.min(maximum, Math.max(candidates.length && healthyCount ? 1 : 0, capacity));
    p.expansionDeferred = !cpuSafe;
    candidates.forEach(function(e, candidateIndex) {
        var r = memory.reactors[e.reactorId], usedSources = [];
        e.active = false; e.fuelPriority = candidateIndex + 1; e.reservedThorium = 0;
        e.allocatedThroughput = 0; e.assignedMiningRooms = [];
        var eligible = e.healthy && (e.fresh || e.owned) && (e.owned || !e.owner || r.everMine || config.recaptureMode === 'manual') &&
            !(e.owner && !e.owned && CombatPolicy.isAlly(e.owner));
        var slots = protectedCount < p.desiredActiveCount && (cpuSafe || e.wasActive);
        if (eligible && slots) {
            var need = 1;
            (e.routes || []).forEach(function(route) {
                if (need <= 0) return;
                var amount = Math.min(need, sourceIncome[route.sourceRoom] || 0, route.throughput);
                if (amount > 0 || !usedSources.length) {
                    usedSources.push({ route: route, amount: amount });
                    e.allocatedThroughput += amount; need -= amount;
                }
            });
            // One bootstrap target may build its reserve while production ramps up.
            e.active = usedSources.length > 0 && (e.allocatedThroughput >= 0.999 || protectedCount === 0) ||
                e.owned && e.thoriumBuffer > 0 && protectedCount === 0;
        }
        e.startup = usedSources.reduce(function(worst, allocation) {
            var reserve = Portfolio.startupReserve(allocation.route, config);
            return reserve.required > worst.required ? reserve : worst;
        }, Portfolio.startupReserve({}, config));
        if (e.active) {
            var wanted = Math.max(0, (e.startup ? e.startup.reserve : config.startupReserve) -
                (e.owned ? e.thoriumBuffer : 0) - e.inTransit);
            usedSources.forEach(function(allocation) {
                var route = allocation.route;
                sourceIncome[route.sourceRoom] = Math.max(0, (sourceIncome[route.sourceRoom] || 0) - allocation.amount);
                e.assignedMiningRooms.push(route.sourceRoom);
                var granted = Portfolio.reserveFuel(ledger, route.stagingId, e.reactorId,
                    getStoreAmount(getObjectById(route.stagingId), getThoriumResourceType()), wanted);
                e.reservedThorium += granted; wanted -= granted;
            });
            protectedCount++;
        }
        var remaining = usedSources.reduce(function(sum, a) { return sum + a.route.remaining; }, 0);
        var required = e.startup ? e.startup.reserve : config.startupReserve;
        e.pipelineReady = usedSources.length > 0 && usedSources.every(function(a) {
            return liveMiners[a.route.sourceRoom] >= a.route.minerWork && liveHaulers[e.reactorId] &&
                liveHaulers[e.reactorId][a.route.sourceRoom] * a.route.reliability / a.route.roundTrip >= a.amount;
        });
        e.claimReady = !!(!e.owned && e.active && e.fresh && e.startup && e.startup.feasible &&
            e.allocatedThroughput >= 0.999 && e.reservedThorium >= required &&
            e.combatReady && isClaimApiAvailable() && getTime() >= (r.recaptureCooldownUntil || 0));
        e.recapture = Portfolio.recapture(Object.assign({}, e, {
            mode: config.recaptureMode, manual: config.recapture === true, everMine: r.everMine,
            ally: !!(e.owner && CombatPolicy.isAlly(e.owner)), policyAllowed: !!(e.owner &&
                CombatPolicy.mayLaunchOffense(e.owner, config.recaptureMode === 'manual' && config.recapture === true)),
            tick: tick, cooldownUntil: r.recaptureCooldownUntil || 0, failures: r.recaptureFailures || 0,
            viable: e.claimReady, throughput: e.allocatedThroughput, reserve: e.reservedThorium,
            startupReserve: required, remaining: remaining,
            enemyDefense: (e.threat.combatThreat || 0) + (e.threat.supportThreat || 0) +
                e.defenseStructures * 20,
            maximumDefense: config.maximumRecaptureDefense }));
        e.recapture.preparing = !!(e.owner && !e.owned && e.recapture.approved && !e.pipelineReady);
        if (e.recapture.preparing) {
            e.recapture.approved = false;
            e.recapture.reason = 'prepare live mining and hauling pipeline before recapture';
        }
        if (e.owner && !e.owned && !e.recapture.approved && !e.recapture.preparing) {
            e.claimReady = false;
            if (e.active) {
                usedSources.forEach(function(a) { sourceIncome[a.route.sourceRoom] += a.amount; });
                Object.values(ledger).forEach(function(store) { delete store.reactors[e.reactorId]; });
                e.reservedThorium = 0;
                e.active = false;
                protectedCount--;
            }
        }
        e.claimReady = e.claimReady && e.pipelineReady;
        // An approved fight still must be won before sending a fragile claimant.
        e.claimReady = e.claimReady && !(e.threat.combatThreat > 0 || e.threat.supportThreat > 0 ||
            e.threat.claimThreat > 0 || e.defenseStructures > 0);
        e.recaptureCooldownUntil = r.recaptureCooldownUntil || 0;
        e.state = e.recapture.preparing ? 'MUSTERING' : e.owner && !e.owned && !e.recapture.approved ? 'RECOVERING' :
            !e.active ? 'HOLD_OFF' : e.owned ? (e.starvationRisk ? 'SUPPLYING' : 'HOLDING') :
            e.owner ? (e.recapture.approved ? 'CONTESTING' : 'RECOVERING') : e.claimReady ? 'CLAIMING' : 'MUSTERING';
        e.reason = e.owner && !e.owned ? e.recapture.reason :
            !e.active ? 'protect higher-value continuity; capacity or economy limited' : e.state;
        e.wasActive = e.active;
    });
    p.activeReactorIds = candidates.filter(function(e) { return e.active; }).map(function(e) { return e.reactorId; });
    var primary = candidates.find(function(e) { return e.active; }) || candidates[0];
    memory.assignments.selectedReactorId = primary ? primary.reactorId : null;
    memory.assignments.selectedReactorRoom = primary ? primary.roomName : null;
    memory.thoriumReservations = { tick: tick, stores: ledger };
    memory.dashboard = { tick: tick, reactors: candidates.slice().sort(function(a, b) {
        return Number(b.active) - Number(a.active) || a.fuelPriority - b.fuelPriority;
    }).slice(0, 5).map(function(e) {
        return { reactorId: e.reactorId, roomName: e.roomName, state: e.state, scoreRate: e.scoreRate,
            work: e.continuousWork, fuel: e.ticksUntilEmpty, eta: e.deliveryEta, defense: e.defenseTier,
            claimThreat: e.threat.claimThreat || 0, combatThreat: e.threat.combatThreat || 0,
            recaptureValue: e.recapture.recaptureScore, reason: e.reason, retry: Math.max(0, e.recaptureCooldownUntil - tick) };
    }), activeCount: p.activeReactorIds.length, desiredCount: p.desiredActiveCount,
    throughput: p.sustainableThoriumDeliveryPerTick, sustainableCount: capacity, expansionDeferred: !cpuSafe };
    if (rescore) p.plannedAt = tick;
    invalidateDiagnostics();
}

function getFuelAllowance(stagingId, reactorId) {
    var reservations = ensureMemory().thoriumReservations;
    if (reservations.tick !== getTime()) return 0;
    var store = reservations.stores[stagingId];
    return store ? Math.max(0, store.reactors[reactorId] || 0) : 0;
}

function consumeFuelAllowance(stagingId, reactorId, amount) {
    var reservations = ensureMemory().thoriumReservations;
    var store = reservations.stores[stagingId];
    if (store) store.reactors[reactorId] = Math.max(0, (store.reactors[reactorId] || 0) - amount);
}

function getSpawnPlanForRoom(room) {
    var memory = ensureMemory();
    var plans = [];

    if (!isOperatingMode() || !homeReadiness(room.name).healthy) {
        return plans;
    }

    for (var sourceRoom in memory.assignments.mining) {
        if (!memory.assignments.mining.hasOwnProperty(sourceRoom)) {
            continue;
        }
        var assignment = memory.assignments.mining[sourceRoom];
        if (
            assignment && assignment.ready &&
            assignment.homeRoom === room.name &&
            assignment.remaining > 0 && !shouldPauseMining(assignment.roomName) &&
            getCpuBucket() >= memory.config.minimumCpuBucket &&
            getAssignmentCount(assignment.key, true) < 1
        ) {
            plans.push(makeMinerPlan(assignment));
        }
    }

    for (var reactorId of memory.reactorPortfolio.activeReactorIds) {
    var reactor = memory.reactors[reactorId];
    var entry = memory.reactorPortfolio.reactors[reactorId];
    if (!reactor || !entry) continue;
    var reserveReady = entry.claimReady;
    var throughputReady = entry.allocatedThroughput >= 0.999;
    var reactorHome = entry.homeRoom ? { roomName: entry.homeRoom } : null;
    var canClaimUnowned = !reactor.owner;
    var canRecapture = !!(reactor.owner && !reactor.my && entry.recapture && entry.recapture.approved);

    if (
        reactorHome && reactorHome.roomName === room.name &&
        reserveReady && throughputReady && !reactor.my &&
        (canClaimUnowned || canRecapture) &&
        isClaimApiAvailable() &&
        getCpuBucket() >= memory.config.minimumCpuBucket &&
        getTime() >= (reactor.nextClaimRequestAfter || 0)
    ) {
        var claimPlan = makeClaimerPlan(room.name, reactor);
        if (getAssignmentCount(claimPlan.assignmentKey, true) < 1) {
            plans.push(claimPlan);
        }
    }

    var claiming = getAssignmentCount('claim:' + reactor.id, true) > 0;
    if (!reactor.my && !claiming && reactor.owner && !entry.recapture.approved && !entry.recapture.preparing) {
        continue;
    }

    var starving = reactor.my &&
        (reactor.thorium || 0) <= Math.max(
            memory.config.starvationWarningTicks,
            memory.config.reactorSafetyStock
        );
    for (var miningRoom in memory.assignments.mining) {
        if (!memory.assignments.mining.hasOwnProperty(miningRoom)) {
            continue;
        }
        var haulAssignment = memory.assignments.mining[miningRoom];
        if (!haulAssignment || !haulAssignment.stagingId || entry.assignedMiningRooms.indexOf(miningRoom) < 0) {
            continue;
        }
        var home = chooseHomeRoom(haulAssignment.roomName,
            memory.config.maximumMiningRouteRooms);
        if (!home || home.roomName !== room.name) {
            continue;
        }
        var haulPlan = makeHaulerPlan(room.name, haulAssignment, reactor, starving);
        if (haulPlan && getAssignmentCount(haulPlan.assignmentKey, true) <
            haulPlan.desired) {
            plans.push(haulPlan);
        }
    }
    }
    return plans;
}

function shouldPauseMining(roomName) {
    var memory = ensureMemory(), assignment = memory.assignments.mining[roomName];
    if (!assignment || !assignment.ready || assignment.remaining <= 0) return true;
    var entries = Object.values(memory.reactorPortfolio.reactors);
    var useful = entries.filter(function(e) { return e.active && (e.assignedMiningRooms || []).indexOf(roomName) >= 0; });
    // Build at most one startup stockpile per useful Reactor, then preserve finite deposits.
    var target = useful.reduce(function(sum, e) { return sum + (e.startup ? e.startup.reserve : memory.config.startupReserve); }, 0);
    return !target || getStoreAmount(getObjectById(assignment.stagingId), getThoriumResourceType()) >= target;
}

function noteSpawnRequestQueued(plan) {
    if (!plan || plan.role !== 'ReactorClaimer') {
        return;
    }
    var reactor = ensureMemory().reactors[plan.memory && plan.memory.season11ReactorId];
    if (reactor) {
        reactor.nextClaimRequestAfter = getTime() + ensureMemory().config.claimCooldown;
        reactor.lastRecaptureAttempt = getTime();
        reactor.claimAttemptDeadline = getTime() + 1000;
    }
}

function markThoriumDepleted(roomName, mineralId) {
    var memory = ensureMemory();
    var roomIntel = memory.rooms[roomName] || {
        roomName: roomName,
        lastSeen: getTime()
    };
    roomIntel.thorium = roomIntel.thorium || { id: mineralId };
    roomIntel.thorium.id = mineralId || roomIntel.thorium.id;
    roomIntel.thorium.remaining = 0;
    roomIntel.thorium.depleted = true;
    roomIntel.thorium.lastSeen = getTime();
    memory.rooms[roomName] = roomIntel;
    if (memory.assignments.mining[roomName]) {
        memory.assignments.mining[roomName].remaining = 0;
        memory.assignments.mining[roomName].ready = false;
        memory.assignments.mining[roomName].depleted = true;
        memory.assignments.mining[roomName].reason = 'DRAINING STAGING';
    }
    setAlert('DEPLETED', roomName, 500);
}

function noteClaimResult(reactorId, result) {
    var memory = ensureMemory();
    var reactor = memory.reactors[reactorId];
    if (!reactor) {
        return;
    }
    reactor.lastClaimResult = result;
    reactor.lastClaimTick = getTime();
    reactor.nextClaimRequestAfter = getTime() + memory.config.claimCooldown;
    if (result === 0) {
        logEvent('CLAIM', reactor.roomName + ' intent accepted');
        clearAlert('NO CLAIM');
    }
    else if (result !== -9 && result !== -11 && result !== -4) {
        recordClaimFailure(reactor, 'claim intent rejected: ' + result);
    }
}

function noteCreepEta(creep, eta) {
    if (creep && creep.memory) {
        creep.memory.season11DeliveryEta = Math.max(0, Math.floor(eta || 0));
        creep.memory.season11EtaTick = getTime();
        invalidateDiagnostics();
    }
}

function getObjectById(id) {
    if (!id || typeof Game === 'undefined' ||
        typeof Game.getObjectById !== 'function') {
        return null;
    }
    return Game.getObjectById(id);
}

function getDiagnostics() {
    var tick = getTime();
    if (diagnosticsCache && diagnosticsTick === tick) {
        return diagnosticsCache;
    }

    var memory = ensureMemory();
    var thoriumType = getThoriumResourceType();
    var knownRemaining = 0;
    var depletedRooms = 0;
    var stored = 0;
    var routedStored = 0;
    var inTransit = 0;
    var miners = 0;
    var haulers = 0;
    var claimers = 0;
    var nextEta = null;
    var maximumObservedTileThorium = 0;
    var maximumAgingMultiplier = 0;
    var agingFallbackCreeps = 0;
    var seenStores = {};

    for (var roomName in memory.rooms) {
        var intel = memory.rooms[roomName];
        if (intel && intel.thorium) {
            knownRemaining += Math.max(0, intel.thorium.remaining || 0);
            if (intel.thorium.depleted) {
                depletedRooms++;
            }
        }
    }

    var tickIndex = TickIndex.get();
    for (var roomIndex = 0; roomIndex < tickIndex.ownedRooms.length; roomIndex++) {
        var visibleRoom = tickIndex.ownedRooms[roomIndex];
        var ownedStores = [visibleRoom.storage, visibleRoom.terminal];
        for (var storeIndex = 0; storeIndex < ownedStores.length; storeIndex++) {
            var ownedStore = ownedStores[storeIndex];
            if (ownedStore && ownedStore.id && !seenStores[ownedStore.id]) {
                seenStores[ownedStore.id] = true;
                stored += getStoreAmount(ownedStore, thoriumType);
            }
        }
    }

    for (var sourceRoom in memory.assignments.mining) {
        var assignment = memory.assignments.mining[sourceRoom];
        var staging = assignment && getObjectById(assignment.stagingId);
        if (staging) {
            var stagingAmount = getStoreAmount(staging, thoriumType);
            routedStored += stagingAmount;
            if (!seenStores[staging.id]) {
                seenStores[staging.id] = true;
                stored += stagingAmount;
            }
        }
    }

    for (var creepIndex = 0;
        creepIndex < tickIndex.allCreeps.length;
        creepIndex++) {
        var creep = tickIndex.allCreeps[creepIndex];
        if (!creep || !creep.memory) {
            continue;
        }
        if (creep.memory.role === 'ThoriumMiner') {
            miners++;
        }
        else if (creep.memory.role === 'ThoriumHauler') {
            haulers++;
            maximumObservedTileThorium = Math.max(maximumObservedTileThorium,
                Number(creep.memory.season11ObservedTileThorium) || 0);
            maximumAgingMultiplier = Math.max(maximumAgingMultiplier,
                Number(creep.memory.season11AgingMultiplier) || 0);
            if (creep.memory.season11AgingEstimateSource === 'fallbackEstimate') agingFallbackCreeps++;
            var eta = creep.memory.season11DeliveryEta;
            if (typeof eta === 'number' &&
                creep.memory.season11ReactorId === memory.assignments.selectedReactorId &&
                getStoreAmount(creep, thoriumType) > 0 &&
                getTime() - (creep.memory.season11EtaTick || 0) <= 2 &&
                (nextEta === null || eta < nextEta)) {
                nextEta = eta;
            }
        }
        else if (creep.memory.role === 'ReactorClaimer') {
            claimers++;
        }
        if (creep.memory.role === 'ThoriumMiner' ||
            creep.memory.role === 'ThoriumHauler') {
            inTransit += getStoreAmount(creep, thoriumType);
        }
    }

    var reactor = getSelectedReactorRecord();
    var reactorInfo = reactor ? {
        id: reactor.id,
        roomName: reactor.roomName,
        owner: reactor.owner,
        my: reactor.my === true,
        thorium: reactor.thorium || 0,
        capacity: reactor.capacity || REACTOR_CAPACITY,
        continuousWork: reactor.continuousWork || 0,
        scorePerTick: scoreRate(reactor.continuousWork),
        ticksUntilEmpty: Math.max(0, reactor.thorium || 0),
        hostileCreeps: reactor.hostileCreeps || 0,
        threatParts: reactor.threatParts || 0,
        lastSeen: reactor.lastSeen || 0
    } : null;

    var alerts = [];
    for (var alertCode in memory.alerts) {
        if (memory.alerts[alertCode] && memory.alerts[alertCode].until > tick) {
            alerts.push(memory.alerts[alertCode]);
        }
    }
    alerts.sort(function(a, b) { return a.code < b.code ? -1 : 1; });

    diagnosticsCache = {
        tick: tick,
        schemaVersion: memory.schemaVersion,
        mode: memory.mode,
        apiAvailable: isApiAvailable(),
        claimApiAvailable: isClaimApiAvailable(),
        operating: isOperatingMode(),
        knownThoriumRemaining: knownRemaining,
        depletedRooms: depletedRooms,
        storedThorium: stored,
        inTransit: inTransit,
        availableReserve: stored + inTransit,
        deliverableReserve: routedStored + inTransit,
        miners: miners,
        haulers: haulers,
        claimers: claimers,
        selectedReactor: reactorInfo,
        reactorPortfolio: memory.reactorPortfolio,
        portfolioDashboard: memory.dashboard || null,
        nextDeliveryEta: nextEta,
        aging: {
            maximumObservedTileThorium: maximumObservedTileThorium,
            maximumMultiplier: maximumAgingMultiplier,
            fallbackCreeps: agingFallbackCreeps,
            fallbackThorium: memory.config.agingFallbackThorium
        },
        alerts: alerts,
        rankedMiningTargets: memory.assignments.rankedMiningTargets || [],
        rankedReactors: memory.assignments.rankedReactors || [],
        events: memory.stats.events.slice()
    };
    diagnosticsTick = tick;
    return diagnosticsCache;
}

function updateOperationalAlerts() {
    var memory = ensureMemory();
    var diagnostics = getDiagnostics();
    var reactor = diagnostics.selectedReactor;

    if (!reactor) {
        if (diagnostics.knownThoriumRemaining <= 0 &&
            diagnostics.depletedRooms > 0) {
            setAlert('DEPLETED', 'all known Thorium rooms', 250);
        }
        return;
    }
    if (!reactor.my && diagnostics.availableReserve >= memory.config.startupReserve &&
        diagnostics.claimers <= 0) {
        setAlert('NO CLAIM', reactor.roomName, 100);
    }
    else if (reactor.my) {
        clearAlert('NO CLAIM');
    }

    if (reactor.my && reactor.thorium <= memory.config.starvationWarningTicks) {
        var starvation = estimateStarvation(reactor.thorium,
            diagnostics.nextDeliveryEta);
        if (starvation.starving) {
            setAlert('STARVING', reactor.roomName + ' ' +
                reactor.thorium + 'T', 100);
        }
    }
    else {
        clearAlert('STARVING');
    }

    if (reactor.threatParts > 0 || reactor.hostileCreeps > 0) {
        setAlert('HOSTILE', reactor.roomName, 100);
    }
    else {
        clearAlert('HOSTILE');
    }

    var missingDetail = null;
    for (var sourceRoom in memory.assignments.mining) {
        var assignment = memory.assignments.mining[sourceRoom];
        if (assignment && assignment.ready && assignment.remaining > 0 &&
            getAssignmentCount(assignment.key, true) <= 0) {
            missingDetail = sourceRoom + ' miner';
            break;
        }
    }
    if (!missingDetail && reactor.my && diagnostics.storedThorium > 0 &&
        diagnostics.haulers <= 0) {
        missingDetail = reactor.roomName + ' hauler';
    }
    if (missingDetail) {
        setAlert('MISSING', missingDetail, 100);
    }
    else {
        clearAlert('MISSING');
    }

    if (diagnostics.knownThoriumRemaining <= 0 &&
        diagnostics.depletedRooms > 0) {
        setAlert('DEPLETED', 'all known Thorium rooms', 250);
    }
}

function shouldSuppressPixelGeneration() {
    if (!isOperatingMode()) {
        return false;
    }
    var diagnostics = getDiagnostics();
    return diagnostics.miners > 0 || diagnostics.haulers > 0 ||
        diagnostics.claimers > 0 || !!diagnostics.selectedReactor;
}

function resetCacheForTests() {
    agingRouteTick = -1;
    agingRoutes = {};
    observedTick = -1;
    observedRooms = {};
    routeTick = -1;
    routeOps = 0;
    diagnosticsTick = -1;
    diagnosticsCache = null;
    TickIndex.resetForTests();
}

module.exports = {
    refreshPortfolio: refreshPortfolio,
    homeReadiness: homeReadiness,
    getFuelAllowance: getFuelAllowance,
    consumeFuelAllowance: consumeFuelAllowance,
    shouldPauseMining: shouldPauseMining,
    recordClaimFailure: recordClaimFailure,
    run: run,
    plan: plan,
    observeRoom: observeRoom,
    ensureMemory: ensureMemory,
    isApiAvailable: isApiAvailable,
    isClaimApiAvailable: isClaimApiAvailable,
    isObserving: isObserving,
    isOperatingMode: isOperatingMode,
    getMode: getMode,
    setMode: setMode,
    configure: configure,
    getScoutRadius: getScoutRadius,
    scoutPriority: scoutPriority,
    getThoriumResourceType: getThoriumResourceType,
    getReactorFindConstant: getReactorFindConstant,
    getRouteDistance: getRouteDistance,
    noteRouteFailure: noteRouteFailure,
    rankMiningTargets: rankMiningTargets,
    rankReactors: rankReactors,
    selectReactor: selectReactor,
    clearReactorSelection: clearReactorSelection,
    cleanupStaleIntel: cleanupStaleIntel,
    scoreRate: scoreRate,
    thoriumAgingMultiplier: thoriumAgingMultiplier,
    observeTileThorium: observeTileThorium,
    estimateStarvation: estimateStarvation,
    calculateHaulerDemand: calculateHaulerDemand,
    getRouteAgingEstimate: getRouteAgingEstimate,
    getAssignmentCount: getAssignmentCount,
    getSpawnPlanForRoom: getSpawnPlanForRoom,
    mayClaimReactor: mayClaimReactor,
    noteSpawnRequestQueued: noteSpawnRequestQueued,
    markThoriumDepleted: markThoriumDepleted,
    noteClaimResult: noteClaimResult,
    noteCreepEta: noteCreepEta,
    getDiagnostics: getDiagnostics,
    shouldSuppressPixelGeneration: shouldSuppressPixelGeneration,
    getStoreAmount: getStoreAmount,
    resetCacheForTests: resetCacheForTests
};
