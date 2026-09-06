/*
 * Planner.Remote.js
 *
 * Harabi-inspired remote mining planner for Sushi.
 *
 * The important idea is to keep long-term remote planning data under the home
 * room that owns the plan:
 * Memory.rooms[homeRoomName].remotePlanner
 *
 * Memory stores compact plain data (ids, numbers, packed coordinates). Rebuilt
 * RoomPosition paths are kept in global heap cache because live objects do not
 * belong in Memory and would waste serialization CPU every tick.
 */

var travel = require('utility.Travel.Creep');
var Intel = require('Remote.Intel');
var TickIndex = require('HiveMind.Index');
var LogisticsIndex = require('Logistics.Index');
var BodyConfig = require('role.creepBodyConfig');
var utility = require('utility');
var Economy = require('HiveMind.Economy');
var HiveMemory = require('HiveMind.Memory');

var PATH_VERSION = 1;
var HEAVY_PLAN_INTERVAL = 75;
var RESCORE_INTERVAL = 1000;
var DEBUG_INTERVAL = 500;
var LOW_BUCKET_SKIP = 1000;
var CPU_BUFFER = 3;
var MAX_ACTIVE_REMOTE_SOURCES = 4;
var MAX_REMOTE_DISTANCE = 150;
var ESTIMATED_CARRY_COST_PER_PART = 100;
var CONTAINER_OR_DROP_LOSS = 0.05;
var ROAD_REPAIR_COST_PER_TILE = 0.003;
var MAX_PATH_ROOMS = 8;
var MAX_PATH_OPS = 12000;
var HAUL_RESERVATION_TICKS = 25;
var EXTRACTOR_REPLACEMENT_BUFFER_TICKS = 30;
var REMOTE_REBALANCE_COOLDOWN = 500;
var REMOTE_REBALANCE_MIN_GAIN = 0.75;
var ROUTE_VALIDATION_INTERVAL = 251;
var TRAVEL_EWMA_ALPHA = 0.2;
var REMOTE_SCHEMA_VERSION = 2;
var REMOTE_STATES = Object.freeze({
    DISCOVERED: 'DISCOVERED',
    PLANNED: 'PLANNED',
    BOOTSTRAPPING: 'BOOTSTRAPPING',
    RESERVING: 'RESERVING',
    ACTIVE: 'ACTIVE',
    DEGRADED: 'DEGRADED',
    SUSPENDED_DANGER: 'SUSPENDED_DANGER',
    SUSPENDED_ECONOMY: 'SUSPENDED_ECONOMY',
    RETIRED: 'RETIRED'
});

function run() {
    if (!Memory.rooms) {
        return;
    }

    for (var roomName in Game.rooms) {
        if (!Game.rooms.hasOwnProperty(roomName)) {
            continue;
        }

        var room = Game.rooms[roomName];
        if (!room || !room.controller || !room.controller.my) {
            continue;
        }

        var planner = ensurePlannerMemory(roomName);
        planner.lastRun = Game.time;

        cleanupRemoteAssignments(roomName);
        refreshVisibleIntel(roomName, planner);
        scheduleRouteValidation(roomName, planner);
        rebuildRequestedRoute(roomName, planner);
        if (planner.selectionDirty) { delete planner.selectionDirty; selectActiveSources(roomName); }
        if (planner.lastHeavyPlanAt === undefined || Game.time - planner.lastHeavyPlanAt >= HEAVY_PLAN_INTERVAL) {
            planner.lastHeavyPlanAt = Game.time;
            refreshVisibleCandidatePlans(roomName);
            selectActiveSources(roomName);
        }

        if (planner.lastRescoreAt === undefined || Game.time - planner.lastRescoreAt >= RESCORE_INTERVAL) {
            planner.lastRescoreAt = Game.time;
            rescorePlanner(roomName);
            selectActiveSources(roomName);
        }

        if (planner.lastDebugAt === undefined || Game.time - planner.lastDebugAt >= DEBUG_INTERVAL) {
            planner.lastDebugAt = Game.time;
            logDebugSummary(roomName);
        }
    }
}

function onScoutRoom(creep) {
    if (!creep || !creep.room) {
        return false;
    }

    var homeRoomName = getHomeRoomName(creep);
    if (!homeRoomName || creep.room.name === homeRoomName) {
        return false;
    }

    var scanned = scanVisibleRoom(homeRoomName, creep.room);
    var hive = HiveMemory.ensure();
    var homes = hive.homeRooms && hive.homeRooms.names || [];
    for (var i = 0; i < homes.length; i++) {
        if (homes[i] !== homeRoomName && homes[i] !== creep.room.name &&
            isWithinRemoteRange(homes[i], creep.room.name)) {
            scanned = scanVisibleRoom(homes[i], creep.room) || scanned;
        }
    }
    return scanned;
}

function scanVisibleRoom(homeRoomName, room) {
    if (!homeRoomName || !room) {
        return false;
    }

    if (!isWithinRemoteRange(homeRoomName, room.name)) {
        return false;
    }

    updateVisibleControllerMemory(room);

    if (room.controller && room.controller.my || isOwnedEnemyRoom(room)) {
        rememberBlockedRemote(homeRoomName, room.name, 'blocked');
        return false;
    }

    if (hasInvaderCore(room) || hasSeriousDanger(room)) {
        rememberBlockedRemote(homeRoomName, room.name, 'danger');
        return false;
    }

    var planner = ensurePlannerMemory(homeRoomName);
    planner.lastRun = Game.time;

    return generateRemotePlan(homeRoomName, room);
}

function getHomeRoomName(creepOrRoom) {
    if (!creepOrRoom) {
        return null;
    }

    if (creepOrRoom.memory) {
        return creepOrRoom.memory.homeRoom ||
            creepOrRoom.memory.spawnRoom ||
            creepOrRoom.memory.birthRoom ||
            (creepOrRoom.room ? creepOrRoom.room.name : null);
    }

    if (creepOrRoom.name) {
        return creepOrRoom.name;
    }

    return null;
}

/* Legacy direct-neighbor predicate retained for console/debug compatibility. */
function isAdjacentToHomeRoom(homeRoomName, remoteRoomName) {
    if (!homeRoomName || !remoteRoomName || homeRoomName === remoteRoomName) {
        return false;
    }

    var exits = Game.map.describeExits(homeRoomName);

    if (!exits) {
        return false;
    }

    for (var direction in exits) {
        if (!exits.hasOwnProperty(direction)) {
            continue;
        }

        if (exits[direction] === remoteRoomName) {
            return true;
        }
    }

    return false;
}

function ensurePlannerMemory(homeRoomName) {
    if (!Memory.rooms) {
        Memory.rooms = {};
    }

    if (!Memory.rooms[homeRoomName]) {
        Memory.rooms[homeRoomName] = {};
    }

    if (!Memory.rooms[homeRoomName].remotePlanner) {
        Memory.rooms[homeRoomName].remotePlanner = {
            lastRun: Game.time,
            activeSourceIds: [],
            sourceInfos: {},
            remotes: {},
            pathVersion: PATH_VERSION
        };
    }

    var planner = Memory.rooms[homeRoomName].remotePlanner;

    if (!planner.activeSourceIds) {
        planner.activeSourceIds = [];
    }
    if (!planner.sourceInfos) {
        planner.sourceInfos = {};
    }
    if (!planner.remotes) {
        planner.remotes = {};
    }
    planner.schemaVersion = REMOTE_SCHEMA_VERSION;
    if (planner.pathVersion !== PATH_VERSION) {
        planner.pathVersion = PATH_VERSION;
        /* Preserve discovery and ownership data; only cached routes need rebuilding. */
        for (var oldSourceId in planner.sourceInfos) {
            if (!planner.sourceInfos.hasOwnProperty(oldSourceId)) continue;
            var oldInfo = planner.sourceInfos[oldSourceId];
            if (!oldInfo) continue;
            delete oldInfo.roadCoords;
            oldInfo.routeRevision = oldInfo.route && oldInfo.route.revision || oldInfo.routeRevision || 0;
            delete oldInfo.route;
            oldInfo.routeInvalidReason = 'path version changed';
            oldInfo.operational = false;
            oldInfo.roadEligible = false;
            oldInfo.replanRequestedAt = Game.time;
        }
        clearHeapPathCache(homeRoomName);
    }
    for (var sourceId in planner.sourceInfos) {
        if (!planner.sourceInfos.hasOwnProperty(sourceId) || !planner.sourceInfos[sourceId]) continue;
        var info = planner.sourceInfos[sourceId];
        if (!info.state) info.state = info.active ? REMOTE_STATES.ACTIVE : REMOTE_STATES.PLANNED;
        if (!info.parentHome) info.parentHome = info.parentRoomName || homeRoomName;
        if (!info.parentRoomName) info.parentRoomName = info.parentHome;
        if (info.lastParentChangeAt === undefined) info.lastParentChangeAt = Game.time;
        if (info.active) info.established = true;
    }

    planner.activeSourceIds = planner.activeSourceIds.filter(function(id) {
        var info = planner.sourceInfos[id];
        return info && info.active && info.operational !== false && (!info.route || info.route.valid !== false);
    });
    return planner;
}

function generateRemotePlan(homeRoomName, remoteRoom) {
    if (remoteRoom && remoteRoom.controller && remoteRoom.controller.my) return false;
    if (!homeRoomName || !remoteRoom || remoteRoom.name === homeRoomName) {
        return false;
    }

    if (!isWithinRemoteRange(homeRoomName, remoteRoom.name)) {
        return false;
    }

    if (!canSpendPlanningCpu()) {
        return false;
    }

    updateVisibleControllerMemory(remoteRoom);

    var remoteMemory = Memory.rooms && Memory.rooms[remoteRoom.name];
    if (!remoteMemory || !remoteMemory.sources) {
        return false;
    }

    var planner = ensurePlannerMemory(homeRoomName);
    var roomType = getRoomType(remoteRoom.name, remoteRoom);
    var remoteInfo = makeRemoteInfo(homeRoomName, remoteRoom, roomType);

    if (remoteInfo.status === 'blocked' || remoteInfo.status === 'danger') {
        planner.remotes[remoteRoom.name] = remoteInfo;
        return false;
    }

    var sourceIds = [];
    for (var sourceId in remoteMemory.sources) {
        if (!remoteMemory.sources.hasOwnProperty(sourceId)) {
            continue;
        }

        if (!canSpendPlanningCpu()) {
            break;
        }

        var sourceMemory = remoteMemory.sources[sourceId];
        var realSourceId = sourceMemory.id || sourceId;
        var sourceInfo = planRemoteSource(homeRoomName, remoteRoom, realSourceId, sourceMemory, roomType);

        if (!sourceInfo) {
            continue;
        }

        /* Score the home/source relationship before comparing it with another HOME. */
        sourceInfo = mergeReplannedSource(homeRoomName, planner.sourceInfos[realSourceId], sourceInfo);
        planner.sourceInfos[realSourceId] = sourceInfo;
        validateRemoteRoute(homeRoomName, realSourceId, true);
        scoreRemoteSource(homeRoomName, realSourceId);
        sourceInfo = claimBestParentForSource(homeRoomName, sourceInfo);
        if (sourceInfo.parentRoomName !== homeRoomName) {
            delete planner.sourceInfos[realSourceId];
            continue;
        }

        planner.sourceInfos[realSourceId] = sourceInfo;
        sourceIds.push(realSourceId);
    }

    remoteInfo.sourceIds = sourceIds;
    planner.remotes[remoteRoom.name] = remoteInfo;
    scoreRemoteRoom(homeRoomName, remoteRoom.name);
    selectActiveSources(homeRoomName);

    return sourceIds.length > 0;
}

function scoreRemoteRoom(homeRoomName, remoteRoomName) {
    var planner = ensurePlannerMemory(homeRoomName);
    var remoteInfo = planner.remotes[remoteRoomName];

    if (!remoteInfo) {
        return 0;
    }

    if (!isWithinRemoteRange(homeRoomName, remoteRoomName)) {
        remoteInfo.score = -999;
        remoteInfo.netEnergyPerTick = 0;
        remoteInfo.status = 'rejected';
        remoteInfo.lastRejectReason = 'outside configured remote range';
        return remoteInfo.score;
    }

    var netEnergyPerTick = 0;
    var totalDistance = 0;
    var sourceCount = 0;

    for (var i = 0; i < remoteInfo.sourceIds.length; i++) {
        var sourceId = remoteInfo.sourceIds[i];
        var sourceScore = scoreRemoteSource(homeRoomName, sourceId);
        var sourceInfo = planner.sourceInfos[sourceId];

        if (!sourceInfo) {
            continue;
        }

        netEnergyPerTick += sourceInfo.netIncome || 0;
        totalDistance += sourceInfo.distance || 0;
        sourceCount++;

        if (sourceScore <= 0 && sourceInfo.rejectReason) {
            remoteInfo.lastRejectReason = sourceInfo.rejectReason;
        }
    }

    remoteInfo.netEnergyPerTick = round2(netEnergyPerTick);
    remoteInfo.totalDistance = totalDistance;
    remoteInfo.score = round2(netEnergyPerTick - (remoteInfo.risk || 0));
    remoteInfo.status = remoteInfo.score > 0 && sourceCount > 0 ? 'candidate' : remoteInfo.status;

    return remoteInfo.score;
}

function scoreRemoteSource(homeRoomName, sourceId) {
    var planner = ensurePlannerMemory(homeRoomName);
    var info = planner.sourceInfos[sourceId];

    if (!info) {
        return 0;
    }

    if (!shouldUseRemoteSource(homeRoomName, sourceId, true)) {
        info.netIncome = -999;
        info.score = -999;
        return info.score;
    }

    var distance = Math.max(1, info.distance || MAX_REMOTE_DISTANCE);
    var grossEnergyPerTick = info.grossEnergyPerTick || getBaseEnergyPerTickForInfo(planner, info);
    var effectiveEnergyPerTick = grossEnergyPerTick;
    var controller = getControllerInfo(info.roomName);
    var reservationUsername = getReservationUsername(controller);

    if (reservationUsername && reservationUsername !== getMyUsername()) {
        if (!Game.rooms[info.roomName]) Intel.request(info.roomName, 'HOSTILE_RESERVATION_INTEL', 90);
        info.rejectReason = 'hostile reservation';
        info.netIncome = -999;
        info.score = -999;
        return info.score;
    }

    if (!reservationUsername) {
        if (!Game.rooms[info.roomName]) Intel.request(info.roomName, 'VERIFY_RESERVATION', 60);
        effectiveEnergyPerTick *= 0.5;
    }

    var minerLifetime = Math.max(1, CREEP_LIFE_TIME - distance);
    var harvestPower = typeof HARVEST_POWER === 'number' ? HARVEST_POWER : 2;
    var requiredWork = Math.max(1, Math.ceil(effectiveEnergyPerTick / harvestPower));
    var minerBodyCost = requiredWork * BODYPART_COST[WORK] +
        Math.ceil(requiredWork / 2) * BODYPART_COST[MOVE] + BODYPART_COST[CARRY];
    var minerCostPerTick = minerBodyCost / minerLifetime;
    var travelEstimate = getRouteTravelEstimate(info, getRepresentativeFreighterBody(homeRoomName, sourceId), true);
    var effectiveRoundTripTicks = Math.max(distance * 2, travelEstimate.roundTripTicks);
    var carryPartsNeeded = Math.ceil((effectiveEnergyPerTick * effectiveRoundTripTicks) / CARRY_CAPACITY);
    var haulerCostPerTick = (carryPartsNeeded * ESTIMATED_CARRY_COST_PER_PART) / CREEP_LIFE_TIME;
    var roadCost = distance * ROAD_REPAIR_COST_PER_TILE;
    var riskPenalty = (info.risk || 0) + getTransitRisk(info.route, homeRoomName, info.roomName);

    var netIncome = effectiveEnergyPerTick - minerCostPerTick - haulerCostPerTick - CONTAINER_OR_DROP_LOSS - roadCost - riskPenalty;

    info.grossEnergyPerTick = round3(grossEnergyPerTick);
    info.effectiveEnergyPerTick = round3(effectiveEnergyPerTick);
    info.energyPerTick = info.grossEnergyPerTick;
    info.currentNetEPT = round3(netIncome);
    info.projectedReservedNetEPT = null;
    info.reservationBootstrap = false;
    var annexBody = BodyConfig.getAnnexBody(Game.rooms[homeRoomName]);
    var roomType = planner.remotes[info.roomName] && planner.remotes[info.roomName].type || 'normal';
    if (!reservationUsername && roomType === 'normal' && controller && !controller.owner && annexBody && annexBody.length) {
        var reservedWork = Math.ceil(grossEnergyPerTick / harvestPower);
        var reservedMinerCost = reservedWork * BODYPART_COST[WORK] + Math.ceil(reservedWork / 2) * BODYPART_COST[MOVE] + BODYPART_COST[CARRY];
        var reservedCarry = Math.ceil(grossEnergyPerTick * effectiveRoundTripTicks / CARRY_CAPACITY);
        var annexCost = annexBody.reduce(function(sum, part) { return sum + BODYPART_COST[part.type || part]; }, 0);
        // A bootstrap must pay for its Annex without relying on unselected historical sources.
        var reservedNet = grossEnergyPerTick - reservedMinerCost / minerLifetime -
            reservedCarry * ESTIMATED_CARRY_COST_PER_PART / CREEP_LIFE_TIME - CONTAINER_OR_DROP_LOSS - roadCost - riskPenalty -
            annexCost / Math.max(1, 600 - distance);
        info.projectedReservedNetEPT = round3(reservedNet);
        var home = Game.rooms[homeRoomName];
        var economy = Economy.get(homeRoomName) || {};
        var growth = economy.growth || {};
        var initialCost = annexCost + reservedMinerCost + Math.max(150, reservedCarry * ESTIMATED_CARRY_COST_PER_PART);
        var liquidity = (home.energyAvailable || 0) + Math.max(0, growth.energyAboveReserve || 0);
        var roi = initialCost / Math.max(0.01, reservedNet);
        var queue = Memory.rooms[homeRoomName].spawn && Memory.rooms[homeRoomName].spawn.queue || [];
        var committed = info.reservationBootstrapUntil >= Game.time && (queue.some(function(request) {
            return request.memory && request.memory.role === 'Annex' && request.memory.targetRoom === info.roomName;
        }) || (TickIndex.get().creepsByHomeRoom.get(homeRoomName) || []).some(function(creep) {
            return creep.memory && creep.memory.role === 'Annex' && creep.memory.homeRoom === homeRoomName &&
                creep.memory.targetRoom === info.roomName;
        }));
        info.reservationBootstrap = netIncome <= 0 && reservedNet >= 1 && roi <= 1500 && (liquidity >= initialCost || committed) &&
            growth.spawnPressure < 0.5 && Economy.canSpend(homeRoomName, 'remoteBootstrap') &&
            home.energyCapacityAvailable >= annexCost && (!info.route || info.route.valid !== false);
        if (info.reservationBootstrap) netIncome = reservedNet;
    }
    info.netIncome = round3(netIncome);
    info.requiredWork = requiredWork;
    info.requiredCarry = carryPartsNeeded;
    info.oneWayTravelTicks = travelEstimate.outboundTicks;
    info.roundTripTicks = effectiveRoundTripTicks;
    info.estimatedMinerBodyCost = minerBodyCost;
    info.spawnUsage = round3((minerBodyCost / CREEP_LIFE_TIME) + haulerCostPerTick);
    info.score = round3(netIncome - (distance / 1000));
    info.scoreComponents = {
        grossEPT: round3(grossEnergyPerTick),
        effectiveEPT: round3(effectiveEnergyPerTick),
        minerCost: round3(minerCostPerTick),
        haulingCost: round3(haulerCostPerTick),
        roadCost: round3(roadCost),
        riskPenalty: round3(riskPenalty),
        netEPT: round3(netIncome)
    };
    info.rejectReason = info.score > 0 ? null : 'negative net income';

    return info.score;
}


function getBaseEnergyPerTickForInfo(planner, info) {
    var remoteInfo = planner && planner.remotes ? planner.remotes[info.roomName] : null;
    var roomType = remoteInfo ? remoteInfo.type : 'normal';

    if (roomType === 'keeper') {
        return SOURCE_ENERGY_KEEPER_CAPACITY / ENERGY_REGEN_TIME;
    }

    return SOURCE_ENERGY_CAPACITY / ENERGY_REGEN_TIME;
}

function getBestRemoteSourceForExtractor(creep) {
    if (!creep || !creep.memory) {
        return null;
    }

    var homeRoomName = getHomeRoomName(creep);
    if (!homeRoomName) {
        return null;
    }

    cleanupRemoteAssignments(homeRoomName);
    selectActiveSources(homeRoomName);

    var planner = ensurePlannerMemory(homeRoomName);
    var bestInfo = null;

    for (var i = 0; i < planner.activeSourceIds.length; i++) {
        var sourceId = planner.activeSourceIds[i];
        var info = planner.sourceInfos[sourceId];

        if (!info || !info.active || info.operational === false || (info.route && info.route.valid === false)) {
            continue;
        }

        if (!isWithinRemoteRange(homeRoomName, info.roomName)) {
            continue;
        }

        if (!hasRemoteAssignmentCapacity(homeRoomName, info, creep)) {
            continue;
        }

        if (!bestInfo || isBetterExtractorRemote(info, bestInfo)) {
            bestInfo = info;
        }
    }

    if (!bestInfo) {
        return null;
    }

    claimRemoteSource(creep, homeRoomName, bestInfo);
    return bestInfo;
}

function getRemotePath(homeRoomName, sourceId) {
    var planner = ensurePlannerMemory(homeRoomName);
    var info = planner.sourceInfos[sourceId];

    if (!info || !info.roadCoords) {
        return [];
    }

    ensureOrderedRoute(info);
    if (info.route.valid !== false && info.route.roomSequence.some(function(roomName) {
        return isBlockedRoomForPath(homeRoomName, roomName);
    })) info.route.dirty = true;
    if (info.route.dirty || info.route.validatedRevision !== info.route.revision ||
        routeDestinationChanged(homeRoomName, info)) {
        validateRemoteRoute(homeRoomName, sourceId, true);
    }
    if (!info.route.valid) return [];

    if (!global.__sushiRemotePlannerPaths) {
        global.__sushiRemotePlannerPaths = {};
    }

    var cacheKey = homeRoomName + ':' + sourceId;
    var cached = global.__sushiRemotePlannerPaths[cacheKey];
    if (cached && cached.pathVersion === PATH_VERSION &&
        cached.routeRevision === info.route.revision && cached.signature === info.route.signature) {
        return cached.path;
    }

    var path = [];
    for (var segmentIndex = 0; segmentIndex < info.route.segments.length; segmentIndex++) {
        var segment = info.route.segments[segmentIndex];
        var packedList = segment.coords;
        for (var i = 0; i < packedList.length; i++) {
            path.push(unpackCoord(packedList[i], segment.room));
        }
    }

    global.__sushiRemotePlannerPaths[cacheKey] = {
        pathVersion: PATH_VERSION,
        routeRevision: info.route.revision,
        signature: info.route.signature,
        path: path
    };

    return path;
}

function ensureOrderedRoute(info) {
    if (!info.route) info.route = {};
    if (!Array.isArray(info.route.segments) || info.route.segments.length === 0) {
        info.route.segments = [];
        for (var roomName in info.roadCoords) {
            if (!info.roadCoords.hasOwnProperty(roomName)) continue;
            info.route.segments.push({ room: roomName, coords: info.roadCoords[roomName].slice() });
        }
    }
    info.route.version = info.route.version || PATH_VERSION;
    info.route.length = info.route.length || info.route.segments.reduce(function(sum, segment) {
        return sum + (segment && segment.coords ? segment.coords.length : 0);
    }, 0);
    info.route.roomSequence = info.route.segments.map(function(segment) { return segment && segment.room; });
    if (info.route.valid === undefined) info.route.valid = true;
    if (info.containerCoord === undefined && info.route.segments.length > 0) {
        var lastSegment = info.route.segments[info.route.segments.length - 1];
        if (lastSegment && lastSegment.coords && lastSegment.coords.length) {
            info.containerCoord = lastSegment.coords[lastSegment.coords.length - 1];
        }
    }
    if (info.route.targetCoord === undefined) info.route.targetCoord = info.containerCoord;
    if (!info.route.terrain) info.route.terrain = { road: 0, plain: info.route.length, swamp: 0 };
    if (!info.route.revision) info.route.revision = 1;
    if (!info.route.signature) info.route.signature = routeSignature(info);
    return info.route;
}

/* Additive migration: schema 1 packed segments stay valid; legacy heap entries
 * lack pathVersion/revision and cannot be reused. Identity describes geometry. */
function routeSignature(info) {
    var geometry = JSON.stringify([info.roomName, Number(info.route.targetCoord),
        info.route.segments.map(function(segment) {
            return segment && [segment.room, Array.isArray(segment.coords) ? segment.coords.map(Number) : null];
        })]);
    var hash = 2166136261;
    for (var i = 0; i < geometry.length; i++) hash = Math.imul(hash ^ geometry.charCodeAt(i), 16777619);
    return geometry.length + ':' + (hash >>> 0).toString(36);
}

function mergeReplannedSource(homeRoomName, oldInfo, plan) {
    ensureOrderedRoute(plan);
    if (!oldInfo) { plan.routeRevision = plan.route.revision; return plan; }
    var oldRoute = oldInfo.route && ensureOrderedRoute(oldInfo);
    var same = oldRoute && oldRoute.signature === plan.route.signature;
    plan.route.revision = oldRoute ? oldRoute.revision + (same ? 0 : 1) : (oldInfo.routeRevision || 0) + 1;
    oldInfo.routeRevision = plan.route.revision;
    if (same) {
        var observations = ['observedOutboundTicks', 'observedReturnTicks', 'observedRoundTripTicks',
            'travelDeviation', 'outboundSamples', 'returnSamples', 'travelSamples', 'lastObservedAt',
            'observationDecayedAt'];
        observations.forEach(function(field) {
            if (oldRoute[field] !== undefined) plan.route[field] = oldRoute[field];
        });
        // Road completion changes speed without changing geometry: decay confidence once.
        if (oldRoute.terrain.road !== plan.route.terrain.road) {
            ['travelSamples', 'outboundSamples', 'returnSamples'].forEach(function(field) {
                if (plan.route[field]) plan.route[field] = Math.floor(plan.route[field] / 2);
            });
            plan.route.observationDecayedAt = Game.time;
        }
    } else {
        clearSourceHeapPath(homeRoomName, plan.sourceId);
    }
    // Only overwrite derived planning data. Unknown telemetry and lifecycle fields survive.
    ['distance', 'grossEnergyPerTick', 'energyPerTick', 'numOpen', 'containerCoord',
        'roadCoords', 'route', 'risk', 'lastPlanned'].forEach(function(field) {
        oldInfo[field] = plan[field];
    });
    return oldInfo;
}

function rebuildRequestedRoute(homeRoomName, planner) {
    if (!canSpendPlanningCpu()) return;
    var ids = Object.keys(planner.sourceInfos).filter(function(id) {
        var info = planner.sourceInfos[id];
        return info.replanRequestedAt !== undefined && Game.rooms[info.roomName] &&
            (info.lastRebuildAttemptAt === undefined || Game.time - info.lastRebuildAttemptAt >= HEAVY_PLAN_INTERVAL);
    }).sort(function(a, b) {
        return (planner.sourceInfos[a].lastRebuildAttemptAt || 0) - (planner.sourceInfos[b].lastRebuildAttemptAt || 0);
    });
    if (!ids.length) return;
    var info = planner.sourceInfos[ids[0]];
    info.lastRebuildAttemptAt = Game.time;
    generateRemotePlan(homeRoomName, Game.rooms[info.roomName]);
}

function routeDestinationChanged(homeRoomName, info) {
    var route = info.route;
    if (Number(route.targetCoord) !== Number(info.containerCoord) || (route.anchorCoord !== undefined &&
        route.anchorCoord !== packCoord(getHomeAnchor(homeRoomName)))) return true;
    var memory = Memory.rooms[info.roomName];
    var target = getSourceTargetInfo(memory && memory.sources && memory.sources[info.sourceId]);
    return !!(target && target.range === 0 && (target.pos.roomName !== info.roomName ||
        packCoord(target.pos) !== Number(route.targetCoord)));
}

function routeValidationDue(info) {
    if (!info || !info.roadCoords) return false;
    var route = ensureOrderedRoute(info);
    var interval = Number((HiveMemory.getConfig('remote') || {}).routeValidationInterval) || ROUTE_VALIDATION_INTERVAL;
    return route.valid === false && route.invalidReason === 'HOSTILE_TRANSIT_ROOM' &&
        route.roomSequence.every(function(roomName) { return !isBlockedRoomForPath(info.parentHome || info.parentRoomName, roomName); }) ||
        route.dirty || route.validatedRevision !== route.revision ||
        routeDestinationChanged(info.parentHome || info.parentRoomName, info) ||
        Game.time - (route.lastValidationAttemptAt || route.lastValidatedAt || 0) >= interval;
}

function scheduleRouteValidation(homeRoomName, planner) {
    var ids = Object.keys(planner.sourceInfos).sort();
    var cursor = (planner.validationCursor || 0) % Math.max(1, ids.length);
    var budget = 2;
    for (var n = 0; n < ids.length && budget > 0; n++) {
        var index = (cursor + n) % ids.length;
        var info = planner.sourceInfos[ids[index]];
        if (!routeValidationDue(info)) continue;
        validateRemoteRoute(homeRoomName, ids[index], true);
        budget--;
        planner.validationCursor = (index + 1) % ids.length;
    }
}

function validateRemoteRoute(homeRoomName, sourceId, force) {
    var planner = ensurePlannerMemory(homeRoomName);
    var info = planner.sourceInfos[sourceId];
    if (!info || !info.roadCoords) return { valid: false, reason: 'MISSING_ROUTE_DATA' };
    var route = ensureOrderedRoute(info);
    var reason = null;
    if (route.version !== PATH_VERSION) reason = 'PATH_VERSION_CHANGED';
    else if (!Array.isArray(route.segments) || route.segments.length === 0) reason = 'MALFORMED_ROUTE';
    else if (routeDestinationChanged(homeRoomName, info)) reason = 'DESTINATION_CHANGED';
    var count = 0;
    for (var i = 0; !reason && i < route.segments.length; i++) {
        var segment = route.segments[i];
        if (!segment || !segment.room || !Array.isArray(segment.coords) || segment.coords.length === 0) {
            reason = 'MALFORMED_ROUTE';
            break;
        }
        if (!reason && i > 0) {
            reason = getBorderContinuityReason(route.segments[i - 1], segment);
        }
        if (isBlockedRoomForPath(homeRoomName, segment.room)) {
            reason = 'HOSTILE_TRANSIT_ROOM';
            break;
        }
        var room = Game.rooms[segment.room];
        var blocked = room ? getPermanentBlockedCoords(room) : null;
        for (var j = 0; j < segment.coords.length; j++) {
            var packed = Number(segment.coords[j]);
            if (!Number.isFinite(packed) || packed < 0 || packed >= 2500) {
                reason = 'MALFORMED_ROUTE';
                break;
            }
            count++;
            if (blocked && blocked[packed]) {
                reason = blocked[packed];
                break;
            }
        }
    }
    if (!reason && count !== route.length) reason = 'ROUTE_LENGTH_MISMATCH';
    if (!reason) {
        var last = route.segments[route.segments.length - 1];
        if (!last.coords.length || last.room !== info.roomName ||
            Number(last.coords[last.coords.length - 1]) !== Number(info.containerCoord)) {
            reason = 'ROUTE_ENDPOINT_MISMATCH';
        }
    }
    if (!reason) refreshRouteTerrain(info, route);
    route.lastValidationAttemptAt = Game.time;
    route.validatedRevision = route.revision;
    route.dirty = false;
    if (reason) {
        route.valid = false;
        route.invalidReason = reason;
        route.invalidatedAt = Game.time;
        info.routeInvalidReason = reason;
        planner.selectionDirty = true;
        info.operational = false;
        info.active = false;
        removeFromActiveList(planner, sourceId);
        info.roadEligible = false;
        info.blockedReason = reason;
        info.state = reason === 'HOSTILE_TRANSIT_ROOM' ? REMOTE_STATES.SUSPENDED_DANGER : REMOTE_STATES.DEGRADED;
        info.replanRequestedAt = info.replanRequestedAt || Game.time;
        clearSourceHeapPath(homeRoomName, sourceId);
        return { valid: false, reason: reason };
    }
    if (route.valid === false) {
        planner.selectionDirty = true;
        if (Game.rooms[info.roomName]) info.risk = getRoomRisk(Game.rooms[info.roomName], getRoomType(info.roomName, Game.rooms[info.roomName]));
    }
    route.valid = true;
    info.operational = true;
    delete info.replanRequestedAt;
    route.lastValidatedAt = Game.time;
    delete route.invalidReason;
    delete info.routeInvalidReason;
    return { valid: true, reason: null };
}

function getBorderContinuityReason(previous, next) {
    if (!previous || !next || previous.room === next.room) return null;
    var from = unpackCoord(Number(previous.coords[previous.coords.length - 1]), previous.room);
    var to = unpackCoord(Number(next.coords[0]), next.room);
    var exits = Game.map && Game.map.describeExits ? Game.map.describeExits(previous.room) : null;
    if (!exits || !Object.keys(exits).length) return null;
    var direction = null;
    if (exits) for (var key in exits) if (exits[key] === next.room) direction = Number(key);
    if (!direction) return 'BORDER_DISCONTINUITY';
    var aligned = direction === TOP ? from.y === 0 && to.y === 49 && from.x === to.x :
        direction === RIGHT ? from.x === 49 && to.x === 0 && from.y === to.y :
        direction === BOTTOM ? from.y === 49 && to.y === 0 && from.x === to.x :
        direction === LEFT ? from.x === 0 && to.x === 49 && from.y === to.y : false;
    return aligned ? null : 'BORDER_DISCONTINUITY';
}

function getBestRouteToRoom(homeRoomName, targetRoomName) {
    var planner = ensurePlannerMemory(homeRoomName);
    var candidates = planner.activeSourceIds.map(function(sourceId) {
        var info = planner.sourceInfos[sourceId];
        if (!info || !info.route || info.roomName !== targetRoomName || info.operational === false) return null;
        var validation = validateRemoteRoute(homeRoomName, sourceId, false);
        return validation.valid ? info : null;
    }).filter(Boolean);
    candidates.sort(function(a, b) {
        return (a.route.length || a.distance || 0) - (b.route.length || b.distance || 0) ||
            String(a.sourceId).localeCompare(String(b.sourceId));
    });
    return candidates[0] || null;
}

function moveToRemoteRoomAlongRoute(creep, homeRoomName, targetRoomName) {
    if (!creep || !creep.memory || !homeRoomName || !targetRoomName) return false;
    if (creep.pos.roomName === targetRoomName) return false;
    var info = getBestRouteToRoom(homeRoomName, targetRoomName);
    if (!info) return false;
    var path = getRemotePath(homeRoomName, info.sourceId);
    var first = path.filter(function(pos) { return pos.roomName === targetRoomName; })[0];
    if (!first) return false;
    var current = path.filter(function(pos) { return pos.roomName === creep.pos.roomName; });
    var target = current.length ? current[current.length - 1] : path[0];
    travel.move(creep, target, { range: 0, maxRooms: target.roomName === creep.pos.roomName ? 1 : 2, reusePath: 5,
        trafficPriority: creep.memory.role === 'Annex' ? 55 : 35 });
    creep.memory.remoteLaneSourceId = info.sourceId;
    creep.memory.remoteLaneRevision = info.route.revision;
    return true;
}

function discoverSharedLanes(homeRoomName) {
    var planner = ensurePlannerMemory(homeRoomName);
    var active = (planner.activeSourceIds || []).map(function(id) { return planner.sourceInfos[id]; }).filter(function(info) {
        return info && info.route && info.route.valid !== false;
    });
    var groups = {};
    for (var i = 0; i < active.length; i++) {
        var info = active[i], route = ensureOrderedRoute(info), prefix = [];
        for (var s = 0; s < route.segments.length; s++) {
            for (var c = 0; c < route.segments[s].coords.length; c++) {
                prefix.push(route.segments[s].room + ':' + route.segments[s].coords[c]);
                if (prefix.length >= 2) {
                    var key = prefix.join('|');
                    if (!groups[key]) groups[key] = { rooms: route.segments.slice(0, s + 1).map(function(x) { return x.room; }), coords: prefix.slice(), users: [] };
                    if (groups[key].users.indexOf(info.sourceId) < 0) groups[key].users.push(info.sourceId);
                }
            }
        }
    }
    var shared = {};
    Object.keys(groups).forEach(function(key) {
        var group = groups[key];
        if (group.users.length > 1) shared[key] = { revision: Game.time, rooms: group.rooms, packed: group.coords, users: group.users, lastUsed: Game.time };
    });
    planner.sharedLanes = shared;
    return shared;
}

function refreshRouteTerrain(info, route) {
    var path = [];
    for (var i = 0; i < route.segments.length; i++) {
        for (var j = 0; j < route.segments[i].coords.length; j++) {
            path.push(unpackCoord(route.segments[i].coords[j], route.segments[i].room));
        }
    }
    var previousRoads = route.terrain && route.terrain.road || 0;
    route.terrain = getRouteTerrain(path);
    if (route.terrain.road !== previousRoads && route.travelSamples) {
        route.travelSamples = Math.floor(route.travelSamples * 0.5);
        route.outboundSamples = Math.floor((route.outboundSamples || 0) * 0.5);
        route.returnSamples = Math.floor((route.returnSamples || 0) * 0.5);
        route.observationDecayedAt = Game.time;
    }
    var estimate = getRouteTravelEstimate(info, getRepresentativeFreighterBody(info.parentHome || info.parentRoomName, info.sourceId), true);
    route.estimatedOutboundTicks = estimate.modelOutboundTicks;
    route.estimatedReturnTicks = estimate.modelReturnTicks;
    route.estimatedRoundTripTicks = estimate.modelOutboundTicks + estimate.modelReturnTicks;
}

function getPermanentBlockedCoords(room) {
    return getValidationSnapshot(room).blocked;
}

function getValidationSnapshot(room) {
    if (!global.__sushiRouteSnapshots || global.__sushiRouteSnapshots.tick !== Game.time ||
        global.__sushiRouteSnapshots.game !== Game) {
        global.__sushiRouteSnapshots = { tick: Game.time, game: Game, rooms: {} };
    }
    var cache = global.__sushiRouteSnapshots.rooms;
    if (room && cache[room.name]) return cache[room.name];
    var blocked = {};
    var snapshot = { blocked: blocked, roads: {}, structures: [] };
    if (!room || typeof room.find !== 'function') return snapshot;
    var structures = room.find(FIND_STRUCTURES) || [];
    snapshot.structures = structures;
    for (var i = 0; i < structures.length; i++) {
        var structure = structures[i];
        if (structure.structureType === STRUCTURE_ROAD) snapshot.roads[packCoord(structure.pos)] = true;
        var reason = null;
        if (structure.structureType === STRUCTURE_RAMPART && !structure.my && !structure.isPublic) {
            reason = 'BLOCKED_RAMPART';
        }
        else if (typeof OBSTACLE_OBJECT_TYPES !== 'undefined' &&
            OBSTACLE_OBJECT_TYPES.indexOf(structure.structureType) >= 0) {
            reason = 'BLOCKED_STRUCTURE';
        }
        if (reason) blocked[packCoord(structure.pos)] = reason;
    }
    cache[room.name] = snapshot;
    return snapshot;
}

function clearSourceHeapPath(homeRoomName, sourceId) {
    // Road plans are derived from these lanes; never build a cached, retired lane.
    var roads = Memory.rooms[homeRoomName] && Memory.rooms[homeRoomName].roadPlanner;
    if (roads) { roads.rooms = {}; roads.lastPlanned = 0; }
    if (global.__sushiRemotePlannerPaths) delete global.__sushiRemotePlannerPaths[homeRoomName + ':' + sourceId];
}

function startRemoteTrip(creep, sourceInfo) {
    if (!creep || !creep.memory || !sourceInfo) return;
    var route = ensureOrderedRoute(sourceInfo);
    if (!atRouteEndpoint(creep, sourceInfo, true)) return;
    creep.memory.remoteTrip = {
        sourceId: sourceInfo.sourceId,
        routeVersion: route.version,
        routeRevision: route.revision,
        departureTick: Game.time,
        direction: 'OUTBOUND'
    };
}

function recordRemoteTripLeg(creep, direction) {
    if (!creep || !creep.memory || !creep.memory.homeRoom) return false;
    var trip = creep.memory.remoteTrip;
    var sourceId = trip && trip.sourceId || creep.memory.pickupSourceId || creep.memory.remoteDeliverySourceId;
    var planner = ensurePlannerMemory(creep.memory.homeRoom);
    var info = sourceId && planner.sourceInfos[sourceId];
    if (!trip || !info || !info.route || trip.routeVersion !== info.route.version ||
        trip.routeRevision !== info.route.revision || info.route.valid === false) return false;
    var route = info.route;
    if (!creep.pos || !atRouteEndpoint(creep, info, direction === 'RETURN')) return false;
    if (direction === 'OUTBOUND' && trip.direction === 'OUTBOUND') {
        var outbound = Math.max(1, Game.time - trip.departureTick);
        route.observedOutboundTicks = updateEwma(route.observedOutboundTicks, outbound);
        route.travelDeviation = updateEwma(route.travelDeviation, Math.abs(outbound - route.observedOutboundTicks));
        route.outboundSamples = (route.outboundSamples || 0) + 1;
        trip.outboundTicks = outbound;
        trip.direction = 'PICKUP';
        return true;
    }
    if (direction === 'RETURN' && trip.direction === 'RETURN' && trip.returnStartedAt !== undefined) {
        var returning = Math.max(1, Game.time - trip.returnStartedAt);
        route.observedReturnTicks = updateEwma(route.observedReturnTicks, returning);
        route.travelDeviation = updateEwma(route.travelDeviation, Math.abs(returning - route.observedReturnTicks));
        route.returnSamples = (route.returnSamples || 0) + 1;
        route.travelSamples = Math.min(route.outboundSamples || 0, route.returnSamples || 0);
        if (trip.outboundTicks) route.observedRoundTripTicks = updateEwma(
            route.observedRoundTripTicks, trip.outboundTicks + returning);
        route.lastObservedAt = Game.time;
        var calibrated = getRouteTravelEstimate(info, creep.body || getRepresentativeFreighterBody(creep.memory.homeRoom), true);
        info.oneWayTravelTicks = calibrated.outboundTicks;
        info.roundTripTicks = calibrated.roundTripTicks;
        delete creep.memory.remoteTrip;
        return true;
    }
    return false;
}

function updateEwma(previous, sample) {
    return previous === undefined || previous === null ? sample :
        round3(previous * (1 - TRAVEL_EWMA_ALPHA) + sample * TRAVEL_EWMA_ALPHA);
}

function shouldUseRemoteSource(homeRoomName, sourceId, ignoreScore) {
    var planner = ensurePlannerMemory(homeRoomName);
    var info = planner.sourceInfos[sourceId];

    if (!info) {
        return false;
    }

    var category = sourceSpendCategory(planner, info);
    var spend = Economy.checkSpend(homeRoomName, category);
    info.spendCategory = category;
    info.spendAllowed = spend.allowed;
    if (!spend.allowed) {
        info.rejectReason = spend.reason;
        return false;
    }

    if (info.route && info.route.valid === false) {
        info.rejectReason = info.route.invalidReason || 'invalid canonical route';
        info.blockedReason = info.rejectReason;
        info.state = info.route.invalidReason === 'HOSTILE_TRANSIT_ROOM' ?
            REMOTE_STATES.SUSPENDED_DANGER : REMOTE_STATES.DEGRADED;
        return false;
    }

    if (!isWithinRemoteRange(homeRoomName, info.roomName)) {
        info.rejectReason = 'outside configured remote range';
        return false;
    }

    if (info.parentRoomName !== homeRoomName) {
        info.rejectReason = 'different parent room';
        return false;
    }

    if (!info.numOpen || info.numOpen < 1) {
        info.rejectReason = 'no open seats';
        return false;
    }

    if (!info.distance || info.distance > MAX_REMOTE_DISTANCE) {
        info.rejectReason = 'path too long';
        return false;
    }

    if (info.risk >= 5) {
        info.rejectReason = 'too dangerous';
        info.state = REMOTE_STATES.SUSPENDED_DANGER;
        info.blockedReason = 'REMOTE_DANGER';
        return false;
    }

    var controller = getControllerInfo(info.roomName);
    if (controller && controller.my) {
        info.rejectReason = 'owned HOME';
        info.active = false;
        info.operational = false;
        return false;
    }
    if (controller && controller.owner && controller.owner !== getMyUsername()) {
        info.rejectReason = 'enemy owned room';
        return false;
    }

    if (!ignoreScore && info.score <= 0) {
        return false;
    }

    return true;
}

function packCoord(pos) {
    if (!pos) {
        return null;
    }

    return pos.x + (pos.y * 50);
}

function unpackCoord(packed, roomName) {
    var value = parseInt(packed, 10) || 0;
    var x = value % 50;
    var y = Math.floor(value / 50);

    return new RoomPosition(x, y, roomName);
}

function planRemoteSource(homeRoomName, remoteRoom, sourceId, sourceMemory, roomType) {
    var anchor = getHomeAnchor(homeRoomName);
    var targetInfo = getSourceTargetInfo(sourceMemory);

    if (!anchor || !targetInfo || !targetInfo.pos) {
        return null;
    }

    var ret = PathFinder.search(anchor, { pos: targetInfo.pos, range: targetInfo.range }, {
        maxRooms: MAX_PATH_ROOMS,
        maxOps: MAX_PATH_OPS,
        plainCost: 2,
        swampCost: 10,
        roomCallback: function(roomName) {
            return buildRemoteCostMatrix(homeRoomName, roomName);
        }
    });

    if (ret.incomplete || !ret.path || ret.path.length === 0) {
        return null;
    }

    var path = ret.path;
    var containerPos = path[path.length - 1] || targetInfo.pos;
    var roadCoords = {};

    /*
     * The saved path is both today's movement lane and tomorrow's road lane.
     * Coordinates are grouped by room so future road/container planners can read
     * only the room they are working on without decoding every remote path.
     */
    for (var i = 0; i < path.length; i++) {
        var pos = path[i];
        if (!roadCoords[pos.roomName]) {
            roadCoords[pos.roomName] = [];
        }
        roadCoords[pos.roomName].push(packCoord(pos));
    }

    var segments = buildRouteSegments(path);
    var terrain = getRouteTerrain(path);
    var route = {
        version: PATH_VERSION,
        valid: true,
        calculatedAt: Game.time,
        lastValidatedAt: Game.time,
        length: path.length,
        targetCoord: packCoord(containerPos),
        anchorCoord: packCoord(anchor),
        terrain: terrain,
        segments: segments,
        roomSequence: segments.map(function(segment) { return segment.room; })
    };
    var initialTravel = estimateRouteTravelTicks(route, [CARRY, CARRY, MOVE], false);
    route.estimatedOutboundTicks = initialTravel;
    route.estimatedReturnTicks = estimateRouteTravelTicks(route, [CARRY, CARRY, MOVE], true);
    route.estimatedRoundTripTicks = route.estimatedOutboundTicks + route.estimatedReturnTicks;

    return {
        sourceId: sourceId,
        roomName: remoteRoom.name,
        parentRoomName: homeRoomName,
        parentHome: homeRoomName,
        distance: path.length,
        grossEnergyPerTick: roomType === 'keeper' ? SOURCE_ENERGY_KEEPER_CAPACITY / ENERGY_REGEN_TIME : SOURCE_ENERGY_CAPACITY / ENERGY_REGEN_TIME,
        effectiveEnergyPerTick: 0,
        energyPerTick: roomType === 'keeper' ? SOURCE_ENERGY_KEEPER_CAPACITY / ENERGY_REGEN_TIME : SOURCE_ENERGY_CAPACITY / ENERGY_REGEN_TIME,
        numOpen: getSourceSeatCount(sourceMemory),
        containerCoord: packCoord(containerPos),
        roadCoords: roadCoords,
        route: route,
        constructed: false,
        risk: getRoomRisk(remoteRoom, roomType),
        netIncome: 0,
        spawnUsage: 0,
        score: 0,
        active: false,
        state: REMOTE_STATES.PLANNED,
        lastPlanned: Game.time
    };
}

function getRemoteMaxRoomRange() {
    var config = HiveMemory.getConfig('remote') || {};
    return Math.max(1, Math.min(MAX_PATH_ROOMS - 1, Number(config.maxRoomRange) || 2));
}

function isWithinRemoteRange(homeRoomName, remoteRoomName) {
    if (!homeRoomName || !remoteRoomName || homeRoomName === remoteRoomName) return false;
    return Game.map.getRoomLinearDistance(homeRoomName, remoteRoomName) <= getRemoteMaxRoomRange();
}

function getPathRoomSequence(path) {
    var result = [];
    for (var i = 0; i < path.length; i++) {
        if (result[result.length - 1] !== path[i].roomName) result.push(path[i].roomName);
    }
    return result;
}

function buildRouteSegments(path) {
    var segments = [];
    for (var i = 0; i < path.length; i++) {
        var last = segments[segments.length - 1];
        if (!last || last.room !== path[i].roomName) {
            last = { room: path[i].roomName, coords: [] };
            segments.push(last);
        }
        last.coords.push(packCoord(path[i]));
    }
    return segments;
}

function getRouteTerrain(path) {
    var result = { road: 0, plain: 0, swamp: 0 };
    var roads = {};
    var routeRooms = {};
    for (var routeIndex = 0; routeIndex < path.length; routeIndex++) routeRooms[path[routeIndex].roomName] = true;
    for (var roomName in routeRooms) {
        if (!Game.rooms[roomName] || typeof Game.rooms[roomName].find !== 'function') continue;
        roads[roomName] = getValidationSnapshot(Game.rooms[roomName]).roads;
    }
    for (var i = 0; i < path.length; i++) {
        var pos = path[i];
        if (roads[pos.roomName] && roads[pos.roomName][packCoord(pos)]) result.road++;
        else {
            var terrain = Game.map.getRoomTerrain(pos.roomName).get(pos.x, pos.y);
            if (terrain === TERRAIN_MASK_SWAMP) result.swamp++;
            else result.plain++;
        }
    }
    return result;
}

function estimateRouteTravelTicks(route, body, loaded) {
    route = route || { length: 1, terrain: { plain: 1, road: 0, swamp: 0 } };
    var moveParts = countBodyParts(body, MOVE);
    var weight = 0;
    for (var i = 0; i < (body || []).length; i++) {
        var type = body[i] && body[i].type || body[i];
        if (type !== MOVE && (type !== CARRY || loaded)) weight++;
    }
    if (moveParts <= 0) return Math.max(1, route.length || 1) * 50;
    var terrain = route.terrain || { road: 0, plain: route.length || 1, swamp: 0 };
    function tileTicks(cost) { return Math.max(1, Math.ceil(weight * cost / (moveParts * 2))); }
    return (terrain.road || 0) * tileTicks(1) +
        (terrain.plain || 0) * tileTicks(2) + (terrain.swamp || 0) * tileTicks(10);
}

function getRepresentativeFreighterBody(homeRoomName, sourceId) {
    var freighters = LogisticsIndex.snapshot().freighters;
    var assigned = freighters.filter(function(creep) {
        return creep.memory.homeRoom === homeRoomName && creep.body &&
            (creep.memory.freighterJob === 'remote' || creep.memory.freighterJob === 'remoteDelivery') &&
            (!sourceId || (creep.memory.pickupSourceId || creep.memory.remoteDeliverySourceId) === sourceId);
    }).sort(function(a, b) { return a.body.length - b.body.length || (a.name || '').localeCompare(b.name || ''); });
    if (assigned.length) return assigned[Math.floor(assigned.length / 2)].body;
    var room = Game.rooms[homeRoomName];
    if (room) {
        var body = BodyConfig.getFreighterBody(room);
        if (body && body.length) return body;
    }
    return [CARRY, CARRY, MOVE];
}

function getRouteTravelEstimate(info, body, loaded) {
    var route = ensureOrderedRoute(info);
    var modelOutbound = estimateRouteTravelTicks(route, body, false);
    var modelReturn = estimateRouteTravelTicks(route, body, loaded !== false);
    var samples = route.travelSamples || 0;
    var observedWeight = Math.min(0.8, samples * 0.16);
    var outbound = route.observedOutboundTicks ?
        modelOutbound * (1 - observedWeight) + route.observedOutboundTicks * observedWeight : modelOutbound;
    var returning = route.observedReturnTicks ?
        modelReturn * (1 - observedWeight) + route.observedReturnTicks * observedWeight : modelReturn;
    return { outboundTicks: Math.ceil(outbound), returnTicks: Math.ceil(returning),
        roundTripTicks: Math.ceil(outbound + returning), modelOutboundTicks: modelOutbound,
        modelReturnTicks: modelReturn };
}

function getTransitRisk(route, homeRoomName, destinationRoomName) {
    if (!route || !route.roomSequence) return 0.5;
    var risk = 0;
    for (var i = 0; i < route.roomSequence.length; i++) {
        var roomName = route.roomSequence[i];
        if (roomName === homeRoomName || roomName === destinationRoomName) continue;
        if (isBlockedRoomForPath(homeRoomName, roomName)) return 100;
        var memory = Memory.rooms && Memory.rooms[roomName];
        var hive = HiveMemory.ensure();
        var threat = hive.threats && hive.threats[roomName];
        if (!memory) risk += 0.25;
        var reservation = getReservationUsername(getControllerInfo(roomName));
        if (reservation && reservation !== getMyUsername()) risk += 1.5;
        if (!Game.rooms[roomName] && threat && threat.harmfulHostileCount > 0) risk += 5;
        if (!Game.rooms[roomName] && memory && memory.remotePlanner && memory.remotePlanner.status === 'danger') risk += 5;
    }
    return risk;
}

function getHomeAnchor(homeRoomName) {
    var room = Game.rooms[homeRoomName];
    if (!room) {
        return new RoomPosition(25, 25, homeRoomName);
    }

    if (room.storage) {
        return room.storage.pos;
    }

    var spawns = room.find(FIND_MY_SPAWNS);
    if (spawns && spawns.length > 0) {
        return spawns[0].pos;
    }

    if (room.controller) {
        return room.controller.pos;
    }

    return new RoomPosition(25, 25, homeRoomName);
}

function getSourceTargetInfo(sourceMemory) {
    if (!sourceMemory) {
        return null;
    }

    var station = utility.getPlannedSourceContainerPosition(sourceMemory);
    if (station) return { pos: station, range: 0 };

    /*
     * Target priority follows Sushi's existing source-container fields:
     * The validated planned station above wins throughout bootstrap and operation.
     * Without one, fall back to a live container, saved seat, then source range 1.
     */
    if (sourceMemory.containerId) {
        var container = Game.getObjectById(sourceMemory.containerId);
        if (
            container &&
            container.structureType === STRUCTURE_CONTAINER &&
            container.pos &&
            sourceMemory.pos &&
            container.pos.roomName === sourceMemory.pos.roomName &&
            container.pos.getRangeTo(makeRoomPosition(sourceMemory.pos)) <= 2
        ) {
            return {
                pos: container.pos,
                range: 0
            };
        }
    }

    if (sourceMemory.seats && sourceMemory.seats.length > 0) {
        return {
            pos: makeRoomPosition(sourceMemory.seats[0]),
            range: 0
        };
    }

    if (sourceMemory.pos) {
        return {
            pos: makeRoomPosition(sourceMemory.pos),
            range: 1
        };
    }

    return null;
}

function getSourceTargetPosition(sourceMemory) {
    var targetInfo = getSourceTargetInfo(sourceMemory);
    return targetInfo ? targetInfo.pos : null;
}

function makeRoomPosition(pos) {
    if (!pos || pos.x === undefined || pos.y === undefined || !pos.roomName) {
        return null;
    }

    return new RoomPosition(pos.x, pos.y, pos.roomName);
}

function buildRemoteCostMatrix(homeRoomName, roomName, allowDanger) {
    if (!allowDanger && isBlockedRoomForPath(homeRoomName, roomName)) {
        return false;
    }

    var costs = new PathFinder.CostMatrix();
    var room = Game.rooms[roomName];

    if (!room) {
        return costs;
    }

    var structures = room.find(FIND_STRUCTURES);
    for (var i = 0; i < structures.length; i++) {
        var structure = structures[i];

        if (structure.structureType === STRUCTURE_ROAD) {
            costs.set(structure.pos.x, structure.pos.y, 1);
            continue;
        }

        if (structure.structureType === STRUCTURE_CONTAINER) {
            costs.set(structure.pos.x, structure.pos.y, 5);
            continue;
        }

        if (structure.structureType === STRUCTURE_RAMPART) {
            if (!structure.my && !structure.isPublic) {
                costs.set(structure.pos.x, structure.pos.y, 255);
            }
            continue;
        }

        if (typeof OBSTACLE_OBJECT_TYPES !== 'undefined' && OBSTACLE_OBJECT_TYPES.indexOf(structure.structureType) !== -1) {
            costs.set(structure.pos.x, structure.pos.y, 255);
        }
    }

    return costs;
}

function isBlockedRoomForPath(homeRoomName, roomName) {
    var roomMemory = Memory.rooms && Memory.rooms[roomName];
    var room = Game.rooms[roomName];
    var remoteConfig = HiveMemory.getConfig('remote') || {};

    if (!remoteConfig.allowKeeperRooms && isKeeperRoom(roomName, room)) return true;
    if (room && isOwnedEnemyRoom(room)) return true;
    if (room) {
        var snapshot = getValidationSnapshot(room);
        if (snapshot.danger === undefined) snapshot.danger = hasInvaderCore(room) || hasSeriousDanger(room);
        if (snapshot.danger) return true;
    }
    if (room) return false;
    Intel.controller(roomName);
    var hive = HiveMemory.ensure();
    var threat = hive.threats && hive.threats[roomName];
    if (threat && threat.harmfulHostileCount > 0 && threat.lastSeen >= Game.time - 1500) {
        Intel.request(roomName, 'STALE_TRANSIT_SAFETY', 90);
        return true;
    }

    if (!roomMemory) {
        return false;
    }

    if (roomMemory.controller && roomMemory.controller.owner && roomMemory.controller.owner !== getMyUsername()) {
        return true;
    }

    if (roomMemory.remotePlanner && roomName !== homeRoomName) {
        return false;
    }

    return false;
}

function makeRemoteInfo(homeRoomName, remoteRoom, roomType) {
    var controller = readControllerInfo(remoteRoom);
    var risk = getRoomRisk(remoteRoom, roomType);
    var status = risk >= 5 || roomType === 'keeper' ? 'blocked' : 'candidate';

    if (isOwnedEnemyRoom(remoteRoom)) {
        status = 'blocked';
    }

    if (hasInvaderCore(remoteRoom) || hasSeriousDanger(remoteRoom)) {
        status = 'danger';
    }

    return {
        roomName: remoteRoom.name,
        parentRoomName: homeRoomName,
        status: status,
        lastSeen: Game.time,
        type: roomType,
        sourceIds: [],
        controller: controller,
        risk: risk,
        score: 0,
        netEnergyPerTick: 0,
        totalDistance: 0
    };
}

function readControllerInfo(room) {
    if (!room || !room.controller) {
        return {
            owner: null,
            reservation: null,
            ticksToEnd: 0
        };
    }

    return {
        owner: room.controller.owner ? room.controller.owner.username : null,
        reservation: room.controller.reservation ? room.controller.reservation.username : null,
        ticksToEnd: room.controller.reservation ? room.controller.reservation.ticksToEnd : 0
    };
}


function updateVisibleControllerMemory(room) { Intel.refresh(room); }

function getControllerInfo(roomName) { return Intel.controller(roomName); }

function getReservationUsername(controller) {
    if (!controller || !controller.reservation) {
        return null;
    }

    if (typeof controller.reservation === 'string') {
        return controller.reservation;
    }

    return controller.reservation.username || null;
}

function rememberBlockedRemote(homeRoomName, remoteRoomName, status) {
    var planner = ensurePlannerMemory(homeRoomName);

    if (!planner.remotes[remoteRoomName]) {
        planner.remotes[remoteRoomName] = {
            roomName: remoteRoomName,
            parentRoomName: homeRoomName,
            status: status,
            lastSeen: Game.time,
            type: 'unknown',
            sourceIds: [],
            controller: { owner: null, reservation: null, ticksToEnd: 0 },
            risk: status === 'danger' ? 10 : 5,
            score: -999,
            netEnergyPerTick: 0,
            totalDistance: 0
        };
    } else {
        planner.remotes[remoteRoomName].status = status;
        planner.remotes[remoteRoomName].lastSeen = Game.time;
        planner.remotes[remoteRoomName].score = -999;
    }
}

function getRoomType(roomName, room) {
    if (isHighwayRoom(roomName)) {
        return 'highway';
    }

    if (isKeeperRoom(roomName, room)) {
        return 'keeper';
    }

    return 'normal';
}

function isHighwayRoom(roomName) {
    var parsed = parseRoomName(roomName);
    return parsed && (parsed.x % 10 === 0 || parsed.y % 10 === 0);
}

function isKeeperRoom(roomName, room) {
    if (room) {
        var lairs = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: function(structure) {
                return typeof STRUCTURE_KEEPER_LAIR !== 'undefined' && structure.structureType === STRUCTURE_KEEPER_LAIR;
            }
        });
        if (lairs.length > 0) {
            return true;
        }
    }

    var parsed = parseRoomName(roomName);
    if (!parsed) {
        return false;
    }

    var x = parsed.x % 10;
    var y = parsed.y % 10;
    return x >= 4 && x <= 6 && y >= 4 && y <= 6;
}

function parseRoomName(roomName) {
    var match = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);
    if (!match) {
        return null;
    }

    return {
        x: parseInt(match[2], 10),
        y: parseInt(match[4], 10)
    };
}

function isOwnedEnemyRoom(room) {
    return room && room.controller && room.controller.owner && !room.controller.my;
}

function hasInvaderCore(room) {
    if (!room || typeof STRUCTURE_INVADER_CORE === 'undefined') {
        return false;
    }

    var cores = room.find(FIND_HOSTILE_STRUCTURES, {
        filter: function(structure) {
            return structure.structureType === STRUCTURE_INVADER_CORE;
        }
    });

    return cores.length > 0;
}

function hasSeriousDanger(room) {
    if (!room) {
        return false;
    }

    var freshThreat = HiveMemory.ensure().threats[room.name];
    if (freshThreat && freshThreat.lastSeen === Game.time) return freshThreat.harmfulHostileCount > 0;
    var hostiles = room.find(FIND_HOSTILE_CREEPS, {
        filter: function(creep) {
            return creep.getActiveBodyparts(ATTACK) > 0 ||
                creep.getActiveBodyparts(RANGED_ATTACK) > 0 ||
                creep.getActiveBodyparts(HEAL) > 0;
        }
    });

    return hostiles.length > 0;
}

function getRoomRisk(room, roomType) {
    var risk = 0;

    if (roomType === 'keeper') {
        risk += 10;
    }

    if (hasInvaderCore(room)) {
        risk += 10;
    }

    if (hasSeriousDanger(room)) {
        risk += 10;
    }

    if (room && room.controller && room.controller.reservation && room.controller.reservation.username !== getMyUsername()) {
        risk += 3;
    }

    return risk;
}

function getSourceSeatCount(sourceMemory) {
    if (sourceMemory && sourceMemory.seatCount && sourceMemory.seatCount > 0) {
        return sourceMemory.seatCount;
    }

    if (sourceMemory && sourceMemory.seats && sourceMemory.seats.length > 0) {
        return sourceMemory.seats.length;
    }

    return 0;
}

function canSpendPlanningCpu() {
    if (Game.cpu && Game.cpu.bucket !== undefined && Game.cpu.bucket < LOW_BUCKET_SKIP) {
        return false;
    }

    if (Game.cpu && Game.cpu.tickLimit !== undefined && Game.cpu.getUsed && Game.cpu.getUsed() > Game.cpu.tickLimit - CPU_BUFFER) {
        return false;
    }

    return true;
}

function visibleRemoteRooms(homeRoomName) {
    return Object.keys(Game.rooms).filter(function(name) {
        return name !== homeRoomName && isWithinRemoteRange(homeRoomName, name) &&
            Memory.rooms[name] && Memory.rooms[name].sources;
    }).sort();
}

function refreshVisibleIntel(homeRoomName, planner) {
    var names = visibleRemoteRooms(homeRoomName);
    var cursor = planner.visibleRefreshCursor || 0;
    for (var i = 0; i < Math.min(2, names.length); i++) {
        var name = names[(cursor + i) % names.length];
        Intel.refresh(Game.rooms[name]);
        // Live containers/haul are maintained by the existing utility without route PathFinder work.
        var sources = Memory.rooms[name].sources;
        Object.keys(sources).forEach(function(id) {
            var source = sources[id];
            var container = source.containerId && Game.getObjectById(source.containerId);
            if (container && container.store) {
                var haul = utility.ensureSourceHaulMemory(name, id, homeRoomName);
                haul.targetId = container.id;
                haul.targetType = 'container';
                haul.amount = container.store[RESOURCE_ENERGY] || 0;
                haul.capacity = typeof container.store.getCapacity === 'function' ? container.store.getCapacity(RESOURCE_ENERGY) : 2000;
                haul.lastSeen = Game.time;
            } else if (source.containerId) {
                if (source.haul && source.haul.targetId === source.containerId) {
                    source.haul.targetId = null;
                    source.haul.amount = 0;
                    source.haul.lastSeen = Game.time;
                }
                delete source.containerId;
            }
        });
        for (var id in planner.sourceInfos) {
            var info = planner.sourceInfos[id];
            if (info.roomName === name) {
                info.risk = getRoomRisk(Game.rooms[name], getRoomType(name, Game.rooms[name]));
                if (info.route && routeDestinationChanged(homeRoomName, info)) info.route.dirty = true;
            }
        }
    }
    planner.visibleRefreshCursor = names.length ? (cursor + Math.min(2, names.length)) % names.length : 0;
    planner.lastVisibleRefreshAt = Game.time;
}

function refreshVisibleCandidatePlans(homeRoomName) {
    var planner = ensurePlannerMemory(homeRoomName);
    var names = visibleRemoteRooms(homeRoomName);
    if (!names.length) return;
    var cursor = (planner.routeRefreshCursor || 0) % names.length;
    planner.routeRefreshCursor = (cursor + 1) % names.length;
    generateRemotePlan(homeRoomName, Game.rooms[names[cursor]]);
}

function rescorePlanner(homeRoomName) {
    var planner = ensurePlannerMemory(homeRoomName);

    for (var sourceId in planner.sourceInfos) {
        if (!planner.sourceInfos.hasOwnProperty(sourceId)) {
            continue;
        }

        scoreRemoteSource(homeRoomName, sourceId);
    }

    for (var remoteRoomName in planner.remotes) {
        if (!planner.remotes.hasOwnProperty(remoteRoomName)) {
            continue;
        }

        scoreRemoteRoom(homeRoomName, remoteRoomName);
    }
}

function selectActiveSources(homeRoomName) {
    var planner = ensurePlannerMemory(homeRoomName);
    var candidates = [];
    var selectedBefore = planner.activeSourceIds.slice();
    var homeRoom = Game.rooms[homeRoomName];
    var economy = Economy.get(homeRoomName);

    var maintenance = Economy.checkSpend(homeRoomName, 'remoteMaintenance');
    if (!maintenance.allowed) {
        for (var blockedId in planner.sourceInfos) {
            if (planner.sourceInfos.hasOwnProperty(blockedId) && planner.sourceInfos[blockedId]) {
                planner.sourceInfos[blockedId].active = false;
                if (planner.activeSourceIds.indexOf(blockedId) >= 0) {
                    planner.sourceInfos[blockedId].state = REMOTE_STATES.SUSPENDED_ECONOMY;
                    planner.sourceInfos[blockedId].blockedReason = maintenance.reason;
                }
            }
        }
        /* Keep portfolio, routes, ownership and construction knowledge for cheap restart. */
        planner.suspendedReason = maintenance.reason;
        planner.suspendedAt = Game.time;
        planner.lastDecision = { at: Game.time, ready: false, reason: maintenance.reason,
            category: 'remoteMaintenance', preservedSources: planner.activeSourceIds.length };
        planner.activeSourceIds = [];
        return;
    }
    delete planner.suspendedReason;

    for (var sourceId in planner.sourceInfos) {
        if (!planner.sourceInfos.hasOwnProperty(sourceId)) {
            continue;
        }

        var info = planner.sourceInfos[sourceId];
        var targetController = Intel.controller(info.roomName);
        if (targetController && targetController.my) {
            info.active = false;
            info.operational = false;
            info.blockedReason = 'OWNED_HOME';
            continue;
        }
        scoreRemoteSource(homeRoomName, sourceId);

        if (
            isWithinRemoteRange(homeRoomName, info.roomName) &&
            shouldUseRemoteSource(homeRoomName, sourceId) &&
            info.netIncome > 0
        ) {
            candidates.push(info);
        }
    }

    candidates.sort(function(a, b) {
        if (b.score !== a.score) {
            return b.score - a.score;
        }
        if (a.distance !== b.distance) {
            return a.distance - b.distance;
        }
        return a.sourceId < b.sourceId ? -1 : 1;
    });

    var levelCap = getEffectiveRemoteSourceCap(homeRoom, economy);
    var previousActive = selectedBefore.filter(function(id) {
        return candidates.some(function(candidate) { return candidate.sourceId === id; });
    });
    var ramp = candidates.length > 0 ? getRemoteRampStatus(homeRoomName, previousActive, economy) : {
        ready: false,
        reason: getPlannerBlockedReason(planner),
        category: previousActive.length === 0 ? 'remoteBootstrap' : 'remoteExpansion'
    };
    var returning = candidates.filter(function(info) { return info.established && previousActive.indexOf(info.sourceId) < 0; });
    for (var restart = 0; restart < returning.length && previousActive.length < levelCap; restart++) {
        previousActive.push(returning[restart].sourceId);
    }
    var targetCount = Math.min(Math.max(levelCap, previousActive.length), previousActive.length + (ramp.ready ? 1 : 0));
    if (previousActive.length === 0 && levelCap > 0 && ramp.ready) targetCount = 1;
    var selected = previousActive.slice(0, targetCount);
    for (var i = 0; i < candidates.length && selected.length < targetCount; i++) {
        if (selected.indexOf(candidates[i].sourceId) < 0) selected.push(candidates[i].sourceId);
    }
    rebalanceRemotePortfolio(homeRoomName, planner, candidates, selected, ramp);
    planner.activeSourceIds = selected;
    Object.keys(planner.sourceInfos).forEach(function(id) { planner.sourceInfos[id].active = selected.indexOf(id) >= 0; });
    planner.effectiveSourceCap = levelCap;
    planner.rampReason = ramp.reason;
    planner.rampReady = ramp.ready;
    planner.lastDecision = { at: Game.time, ready: ramp.ready, reason: ramp.reason,
        category: ramp.category, activeSources: selected.length, sourceCap: levelCap };
    for (i = 0; i < selected.length; i++) {
        var selectedInfo = planner.sourceInfos[selected[i]];
        if (!selectedInfo) continue;
        selectedInfo.active = true;
        selectedInfo.established = true;
        selectedInfo.state = selectedInfo.reservationBootstrap ?
            (selectedInfo.reservationBootstrapUntil >= Game.time ? REMOTE_STATES.RESERVING : REMOTE_STATES.BOOTSTRAPPING) :
            previousActive.indexOf(selected[i]) >= 0 ? REMOTE_STATES.ACTIVE : REMOTE_STATES.BOOTSTRAPPING;
        selectedInfo.blockedReason = null;
        selectedInfo.roadEligible = remoteRoadInvestmentReady(homeRoomName, selectedInfo, economy);
        if (Game.rooms[selectedInfo.roomName]) utility.planSourceContainers(selectedInfo.roomName, selectedInfo.sourceId);
        updateSourceTelemetry(homeRoomName, selectedInfo);
    }

    for (var remoteRoomName in planner.remotes) {
        if (!planner.remotes.hasOwnProperty(remoteRoomName)) {
            continue;
        }

        var remoteInfo = planner.remotes[remoteRoomName];
        remoteInfo.status = hasActiveSourceInRemote(planner, remoteInfo) ? 'active' : remoteInfo.status;
    }
    discoverSharedLanes(homeRoomName);
}

function getPlannerBlockedReason(planner) {
    for (var sourceId in planner.sourceInfos) {
        if (!planner.sourceInfos.hasOwnProperty(sourceId)) continue;
        var info = planner.sourceInfos[sourceId];
        if (info && (info.blockedReason || info.rejectReason)) {
            return info.blockedReason || info.rejectReason;
        }
    }
    return 'NO_PROFITABLE_REMOTE';
}

function updateSourceTelemetry(homeRoomName, info) {
    var sourceMemory = Memory.rooms && Memory.rooms[info.roomName] &&
        Memory.rooms[info.roomName].sources && Memory.rooms[info.roomName].sources[info.sourceId];
    var haul = sourceMemory && sourceMemory.haul || {};
    var assigned = countRemoteAssignedExtractorWork(homeRoomName, info);
    var replacementEta = null;
    for (var creepName in Game.creeps) {
        if (!Game.creeps.hasOwnProperty(creepName)) continue;
        var creep = Game.creeps[creepName];
        if (!isRemoteExtractorForSource(creep, homeRoomName, info)) continue;
        if (creep.ticksToLive !== undefined) replacementEta = replacementEta === null ?
            creep.ticksToLive : Math.min(replacementEta, creep.ticksToLive);
    }
    info.telemetry = Object.assign(info.telemetry || {}, {
        at: Game.time,
        minerPresent: assigned.count > 0,
        minerReplacementETA: replacementEta,
        containerId: sourceMemory && sourceMemory.containerId || null,
        amount: haul.amount || 0,
        currentEnergy: haul.amount || 0,
        capacity: haul.capacity || 0,
        productionRate: info.effectiveEnergyPerTick || 0,
        ticksToFull: haul.ticksToFull,
        travelTicks: info.oneWayTravelTicks || info.distance || 0,
        projectedFillAtArrival: haul.projectedFillAtArrival,
        estimatedArrival: haul.travelTicks || info.oneWayTravelTicks || info.distance || 0,
        requiredCarry: info.requiredCarry || 0,
        reservedCarry: haul.reservedCarry || 0,
        inboundFreighters: haul.inboundFreighters || 0,
        lastPickup: Math.max(haul.lastPickupAt || 0, info.telemetry && info.telemetry.lastPickup || 0),
        lastDelivery: Math.max(haul.lastDeliveryAt || 0, info.telemetry && info.telemetry.lastDelivery || 0),
        routeAge: info.route ? Game.time - info.route.calculatedAt : null,
        routeVersion: info.route && info.route.version || null,
        routeValid: info.route && info.route.valid !== false,
        routeInvalidReason: info.route && info.route.invalidReason || null,
        estimatedOutboundTicks: info.route && info.route.estimatedOutboundTicks,
        estimatedReturnTicks: info.route && info.route.estimatedReturnTicks,
        observedOutboundTicks: info.route && info.route.observedOutboundTicks,
        observedReturnTicks: info.route && info.route.observedReturnTicks,
        observedRoundTripTicks: info.route && info.route.observedRoundTripTicks,
        travelSamples: info.route && info.route.travelSamples || 0,
        dispatchSafetyTicks: haul.dispatchSafetyTicks,
        dispatchReason: haul.dispatchReason || null
    });
}

function getEffectiveRemoteSourceCap(homeRoom, economy) {
    var rcl = homeRoom && homeRoom.controller && homeRoom.controller.level || 1;
    var capacity = homeRoom && homeRoom.energyCapacityAvailable || 0;
    var hasSpawn = homeRoom && typeof homeRoom.find === 'function' && (homeRoom.find(FIND_MY_SPAWNS) || []).length > 0;
    if (!hasSpawn || capacity < 250) return 0;
    if (rcl < 2) return 1;
    if (rcl === 2) return 2;
    if (rcl === 3) return MAX_ACTIVE_REMOTE_SOURCES;
    if (!economy || !economy.growth ||
        (economy.state !== Economy.STATES.STABLE && economy.state !== Economy.STATES.SURPLUS)) {
        return MAX_ACTIVE_REMOTE_SOURCES;
    }
    var growth = economy.growth;
    var remote = growth.remote || {};
    var threats = HiveMemory.ensure().threats[homeRoom.name];
    var backlog = Math.max(0, (remote.backlog || 0) - (remote.reservedCarry || 0));
    var logisticsProven = (remote.operationalSources !== undefined ? remote.operationalSources : remote.activeSources || 0) === 0 ||
        remote.provenSources >= (remote.operationalSources !== undefined ? remote.operationalSources : remote.activeSources || 0) && backlog <= 500 &&
        (remote.requiredCarry || 0) <= (remote.availableCarry || 0);
    if (growth.spawnPressure > 0.45 || economy.replacementRisk > 0 || !logisticsProven ||
        (threats && threats.harmfulHostileCount > 0) ||
        (Game.cpu && Game.cpu.bucket !== undefined && Game.cpu.bucket < 5000)) {
        return MAX_ACTIVE_REMOTE_SOURCES;
    }
    var spawns = typeof homeRoom.find === 'function' ? homeRoom.find(FIND_MY_SPAWNS) || [] : [];
    if (spawns.length === 0) {
        for (var spawnName in Game.spawns) {
            if (Game.spawns[spawnName] && Game.spawns[spawnName].room === homeRoom) spawns.push(Game.spawns[spawnName]);
        }
    }
    var rclAllowance = rcl >= 8 ? 4 : rcl >= 7 ? 3 : rcl >= 6 ? 2 : 1;
    var spawnAllowance = Math.max(1, spawns.length);
    return MAX_ACTIVE_REMOTE_SOURCES + Math.min(rclAllowance, spawnAllowance);
}

function remoteSwitchingCost(homeRoomName, info) {
    var sourceMemory = Memory.rooms && Memory.rooms[info.roomName] &&
        Memory.rooms[info.roomName].sources && Memory.rooms[info.roomName].sources[info.sourceId];
    var cost = REMOTE_REBALANCE_MIN_GAIN;
    if (sourceMemory && sourceMemory.containerId) cost += 0.6;
    if (countRemoteAssignedExtractorWork(homeRoomName, info).count > 0) cost += 0.5;
    if (sourceMemory && sourceMemory.haul && sourceMemory.haul.lastSeen >= Game.time - 100) cost += 0.4;
    var controller = getControllerInfo(info.roomName);
    if (controller && controller.reservation && controller.reservation.username === getMyUsername()) cost += 0.25;
    return cost;
}

function rebalanceRemotePortfolio(homeRoomName, planner, candidates, selected, ramp) {
    if (!ramp.ready || selected.length === 0 ||
        planner.lastRebalanceAt && Game.time - planner.lastRebalanceAt < REMOTE_REBALANCE_COOLDOWN) return;
    var selectedInfos = selected.map(function(id) { return planner.sourceInfos[id]; }).filter(Boolean);
    var inactive = candidates.filter(function(info) { return selected.indexOf(info.sourceId) < 0; });
    if (inactive.length === 0) return;
    selectedInfos.sort(function(a, b) { return a.score - b.score; });
    var incumbent = selectedInfos[0];
    var challenger = inactive[0];
    var requiredGain = remoteSwitchingCost(homeRoomName, incumbent);
    if (!incumbent || challenger.score < incumbent.score + requiredGain) return;
    selected[selected.indexOf(incumbent.sourceId)] = challenger.sourceId;
    planner.lastRebalanceAt = Game.time;
    planner.lastRebalance = {
        from: incumbent.sourceId,
        to: challenger.sourceId,
        gain: round3(challenger.score - incumbent.score),
        requiredGain: round3(requiredGain)
    };
}

function getRemoteRampStatus(homeRoomName, activeIds, economy) {
    var room = Game.rooms[homeRoomName];
    if (!room || !room.controller) return { ready: false, reason: 'HOME_NOT_VISIBLE', category: 'remoteBootstrap' };
    var category = activeIds.length === 0 ? 'remoteBootstrap' : 'remoteExpansion';
    var spend = Economy.checkSpend(homeRoomName, category);
    if (!spend.allowed) return { ready: false, reason: spend.reason, category: category };
    if (!economy || !economy.growth) return { ready: false, reason: 'ECONOMY_TELEMETRY_MISSING' };
    if (economy.harvest && economy.harvest.workActive < Math.max(1, economy.harvest.workRequired * 0.9)) {
        return { ready: false, reason: 'LOCAL_HARVEST_SHORTAGE', category: category };
    }
    if (economy.growth.spawnPressure >= 0.75) return { ready: false, reason: 'SPAWN_PRESSURE' };
    if (economy.haul && (economy.haul.localCarry < economy.haul.requiredCarry * 0.85 ||
        economy.growth.remote.backlog - economy.growth.remote.reservedCarry > 750 ||
        economy.growth.remote.requiredCarry > economy.growth.remote.availableCarry &&
            economy.growth.remote.backlog > 250)) {
        return { ready: false, reason: 'HAUL_SHORTAGE' };
    }
    var planner = ensurePlannerMemory(homeRoomName);
    var queue = Memory.rooms[homeRoomName] && Memory.rooms[homeRoomName].spawn &&
        Memory.rooms[homeRoomName].spawn.queue || [];
    for (var i = 0; i < activeIds.length; i++) {
        var info = planner.sourceInfos[activeIds[i]];
        if (!info) continue;
        var assigned = countRemoteAssignedExtractorWork(homeRoomName, info);
        var pending = countPendingRemoteExtractorRequest(homeRoomName, info, queue);
        if (assigned.count + pending.count < 1) return { ready: false, reason: 'REMOTE_MINER_PENDING' };
        var sourceMemory = Memory.rooms[info.roomName] && Memory.rooms[info.roomName].sources &&
            Memory.rooms[info.roomName].sources[info.sourceId];
        if (!sourceMemory || !sourceMemory.containerId && !sourceMemory.containerPlanned) {
            return { ready: false, reason: 'REMOTE_CONTAINER_PENDING' };
        }
        if (!sourceMemory.haul || sourceMemory.haul.lastSeen < Game.time - 100) {
            return { ready: false, reason: 'REMOTE_HAUL_UNPROVEN' };
        }
    }
    return { ready: true, reason: activeIds.length ? 'LOGISTICS_READY_FOR_NEXT_SOURCE' : 'FIRST_PROFITABLE_SOURCE', category: category };
}

function remoteRoadInvestmentReady(homeRoomName, info, economy) {
    if (!info || !info.active || info.reservationBootstrap || info.netIncome <= 0 || !economy) return false;
    var sourceMemory = Memory.rooms[info.roomName] && Memory.rooms[info.roomName].sources &&
        Memory.rooms[info.roomName].sources[info.sourceId];
    var controller = getControllerInfo(info.roomName);
    var reserved = controller && controller.reservation && controller.reservation.username === getMyUsername();
    var haulOperational = sourceMemory && sourceMemory.haul && sourceMemory.haul.lastSeen >= Game.time - 100;
    var growth = economy.growth || {};
    var localHealthy = economy.harvest && economy.harvest.workActive >=
        Math.max(1, economy.harvest.workRequired * 0.9);
    var terrain = info.route && info.route.terrain || {};
    var materialGain = (terrain.plain || 0) + (terrain.swamp || 0) * 3 >= 10;
    var recoverySafe = economy.state !== Economy.STATES.RECOVERY ||
        (localHealthy && info.state === REMOTE_STATES.ACTIVE && info.netIncome >= 2 &&
            materialGain && growth.energyAboveReserve >= 100);
    return !!(recoverySafe && sourceMemory && sourceMemory.containerId && haulOperational && reserved &&
        growth.energyAboveReserve > 0 && growth.controllerBudget >= 1);
}

function hasActiveSourceInRemote(planner, remoteInfo) {
    if (!remoteInfo || !remoteInfo.sourceIds) {
        return false;
    }

    for (var i = 0; i < remoteInfo.sourceIds.length; i++) {
        var info = planner.sourceInfos[remoteInfo.sourceIds[i]];
        if (info && info.active) {
            return true;
        }
    }

    return false;
}

function claimBestParentForSource(homeRoomName, newInfo) {
    var bestInfo = newInfo;

    for (var roomName in Memory.rooms) {
        if (!Memory.rooms.hasOwnProperty(roomName)) {
            continue;
        }

        var planner = Memory.rooms[roomName].remotePlanner;
        if (!planner || !planner.sourceInfos || !planner.sourceInfos[newInfo.sourceId]) {
            continue;
        }

        var oldInfo = planner.sourceInfos[newInfo.sourceId];
        if (oldInfo.parentRoomName === homeRoomName) {
            continue;
        }

        if (!isWithinRemoteRange(oldInfo.parentRoomName, oldInfo.roomName)) {
            delete planner.sourceInfos[newInfo.sourceId];
            removeFromActiveList(planner, newInfo.sourceId);
            continue;
        }

        var incumbentEstablished = oldInfo.active || oldInfo.state === REMOTE_STATES.ACTIVE ||
            oldInfo.state === REMOTE_STATES.BOOTSTRAPPING || oldInfo.state === REMOTE_STATES.DEGRADED;
        var parentCooldownActive = incumbentEstablished &&
            Game.time - (oldInfo.lastParentChangeAt || 0) < REMOTE_REBALANCE_COOLDOWN;
        var newAdvantage = (newInfo.netIncome || 0) - (oldInfo.netIncome || 0);
        var oldBetter = parentCooldownActive ||
            newAdvantage < remoteSwitchingCost(oldInfo.parentRoomName, oldInfo) ||
            (newAdvantage === 0 && oldInfo.distance <= newInfo.distance);

        if (oldBetter) {
            bestInfo = oldInfo;
            break;
        }

        newInfo.lastParentChangeAt = Game.time;
        delete planner.sourceInfos[newInfo.sourceId];
        removeFromActiveList(planner, newInfo.sourceId);
    }

    return bestInfo;
}

function removeFromActiveList(planner, sourceId) {
    if (!planner || !planner.activeSourceIds) {
        return;
    }

    var next = [];
    for (var i = 0; i < planner.activeSourceIds.length; i++) {
        if (planner.activeSourceIds[i] !== sourceId) {
            next.push(planner.activeSourceIds[i]);
        }
    }
    planner.activeSourceIds = next;
}

function cleanupRemoteAssignments(homeRoomName) {
    var planner = ensurePlannerMemory(homeRoomName);

    for (var sourceId in planner.sourceInfos) {
        if (!planner.sourceInfos.hasOwnProperty(sourceId)) {
            continue;
        }

        var info = planner.sourceInfos[sourceId];
        var remoteMemory = Memory.rooms && Memory.rooms[info.roomName];
        var sourceMemory = remoteMemory && remoteMemory.sources ? remoteMemory.sources[sourceId] : null;

        if (!sourceMemory) {
            continue;
        }

        if (!sourceMemory.assignedMiner) {
            sourceMemory.assignedMiner = [];
        }
        if (typeof sourceMemory.assignedMiner === 'string') {
            sourceMemory.assignedMiner = [sourceMemory.assignedMiner];
        }
        if (!Array.isArray(sourceMemory.assignedMiner)) {
            sourceMemory.assignedMiner = [];
        }

        var clean = [];
        var seen = {};
        for (var i = 0; i < sourceMemory.assignedMiner.length; i++) {
            var creepId = sourceMemory.assignedMiner[i];
            var creep = Game.getObjectById(creepId) || Game.creeps[creepId];

            if (!isCreepAssignedToRemote(creep, homeRoomName, info)) {
                continue;
            }

            if (seen[creep.id]) {
                continue;
            }

            seen[creep.id] = true;
            clean.push(creep.id);
        }

        sourceMemory.assignedMiner = clean;
    }
}

function isCreepAssignedToRemote(creep, homeRoomName, info) {
    if (!creep || !creep.my || !creep.memory) {
        return false;
    }

    if (creep.memory.role !== 'Extractor') {
        return false;
    }

    return creep.memory.remoteMining === true &&
        creep.memory.homeRoom === homeRoomName &&
        (creep.memory.sourceId === info.sourceId || creep.memory.targetSourceId === info.sourceId) &&
        (creep.memory.sourceRoom === info.roomName || creep.memory.targetRoom === info.roomName);
}

function hasRemoteAssignmentCapacity(homeRoomName, info, requestingCreep) {
    if (requestingCreep && isCreepAssignedToRemote(requestingCreep, homeRoomName, info)) {
        return true;
    }

    var assigned = countRemoteAssignedExtractorWork(homeRoomName, info);
    var queue = Memory.rooms && Memory.rooms[homeRoomName] && Memory.rooms[homeRoomName].spawn ?
        Memory.rooms[homeRoomName].spawn.queue : null;
    var queued = countPendingRemoteExtractorRequest(homeRoomName, info, queue);

    return assigned.work + queued.work < getRemoteWantedWork(info) &&
        assigned.count + queued.count < getRemoteSeatCapacity(info);
}

function claimRemoteSource(creep, homeRoomName, info) {
    if (!creep || !creep.memory || !info || !isWithinRemoteRange(homeRoomName, info.roomName)) {
        return false;
    }

    // Remote Extractor is assignment state, not a separate role.
    creep.memory.role = 'Extractor';
    creep.memory.sourceId = info.sourceId;
    creep.memory.targetSourceId = info.sourceId;
    creep.memory.sourceRoom = info.roomName;
    creep.memory.targetRoom = info.roomName;
    creep.memory.homeRoom = homeRoomName;
    creep.memory.remoteMining = true;

    var remoteMemory = Memory.rooms && Memory.rooms[info.roomName];
    var sourceMemory = remoteMemory && remoteMemory.sources ? remoteMemory.sources[info.sourceId] : null;

    if (!sourceMemory) {
        return true;
    }

    if (!sourceMemory.assignedMiner || !Array.isArray(sourceMemory.assignedMiner)) {
        sourceMemory.assignedMiner = [];
    }

    for (var i = 0; i < sourceMemory.assignedMiner.length; i++) {
        if (sourceMemory.assignedMiner[i] === creep.id) {
            return true;
        }
    }

    sourceMemory.assignedMiner.push(creep.id);
    return true;
}

function isBetterExtractorRemote(candidate, best) {
    if (candidate.score !== best.score) {
        return candidate.score > best.score;
    }

    if (candidate.distance !== best.distance) {
        return candidate.distance < best.distance;
    }

    return candidate.sourceId < best.sourceId;
}

function moveExtractorAlongRemotePath(creep, homeRoomName, sourceId) {
    creep.memory.extractorState = 'movingToRemoteSource';
    return followRemotePath(creep, homeRoomName, sourceId, false);
}

function getRemoteSourcePosition(homeRoomName, sourceId) {
    var planner = ensurePlannerMemory(homeRoomName);
    var info = planner.sourceInfos[sourceId];
    if (!info) {
        return null;
    }

    var remoteMemory = Memory.rooms && Memory.rooms[info.roomName];
    var sourceMemory = remoteMemory && remoteMemory.sources ? remoteMemory.sources[sourceId] : null;
    if (sourceMemory && sourceMemory.pos) {
        return makeRoomPosition(sourceMemory.pos);
    }

    if (info.containerCoord !== undefined && info.containerCoord !== null) {
        return unpackCoord(info.containerCoord, info.roomName);
    }

    return new RoomPosition(25, 25, info.roomName);
}



function getActiveRemoteSourcesForHome(homeRoomName) {
    if (!Economy.canSpend(homeRoomName, 'remoteMaintenance')) return [];
    var planner = ensurePlannerMemory(homeRoomName);
    var activeSources = [];

    for (var i = 0; i < planner.activeSourceIds.length; i++) {
        var sourceId = planner.activeSourceIds[i];
        var info = planner.sourceInfos[sourceId];

        if (
            !info ||
            !info.active ||
            info.operational === false || (info.route && info.route.valid === false) ||
            info.parentRoomName !== homeRoomName ||
            !isWithinRemoteRange(homeRoomName, info.roomName)
        ) {
            continue;
        }

        activeSources.push(info);
    }

    return activeSources;
}

function countRemoteAssignedExtractorWork(homeRoomName, sourceInfo) {
    var result = {
        count: 0,
        work: 0
    };
    var seen = {};

    if (!sourceInfo) {
        return result;
    }

    for (var creepName in Game.creeps) {
        if (!Game.creeps.hasOwnProperty(creepName)) {
            continue;
        }

        var creep = Game.creeps[creepName];
        if (!isRemoteExtractorForSource(creep, homeRoomName, sourceInfo)) {
            continue;
        }

        var replacementLead = ((creep.body && creep.body.length) || 0) * 3 +
            Math.max(EXTRACTOR_REPLACEMENT_BUFFER_TICKS, sourceInfo.distance || 0) + 10;
        if (
            creep.ticksToLive !== undefined &&
            creep.ticksToLive <= replacementLead
        ) {
            continue;
        }

        if (seen[creep.id]) {
            continue;
        }

        seen[creep.id] = true;
        result.count++;
        result.work += countCreepBodyParts(creep, WORK);
    }

    return result;
}

function hasPendingRemoteExtractorRequest(homeRoomName, sourceInfo, queue) {
    return countPendingRemoteExtractorRequest(homeRoomName, sourceInfo, queue).count > 0;
}

function countPendingRemoteExtractorRequest(homeRoomName, sourceInfo, queue) {
    var result = {
        count: 0,
        work: 0
    };

    if (!sourceInfo || !queue) {
        return result;
    }

    for (var i = 0; i < queue.length; i++) {
        var request = queue[i];
        var memory = request && request.memory ? request.memory : {};
        var role = request ? (request.role || memory.role) : null;

        if (role !== 'Extractor') {
            continue;
        }

        if (memory.remoteMining !== true) {
            continue;
        }

        if (memory.homeRoom !== homeRoomName) {
            continue;
        }

        if ((memory.sourceRoom || memory.targetRoom) !== sourceInfo.roomName) {
            continue;
        }

        if ((memory.sourceId || memory.targetSourceId) !== sourceInfo.sourceId) {
            continue;
        }

        result.count++;
        result.work += countBodyParts(request.body, WORK);
    }

    return result;
}

function getRemoteExtractorDemand(homeRoomName, extractorBody, queue) {
    var demands = [];
    var activeSources = getActiveRemoteSourcesForHome(homeRoomName);

    for (var i = 0; i < activeSources.length; i++) {
        var sourceInfo = activeSources[i];

        if (!isWithinRemoteRange(homeRoomName, sourceInfo.roomName)) {
            continue;
        }

        var assigned = countRemoteAssignedExtractorWork(homeRoomName, sourceInfo);
        var queued = countPendingRemoteExtractorRequest(homeRoomName, sourceInfo, queue);
        var wantedWork = getRemoteWantedWork(sourceInfo);
        var seats = getRemoteSeatCapacity(sourceInfo);
        var missingWork = Math.max(0, wantedWork - assigned.work - queued.work);
        if (!missingWork || assigned.count + queued.count >= seats) {
            continue;
        }

        demands.push({
            sourceInfo: sourceInfo,
            sourceId: sourceInfo.sourceId,
            remoteRoomName: sourceInfo.roomName,
            homeRoomName: homeRoomName,
            seats: seats,
            missingWork: missingWork,
            assignedCount: assigned.count,
            assignedWork: assigned.work,
            queuedCount: queued.count,
            queuedWork: queued.work,
            wantedWork: wantedWork,
            bodyWork: countBodyParts(extractorBody, WORK)
        });
    }

    return demands;
}

function getRemoteWantedWork(info) {
    var energy = info.effectiveEnergyPerTick || info.grossEnergyPerTick || 10;
    // A fresh friendly reservation raises coverage immediately, before the next rescore.
    var controller = getControllerInfo(info.roomName);
    if (getReservationUsername(controller) === getMyUsername() && getMyUsername()) {
        energy = info.grossEnergyPerTick || 10;
    }
    return Math.max(1, Math.ceil(energy / (typeof HARVEST_POWER === 'number' ? HARVEST_POWER : 2)));
}

function getRemoteSeatCapacity(info) {
    var room = Memory.rooms[info.roomName];
    var memory = room && room.sources && room.sources[info.sourceId];
    var positions = utility.getValidSourceMiningSeats(memory);
    var savedCount = memory && typeof memory.seatCount === 'number' ? memory.seatCount : null;
    if (memory && memory.pos) return Math.max(0, savedCount === null ? positions.length : Math.min(savedCount, positions.length));
    return Math.max(0, savedCount === null ? (info.numOpen || 1) : savedCount);
}

function isRemoteExtractorForSource(creep, homeRoomName, sourceInfo) {
    if (!creep || !creep.my || !creep.memory || !sourceInfo) {
        return false;
    }

    if (creep.memory.role !== 'Extractor') {
        return false;
    }

    return creep.memory.remoteMining === true &&
        creep.memory.homeRoom === homeRoomName &&
        (creep.memory.sourceRoom === sourceInfo.roomName || creep.memory.targetRoom === sourceInfo.roomName) &&
        (creep.memory.sourceId === sourceInfo.sourceId || creep.memory.targetSourceId === sourceInfo.sourceId);
}

function countCreepBodyParts(creep, bodyPartType) {
    if (!creep) {
        return 0;
    }

    if (typeof creep.getActiveBodyparts === 'function') {
        var activeParts = creep.getActiveBodyparts(bodyPartType);
        if (activeParts > 0 || !creep.spawning) {
            return activeParts;
        }
    }

    return countBodyPartsFromCreepBody(creep.body, bodyPartType);
}

function countBodyParts(body, bodyPartType) {
    var count = 0;

    if (!body) {
        return count;
    }

    for (var i = 0; i < body.length; i++) {
        if (body[i] === bodyPartType || (body[i] && body[i].type === bodyPartType)) {
            count++;
        }
    }

    return count;
}

function countBodyPartsFromCreepBody(body, bodyPartType) {
    var count = 0;

    if (!body) {
        return count;
    }

    for (var i = 0; i < body.length; i++) {
        if (body[i] && body[i].type === bodyPartType && body[i].hits !== 0) {
            count++;
        }
    }

    return count;
}

function claimRemotePickupTarget(creep, pickupInfo) {
    if (!creep || !creep.memory || !pickupInfo) {
        return false;
    }

    var homeRoomName = pickupInfo.homeRoomName || creep.memory.homeRoom || creep.room.name;
    var pickupRoom = pickupInfo.pickupRoom || pickupInfo.remoteRoomName;
    var source = ensurePlannerMemory(homeRoomName).sourceInfos[pickupInfo.sourceId];
    if (!source || !source.active || source.operational === false || (source.route && source.route.valid === false)) return false;
    var haul = utility.ensureSourceHaulMemory(pickupRoom, pickupInfo.sourceId, homeRoomName);

    if (!haul || haul.targetId !== pickupInfo.targetId) {
        return false;
    }

    releaseRemoteFreighterReservation(creep);
    syncSourceHaulReservation(pickupRoom, pickupInfo.sourceId, haul, creep.name);

    var projectedEnergy = Math.max(haul.amount || 0, pickupInfo.projectedEnergyAtArrival || 0);
    var remainingEnergy = projectedEnergy - haul.reservedCarry;
    var reservedCarry = Math.min(
        creep.store.getFreeCapacity(RESOURCE_ENERGY),
        Math.max(0, remainingEnergy)
    );

    if (reservedCarry <= 0) {
        return false;
    }

    creep.memory.freighterJob = 'remote';
    creep.memory.pickupRoom = pickupRoom;
    creep.memory.pickupSourceId = pickupInfo.sourceId;
    creep.memory.pickupTargetId = pickupInfo.targetId;
    creep.memory.pickupTargetType = pickupInfo.type;
    creep.memory.homeRoom = homeRoomName;
    creep.memory.destinationRoom = pickupInfo.destinationRoom || homeRoomName;
    creep.memory.logisticsPurpose = 'REMOTE_ENERGY';
    creep.memory.freighterReservedCarry = reservedCarry;
    creep.memory.freighterReservedUntil = Game.time + HAUL_RESERVATION_TICKS;
    delete creep.memory.remoteTrip;
    delete creep.memory.remoteReturnComplete;
    delete creep.memory.remoteOutboundLane;

    LogisticsIndex.update(creep);
    syncSourceHaulReservation(pickupRoom, pickupInfo.sourceId, haul, null);

    return true;
}

function clearRemoteFreighterMemory(creep) {
    if (!creep || !creep.memory) {
        return;
    }

    releaseRemoteFreighterReservation(creep);

    delete creep.memory.freighterJob;
    delete creep.memory.pickupRoom;
    delete creep.memory.pickupSourceId;
    delete creep.memory.pickupTargetId;
    delete creep.memory.pickupTargetType;
    delete creep.memory.freighterReservedCarry;
    delete creep.memory.freighterReservedUntil;
    delete creep.memory.remoteDeliveryRoom;
    delete creep.memory.remoteDeliverySourceId;
    delete creep.memory.destinationRoom;
    delete creep.memory.logisticsPurpose;
    delete creep.memory.originRoom;
    delete creep.memory.resourceType;
    delete creep.memory.logisticsAmount;
    delete creep.memory.logisticsPriority;
    delete creep.memory.remoteTrip;
    delete creep.memory.remoteReturnComplete;

    /* Remove fields written by the previous remote Freighter implementation. */
    delete creep.memory.remoteFreighting;
    delete creep.memory.freighterHomeRoom;
    delete creep.memory.freighterRemoteRoom;
    delete creep.memory.freighterPickupTargetId;
    delete creep.memory.freighterPickupSourceId;
    delete creep.memory.freighterPickupType;
}

function refreshRemoteFreighterReservation(creep) {
    if (!creep || !creep.memory || creep.memory.freighterJob !== 'remote') {
        return false;
    }

    var haul = utility.ensureSourceHaulMemory(
        creep.memory.pickupRoom,
        creep.memory.pickupSourceId,
        creep.memory.homeRoom
    );

    if (!haul || haul.targetId !== creep.memory.pickupTargetId) {
        return false;
    }

    var freeCapacity = creep.store.getFreeCapacity(RESOURCE_ENERGY);

    if (freeCapacity <= 0) {
        releaseRemoteFreighterReservation(creep);
        return false;
    }

    creep.memory.freighterReservedCarry = Math.min(
        creep.memory.freighterReservedCarry || freeCapacity,
        freeCapacity
    );
    creep.memory.freighterReservedUntil = Game.time + HAUL_RESERVATION_TICKS;
    LogisticsIndex.update(creep);
    syncSourceHaulReservation(creep.memory.pickupRoom, creep.memory.pickupSourceId, haul, null);
    return true;
}

function releaseRemoteFreighterReservation(creep) {
    if (creep) LogisticsIndex.remove(creep);
    if (!creep || !creep.memory || !creep.memory.pickupRoom || !creep.memory.pickupSourceId) {
        return;
    }

    var haul = utility.ensureSourceHaulMemory(
        creep.memory.pickupRoom,
        creep.memory.pickupSourceId,
        creep.memory.homeRoom
    );

    if (haul) {
        syncSourceHaulReservation(creep.memory.pickupRoom, creep.memory.pickupSourceId, haul, creep.name);
    }
}

function syncSourceHaulReservation(roomName, sourceId, haul, skipCreepName) {
    var claim = LogisticsIndex.remoteClaim(roomName, sourceId, haul.targetId, skipCreepName);
    haul.reservedBy = claim.name;
    haul.reservedUntil = claim.until;
    haul.reservedCarry = claim.energy;
}

function getLogisticsDestinationRoom(creep) {
    return creep && creep.memory && (creep.memory.destinationRoom || creep.memory.homeRoom) || null;
}

function getHomeDeliveryTarget(creep, destinationRoomName) {
    if (!creep || !creep.memory) {
        return null;
    }

    var homeRoomName = destinationRoomName || getLogisticsDestinationRoom(creep) || creep.room.name;
    var homeRoom = Game.rooms[homeRoomName];

    if (!homeRoom) {
        return null;
    }

    var spawnOrExtension = homeRoom.find(FIND_MY_STRUCTURES, {
        filter: function(structure) {
            return (
                (structure.structureType === STRUCTURE_SPAWN || structure.structureType === STRUCTURE_EXTENSION) &&
                structure.store &&
                structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0
            );
        }
    })[0];

    if (spawnOrExtension && homeRoom.energyAvailable < homeRoom.energyCapacityAvailable) {
        return spawnOrExtension;
    }

    if (homeRoom.storage && homeRoom.storage.store && homeRoom.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        return homeRoom.storage;
    }

    var tower = homeRoom.find(FIND_MY_STRUCTURES, {
        filter: function(structure) {
            return structure.structureType === STRUCTURE_TOWER &&
                structure.store &&
                structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
        }
    })[0];

    if (tower) {
        return tower;
    }

    if (homeRoom.terminal && homeRoom.terminal.store && homeRoom.terminal.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        return homeRoom.terminal;
    }

    return null;
}

function getBestRemoteRoomForFreighter(creep) {
    var homeRoomName = creep && creep.memory ? (creep.memory.homeRoom || creep.room.name) : null;
    if (!homeRoomName) {
        return null;
    }

    var planner = ensurePlannerMemory(homeRoomName);
    var best = null;

    for (var i = 0; i < planner.activeSourceIds.length; i++) {
        var info = planner.sourceInfos[planner.activeSourceIds[i]];
        if (!info || !info.active) {
            continue;
        }

        if (!best || info.score > best.score || (info.score === best.score && info.distance < best.distance)) {
            best = info;
        }
    }

    return best ? best.roomName : null;
}

function moveFreighterToRemotePickup(creep) {
    if (!creep || !creep.memory) {
        return false;
    }

    var homeRoomName = creep.memory.homeRoom;
    var sourceId = creep.memory.pickupSourceId;
    var target = creep.memory.pickupTargetId ? Game.getObjectById(creep.memory.pickupTargetId) : null;

    if (homeRoomName && sourceId && moveFreighterAlongRemotePath(creep, homeRoomName, sourceId, false)) return true;
    if (target) return travel.move(creep, target, { range: 1 }) === OK;

    return false;
}

function moveFreighterAlongRemotePath(creep, homeRoomName, sourceId, reverse) {
    return followRemotePath(creep, homeRoomName, sourceId, reverse === true);
}

function atRouteEndpoint(creep, info, reverse) {
    var route = ensureOrderedRoute(info);
    var segment = reverse ? route.segments[0] : route.segments[route.segments.length - 1];
    if (!segment || !segment.coords.length || !creep.pos || creep.pos.roomName !== segment.room) return false;
    var coord = reverse ? segment.coords[0] : segment.coords[segment.coords.length - 1];
    // The pickup tile can be occupied by its stationary miner.
    var range = !reverse && creep.memory && creep.memory.role === 'Freighter' ? 1 : 0;
    return creep.pos.getRangeTo(unpackCoord(coord, segment.room)) <= range;
}

function retreatRemoteCreep(creep, homeRoomName) {
    if (creep.memory && creep.memory.role === 'Extractor') creep.memory.extractorState = 'remoteRetreat';
    if (!creep.pos || creep.pos.roomName === homeRoomName) return true;
    // Compute a safe retreat explicitly; never use generic room travel for a failed lane.
    var result = PathFinder.search(creep.pos, { pos: getHomeAnchor(homeRoomName), range: 1 }, {
        maxRooms: MAX_PATH_ROOMS, maxOps: MAX_PATH_OPS,
        roomCallback: function(roomName) {
            if (roomName !== creep.pos.roomName && isBlockedRoomForPath(homeRoomName, roomName)) return false;
            return buildRemoteCostMatrix(homeRoomName, roomName, roomName === creep.pos.roomName);
        }
    });
    if (!result.incomplete && result.path && result.path.length) {
        travel.move(creep, result.path[0], { range: 0,
            maxRooms: result.path[0].roomName === creep.pos.roomName ? 1 : 2, reusePath: 0 });
    }
    return true;
}

function followRemotePath(creep, homeRoomName, sourceId, reverse) {
    var info = ensurePlannerMemory(homeRoomName).sourceInfos[sourceId];
    if (!info) return true; // Missing plan: wait for the planner, never invent an outbound route.
    var path = getRemotePath(homeRoomName, sourceId);
    if (!path.length) {
        if (creep.memory) {
            delete creep.memory.remoteTrip;
            creep.memory.freighterReservedUntil = Game.time - 1;
            releaseRemoteFreighterReservation(creep);
        }
        if (info.route && info.route.invalidReason === 'HOSTILE_TRANSIT_ROOM') {
            if (creep.pos.roomName === homeRoomName && creep.memory && creep.memory.role === 'Freighter') {
                if (reverse) return false;
                if ((creep.store[RESOURCE_ENERGY] || 0) > 0) {
                    creep.memory.remoteDeliverySourceId = sourceId;
                    creep.memory.remoteDeliveryRoom = info.roomName;
                    creep.memory.freighterJob = 'remoteDelivery';
                    creep.memory.FreighterWorking = true;
                    releaseRemoteFreighterReservation(creep);
                } else clearRemoteFreighterMemory(creep);
                return true;
            }
            return retreatRemoteCreep(creep, homeRoomName);
        }
        info.replanRequestedAt = info.replanRequestedAt || Game.time;
        return true;
    }
    var route = info.route;
    route.traffic = route.traffic || { moves: 0, blockedMoves: 0, pushes: 0, detours: 0, stuckEvents: 0,
        avgObservedTravel: route.observedRoundTripTicks || 0, congestionScore: 0, lastUpdated: Game.time };
    // The lane owns travel and safety; beside the source, unique mining seats own movement.
    // Supplements must not be driven back onto the primary station every tick.
    if (!reverse && creep.memory && creep.memory.role === 'Extractor') {
        var sourceMemory = Memory.rooms[info.roomName] && Memory.rooms[info.roomName].sources &&
            Memory.rooms[info.roomName].sources[sourceId];
        var station = utility.getPlannedSourceContainerPosition(sourceMemory);
        if (station && creep.pos.roomName === info.roomName &&
            creep.pos.getRangeTo(makeRoomPosition(sourceMemory.pos)) <= 1) return false;
    }
    if (!reverse && creep.memory && creep.memory.role === 'Freighter') refreshRemoteFreighterReservation(creep);
    if (reverse && creep.memory && creep.memory.remoteReturnComplete === sourceId + ':' + route.revision) return false;
    if (atRouteEndpoint(creep, info, reverse)) {
        recordRemoteTripLeg(creep, reverse ? 'RETURN' : 'OUTBOUND');
        if (reverse && creep.memory) creep.memory.remoteReturnComplete = sourceId + ':' + route.revision;
        return false;
    }
    var bestIndex = -1;
    var bestRange = Infinity;
    for (var i = 0; i < path.length; i++) {
        if (path[i].roomName !== creep.pos.roomName) continue;
        var range = creep.pos.getRangeTo(path[i]);
        if (range < bestRange) { bestRange = range; bestIndex = i; }
    }
    if (creep.memory && creep.memory.role === 'Freighter') {
        if (!reverse && bestIndex === 0 && bestRange === 0 && !creep.memory.remoteTrip) startRemoteTrip(creep, info);
        if (reverse && creep.memory.remoteTrip && creep.memory.remoteTrip.direction === 'PICKUP' &&
            atRouteEndpoint(creep, info, false)) {
            creep.memory.remoteTrip.direction = 'RETURN';
            creep.memory.remoteTrip.returnStartedAt = Game.time;
        }
    }
    // Rejoin the saved lane locally before progressing; do not skip rooms or corners.
    if (bestIndex < 0) return retreatRemoteCreep(creep, homeRoomName);
    var laneKey = sourceId + ':' + route.revision;
    if (!reverse && creep.memory && creep.pos.roomName === homeRoomName && creep.memory.remoteOutboundLane !== laneKey) {
        if (bestIndex === 0 && bestRange === 0) creep.memory.remoteOutboundLane = laneKey;
        else { travel.move(creep, path[0], { range: 0, maxRooms: 1, reusePath: 5 }); return true; }
    }
    var nextIndex = (bestRange === 0 || (reverse && atRouteEndpoint(creep, info, false))) ? (reverse ? Math.max(0, bestIndex - 1) : Math.min(path.length - 1, bestIndex + 1)) : bestIndex;
    if (!reverse && creep.pos.roomName === homeRoomName && bestRange > 3) nextIndex = 0;
    var result = travel.move(creep, path[nextIndex], { range: 0,
        maxRooms: path[nextIndex].roomName === creep.pos.roomName ? 1 : 2, reusePath: 5 });
    route.traffic.moves++;
    if (result === ERR_NO_PATH || result === ERR_INVALID_TARGET) {
        route.traffic.blockedMoves++;
        route.movementFailures = (route.movementFailures || 0) + 1;
        if (route.movementFailures >= 3) route.dirty = true;
    } else if (result === OK) route.movementFailures = 0;
    if (Game.time - (route.traffic.lastUpdated || 0) >= 10) {
        var ratio = route.traffic.moves ? route.traffic.blockedMoves / route.traffic.moves : 0;
        route.traffic.congestionScore = Math.round((route.traffic.congestionScore || 0) * 0.8 + ratio * 100 * 0.2);
        route.traffic.avgObservedTravel = route.observedRoundTripTicks || route.traffic.avgObservedTravel || 0;
        route.traffic.lastUpdated = Game.time;
    }
    return true; // A movement intent, fatigue or traffic still owns this leg.
}

function clearHeapPathCache(homeRoomName) {
    if (!global.__sushiRemotePlannerPaths) {
        return;
    }

    var prefix = homeRoomName + ':';
    for (var key in global.__sushiRemotePlannerPaths) {
        if (global.__sushiRemotePlannerPaths.hasOwnProperty(key) && key.indexOf(prefix) === 0) {
            delete global.__sushiRemotePlannerPaths[key];
        }
    }
}

function getMyUsername() {
    var identity = HiveMemory.ensure().identity;
    if (identity.username) {
        return identity.username;
    }

    for (var name in Game.spawns) {
        if (Game.spawns.hasOwnProperty(name) && Game.spawns[name].owner) {
            identity.username = Game.spawns[name].owner.username;
            return identity.username;
        }
    }

    return null;
}

function logDebugSummary(homeRoomName) {
    var planner = ensurePlannerMemory(homeRoomName);
    if (!planner.activeSourceIds || planner.activeSourceIds.length === 0) {
        if (planner.lastDecision && planner.lastDecision.ready === false) {
            console.log('[RemotePlanner ' + homeRoomName + '] blocked: ' + planner.lastDecision.reason);
        }
        return;
    }

    var parts = [];
    for (var i = 0; i < planner.activeSourceIds.length; i++) {
        var info = planner.sourceInfos[planner.activeSourceIds[i]];
        if (!info) {
            continue;
        }
        parts.push(info.roomName + '/' + info.sourceId + ' score=' + info.score + ' dist=' + info.distance);
    }

    if (parts.length > 0) {
        console.log('[RemotePlanner ' + homeRoomName + '] active: ' + parts.join(', '));
    }
}

function round2(value) {
    return Math.round(value * 100) / 100;
}

function round3(value) {
    return Math.round(value * 1000) / 1000;
}

function sourceSpendCategory(planner, info) {
    var established = info.established || info.active || info.state === REMOTE_STATES.ACTIVE ||
        info.state === REMOTE_STATES.DEGRADED || info.state === REMOTE_STATES.BOOTSTRAPPING ||
        info.state === REMOTE_STATES.SUSPENDED_ECONOMY;
    return established ? 'remoteMaintenance' :
        (planner.activeSourceIds.length === 0 ? 'remoteBootstrap' : 'remoteExpansion');
}

function getDiagnostics(homeRoomName) {
    var planner = ensurePlannerMemory(homeRoomName);
    var economy = Economy.get(homeRoomName);
    var ramp = getRemoteRampStatus(homeRoomName, planner.activeSourceIds, economy);
    var sourceCap = getEffectiveRemoteSourceCap(Game.rooms[homeRoomName], economy);
    var queue = Memory.rooms[homeRoomName].spawn && Memory.rooms[homeRoomName].spawn.queue || [];
    var sources = {};
    Object.keys(planner.sourceInfos).forEach(function(id) {
        var info = planner.sourceInfos[id];
        var room = Memory.rooms[info.roomName] || {};
        var source = room.sources && room.sources[id] || {};
        var reservation = Intel.getEffectiveReservation(info.roomName);
        var saved = room.controller || {};
        var threat = HiveMemory.ensure().threats[info.roomName];
        var miners = countRemoteAssignedExtractorWork(homeRoomName, info);
        var queued = countPendingRemoteExtractorRequest(homeRoomName, info, queue);
        var haul = source.haul || {};
        var category = sourceSpendCategory(planner, info);
        var spend = Economy.checkSpend(homeRoomName, category);
        var carry = LogisticsIndex.snapshot().freighters.filter(function(creep) {
            return creep.memory.homeRoom === homeRoomName && (creep.memory.pickupSourceId || creep.memory.remoteDeliverySourceId) === id;
        }).reduce(function(sum, creep) { return sum + countBodyParts(creep.body || [], CARRY); }, 0);
        var visible = Game.rooms[info.roomName];
        var unselectedReason = info.parentRoomName !== homeRoomName ? 'DIFFERENT_PARENT_HOME' :
            !isWithinRemoteRange(homeRoomName, info.roomName) ? 'OUTSIDE_REMOTE_RANGE' :
            !info.numOpen ? 'NO_OPEN_SEATS' : !info.distance || info.distance > MAX_REMOTE_DISTANCE ? 'ROUTE_TOO_LONG' :
            !ramp.ready ? ramp.reason : planner.activeSourceIds.length >= sourceCap ? 'REMOTE_SOURCE_CAP' :
            'AWAITING_PLANNER_SELECTION';
        var reason = visible && (isOwnedEnemyRoom(visible) || hasInvaderCore(visible) || hasSeriousDanger(visible)) ? 'HOSTILE_VISIBLE_NOW' :
            info.route && info.route.valid === false ? info.route.invalidReason :
            !spend.allowed ? spend.reason : info.score <= 0 ? 'NO_PROFITABLE_ROUTE' :
            !info.active ? unselectedReason : info.reservationBootstrap ? 'AWAITING_RESERVATION' :
            miners.count === 0 ? (queued.count ? 'REMOTE_MINER_QUEUED' : 'SPAWN_CAPACITY_SHORTAGE') :
            !source.containerId && !haul.targetId ? 'REMOTE_CONTAINER_BOOTSTRAPPING' :
            carry < (info.requiredCarry || 0) ? 'INSUFFICIENT_HAUL' : null;
        sources[id] = {
            active: !!info.active, operational: !!info.active && info.operational !== false && !!(info.route && info.route.valid),
            state: info.state, parentHome: info.parentHome, score: info.score,
            currentNetEPT: info.currentNetEPT, projectedReservedNetEPT: info.projectedReservedNetEPT,
            routeValid: !!(info.route && info.route.valid), blockedReason: reason,
            spendCategory: category, spendAllowed: spend.allowed,
            minerPresent: miners.count > 0, minerQueued: queued.count > 0,
            wantedWork: getRemoteWantedWork(info), activeWork: miners.work, queuedWork: queued.work,
            availableSeats: getRemoteSeatCapacity(info), assignedExtractors: miners.count,
            freighterCoverage: { assignedCarryParts: carry, reservedEnergyCapacity: haul.reservedCarry || 0, requiredCarryParts: info.requiredCarry || 0 },
            reservationOwner: reservation && reservation.username || null,
            reservationObservedTicks: saved.reservation && saved.reservation.ticksToEnd || 0,
            estimatedReservationTicks: reservation && reservation.ticksToEnd || 0,
            intelAge: saved.lastObservedAt !== undefined ? Game.time - saved.lastObservedAt : null,
            threatAge: threat ? Game.time - threat.lastSeen : null,
            intelRefreshRequested: room.intelRefreshRequestedAt !== undefined,
            containerId: source.containerId || null, haulAge: haul.lastSeen !== undefined ? Game.time - haul.lastSeen : null,
            lastDelivery: haul.lastDeliveryAt || info.telemetry && info.telemetry.lastDelivery || 0
        };
    });
    var scout = require('Scout.Economy').status(Game.rooms[homeRoomName] || { name: homeRoomName });
    var scoutMemory = Memory.rooms[homeRoomName].scout || {};
    return { scoutPresent: scout.living > 0, scoutQueued: scout.queued > 0,
        scoutBlockedReason: scoutMemory.blockedReason || scout.blockedReason,
        discoveryBlockedReason: !Object.keys(sources).length && !scout.living ? 'REMOTE_DISCOVERY_HAS_NO_SCOUT' : null,
        knownRemoteRooms: scout.knownRemoteRooms, knownRemoteSources: scout.knownRemoteSources,
        intelRefreshPending: scout.intelRefreshPending, oldestRemoteIntelAge: scout.oldestRemoteIntelAge,
        operationalActiveCount: planner.activeSourceIds.length, portfolioCount: Object.keys(sources).length,
        candidateCount: Object.keys(sources).filter(function(id) { return !sources[id].active && sources[id].score > 0; }).length,
        lastHeavyPlanAt: planner.lastHeavyPlanAt, lastRescoreAt: planner.lastRescoreAt,
        lastVisibleRefreshAt: planner.lastVisibleRefreshAt, sources: sources };
}

module.exports = {
    getDiagnostics: getDiagnostics,
    run: run,
    getEffectiveReservation: Intel.getEffectiveReservation,
    getControllerInfo: getControllerInfo,
    onScoutRoom: onScoutRoom,
    scanVisibleRoom: scanVisibleRoom,
    getHomeRoomName: getHomeRoomName,
    ensurePlannerMemory: ensurePlannerMemory,
    generateRemotePlan: generateRemotePlan,
    scoreRemoteRoom: scoreRemoteRoom,
    scoreRemoteSource: scoreRemoteSource,
    selectActiveSources: selectActiveSources,
    getEffectiveRemoteSourceCap: getEffectiveRemoteSourceCap,
    getBestRemoteSourceForExtractor: getBestRemoteSourceForExtractor,
    getActiveRemoteSourcesForHome: getActiveRemoteSourcesForHome,
    getRemoteExtractorDemand: getRemoteExtractorDemand,
    countRemoteAssignedExtractorWork: countRemoteAssignedExtractorWork,
    hasPendingRemoteExtractorRequest: hasPendingRemoteExtractorRequest,
    claimRemotePickupTarget: claimRemotePickupTarget,
    refreshRemoteFreighterReservation: refreshRemoteFreighterReservation,
    releaseRemoteFreighterReservation: releaseRemoteFreighterReservation,
    clearRemoteFreighterMemory: clearRemoteFreighterMemory,
    getHomeDeliveryTarget: getHomeDeliveryTarget,
    getLogisticsDestinationRoom: getLogisticsDestinationRoom,
    getBestRemoteRoomForFreighter: getBestRemoteRoomForFreighter,
    moveFreighterToRemotePickup: moveFreighterToRemotePickup,
    moveFreighterAlongRemotePath: moveFreighterAlongRemotePath,
    getRemotePath: getRemotePath,
    getBestRouteToRoom: getBestRouteToRoom,
    moveToRemoteRoomAlongRoute: moveToRemoteRoomAlongRoute,
    discoverSharedLanes: discoverSharedLanes,
    getBorderContinuityReason: getBorderContinuityReason,
    validateRemoteRoute: validateRemoteRoute,
    retreatRemoteCreep: retreatRemoteCreep,
    estimateRouteTravelTicks: estimateRouteTravelTicks,
    getRouteTravelEstimate: getRouteTravelEstimate,
    recordRemoteTripLeg: recordRemoteTripLeg,
    startRemoteTrip: startRemoteTrip,
    isWithinRemoteRange: isWithinRemoteRange,
    getRemoteMaxRoomRange: getRemoteMaxRoomRange,
    shouldUseRemoteSource: shouldUseRemoteSource,
    packCoord: packCoord,
    unpackCoord: unpackCoord,

    /* Extra small helpers used by role.Extractor.js. */
    moveExtractorAlongRemotePath: moveExtractorAlongRemotePath,
    getRemoteSourcePosition: getRemoteSourcePosition,
    getRemoteRampStatus: getRemoteRampStatus,
    REMOTE_STATES: REMOTE_STATES
};
