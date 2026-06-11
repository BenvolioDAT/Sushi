/*
 * Planner.Roads.js
 *
 * CPU-smart permanent road planner for Sushi.
 *
 * Important idea:
 * - utility.Travel.Creep.js may cache routes to help creeps move.
 * - Those creep-walked routes are only feedback/fallback movement data.
 * - This file is the permanent road planner. It plans from stable colony
 *   anchors, such as storage/spawn, to stable targets, such as sources,
 *   controller infrastructure, and approved remote mining roads.
 *
 * The code intentionally stays simple and defensive. Screeps CPU safety is
 * more important than perfect roads, so this planner does only a little work
 * each tick and skips expensive work when the CPU bucket is low.
 */

var ROAD_PLANNER_VERSION = 1;
var ROAD_REPLAN_INTERVAL = 1000;
var ROAD_BUILD_INTERVAL = 50;
var LOW_BUCKET_SKIP = 1000;
var CPU_BUFFER = 3;
var MAX_ROAD_SITES_PER_RUN = 3;
var MAX_TOTAL_CONSTRUCTION_SITES = 85;
var MAX_PATH_OPS_LOCAL = 4000;
var MAX_PATH_OPS_REMOTE = 12000;
var MAX_PATH_ROOMS_REMOTE = 8;
/*
 * Remote path constants stay documented here for safety, but this planner does
 * not spend them while Planner.Remote.js already has saved roadCoords.
 */
var MAX_VISUAL_DOTS_PER_ROOM = 80;

var ROAD_PRIORITY_HUB = 1;
var ROAD_PRIORITY_SOURCE = 2;
var ROAD_PRIORITY_CONTROLLER = 3;
var ROAD_PRIORITY_REMOTE = 4;

function run() {
    if (!canSpendCpu()) {
        return;
    }

    var ownedRooms = getOwnedVisibleRooms();
    if (ownedRooms.length === 0) {
        return;
    }

    /*
     * Spread owned rooms across ticks. A mature empire can have several rooms,
     * and replanning every one on the same tick is unnecessary CPU risk.
     */
    var room = ownedRooms[Game.time % ownedRooms.length];
    runRoom(room);
}

function runRoom(room) {
    if (!room || !room.controller || !room.controller.my) {
        return;
    }

    var planner = ensureRoadPlannerMemory(room.name);

    if (planner.version !== ROAD_PLANNER_VERSION) {
        resetRoadPlannerMemory(room.name);
        planner = ensureRoadPlannerMemory(room.name);
    }

    if (shouldReplanRoom(room, planner)) {
        planOwnedRoomRoads(room);
        planner.lastPlanned = Game.time;
    }

    if (Game.time - (planner.lastBuilt || 0) >= ROAD_BUILD_INTERVAL) {
        buildRoadSites(room.name);
        planner.lastBuilt = Game.time;
    }

    drawRoadPlannerVisuals(room.name);
}

function planOwnedRoomRoads(room) {
    if (!room || !room.controller || !room.controller.my) {
        return null;
    }

    if (!canSpendCpu()) {
        return null;
    }

    var planner = ensureRoadPlannerMemory(room.name);
    var hub = getHubAnchor(room);

    if (!hub) {
        return null;
    }

    /*
     * Keep planned road lists in one compact packed-coordinate list per room.
     * A plain object is used as a set while planning so duplicates disappear.
     */
    var planSets = {};
    var prioritySets = {};

    addHubAreaRoads(room, hub, planSets, prioritySets);
    addStructureAreaRoads(room, planSets, prioritySets);
    addOwnedRoomSourceRoads(room, hub, planSets, prioritySets);
    addOwnedRoomControllerRoads(room, hub, planSets, prioritySets);
    addRemoteRoadsFromRemotePlanner(room.name, planSets, prioritySets);

    planner.rooms = {};

    for (var roomName in planSets) {
        if (!planSets.hasOwnProperty(roomName)) {
            continue;
        }

        var sortedRoadCoords = buildSortedRoadCoordList(planSets[roomName], prioritySets[roomName]);

        planner.rooms[roomName] = {
            roadCoords: sortedRoadCoords,
            buildIndex: 0,
            firstPriority: getStoredFirstPriority(sortedRoadCoords, prioritySets[roomName]),
            lastPlanned: Game.time
        };
    }

    return planner;
}

function buildRoadSites(homeRoomName) {
    var planner = ensureRoadPlannerMemory(homeRoomName);

    if (!planner.rooms || !canBuildRoadSites()) {
        return 0;
    }

    var built = 0;
    var roomNames = getBuildRoomOrder(planner);

    for (var r = 0; r < roomNames.length && built < MAX_ROAD_SITES_PER_RUN; r++) {
        var roomName = roomNames[r];
        var roomPlan = planner.rooms[roomName];
        var room = Game.rooms[roomName];

        if (!room || !roomPlan || !roomPlan.roadCoords || roomPlan.roadCoords.length === 0) {
            continue;
        }

        var checked = 0;
        var maxChecks = roomPlan.roadCoords.length;
        var index = roomPlan.buildIndex || 0;

        while (checked < maxChecks && built < MAX_ROAD_SITES_PER_RUN) {
            if (!canBuildRoadSites()) {
                roomPlan.buildIndex = index;
                return built;
            }

            if (index >= roomPlan.roadCoords.length) {
                index = 0;
            }

            var packed = roomPlan.roadCoords[index];
            var pos = unpackCoord(packed, roomName);
            index++;
            checked++;

            var allowRemoteEdge = roomName !== homeRoomName;

            if (!canPlaceRoadSite(room, pos, allowRemoteEdge)) {
                continue;
            }

            var result = room.createConstructionSite(pos, STRUCTURE_ROAD);
            if (result === OK) {
                built++;
            }
        }

        roomPlan.buildIndex = index;
    }

    return built;
}

function packCoord(pos) {
    return pos.x + (pos.y * 50);
}

function unpackCoord(packed, roomName) {
    var value = parseInt(packed, 10) || 0;
    var x = value % 50;
    var y = Math.floor(value / 50);

    return new RoomPosition(x, y, roomName);
}

function getOwnedVisibleRooms() {
    var rooms = [];

    for (var roomName in Game.rooms) {
        if (!Game.rooms.hasOwnProperty(roomName)) {
            continue;
        }

        var room = Game.rooms[roomName];
        if (room && room.controller && room.controller.my) {
            rooms.push(room);
        }
    }

    rooms.sort(function(a, b) {
        return a.name < b.name ? -1 : 1;
    });

    return rooms;
}

function ensureRoadPlannerMemory(homeRoomName) {
    if (!Memory.rooms) {
        Memory.rooms = {};
    }

    if (!Memory.rooms[homeRoomName]) {
        Memory.rooms[homeRoomName] = {};
    }

    if (!Memory.rooms[homeRoomName].roadPlanner) {
        Memory.rooms[homeRoomName].roadPlanner = makeEmptyRoadPlannerMemory();
    }

    var planner = Memory.rooms[homeRoomName].roadPlanner;

    if (!planner.rooms) {
        planner.rooms = {};
    }
    if (!planner.lastPlanned) {
        planner.lastPlanned = 0;
    }
    if (!planner.lastBuilt) {
        planner.lastBuilt = 0;
    }

    return planner;
}

function makeEmptyRoadPlannerMemory() {
    return {
        version: ROAD_PLANNER_VERSION,
        lastPlanned: 0,
        lastBuilt: 0,
        rooms: {}
    };
}

function resetRoadPlannerMemory(homeRoomName) {
    if (!Memory.rooms) {
        Memory.rooms = {};
    }
    if (!Memory.rooms[homeRoomName]) {
        Memory.rooms[homeRoomName] = {};
    }

    Memory.rooms[homeRoomName].roadPlanner = makeEmptyRoadPlannerMemory();
}

function shouldReplanRoom(room, planner) {
    if (!planner || !planner.rooms || !planner.rooms[room.name]) {
        return true;
    }

    return Game.time - (planner.lastPlanned || 0) >= ROAD_REPLAN_INTERVAL;
}

function canSpendCpu() {
    if (Game.cpu && Game.cpu.bucket !== undefined && Game.cpu.bucket < LOW_BUCKET_SKIP) {
        return false;
    }

    if (
        Game.cpu &&
        typeof Game.cpu.getUsed === 'function' &&
        Game.cpu.tickLimit !== undefined &&
        Game.cpu.getUsed() > Game.cpu.tickLimit - CPU_BUFFER
    ) {
        return false;
    }

    return true;
}

function canBuildRoadSites() {
    if (!canSpendCpu()) {
        return false;
    }

    return getTotalConstructionSiteCount() < MAX_TOTAL_CONSTRUCTION_SITES;
}

function getTotalConstructionSiteCount() {
    if (!Game.constructionSites) {
        return 0;
    }

    return Object.keys(Game.constructionSites).length;
}

function getHubAnchor(room) {
    if (room.storage) {
        return room.storage.pos;
    }

    var spawns = room.find(FIND_MY_SPAWNS);
    if (spawns.length > 0) {
        var plannedStorage = new RoomPosition(spawns[0].pos.x + 1, spawns[0].pos.y, room.name);
        if (isWalkableRoadTile(room, plannedStorage, false)) {
            return plannedStorage;
        }

        return spawns[0].pos;
    }

    return null;
}

function addHubAreaRoads(room, hub, planSets, prioritySets) {
    addRoadCoord(hub, ROAD_PRIORITY_HUB, planSets, prioritySets);

    /*
     * A tiny 3x3 hub pad makes storage/spawn traffic less cramped. We still use
     * normal road-tile validation so walls and important objects are skipped.
     */
    for (var dx = -1; dx <= 1; dx++) {
        for (var dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) {
                continue;
            }

            var pos = new RoomPosition(hub.x + dx, hub.y + dy, hub.roomName);
            if (isWalkableRoadTile(room, pos, false)) {
                addRoadCoord(pos, ROAD_PRIORITY_HUB, planSets, prioritySets);
            }
        }
    }
}

function addStructureAreaRoads(room, planSets, prioritySets) {
    var structures = room.find(FIND_MY_STRUCTURES, {
        filter: function(structure) {
            return structure.structureType === STRUCTURE_SPAWN ||
                structure.structureType === STRUCTURE_STORAGE ||
                structure.structureType === STRUCTURE_TERMINAL ||
                structure.structureType === STRUCTURE_TOWER ||
                structure.structureType === STRUCTURE_EXTENSION;
        }
    });

    for (var i = 0; i < structures.length; i++) {
        addAdjacentRoads(room, structures[i].pos, ROAD_PRIORITY_HUB, planSets, prioritySets);
    }
}

function addOwnedRoomSourceRoads(room, hub, planSets, prioritySets) {
    var sources = room.find(FIND_SOURCES);

    for (var i = 0; i < sources.length; i++) {
        if (!canSpendCpu()) {
            return;
        }

        var target = getSourceRoadTarget(room, sources[i]);
        if (!target) {
            continue;
        }

        addPathRoads(hub, target, 0, ROAD_PRIORITY_SOURCE, 1, MAX_PATH_OPS_LOCAL, planSets, prioritySets);
    }
}

function addOwnedRoomControllerRoads(room, hub, planSets, prioritySets) {
    if (!room.controller || !canSpendCpu()) {
        return;
    }

    var target = getControllerRoadTarget(room);
    if (!target) {
        target = getControllerWorkPosition(room);
    }

    if (target) {
        addPathRoads(hub, target, 0, ROAD_PRIORITY_CONTROLLER, 1, MAX_PATH_OPS_LOCAL, planSets, prioritySets);
    }
}

function addRemoteRoadsFromRemotePlanner(homeRoomName, planSets, prioritySets) {
    var homeMemory = Memory.rooms && Memory.rooms[homeRoomName];
    var remotePlanner = homeMemory ? homeMemory.remotePlanner : null;

    if (!remotePlanner || !remotePlanner.activeSourceIds || !remotePlanner.sourceInfos) {
        return;
    }

    for (var i = 0; i < remotePlanner.activeSourceIds.length; i++) {
        var sourceId = remotePlanner.activeSourceIds[i];
        var sourceInfo = remotePlanner.sourceInfos[sourceId];

        if (!sourceInfo || !sourceInfo.active || !sourceInfo.roadCoords) {
            continue;
        }

        for (var roomName in sourceInfo.roadCoords) {
            if (!sourceInfo.roadCoords.hasOwnProperty(roomName)) {
                continue;
            }

            var coords = sourceInfo.roadCoords[roomName];
            for (var c = 0; c < coords.length; c++) {
                var pos = unpackCoord(coords[c], roomName);
                addRoadCoord(pos, ROAD_PRIORITY_REMOTE, planSets, prioritySets);
            }
        }
    }
}

function getSourceRoadTarget(room, source) {
    var containers = source.pos.findInRange(FIND_STRUCTURES, 1, {
        filter: function(structure) {
            return structure.structureType === STRUCTURE_CONTAINER;
        }
    });

    if (containers.length > 0) {
        return containers[0].pos;
    }

    var sourceMemory = getSourceMemory(room.name, source.id);
    if (sourceMemory && sourceMemory.containerPlannedPos) {
        return new RoomPosition(
            sourceMemory.containerPlannedPos.x,
            sourceMemory.containerPlannedPos.y,
            sourceMemory.containerPlannedPos.roomName || room.name
        );
    }

    var seats = getSourceSeatPositions(room, source, sourceMemory);
    if (seats.length > 0) {
        return seats[0];
    }

    return null;
}

function getControllerRoadTarget(room) {
    var nearController = room.controller.pos.findInRange(FIND_STRUCTURES, 3, {
        filter: function(structure) {
            return structure.structureType === STRUCTURE_CONTAINER || structure.structureType === STRUCTURE_LINK;
        }
    });

    if (nearController.length > 0) {
        nearController.sort(function(a, b) {
            return room.controller.pos.getRangeTo(a.pos) - room.controller.pos.getRangeTo(b.pos);
        });

        return nearController[0].pos;
    }

    return null;
}

function getControllerWorkPosition(room) {
    var controller = room.controller;

    for (var range = 1; range <= 3; range++) {
        for (var x = controller.pos.x - range; x <= controller.pos.x + range; x++) {
            for (var y = controller.pos.y - range; y <= controller.pos.y + range; y++) {
                if (x < 1 || x > 48 || y < 1 || y > 48) {
                    continue;
                }

                var pos = new RoomPosition(x, y, room.name);
                if (pos.getRangeTo(controller.pos) > 3) {
                    continue;
                }

                if (isWalkableRoadTile(room, pos, false)) {
                    return pos;
                }
            }
        }
    }

    return null;
}

function getSourceMemory(roomName, sourceId) {
    if (!Memory.rooms || !Memory.rooms[roomName] || !Memory.rooms[roomName].sources) {
        return null;
    }

    return Memory.rooms[roomName].sources[sourceId] || null;
}

function getSourceSeatPositions(room, source, sourceMemory) {
    var seats = [];

    if (sourceMemory && sourceMemory.seats) {
        for (var i = 0; i < sourceMemory.seats.length; i++) {
            seats.push(new RoomPosition(
                sourceMemory.seats[i].x,
                sourceMemory.seats[i].y,
                sourceMemory.seats[i].roomName || room.name
            ));
        }
    }

    if (seats.length > 0) {
        return seats;
    }

    for (var dx = -1; dx <= 1; dx++) {
        for (var dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) {
                continue;
            }

            var pos = new RoomPosition(source.pos.x + dx, source.pos.y + dy, room.name);
            if (isWalkableRoadTile(room, pos, false)) {
                seats.push(pos);
            }
        }
    }

    return seats;
}

function addAdjacentRoads(room, center, priority, planSets, prioritySets) {
    for (var dx = -1; dx <= 1; dx++) {
        for (var dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) {
                continue;
            }

            var pos = new RoomPosition(center.x + dx, center.y + dy, center.roomName);
            if (isWalkableRoadTile(room, pos, false)) {
                addRoadCoord(pos, priority, planSets, prioritySets);
            }
        }
    }
}

function addPathRoads(origin, target, range, priority, maxRooms, maxOps, planSets, prioritySets) {
    var ret = PathFinder.search(origin, { pos: target, range: range }, {
        maxRooms: maxRooms,
        maxOps: maxOps,
        plainCost: 2,
        swampCost: 10,
        roomCallback: buildRoadCostMatrix
    });

    if (ret.incomplete || !ret.path || ret.path.length === 0) {
        return;
    }

    for (var i = 0; i < ret.path.length; i++) {
        addRoadCoord(ret.path[i], priority, planSets, prioritySets);
    }
}

function buildRoadCostMatrix(roomName) {
    var room = Game.rooms[roomName];
    if (!room) {
        return false;
    }

    var costs = new PathFinder.CostMatrix();
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

        if (structure.structureType === STRUCTURE_RAMPART && (structure.my || structure.isPublic)) {
            continue;
        }

        if (isBlockingStructureType(structure.structureType)) {
            costs.set(structure.pos.x, structure.pos.y, 255);
        }
    }

    var sites = room.find(FIND_CONSTRUCTION_SITES);
    for (var j = 0; j < sites.length; j++) {
        var site = sites[j];
        if (site.structureType === STRUCTURE_ROAD || site.structureType === STRUCTURE_CONTAINER || site.structureType === STRUCTURE_RAMPART) {
            continue;
        }

        if (isBlockingStructureType(site.structureType)) {
            costs.set(site.pos.x, site.pos.y, 255);
        }
    }

    return costs;
}

function addRoadCoord(pos, priority, planSets, prioritySets) {
    if (!pos || pos.x < 0 || pos.x > 49 || pos.y < 0 || pos.y > 49) {
        return;
    }

    if (!planSets[pos.roomName]) {
        planSets[pos.roomName] = {};
    }
    if (!prioritySets[pos.roomName]) {
        prioritySets[pos.roomName] = {};
    }

    var packed = packCoord(pos);
    planSets[pos.roomName][packed] = true;

    if (!prioritySets[pos.roomName][packed] || priority < prioritySets[pos.roomName][packed]) {
        prioritySets[pos.roomName][packed] = priority;
    }
}

function buildSortedRoadCoordList(roomSet, prioritySet) {
    var entries = [];

    for (var packed in roomSet) {
        if (!roomSet.hasOwnProperty(packed)) {
            continue;
        }

        entries.push({
            packed: parseInt(packed, 10),
            priority: prioritySet[packed] || ROAD_PRIORITY_REMOTE
        });
    }

    entries.sort(function(a, b) {
        if (a.priority !== b.priority) {
            return a.priority - b.priority;
        }

        return a.packed - b.packed;
    });

    var coords = [];
    for (var i = 0; i < entries.length; i++) {
        coords.push(entries[i].packed);
    }

    return coords;
}

function getStoredFirstPriority(sortedRoadCoords, prioritySet) {
    if (!sortedRoadCoords || sortedRoadCoords.length === 0) {
        return ROAD_PRIORITY_REMOTE;
    }

    return prioritySet[sortedRoadCoords[0]] || ROAD_PRIORITY_REMOTE;
}

function getBuildRoomOrder(planner) {
    var roomNames = [];

    for (var roomName in planner.rooms) {
        if (planner.rooms.hasOwnProperty(roomName)) {
            roomNames.push(roomName);
        }
    }

    roomNames.sort(function(a, b) {
        var aPriority = getRoomFirstPriority(planner.rooms[a]);
        var bPriority = getRoomFirstPriority(planner.rooms[b]);

        if (aPriority !== bPriority) {
            return aPriority - bPriority;
        }

        return a < b ? -1 : 1;
    });

    return roomNames;
}

function getRoomFirstPriority(roomPlan) {
    if (!roomPlan || !roomPlan.roadCoords || roomPlan.roadCoords.length === 0) {
        return ROAD_PRIORITY_REMOTE;
    }

    return roomPlan.firstPriority || ROAD_PRIORITY_REMOTE;
}


function canPlaceRoadSite(room, pos, allowEdge) {
    if (!room || !pos || room.name !== pos.roomName) {
        return false;
    }

    if (getTotalConstructionSiteCount() >= MAX_TOTAL_CONSTRUCTION_SITES) {
        return false;
    }

    return isWalkableRoadTile(room, pos, allowEdge === true) && !hasConstructionSite(room, pos) && !hasRoad(room, pos);
}

function isWalkableRoadTile(room, pos, allowEdge) {
    if (!room || !pos || room.name !== pos.roomName) {
        return false;
    }

    if (!allowEdge && (pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49)) {
        return false;
    }

    var terrain = Game.map.getRoomTerrain(pos.roomName);
    if (terrain.get(pos.x, pos.y) === TERRAIN_MASK_WALL) {
        return false;
    }

    if (hasPermanentNaturalObject(room, pos)) {
        return false;
    }

    if (hasBlockingStructure(room, pos)) {
        return false;
    }

    return true;
}

function hasPermanentNaturalObject(room, pos) {
    var sources = room.lookForAt(LOOK_SOURCES, pos.x, pos.y);
    if (sources.length > 0) {
        return true;
    }

    var minerals = room.lookForAt(LOOK_MINERALS, pos.x, pos.y);
    if (minerals.length > 0) {
        return true;
    }

    var structures = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);
    for (var i = 0; i < structures.length; i++) {
        if (structures[i].structureType === STRUCTURE_CONTROLLER) {
            return true;
        }
    }

    return room.controller && room.controller.pos.x === pos.x && room.controller.pos.y === pos.y;
}

function hasRoad(room, pos) {
    var structures = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);

    for (var i = 0; i < structures.length; i++) {
        if (structures[i].structureType === STRUCTURE_ROAD) {
            return true;
        }
    }

    return false;
}

function hasConstructionSite(room, pos) {
    return room.lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y).length > 0;
}

function hasBlockingStructure(room, pos) {
    var structures = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);

    for (var i = 0; i < structures.length; i++) {
        var structure = structures[i];

        if (structure.structureType === STRUCTURE_ROAD || structure.structureType === STRUCTURE_CONTAINER) {
            continue;
        }

        if (structure.structureType === STRUCTURE_RAMPART && (structure.my || structure.isPublic)) {
            continue;
        }

        if (isBlockingStructureType(structure.structureType)) {
            return true;
        }
    }

    return false;
}

function isBlockingStructureType(structureType) {
    return typeof OBSTACLE_OBJECT_TYPES !== 'undefined' && OBSTACLE_OBJECT_TYPES.indexOf(structureType) !== -1;
}

function drawRoadPlannerVisuals(homeRoomName) {
    if (!Memory.settings || Memory.settings.showRoadPlanner !== true) {
        return;
    }

    var planner = ensureRoadPlannerMemory(homeRoomName);
    if (!planner.rooms) {
        return;
    }

    for (var roomName in planner.rooms) {
        if (!planner.rooms.hasOwnProperty(roomName)) {
            continue;
        }

        var room = Game.rooms[roomName];
        var roomPlan = planner.rooms[roomName];
        if (!room || !roomPlan || !roomPlan.roadCoords) {
            continue;
        }

        var limit = Math.min(MAX_VISUAL_DOTS_PER_ROOM, roomPlan.roadCoords.length);
        for (var i = 0; i < limit; i++) {
            var packed = roomPlan.roadCoords[i];
            var pos = unpackCoord(packed, roomName);
            room.visual.circle(pos.x, pos.y, {
                radius: 0.15,
                fill: '#ffaa00',
                opacity: 0.35,
                stroke: '#ffaa00'
            });
        }
    }
}

module.exports = {
    run: run,
    runRoom: runRoom,
    planOwnedRoomRoads: planOwnedRoomRoads,
    buildRoadSites: buildRoadSites,
    packCoord: packCoord,
    unpackCoord: unpackCoord
};
