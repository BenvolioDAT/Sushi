/*
 * Logic.Season11.js
 *
 * Guarded Thorium/Reactor orchestration for Screeps World Season 11. Every
 * access to a seasonal constant happens through a feature-detection helper so
 * this module is safe to load on the persistent shards and private servers.
 */

var Season11Adapter = require('Season11.Adapter');
var CombatPolicy = require('Combat.Policy');

var SCHEMA_VERSION = 2;
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
    maxMiningRooms: 2,
    maximumMiningRouteRooms: 12,
    maximumReactorRouteRooms: 20,
    startupReserve: 500,
    reactorSafetyStock: 150,
    starvationWarningTicks: 200,
    haulerSafetyMargin: 1.25,
    haulerReplacementMargin: 100,
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

    if (typeof Game === 'undefined' || !Game.creeps) {
        return false;
    }

    for (var name in Game.creeps) {
        if (
            Game.creeps.hasOwnProperty(name) &&
            Game.creeps[name] &&
            Season11Adapter.canClaim(Game.creeps[name])
        ) {
            return true;
        }
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
        mode: DEFAULT_MODE,
        config: {},
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

    if (!Memory.season11 || typeof Memory.season11 !== 'object') Memory.season11 = makeInitialMemory();

    var memory = Memory.season11;
    memory.config = memory.config || {};
    copyDefaults(memory.config, DEFAULT_CONFIG);
    memory.rooms = memory.rooms || {};
    memory.reactors = memory.reactors || {};
    memory.assignments = memory.assignments || {};
    memory.assignments.mining = memory.assignments.mining || {};
    memory.routes = memory.routes || {};
    memory.alerts = memory.alerts || {};
    memory.stats = memory.stats || {};
    memory.stats.events = Array.isArray(memory.stats.events) ?
        memory.stats.events : [];
    memory.schemaVersion = SCHEMA_VERSION;

    if (!VALID_MODES[memory.mode]) {
        memory.mode = DEFAULT_MODE;
    }

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

    for (var spawnName in Game.spawns) {
        if (Game.spawns.hasOwnProperty(spawnName)) {
            var spawn = Game.spawns[spawnName];
            if (spawn && spawn.owner && spawn.owner.username) {
                return spawn.owner.username;
            }
        }
    }

    for (var roomName in Game.rooms) {
        if (Game.rooms.hasOwnProperty(roomName)) {
            var controller = Game.rooms[roomName] && Game.rooms[roomName].controller;
            if (controller && controller.my && controller.owner) {
                return getOwnerName(controller.owner);
            }
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
        var remaining = Math.max(0, Number(thorium.mineralAmount) || 0);
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

    for (var i = 0; i < reactors.length; i++) {
        var reactor = reactors[i];
        if (!reactor || !reactor.id) {
            continue;
        }

        var previous = memory.reactors[reactor.id];
        var ownerName = getOwnerName(reactor.owner);
        var record = previous || {};
        var wasMine = previous && previous.my === true;
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
        record.lastSeen = getTime();

        if (record.my) {
            record.everMine = true;
            clearAlert('STOLEN');
        }
        else if (wasMine && ownerName) {
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
    var result = [];
    var seen = {};

    if (typeof Game === 'undefined') {
        return result;
    }

    for (var spawnName in Game.spawns) {
        if (!Game.spawns.hasOwnProperty(spawnName)) {
            continue;
        }
        var spawn = Game.spawns[spawnName];
        var room = spawn && spawn.room;
        if (room && spawn.my !== false && !seen[room.name]) {
            seen[room.name] = true;
            result.push(room);
        }
    }

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
        var accessible = !!home && !ownedByOther && !reservedByOther &&
            (roomIntel.threatParts || 0) === 0;
        var routeDistance = home ? home.distance : null;

        targets.push({
            roomName: roomName,
            mineralId: thorium.id,
            remaining: thorium.remaining,
            density: thorium.density,
            depleted: false,
            accessible: accessible,
            homeRoom: home ? home.roomName : null,
            routeDistance: routeDistance,
            hostileCreeps: roomIntel.hostileCreeps || 0,
            threatParts: roomIntel.threatParts || 0,
            northernTieBreaker: northernTieBreaker(roomName),
            score: (thorium.remaining * 1000000) - hostilePenalty -
                ((routeDistance === null ? 1000 : routeDistance) * 1000) +
                northernTieBreaker(roomName)
        });
    }

    targets.sort(function(a, b) {
        if (b.remaining !== a.remaining) {
            return b.remaining - a.remaining;
        }
        if (a.accessible !== b.accessible) {
            return a.accessible ? -1 : 1;
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
        if (a.threatParts !== b.threatParts) {
            return a.threatParts - b.threatParts;
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

    for (var i = 0; i < ranked.length && selected < maximum; i++) {
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
    if (!isObserving()) {
        return;
    }
    if (!force && getTime() - (memory.stats.lastPlan || 0) <
        getPlanningInterval()) {
        return;
    }

    memory.stats.lastPlan = getTime();
    refreshMiningAssignments();
    refreshSelectedReactor();
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

    var rooms = [];
    if (typeof Game !== 'undefined' && Game.rooms) {
        for (var roomName in Game.rooms) {
            if (Game.rooms.hasOwnProperty(roomName) && Game.rooms[roomName]) {
                rooms.push(Game.rooms[roomName]);
            }
        }
    }
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

    if (!cpuPressured) {
        plan(false);
    }
    updateOperationalAlerts();
    return getDiagnostics();
}

function scoreRate(continuousWork) {
    var work = Math.floor(Number(continuousWork) || 0);
    return work > 0 ? 1 + Math.floor(Math.log10(work)) : 0;
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
    if (typeof Game !== 'undefined' && Game.creeps) {
        for (var name in Game.creeps) {
            if (
                Game.creeps.hasOwnProperty(name) &&
                Game.creeps[name] &&
                Game.creeps[name].memory &&
                Game.creeps[name].memory.season11AssignmentKey === assignmentKey
            ) {
                var creep = Game.creeps[name];
                var routeDistance = Number(
                    creep.memory.season11RouteDistance
                ) || 0;
                if (creep.memory.role === 'ThoriumMiner') {
                    routeDistance *= 50;
                }
                var spawnTime = Array.isArray(creep.body) ?
                    creep.body.length * 3 : 0;
                var replacementLead = spawnTime + routeDistance +
                    ensureMemory().config.haulerReplacementMargin;
                if (creep.ticksToLive === undefined ||
                    creep.ticksToLive > replacementLead) {
                    count++;
                }
            }
        }
    }

    if (!includeQueued || typeof Memory === 'undefined' || !Memory.rooms) {
        return count;
    }
    for (var roomName in Memory.rooms) {
        var queue = Memory.rooms[roomName] && Memory.rooms[roomName].spawnQueue;
        if (!Array.isArray(queue)) {
            continue;
        }
        for (var i = 0; i < queue.length; i++) {
            if (queue[i] && queue[i].memory &&
                queue[i].memory.season11AssignmentKey === assignmentKey) {
                count++;
            }
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
    if (typeof Game === 'undefined' || !Game.creeps) {
        return false;
    }
    for (var name in Game.creeps) {
        var creep = Game.creeps[name];
        if (!creep || !creep.memory || !roles.hasOwnProperty(creep.memory.role)) {
            continue;
        }
        var home = creep.memory.homeRoom || (creep.room && creep.room.name);
        if (home === room.name && (!creep.ticksToLive || creep.ticksToLive > 100)) {
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
    if (!reactor.owner) {
        return true;
    }
    return ensureMemory().config.recapture === true && CombatPolicy.mayLaunchOffense(reactor, true);
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
        priority: 38,
        assignmentKey: key,
        memory: {
            season11AssignmentKey: key,
            season11ReactorId: reactor.id,
            season11ReactorRoom: reactor.roomName
        },
        homeRoom: homeRoom
    };
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
    var thoriumAging = Math.floor(Math.log10(expectedCarryCapacity));
    var effectiveLifetime = Math.max(1,
        Math.floor(1500 / (1 + Math.max(0, thoriumAging))));
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
            season11RouteDistance: routeTiles
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

function getSpawnPlanForRoom(room) {
    var memory = ensureMemory();
    var plans = [];

    if (!isOperatingMode() || !roomHasEssentialEconomy(room) ||
        getCpuBucket() < memory.config.minimumCpuBucket) {
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
            assignment.remaining > 0 &&
            getAssignmentCount(assignment.key, true) < 1
        ) {
            plans.push(makeMinerPlan(assignment));
        }
    }

    var reactor = getSelectedReactorRecord();
    if (!reactor) {
        return plans;
    }

    var diagnostics = getDiagnostics();
    var reserveReady = diagnostics.deliverableReserve >=
        memory.config.startupReserve;
    var throughputReady = hasViableHaulRoute(reactor);
    var reactorHome = chooseHomeRoom(reactor.roomName,
        memory.config.maximumReactorRouteRooms);
    var canClaimUnowned = !reactor.owner;
    var canRecapture = !!(reactor.owner && !reactor.my &&
        memory.config.recapture === true);

    if (
        reactorHome && reactorHome.roomName === room.name &&
        reserveReady && throughputReady && !reactor.my &&
        (canClaimUnowned || canRecapture) &&
        isClaimApiAvailable() &&
        getTime() >= (reactor.nextClaimRequestAfter || 0)
    ) {
        var claimPlan = makeClaimerPlan(room.name, reactor);
        if (getAssignmentCount(claimPlan.assignmentKey, true) < 1) {
            plans.push(claimPlan);
        }
    }

    var claiming = getAssignmentCount('claim:' + reactor.id, true) > 0;
    if (!reactor.my && !claiming) {
        return plans;
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
        if (!haulAssignment || !haulAssignment.stagingId) {
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
    return plans;
}

function noteSpawnRequestQueued(plan) {
    if (!plan || plan.role !== 'ReactorClaimer') {
        return;
    }
    var reactor = getSelectedReactorRecord();
    if (reactor) {
        reactor.nextClaimRequestAfter = getTime() + ensureMemory().config.claimCooldown;
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

    if (typeof Game !== 'undefined' && Game.rooms) {
        for (var visibleRoomName in Game.rooms) {
            var visibleRoom = Game.rooms[visibleRoomName];
            if (!visibleRoom || !visibleRoom.controller ||
                !visibleRoom.controller.my) {
                continue;
            }
            var ownedStores = [visibleRoom.storage, visibleRoom.terminal];
            for (var storeIndex = 0; storeIndex < ownedStores.length; storeIndex++) {
                var ownedStore = ownedStores[storeIndex];
                if (ownedStore && ownedStore.id && !seenStores[ownedStore.id]) {
                    seenStores[ownedStore.id] = true;
                    stored += getStoreAmount(ownedStore, thoriumType);
                }
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

    if (typeof Game !== 'undefined' && Game.creeps) {
        for (var name in Game.creeps) {
            var creep = Game.creeps[name];
            if (!creep || !creep.memory) {
                continue;
            }
            if (creep.memory.role === 'ThoriumMiner') {
                miners++;
            }
            else if (creep.memory.role === 'ThoriumHauler') {
                haulers++;
                var eta = creep.memory.season11DeliveryEta;
                if (typeof eta === 'number' &&
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
        nextDeliveryEta: nextEta,
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
    observedTick = -1;
    observedRooms = {};
    routeTick = -1;
    routeOps = 0;
    diagnosticsTick = -1;
    diagnosticsCache = null;
}

module.exports = {
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
    estimateStarvation: estimateStarvation,
    calculateHaulerDemand: calculateHaulerDemand,
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
