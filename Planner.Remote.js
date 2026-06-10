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

var PATH_VERSION = 1;
var HEAVY_PLAN_INTERVAL = 75;
var RESCORE_INTERVAL = 1000;
var DEBUG_INTERVAL = 500;
var LOW_BUCKET_SKIP = 1000;
var CPU_BUFFER = 3;
var MAX_ACTIVE_REMOTE_SOURCES = 4;
var MAX_REMOTE_DISTANCE = 150;
var SOURCE_WORK_TARGET = 6;
var ESTIMATED_MINER_BODY_COST = 550;
var ESTIMATED_CARRY_COST_PER_PART = 100;
var CONTAINER_OR_DROP_LOSS = 0.05;
var ROAD_REPAIR_COST_PER_TILE = 0.003;
var MAX_PATH_ROOMS = 8;
var MAX_PATH_OPS = 12000;

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

        if (Game.time % HEAVY_PLAN_INTERVAL === 0) {
            refreshVisibleCandidatePlans(roomName);
            selectActiveSources(roomName);
        }

        if (Game.time % RESCORE_INTERVAL === 0) {
            rescorePlanner(roomName);
            selectActiveSources(roomName);
        }

        if (Game.time % DEBUG_INTERVAL === 0) {
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

    return scanVisibleRoom(homeRoomName, creep.room);
}

function scanVisibleRoom(homeRoomName, room) {
    if (!homeRoomName || !room) {
        return false;
    }

    if (isOwnedEnemyRoom(room)) {
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
    if (planner.pathVersion !== PATH_VERSION) {
        planner.pathVersion = PATH_VERSION;
        planner.activeSourceIds = [];
        planner.sourceInfos = {};
        planner.remotes = {};
        clearHeapPathCache(homeRoomName);
    }

    return planner;
}

function generateRemotePlan(homeRoomName, remoteRoom) {
    if (!homeRoomName || !remoteRoom || remoteRoom.name === homeRoomName) {
        return false;
    }

    if (!canSpendPlanningCpu()) {
        return false;
    }

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

        sourceInfo = claimBestParentForSource(homeRoomName, sourceInfo);
        if (sourceInfo.parentRoomName !== homeRoomName) {
            continue;
        }

        planner.sourceInfos[realSourceId] = sourceInfo;
        sourceIds.push(realSourceId);
    }

    remoteInfo.sourceIds = sourceIds;
    scoreRemoteRoom(homeRoomName, remoteRoom.name);
    planner.remotes[remoteRoom.name] = remoteInfo;
    selectActiveSources(homeRoomName);

    return sourceIds.length > 0;
}

function scoreRemoteRoom(homeRoomName, remoteRoomName) {
    var planner = ensurePlannerMemory(homeRoomName);
    var remoteInfo = planner.remotes[remoteRoomName];

    if (!remoteInfo) {
        return 0;
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
    var energyPerTick = info.energyPerTick || (SOURCE_ENERGY_CAPACITY / ENERGY_REGEN_TIME);
    var remoteMemory = Memory.rooms && Memory.rooms[info.roomName];
    var controller = remoteMemory ? remoteMemory.controller : null;

    if (controller && controller.reservation && controller.reservation.username && controller.reservation.username !== getMyUsername()) {
        info.rejectReason = 'hostile reservation';
        info.netIncome = -999;
        info.score = -999;
        return info.score;
    }

    if (!controller || !controller.reservation) {
        energyPerTick *= 0.5;
    }

    var minerLifetime = Math.max(1, CREEP_LIFE_TIME - distance);
    var minerCostPerTick = ESTIMATED_MINER_BODY_COST / minerLifetime;
    var carryPartsNeeded = Math.ceil((energyPerTick * distance * 2) / CARRY_CAPACITY);
    var haulerCostPerTick = (carryPartsNeeded * ESTIMATED_CARRY_COST_PER_PART) / CREEP_LIFE_TIME;
    var roadCost = distance * ROAD_REPAIR_COST_PER_TILE;
    var riskPenalty = info.risk || 0;

    var netIncome = energyPerTick - minerCostPerTick - haulerCostPerTick - CONTAINER_OR_DROP_LOSS - roadCost - riskPenalty;

    info.energyPerTick = round3(energyPerTick);
    info.netIncome = round3(netIncome);
    info.spawnUsage = round3((ESTIMATED_MINER_BODY_COST / CREEP_LIFE_TIME) + haulerCostPerTick);
    info.score = round3(netIncome - (distance / 1000));
    info.rejectReason = info.score > 0 ? null : 'negative net income';

    return info.score;
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

        if (!info || !info.active) {
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

    if (!global.__sushiRemotePlannerPaths) {
        global.__sushiRemotePlannerPaths = {};
    }

    var cacheKey = homeRoomName + ':' + sourceId;
    var cached = global.__sushiRemotePlannerPaths[cacheKey];
    if (cached && cached.version === PATH_VERSION) {
        return cached.path;
    }

    var path = [];
    for (var roomName in info.roadCoords) {
        if (!info.roadCoords.hasOwnProperty(roomName)) {
            continue;
        }

        var packedList = info.roadCoords[roomName];
        for (var i = 0; i < packedList.length; i++) {
            path.push(unpackCoord(packedList[i], roomName));
        }
    }

    global.__sushiRemotePlannerPaths[cacheKey] = {
        version: PATH_VERSION,
        path: path
    };

    return path;
}

function shouldUseRemoteSource(homeRoomName, sourceId, ignoreScore) {
    var planner = ensurePlannerMemory(homeRoomName);
    var info = planner.sourceInfos[sourceId];

    if (!info) {
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
        return false;
    }

    var remoteMemory = Memory.rooms && Memory.rooms[info.roomName];
    if (remoteMemory && remoteMemory.controller && remoteMemory.controller.owner && remoteMemory.controller.owner !== getMyUsername()) {
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
    var target = getSourceTargetPosition(sourceMemory);

    if (!anchor || !target) {
        return null;
    }

    var ret = PathFinder.search(anchor, { pos: target, range: 0 }, {
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
    var containerPos = path[path.length - 1] || target;
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

    return {
        sourceId: sourceId,
        roomName: remoteRoom.name,
        parentRoomName: homeRoomName,
        distance: path.length,
        energyPerTick: roomType === 'keeper' ? SOURCE_ENERGY_KEEPER_CAPACITY / ENERGY_REGEN_TIME : SOURCE_ENERGY_CAPACITY / ENERGY_REGEN_TIME,
        numOpen: getSourceSeatCount(sourceMemory),
        containerCoord: packCoord(containerPos),
        roadCoords: roadCoords,
        constructed: false,
        risk: getRoomRisk(remoteRoom, roomType),
        netIncome: 0,
        spawnUsage: 0,
        score: 0,
        active: false,
        lastPlanned: Game.time
    };
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

function getSourceTargetPosition(sourceMemory) {
    if (!sourceMemory) {
        return null;
    }

    if (sourceMemory.containerPos) {
        return makeRoomPosition(sourceMemory.containerPos);
    }

    if (sourceMemory.seats && sourceMemory.seats.length > 0) {
        return makeRoomPosition(sourceMemory.seats[0]);
    }

    if (sourceMemory.pos) {
        return makeRoomPosition(sourceMemory.pos);
    }

    return null;
}

function makeRoomPosition(pos) {
    if (!pos || pos.x === undefined || pos.y === undefined || !pos.roomName) {
        return null;
    }

    return new RoomPosition(pos.x, pos.y, pos.roomName);
}

function buildRemoteCostMatrix(homeRoomName, roomName) {
    if (isBlockedRoomForPath(homeRoomName, roomName)) {
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

function refreshVisibleCandidatePlans(homeRoomName) {
    for (var roomName in Game.rooms) {
        if (!Game.rooms.hasOwnProperty(roomName)) {
            continue;
        }

        if (roomName === homeRoomName) {
            continue;
        }

        var room = Game.rooms[roomName];
        if (!room || isOwnedEnemyRoom(room) || hasInvaderCore(room) || hasSeriousDanger(room)) {
            continue;
        }

        var memory = Memory.rooms && Memory.rooms[roomName];
        if (memory && memory.sources) {
            generateRemotePlan(homeRoomName, room);
            return;
        }
    }
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

    for (var sourceId in planner.sourceInfos) {
        if (!planner.sourceInfos.hasOwnProperty(sourceId)) {
            continue;
        }

        var info = planner.sourceInfos[sourceId];
        scoreRemoteSource(homeRoomName, sourceId);
        info.active = false;

        if (shouldUseRemoteSource(homeRoomName, sourceId) && info.netIncome > 0) {
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

    planner.activeSourceIds = [];
    for (var i = 0; i < candidates.length && i < MAX_ACTIVE_REMOTE_SOURCES; i++) {
        candidates[i].active = true;
        planner.activeSourceIds.push(candidates[i].sourceId);
    }

    for (var remoteRoomName in planner.remotes) {
        if (!planner.remotes.hasOwnProperty(remoteRoomName)) {
            continue;
        }

        var remoteInfo = planner.remotes[remoteRoomName];
        remoteInfo.status = hasActiveSourceInRemote(planner, remoteInfo) ? 'active' : remoteInfo.status;
    }
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

        var oldBetter = oldInfo.distance < newInfo.distance ||
            (oldInfo.distance === newInfo.distance && oldInfo.netIncome > newInfo.netIncome) ||
            (oldInfo.distance === newInfo.distance && oldInfo.netIncome === newInfo.netIncome && oldInfo.active);

        if (oldBetter) {
            bestInfo = oldInfo;
            break;
        }

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

    if (creep.memory.role !== 'Extractor' && creep.memory.task !== 'Extractor') {
        return false;
    }

    return creep.memory.remoteMining === true &&
        creep.memory.homeRoom === homeRoomName &&
        (creep.memory.sourceId === info.sourceId || creep.memory.targetSourceId === info.sourceId) &&
        (creep.memory.sourceRoom === info.roomName || creep.memory.targetRoom === info.roomName);
}

function hasRemoteAssignmentCapacity(homeRoomName, info, requestingCreep) {
    var remoteMemory = Memory.rooms && Memory.rooms[info.roomName];
    var sourceMemory = remoteMemory && remoteMemory.sources ? remoteMemory.sources[info.sourceId] : null;
    var assignedCount = 0;
    var assignedWork = 0;
    var seen = {};

    if (sourceMemory && sourceMemory.assignedMiner) {
        for (var i = 0; i < sourceMemory.assignedMiner.length; i++) {
            var creep = Game.getObjectById(sourceMemory.assignedMiner[i]) || Game.creeps[sourceMemory.assignedMiner[i]];
            if (!isCreepAssignedToRemote(creep, homeRoomName, info)) {
                continue;
            }
            if (seen[creep.id]) {
                continue;
            }
            seen[creep.id] = true;
            assignedCount++;
            assignedWork += getCreepWorkParts(creep);
        }
    }

    if (requestingCreep && seen[requestingCreep.id]) {
        return true;
    }

    return assignedCount < info.numOpen && assignedWork < SOURCE_WORK_TARGET;
}

function claimRemoteSource(creep, homeRoomName, info) {
    creep.memory.sourceId = info.sourceId;
    creep.memory.targetSourceId = info.sourceId;
    creep.memory.sourceRoom = info.roomName;
    creep.memory.targetRoom = info.roomName;
    creep.memory.homeRoom = homeRoomName;
    creep.memory.remoteMining = true;

    var remoteMemory = Memory.rooms && Memory.rooms[info.roomName];
    var sourceMemory = remoteMemory && remoteMemory.sources ? remoteMemory.sources[info.sourceId] : null;

    if (!sourceMemory) {
        return;
    }

    if (!sourceMemory.assignedMiner || !Array.isArray(sourceMemory.assignedMiner)) {
        sourceMemory.assignedMiner = [];
    }

    for (var i = 0; i < sourceMemory.assignedMiner.length; i++) {
        if (sourceMemory.assignedMiner[i] === creep.id) {
            return;
        }
    }

    sourceMemory.assignedMiner.push(creep.id);
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

function getCreepWorkParts(creep) {
    if (!creep) {
        return 0;
    }

    if (typeof creep.getActiveBodyparts === 'function') {
        return creep.getActiveBodyparts(WORK);
    }

    var count = 0;
    if (creep.body) {
        for (var i = 0; i < creep.body.length; i++) {
            if (creep.body[i] && creep.body[i].type === WORK) {
                count++;
            }
        }
    }
    return count;
}

function moveExtractorAlongRemotePath(creep, homeRoomName, sourceId) {
    var path = getRemotePath(homeRoomName, sourceId);
    if (!path || path.length === 0) {
        return false;
    }

    var bestIndex = -1;
    var bestRange = 99;
    for (var i = 0; i < path.length; i++) {
        if (path[i].roomName !== creep.pos.roomName) {
            continue;
        }

        var range = creep.pos.getRangeTo(path[i]);
        if (range < bestRange) {
            bestRange = range;
            bestIndex = i;
        }
    }

    if (bestIndex < 0 || bestRange > 3) {
        var info = ensurePlannerMemory(homeRoomName).sourceInfos[sourceId];
        if (info) {
            return travel.moveToRoom(creep, info.roomName, { range: 22, reusePath: 20 }) === OK;
        }
        return false;
    }

    var nextIndex = Math.min(path.length - 1, bestIndex + 1);
    return travel.move(creep, path[nextIndex], { range: 0, reusePath: 5 }) === OK;
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
    if (Memory.username) {
        return Memory.username;
    }

    for (var name in Game.spawns) {
        if (Game.spawns.hasOwnProperty(name) && Game.spawns[name].owner) {
            Memory.username = Game.spawns[name].owner.username;
            return Memory.username;
        }
    }

    return null;
}

function logDebugSummary(homeRoomName) {
    var planner = ensurePlannerMemory(homeRoomName);
    if (!planner.activeSourceIds || planner.activeSourceIds.length === 0) {
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

module.exports = {
    run: run,
    onScoutRoom: onScoutRoom,
    scanVisibleRoom: scanVisibleRoom,
    getHomeRoomName: getHomeRoomName,
    ensurePlannerMemory: ensurePlannerMemory,
    generateRemotePlan: generateRemotePlan,
    scoreRemoteRoom: scoreRemoteRoom,
    scoreRemoteSource: scoreRemoteSource,
    getBestRemoteSourceForExtractor: getBestRemoteSourceForExtractor,
    getRemotePath: getRemotePath,
    shouldUseRemoteSource: shouldUseRemoteSource,
    packCoord: packCoord,
    unpackCoord: unpackCoord,

    /* Extra small helpers used by role.Extractor.js. */
    moveExtractorAlongRemotePath: moveExtractorAlongRemotePath,
    getRemoteSourcePosition: getRemoteSourcePosition
};
