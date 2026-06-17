/*
 * Planner.Structures.js
 *
 * Phase 1 CPU-safe structure planner for Sushi.
 *
 * The planner borrows Harabi-style ideas:
 * - choose a stable base anchor
 * - save a structure plan in Memory
 * - group planned structures by RCL
 * - create construction sites slowly by priority
 *
 * It does not copy Harabi's helper system, room.heap cache, full floodfill
 * planner, mincut ramparts, or container-destroy upgrade flow.
 */

var STRUCTURE_PLANNER_VERSION = 1;
var STRUCTURE_REPLAN_INTERVAL = 500;
var STRUCTURE_BUILD_INTERVAL = 25;
var LOW_BUCKET_SKIP = 1500;
var CPU_BUFFER = 5;
var MAX_SITES_PER_RUN = 3;
var MAX_TOTAL_CONSTRUCTION_SITES = 90;
var MAX_VISUAL_DOTS = 120;

var BUILD_PRIORITY = [
    STRUCTURE_CONTAINER,
    STRUCTURE_STORAGE,
    STRUCTURE_EXTENSION,
    STRUCTURE_TOWER,
    STRUCTURE_LINK,
    STRUCTURE_EXTRACTOR,
    STRUCTURE_TERMINAL,
    STRUCTURE_FACTORY,
    STRUCTURE_OBSERVER,
    STRUCTURE_POWER_SPAWN,
    STRUCTURE_NUKER,
    STRUCTURE_LAB,
    STRUCTURE_RAMPART,
    STRUCTURE_SPAWN
];

var POSITION_KEYS = [
    STRUCTURE_SPAWN,
    STRUCTURE_EXTENSION,
    STRUCTURE_TOWER,
    STRUCTURE_STORAGE,
    STRUCTURE_CONTAINER,
    STRUCTURE_LINK,
    STRUCTURE_TERMINAL,
    STRUCTURE_EXTRACTOR,
    STRUCTURE_FACTORY,
    STRUCTURE_OBSERVER,
    STRUCTURE_POWER_SPAWN,
    STRUCTURE_NUKER,
    STRUCTURE_LAB,
    STRUCTURE_RAMPART
];

var RAMPART_TARGETS = [
    STRUCTURE_STORAGE,
    STRUCTURE_TERMINAL,
    STRUCTURE_TOWER,
    STRUCTURE_LINK,
    STRUCTURE_SPAWN
];

var VISUAL_LETTERS = {};
VISUAL_LETTERS[STRUCTURE_SPAWN] = 'S';
VISUAL_LETTERS[STRUCTURE_EXTENSION] = 'E';
VISUAL_LETTERS[STRUCTURE_TOWER] = 'T';
VISUAL_LETTERS[STRUCTURE_CONTAINER] = 'C';
VISUAL_LETTERS[STRUCTURE_LINK] = 'K';
VISUAL_LETTERS[STRUCTURE_STORAGE] = 'G';
VISUAL_LETTERS[STRUCTURE_TERMINAL] = 'M';
VISUAL_LETTERS[STRUCTURE_EXTRACTOR] = 'X';
VISUAL_LETTERS[STRUCTURE_FACTORY] = 'F';
VISUAL_LETTERS[STRUCTURE_OBSERVER] = 'O';
VISUAL_LETTERS[STRUCTURE_POWER_SPAWN] = 'P';
VISUAL_LETTERS[STRUCTURE_NUKER] = 'N';
VISUAL_LETTERS[STRUCTURE_LAB] = 'L';
VISUAL_LETTERS[STRUCTURE_RAMPART] = 'R';

var VISUAL_COLORS = {};
VISUAL_COLORS[STRUCTURE_SPAWN] = '#ffffff';
VISUAL_COLORS[STRUCTURE_EXTENSION] = '#7fd1ff';
VISUAL_COLORS[STRUCTURE_TOWER] = '#ffcc66';
VISUAL_COLORS[STRUCTURE_CONTAINER] = '#c49a6c';
VISUAL_COLORS[STRUCTURE_LINK] = '#78f0c4';
VISUAL_COLORS[STRUCTURE_STORAGE] = '#f7f06d';
VISUAL_COLORS[STRUCTURE_TERMINAL] = '#ff9ad5';
VISUAL_COLORS[STRUCTURE_EXTRACTOR] = '#ffaa44';
VISUAL_COLORS[STRUCTURE_FACTORY] = '#b8b8b8';
VISUAL_COLORS[STRUCTURE_OBSERVER] = '#8fc7ff';
VISUAL_COLORS[STRUCTURE_POWER_SPAWN] = '#ff7070';
VISUAL_COLORS[STRUCTURE_NUKER] = '#d9ff5c';
VISUAL_COLORS[STRUCTURE_LAB] = '#b58cff';
VISUAL_COLORS[STRUCTURE_RAMPART] = '#62e36f';

var AROUND = [
    { x: -1, y: -1 },
    { x: 0, y: -1 },
    { x: 1, y: -1 },
    { x: -1, y: 0 },
    { x: 1, y: 0 },
    { x: -1, y: 1 },
    { x: 0, y: 1 },
    { x: 1, y: 1 }
];

var NEAR_STORAGE_OFFSETS = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
    { x: 1, y: -1 },
    { x: -1, y: -1 },
    { x: 2, y: 0 },
    { x: -2, y: 0 },
    { x: 0, y: 2 },
    { x: 0, y: -2 }
];

var FALLBACK_CONTROLLER_STRUCTURES = {};
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_SPAWN] = [0, 1, 1, 1, 1, 1, 1, 2, 3];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION] = [0, 0, 5, 10, 20, 30, 40, 50, 60];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_TOWER] = [0, 0, 0, 1, 1, 2, 2, 3, 6];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_STORAGE] = [0, 0, 0, 0, 1, 1, 1, 1, 1];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_CONTAINER] = [5, 5, 5, 5, 5, 5, 5, 5, 5];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_LINK] = [0, 0, 0, 0, 0, 2, 3, 4, 6];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_TERMINAL] = [0, 0, 0, 0, 0, 0, 1, 1, 1];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_EXTRACTOR] = [0, 0, 0, 0, 0, 0, 1, 1, 1];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_FACTORY] = [0, 0, 0, 0, 0, 0, 0, 1, 1];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_OBSERVER] = [0, 0, 0, 0, 0, 0, 0, 0, 1];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_POWER_SPAWN] = [0, 0, 0, 0, 0, 0, 0, 0, 1];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_NUKER] = [0, 0, 0, 0, 0, 0, 0, 0, 1];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_LAB] = [0, 0, 0, 0, 0, 0, 3, 6, 10];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_RAMPART] = [0, 0, 300, 300, 300, 300, 300, 300, 300];

function run() {
    if (!canSpendCpu()) {
        return;
    }

    var ownedRooms = getOwnedVisibleRooms();
    if (ownedRooms.length === 0) {
        return;
    }

    var room = ownedRooms[Game.time % ownedRooms.length];
    runRoom(room);
}

function runRoom(room) {
    if (!room || !room.controller || !room.controller.my) {
        return;
    }

    var planner = ensurePlannerMemory(room.name);

    if (planner.version !== STRUCTURE_PLANNER_VERSION) {
        resetRoom(room.name);
        planner = ensurePlannerMemory(room.name);
    }

    if (shouldReplan(room, planner)) {
        planRoom(room);
        planner = ensurePlannerMemory(room.name);
    }

    if (Game.time - (planner.lastBuilt || 0) >= STRUCTURE_BUILD_INTERVAL) {
        buildSites(room);
        planner.lastBuilt = Game.time;
    }

    if (Memory.settings && Memory.settings.showStructurePlanner === true) {
        drawVisuals(room);
    }
}

function planRoom(room) {
    if (!room || !room.controller || !room.controller.my || !canSpendCpu()) {
        return null;
    }

    var planner = ensurePlannerMemory(room.name);
    var oldPlan = planner.plan;
    var plan = makeEmptyPlan();
    var reserved = {};
    var spawns = getSortedOwnedSpawns(room);

    /*
     * Existing spawns are fixed known structures. We record them for visuals
     * and ramparts, but do not create an RCL 1 spawn construction site.
     */
    for (var s = 0; s < spawns.length; s++) {
        recordExistingStructure(plan, reserved, STRUCTURE_SPAWN, spawns[s].pos, 1);
    }

    var anchor = pickStorageAnchor(room, oldPlan, spawns);
    if (!anchor) {
        /*
         * No safe storage anchor means this room is not ready for structure
         * planning this tick. Do not fall back to the spawn tile.
         */
        planner.lastPlanned = Game.time;
        planner.lastPlanFailed = Game.time;
        planner.lastPlanFailReason = 'no storage anchor';
        planner.forceReplan = false;
        return null;
    }

    plan.anchor = plainPosition(anchor);
    addPlannedStructure(room, plan, reserved, STRUCTURE_STORAGE, anchor, 4);

    planSourceContainers(room, plan, reserved, anchor);
    planControllerContainer(room, plan, reserved, anchor);
    planMineral(room, plan, reserved, anchor);

    var candidates = findOpenPositionsAroundAnchor(room, anchor, reserved);

    planStorageLink(room, plan, reserved, anchor);
    planControllerLink(room, plan, reserved, anchor);
    planSourceLinks(room, plan, reserved, anchor);

    planTowers(room, plan, reserved, candidates);
    planExtensions(room, plan, reserved, candidates);
    planSingleNearAnchor(room, plan, reserved, candidates, STRUCTURE_TERMINAL, 6);
    planLabs(room, plan, reserved, candidates);
    planSingleNearAnchor(room, plan, reserved, candidates, STRUCTURE_FACTORY, 7);
    planSingleNearAnchor(room, plan, reserved, candidates, STRUCTURE_OBSERVER, 8);
    planSingleNearAnchor(room, plan, reserved, candidates, STRUCTURE_POWER_SPAWN, 8);
    planSingleNearAnchor(room, plan, reserved, candidates, STRUCTURE_NUKER, 8);
    planExtraSpawns(room, plan, reserved, candidates, spawns.length);

    /*
     * TODO: Replace these key-structure ramparts with full mincut ramparts.
     */
    planKeyRamparts(room, plan, reserved);

    planner.plan = plan;
    planner.lastPlanned = Game.time;
    planner.lastRcl = room.controller.level || 0;
    planner.forceReplan = false;

    return plan;
}

function buildSites(room) {
    if (!room || !room.controller || !room.controller.my) {
        return 0;
    }

    if (!canBuildSites()) {
        return 0;
    }

    var planner = ensurePlannerMemory(room.name);
    if (!planner.plan || !planner.plan.byRcl) {
        return 0;
    }

    var entries = getBuildEntries(room, planner.plan);
    if (entries.length === 0) {
        planner.buildIndex = 0;
        return 0;
    }

    var built = 0;
    var checked = 0;
    var index = planner.buildIndex || 0;

    if (index >= entries.length) {
        index = 0;
    }

    while (checked < entries.length && built < MAX_SITES_PER_RUN) {
        if (!canBuildSites()) {
            planner.buildIndex = index;
            return built;
        }

        var entry = entries[index];
        index++;
        checked++;

        if (index >= entries.length) {
            index = 0;
        }

        var result = tryCreateSite(room, entry);
        if (result === OK) {
            built++;
        } else if (result === ERR_FULL) {
            planner.buildIndex = index;
            return built;
        }
    }

    planner.buildIndex = index;
    return built;
}

function resetRoom(roomName) {
    if (!Memory.rooms) {
        Memory.rooms = {};
    }
    if (!Memory.rooms[roomName]) {
        Memory.rooms[roomName] = {};
    }

    Memory.rooms[roomName].structurePlanner = makeEmptyPlannerMemory();
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

function ensurePlannerMemory(roomName) {
    if (!Memory.rooms) {
        Memory.rooms = {};
    }
    if (!Memory.rooms[roomName]) {
        Memory.rooms[roomName] = {};
    }
    if (!Memory.rooms[roomName].structurePlanner) {
        Memory.rooms[roomName].structurePlanner = makeEmptyPlannerMemory();
    }

    var planner = Memory.rooms[roomName].structurePlanner;

    if (!planner.plan) {
        planner.plan = makeEmptyPlan();
    }
    if (!planner.plan.byRcl) {
        planner.plan.byRcl = makeEmptyByRcl();
    }
    if (!planner.plan.positions) {
        planner.plan.positions = makeEmptyPositions();
    }
    if (!planner.plan.links) {
        planner.plan.links = {
            storage: null,
            controller: null,
            sources: {}
        };
    }
    if (!planner.plan.containers) {
        planner.plan.containers = {
            controller: null,
            mineral: null,
            sources: {}
        };
    }
    if (planner.forceReplan === undefined) {
        planner.forceReplan = false;
    }
    if (!planner.lastPlanned) {
        planner.lastPlanned = 0;
    }
    if (!planner.lastBuilt) {
        planner.lastBuilt = 0;
    }
    if (!planner.lastRcl) {
        planner.lastRcl = 0;
    }
    if (!planner.buildIndex) {
        planner.buildIndex = 0;
    }

    return planner;
}

function makeEmptyPlannerMemory() {
    return {
        version: STRUCTURE_PLANNER_VERSION,
        lastPlanned: 0,
        lastBuilt: 0,
        lastRcl: 0,
        buildIndex: 0,
        forceReplan: false,
        plan: makeEmptyPlan()
    };
}

function makeEmptyPlan() {
    return {
        anchor: null,
        byRcl: makeEmptyByRcl(),
        positions: makeEmptyPositions(),
        links: {
            storage: null,
            controller: null,
            sources: {}
        },
        containers: {
            controller: null,
            mineral: null,
            sources: {}
        }
    };
}

function makeEmptyByRcl() {
    var byRcl = {};

    for (var rcl = 1; rcl <= 8; rcl++) {
        byRcl[rcl] = [];
    }

    return byRcl;
}

function makeEmptyPositions() {
    var positions = {};

    for (var i = 0; i < POSITION_KEYS.length; i++) {
        positions[POSITION_KEYS[i]] = [];
    }

    return positions;
}

function shouldReplan(room, planner) {
    if (!planner) {
        return true;
    }

    if (planner.forceReplan === true) {
        return true;
    }

    if (!planner.plan || !planner.plan.anchor) {
        /*
         * If anchor selection recently failed, wait for the normal replan
         * interval. This prevents a low-CPU room from retrying the same full
         * anchor search every time its room is selected.
         */
        if (
            planner.lastPlanFailed &&
            planner.lastPlanFailReason === 'no storage anchor' &&
            Game.time - planner.lastPlanFailed < STRUCTURE_REPLAN_INTERVAL
        ) {
            return false;
        }

        return true;
    }

    if ((planner.lastRcl || 0) !== (room.controller.level || 0)) {
        return true;
    }

    return Game.time - (planner.lastPlanned || 0) >= STRUCTURE_REPLAN_INTERVAL;
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

function canBuildSites() {
    if (!canSpendCpu()) {
        return false;
    }

    return getTotalConstructionSites() < MAX_TOTAL_CONSTRUCTION_SITES;
}

function getTotalConstructionSites() {
    if (!Game.constructionSites) {
        return 0;
    }

    return Object.keys(Game.constructionSites).length;
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

function getSortedOwnedSpawns(room) {
    var spawns = room.find(FIND_MY_SPAWNS);

    spawns.sort(function(a, b) {
        return a.name < b.name ? -1 : 1;
    });

    return spawns;
}

function pickStorageAnchor(room, oldPlan, spawns) {
    if (room.storage) {
        return room.storage.pos;
    }

    var oldStorage = getOldStoragePosition(room, oldPlan);
    if (oldStorage && isValidStorageAnchor(room, oldStorage)) {
        return oldStorage;
    }

    if (!spawns || spawns.length === 0) {
        return null;
    }

    return pickStorageAnchorNearSpawn(room, spawns[0]);
}

function getOldStoragePosition(room, oldPlan) {
    if (!oldPlan || !oldPlan.positions || !oldPlan.positions[STRUCTURE_STORAGE]) {
        return null;
    }

    var storagePositions = oldPlan.positions[STRUCTURE_STORAGE];
    if (storagePositions.length === 0) {
        return null;
    }

    return makeRoomPositionSafe(storagePositions[0].x, storagePositions[0].y, storagePositions[0].roomName || room.name);
}

function pickStorageAnchorNearSpawn(room, spawn) {
    var best = null;
    var sources = room.find(FIND_SOURCES);

    for (var range = 1; range <= 4; range++) {
        for (var x = spawn.pos.x - range; x <= spawn.pos.x + range; x++) {
            for (var y = spawn.pos.y - range; y <= spawn.pos.y + range; y++) {
                if (Math.max(Math.abs(spawn.pos.x - x), Math.abs(spawn.pos.y - y)) !== range) {
                    continue;
                }

                var pos = makeRoomPositionSafe(x, y, room.name);
                if (!pos || !isValidStorageAnchor(room, pos)) {
                    continue;
                }

                var score = scoreAnchor(room, pos, sources);
                if (!best || score < best.score) {
                    best = {
                        pos: pos,
                        score: score
                    };
                }
            }
        }
    }

    return best ? best.pos : null;
}

function isValidStorageAnchor(room, pos) {
    if (!pos || pos.roomName !== room.name) {
        return false;
    }

    if (pos.x < 3 || pos.x > 46 || pos.y < 3 || pos.y > 46) {
        return false;
    }

    if (room.getTerrain().get(pos.x, pos.y) === TERRAIN_MASK_WALL) {
        return false;
    }

    if (hasNaturalObject(room, pos, STRUCTURE_STORAGE)) {
        return false;
    }

    if (hasStructureTypeAt(room, pos, STRUCTURE_SPAWN)) {
        return false;
    }

    if (hasBlockingStructure(room, pos, STRUCTURE_STORAGE)) {
        return false;
    }

    return room.lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y).length === 0;
}

function scoreAnchor(room, pos, sources) {
    var score = 0;
    var openNeighbors = countOpenNeighbors(room, pos);

    score -= openNeighbors * 8;

    if (room.controller) {
        score += pos.getRangeTo(room.controller.pos) * 3;
    }

    for (var i = 0; i < sources.length; i++) {
        score += pos.getRangeTo(sources[i].pos) * 2;
    }

    if (room.getTerrain().get(pos.x, pos.y) === TERRAIN_MASK_SWAMP) {
        score += 10;
    }

    return score;
}

function planSourceContainers(room, plan, reserved, anchor) {
    var sources = room.find(FIND_SOURCES);
    sources.sort(function(a, b) {
        return a.id < b.id ? -1 : 1;
    });

    ensureSourceMemory(room, sources);

    for (var i = 0; i < sources.length; i++) {
        var source = sources[i];
        var pos = findBestSourceSeat(room, source, anchor, reserved);

        if (!pos || !addPlannedStructure(room, plan, reserved, STRUCTURE_CONTAINER, pos, 2)) {
            continue;
        }

        plan.containers.sources[source.id] = plainPosition(pos);
        saveSourceContainerPosition(room, source.id, pos);
    }
}

function ensureSourceMemory(room, sources) {
    if (!Memory.rooms) {
        Memory.rooms = {};
    }
    if (!Memory.rooms[room.name]) {
        Memory.rooms[room.name] = {};
    }
    if (!Memory.rooms[room.name].sources) {
        Memory.rooms[room.name].sources = {};
    }

    for (var i = 0; i < sources.length; i++) {
        var source = sources[i];
        var sourceMemory = Memory.rooms[room.name].sources[source.id] || {};

        sourceMemory.id = source.id;
        sourceMemory.pos = plainPosition(source.pos);
        sourceMemory.lastScanned = Game.time;

        Memory.rooms[room.name].sources[source.id] = sourceMemory;
    }
}

function findBestSourceSeat(room, source, anchor, reserved) {
    var existingContainers = source.pos.findInRange(FIND_STRUCTURES, 1, {
        filter: function(structure) {
            return structure.structureType === STRUCTURE_CONTAINER;
        }
    });

    if (existingContainers.length > 0) {
        existingContainers.sort(function(a, b) {
            return a.pos.getRangeTo(anchor) - b.pos.getRangeTo(anchor);
        });
        return existingContainers[0].pos;
    }

    var best = null;

    for (var i = 0; i < AROUND.length; i++) {
        var pos = makeRoomPositionSafe(source.pos.x + AROUND[i].x, source.pos.y + AROUND[i].y, room.name);
        if (!pos || isEdge(pos)) {
            continue;
        }

        if (!canPlanAt(room, STRUCTURE_CONTAINER, pos) || hasPlannedConflict(reserved, STRUCTURE_CONTAINER, pos)) {
            continue;
        }

        var score = pos.getRangeTo(anchor) * 10;
        score -= countOpenNeighbors(room, pos) * 3;

        if (room.getTerrain().get(pos.x, pos.y) === TERRAIN_MASK_SWAMP) {
            score += 4;
        }

        if (!best || score < best.score) {
            best = {
                pos: pos,
                score: score
            };
        }
    }

    return best ? best.pos : null;
}

function saveSourceContainerPosition(room, sourceId, pos) {
    if (!Memory.rooms || !Memory.rooms[room.name] || !Memory.rooms[room.name].sources) {
        return;
    }

    var sourceMemory = Memory.rooms[room.name].sources[sourceId] || {};
    sourceMemory.containerPlanned = true;
    sourceMemory.containerPlannedAt = Game.time;
    sourceMemory.containerPlannedPos = plainPosition(pos);
    Memory.rooms[room.name].sources[sourceId] = sourceMemory;
}

function planControllerContainer(room, plan, reserved, anchor) {
    if (!room.controller) {
        return;
    }

    var pos = findBestControllerPosition(room, anchor, reserved);
    if (!pos || !addPlannedStructure(room, plan, reserved, STRUCTURE_CONTAINER, pos, 2)) {
        return;
    }

    plan.containers.controller = plainPosition(pos);

    if (!Memory.rooms[room.name].controller) {
        Memory.rooms[room.name].controller = {};
    }

    Memory.rooms[room.name].controller.containerPlannedPos = plainPosition(pos);
}

function findBestControllerPosition(room, anchor, reserved) {
    var controller = room.controller;
    var existingContainers = controller.pos.findInRange(FIND_STRUCTURES, 3, {
        filter: function(structure) {
            return structure.structureType === STRUCTURE_CONTAINER;
        }
    });

    if (existingContainers.length > 0) {
        existingContainers.sort(function(a, b) {
            return a.pos.getRangeTo(anchor) - b.pos.getRangeTo(anchor);
        });
        return existingContainers[0].pos;
    }

    var best = null;

    for (var x = controller.pos.x - 3; x <= controller.pos.x + 3; x++) {
        for (var y = controller.pos.y - 3; y <= controller.pos.y + 3; y++) {
            var pos = makeRoomPositionSafe(x, y, room.name);
            if (!pos || isEdge(pos) || pos.getRangeTo(controller.pos) > 3) {
                continue;
            }

            if (!canPlanAt(room, STRUCTURE_CONTAINER, pos) || hasPlannedConflict(reserved, STRUCTURE_CONTAINER, pos)) {
                continue;
            }

            var score = pos.getRangeTo(anchor) * 4;
            score -= countOpenNeighbors(room, pos) * 5;

            if (!best || score < best.score) {
                best = {
                    pos: pos,
                    score: score
                };
            }
        }
    }

    return best ? best.pos : null;
}

function planStorageLink(room, plan, reserved, anchor) {
    if (getPlannedCount(plan, STRUCTURE_LINK) >= getAllowedAtRcl(STRUCTURE_LINK, 8)) {
        return;
    }

    var pos = findOpenNear(room, anchor, anchor, reserved, STRUCTURE_LINK, null);

    if (pos && addPlannedStructure(room, plan, reserved, STRUCTURE_LINK, pos, 5)) {
        plan.links.storage = plainPosition(pos);
    }
}

function planControllerLink(room, plan, reserved, anchor) {
    if (!room.controller || !plan.containers.controller) {
        return;
    }

    if (getPlannedCount(plan, STRUCTURE_LINK) >= getAllowedAtRcl(STRUCTURE_LINK, 8)) {
        return;
    }

    var containerPos = makeRoomPositionSafe(
        plan.containers.controller.x,
        plan.containers.controller.y,
        plan.containers.controller.roomName || room.name
    );

    if (!containerPos) {
        return;
    }

    var pos = findOpenNear(room, containerPos, anchor, reserved, STRUCTURE_LINK, function(candidate) {
        return candidate.getRangeTo(room.controller.pos) <= 3;
    });

    /*
     * TODO: Add a later safe container-to-link upgrade. Phase 1 never destroys
     * containers and skips links that cannot find their own tile.
     */
    if (pos && addPlannedStructure(room, plan, reserved, STRUCTURE_LINK, pos, 5)) {
        plan.links.controller = plainPosition(pos);
    }
}

function planSourceLinks(room, plan, reserved, anchor) {
    var sources = room.find(FIND_SOURCES);
    sources.sort(function(a, b) {
        return a.id < b.id ? -1 : 1;
    });

    for (var i = 0; i < sources.length; i++) {
        if (getPlannedCount(plan, STRUCTURE_LINK) >= getAllowedAtRcl(STRUCTURE_LINK, 8)) {
            return;
        }

        var source = sources[i];
        var containerPlain = plan.containers.sources[source.id];
        if (!containerPlain) {
            continue;
        }

        var containerPos = makeRoomPositionSafe(containerPlain.x, containerPlain.y, containerPlain.roomName || room.name);
        if (!containerPos) {
            continue;
        }

        var pos = findOpenNear(room, containerPos, anchor, reserved, STRUCTURE_LINK, function(candidate) {
            return candidate.getRangeTo(source.pos) <= 2;
        });

        if (!pos) {
            continue;
        }

        var ordinal = getPlannedCount(plan, STRUCTURE_LINK) + 1;
        var rcl = getFirstRclForOrdinal(STRUCTURE_LINK, ordinal);

        if (addPlannedStructure(room, plan, reserved, STRUCTURE_LINK, pos, rcl)) {
            plan.links.sources[source.id] = plainPosition(pos);
        }
    }
}

function planMineral(room, plan, reserved, anchor) {
    var minerals = room.find(FIND_MINERALS);
    if (minerals.length === 0) {
        return;
    }

    minerals.sort(function(a, b) {
        return a.id < b.id ? -1 : 1;
    });

    var mineral = minerals[0];
    addPlannedStructure(room, plan, reserved, STRUCTURE_EXTRACTOR, mineral.pos, 6);

    var containerPos = findOpenNear(room, mineral.pos, anchor, reserved, STRUCTURE_CONTAINER, null);
    if (containerPos && addPlannedStructure(room, plan, reserved, STRUCTURE_CONTAINER, containerPos, 6)) {
        plan.containers.mineral = plainPosition(containerPos);
    }
}

function findOpenPositionsAroundAnchor(room, anchor, reserved) {
    var candidates = [];
    var seen = {};
    var maxRange = 46;

    for (var range = 1; range <= maxRange; range++) {
        if (!canSpendCpu()) {
            return sortBuildCandidates(candidates);
        }

        for (var x = anchor.x - range; x <= anchor.x + range; x++) {
            if (!canSpendCpu()) {
                return sortBuildCandidates(candidates);
            }

            for (var y = anchor.y - range; y <= anchor.y + range; y++) {
                if (!canSpendCpu()) {
                    return sortBuildCandidates(candidates);
                }

                if (Math.max(Math.abs(anchor.x - x), Math.abs(anchor.y - y)) !== range) {
                    continue;
                }

                var pos = makeRoomPositionSafe(x, y, room.name);
                if (!pos) {
                    continue;
                }

                var packed = packCoord(pos);
                if (seen[packed]) {
                    continue;
                }
                seen[packed] = true;

                if (!isOpenBuildPosition(room, pos, reserved)) {
                    continue;
                }

                candidates.push({
                    pos: pos,
                    score: scoreBuildPosition(room, pos, anchor)
                });
            }
        }
    }

    return sortBuildCandidates(candidates);
}

function sortBuildCandidates(candidates) {
    candidates.sort(function(a, b) {
        if (a.score !== b.score) {
            return a.score - b.score;
        }

        return packCoord(a.pos) - packCoord(b.pos);
    });

    return candidates;
}

function isOpenBuildPosition(room, pos, reserved) {
    if (pos.x < 3 || pos.x > 46 || pos.y < 3 || pos.y > 46) {
        return false;
    }

    if (reserved[packCoord(pos)]) {
        return false;
    }

    if (room.getTerrain().get(pos.x, pos.y) === TERRAIN_MASK_WALL) {
        return false;
    }

    if (hasNaturalObject(room, pos, null)) {
        return false;
    }

    if (hasBlockingStructure(room, pos, null)) {
        return false;
    }

    if (room.lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y).length > 0) {
        return false;
    }

    return countOpenNeighbors(room, pos) > 0;
}

function scoreBuildPosition(room, pos, anchor) {
    var score = pos.getRangeTo(anchor) * 10;

    if (((pos.x + pos.y) % 2) !== ((anchor.x + anchor.y) % 2)) {
        score += 8;
    }

    if (room.getTerrain().get(pos.x, pos.y) === TERRAIN_MASK_SWAMP) {
        score += 5;
    }

    score -= countOpenNeighbors(room, pos);

    return score;
}

function planSingleNearAnchor(room, plan, reserved, candidates, structureType, rcl) {
    if (getAllowedAtRcl(structureType, 8) <= 0 || getPlannedCount(plan, structureType) > 0) {
        return;
    }

    for (var i = 0; i < candidates.length; i++) {
        var pos = candidates[i].pos;

        if (addPlannedStructure(room, plan, reserved, structureType, pos, rcl)) {
            return;
        }
    }
}

function planLabs(room, plan, reserved, candidates) {
    /*
     * TODO: Add a real 10-lab reaction cluster later. Phase 1 only reserves up
     * to three nearby labs so the room can start basic chemistry.
     */
    var maxLabs = Math.min(3, getAllowedAtRcl(STRUCTURE_LAB, 8));

    for (var i = 0; i < candidates.length && getPlannedCount(plan, STRUCTURE_LAB) < maxLabs; i++) {
        var ordinal = getPlannedCount(plan, STRUCTURE_LAB) + 1;
        var rcl = getFirstRclForOrdinal(STRUCTURE_LAB, ordinal);

        addPlannedStructure(room, plan, reserved, STRUCTURE_LAB, candidates[i].pos, rcl);
    }
}

function planTowers(room, plan, reserved, candidates) {
    fillFromCandidates(room, plan, reserved, candidates, STRUCTURE_TOWER);
}

function planExtensions(room, plan, reserved, candidates) {
    fillFromCandidates(room, plan, reserved, candidates, STRUCTURE_EXTENSION);
}

function planExtraSpawns(room, plan, reserved, candidates, existingSpawnCount) {
    var finalAllowed = getAllowedAtRcl(STRUCTURE_SPAWN, 8);

    while (getPlannedCount(plan, STRUCTURE_SPAWN) < finalAllowed) {
        var ordinal = getPlannedCount(plan, STRUCTURE_SPAWN) + 1;
        var rcl = getFirstRclForOrdinal(STRUCTURE_SPAWN, ordinal);

        if (rcl < 7 || ordinal <= existingSpawnCount) {
            /*
             * The first spawn already exists and is not created by this planner.
             * Extra spawns begin at the RCL allowed by CONTROLLER_STRUCTURES.
             */
            break;
        }

        if (!addFirstCandidate(room, plan, reserved, candidates, STRUCTURE_SPAWN, rcl)) {
            break;
        }
    }
}

function fillFromCandidates(room, plan, reserved, candidates, structureType) {
    var finalAllowed = getAllowedAtRcl(structureType, 8);

    while (getPlannedCount(plan, structureType) < finalAllowed) {
        var ordinal = getPlannedCount(plan, structureType) + 1;
        var rcl = getFirstRclForOrdinal(structureType, ordinal);

        if (!addFirstCandidate(room, plan, reserved, candidates, structureType, rcl)) {
            return;
        }
    }
}

function addFirstCandidate(room, plan, reserved, candidates, structureType, rcl) {
    for (var i = 0; i < candidates.length; i++) {
        if (addPlannedStructure(room, plan, reserved, structureType, candidates[i].pos, rcl)) {
            return true;
        }
    }

    return false;
}

function planKeyRamparts(room, plan, reserved) {
    for (var t = 0; t < RAMPART_TARGETS.length; t++) {
        var structureType = RAMPART_TARGETS[t];
        var positions = plan.positions[structureType] || [];

        for (var i = 0; i < positions.length; i++) {
            var pos = makeRoomPositionSafe(positions[i].x, positions[i].y, positions[i].roomName || room.name);
            addPlannedStructure(room, plan, reserved, STRUCTURE_RAMPART, pos, 5);
        }
    }
}

function getBuildEntries(room, plan) {
    var entries = [];
    var currentRcl = room.controller ? room.controller.level || 0 : 0;

    for (var rcl = 1; rcl <= currentRcl; rcl++) {
        var rclEntries = plan.byRcl[rcl] || [];

        for (var p = 0; p < BUILD_PRIORITY.length; p++) {
            var priorityType = BUILD_PRIORITY[p];

            for (var i = 0; i < rclEntries.length; i++) {
                var entry = rclEntries[i];
                if ((entry.type || entry.structureType) === priorityType) {
                    entries.push(entry);
                }
            }
        }
    }

    return entries;
}

function tryCreateSite(room, entry) {
    var structureType = entry.type || entry.structureType;
    var pos = makeRoomPositionSafe(entry.x, entry.y, entry.roomName || room.name);

    if (!pos || pos.roomName !== room.name) {
        return ERR_INVALID_TARGET;
    }

    if (!canCreateSite(room, pos, structureType)) {
        return ERR_INVALID_TARGET;
    }

    var name = structureType === STRUCTURE_SPAWN ?
        'Sushi-' + room.name + '-' + (countExistingAndSites(room, STRUCTURE_SPAWN) + 1) :
        undefined;

    var result = name ?
        room.createConstructionSite(pos.x, pos.y, structureType, name) :
        room.createConstructionSite(pos.x, pos.y, structureType);

    if (
        result !== OK &&
        result !== ERR_FULL &&
        result !== ERR_RCL_NOT_ENOUGH &&
        result !== ERR_INVALID_TARGET &&
        Game.time % 100 === 0
    ) {
        console.log('[StructurePlanner] ' + room.name + ' failed ' + structureType + ' at ' + pos.x + ',' + pos.y + ': ' + result);
    }

    return result;
}

function canCreateSite(room, pos, structureType) {
    if (getTotalConstructionSites() >= MAX_TOTAL_CONSTRUCTION_SITES) {
        return false;
    }

    var allowed = getAllowedAtRcl(structureType, room.controller ? room.controller.level || 0 : 0);
    if (allowed <= 0) {
        return false;
    }

    if (countExistingAndSites(room, structureType) >= allowed) {
        return false;
    }

    if (hasStructureTypeAt(room, pos, structureType)) {
        return false;
    }

    if (room.lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y).length > 0) {
        return false;
    }

    if (room.getTerrain().get(pos.x, pos.y) === TERRAIN_MASK_WALL) {
        return false;
    }

    if (structureType === STRUCTURE_EXTRACTOR && !hasMineralAt(room, pos)) {
        return false;
    }

    if (structureType !== STRUCTURE_EXTRACTOR && hasNaturalObject(room, pos, structureType)) {
        return false;
    }

    if (structureType === STRUCTURE_RAMPART) {
        return canBuildRampartAt(room, pos);
    }

    return !hasBlockingStructure(room, pos, structureType);
}

function countExistingAndSites(room, structureType) {
    var count = 0;
    var structures = room.find(FIND_STRUCTURES);

    for (var i = 0; i < structures.length; i++) {
        if (structures[i].structureType === structureType) {
            count++;
        }
    }

    var sites = room.find(FIND_CONSTRUCTION_SITES);
    for (var j = 0; j < sites.length; j++) {
        if (sites[j].structureType === structureType && sites[j].my !== false) {
            count++;
        }
    }

    return count;
}

function addPlannedStructure(room, plan, reserved, structureType, pos, rcl) {
    if (!pos || !canPlanAt(room, structureType, pos) || hasPlannedConflict(reserved, structureType, pos)) {
        return false;
    }

    return recordPlannedStructure(plan, reserved, structureType, pos, rcl);
}

function recordExistingStructure(plan, reserved, structureType, pos, rcl) {
    if (!pos) {
        return false;
    }

    addPosition(plan, structureType, pos, rcl);
    reservePosition(reserved, structureType, pos);
    return true;
}

function recordPlannedStructure(plan, reserved, structureType, pos, rcl) {
    var targetRcl = Math.max(1, Math.min(8, rcl || 1));

    addPosition(plan, structureType, pos, targetRcl);

    if (!plan.byRcl[targetRcl]) {
        plan.byRcl[targetRcl] = [];
    }

    if (!hasByRclEntry(plan.byRcl[targetRcl], structureType, pos)) {
        plan.byRcl[targetRcl].push({
            type: structureType,
            x: pos.x,
            y: pos.y,
            roomName: pos.roomName
        });
    }

    reservePosition(reserved, structureType, pos);
    return true;
}

function addPosition(plan, structureType, pos, rcl) {
    if (!plan.positions[structureType]) {
        plan.positions[structureType] = [];
    }

    if (!hasPosition(plan.positions[structureType], pos)) {
        plan.positions[structureType].push({
            x: pos.x,
            y: pos.y,
            roomName: pos.roomName,
            rcl: rcl
        });
    }
}

function reservePosition(reserved, structureType, pos) {
    var packed = packCoord(pos);

    if (!reserved[packed]) {
        reserved[packed] = {
            types: {}
        };
    }

    reserved[packed].types[structureType] = true;
}

function hasPlannedConflict(reserved, structureType, pos) {
    var tile = reserved[packCoord(pos)];
    if (!tile || !tile.types) {
        return false;
    }

    for (var existingType in tile.types) {
        if (!tile.types.hasOwnProperty(existingType)) {
            continue;
        }

        if (existingType === structureType) {
            continue;
        }

        if (existingType === STRUCTURE_RAMPART || structureType === STRUCTURE_RAMPART) {
            continue;
        }

        return true;
    }

    return false;
}

function hasPosition(positions, pos) {
    for (var i = 0; i < positions.length; i++) {
        if (positions[i].x === pos.x && positions[i].y === pos.y && positions[i].roomName === pos.roomName) {
            return true;
        }
    }

    return false;
}

function hasByRclEntry(entries, structureType, pos) {
    for (var i = 0; i < entries.length; i++) {
        if ((entries[i].type || entries[i].structureType) === structureType && entries[i].x === pos.x && entries[i].y === pos.y && entries[i].roomName === pos.roomName) {
            return true;
        }
    }

    return false;
}

function canPlanAt(room, structureType, pos) {
    if (!pos || pos.roomName !== room.name || isEdge(pos)) {
        return false;
    }

    if (room.getTerrain().get(pos.x, pos.y) === TERRAIN_MASK_WALL) {
        return false;
    }

    if (structureType === STRUCTURE_EXTRACTOR) {
        if (!hasMineralAt(room, pos)) {
            return false;
        }
    } else if (hasNaturalObject(room, pos, structureType)) {
        return false;
    }

    if (structureType === STRUCTURE_RAMPART) {
        return canBuildRampartAt(room, pos);
    }

    if (room.lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y).length > 0) {
        return false;
    }

    return !hasBlockingStructure(room, pos, structureType);
}

function canBuildRampartAt(room, pos) {
    if (hasNaturalObject(room, pos, STRUCTURE_RAMPART)) {
        return false;
    }

    var structures = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);
    for (var i = 0; i < structures.length; i++) {
        var structure = structures[i];

        if (structure.structureType === STRUCTURE_RAMPART) {
            return false;
        }

        if (structure.my || structure.structureType === STRUCTURE_ROAD || structure.structureType === STRUCTURE_CONTAINER) {
            continue;
        }

        return false;
    }

    return true;
}

function hasBlockingStructure(room, pos, plannedType) {
    var structures = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);

    for (var i = 0; i < structures.length; i++) {
        var structure = structures[i];

        if (plannedType && structure.structureType === plannedType) {
            continue;
        }

        if (structure.structureType === STRUCTURE_RAMPART) {
            continue;
        }

        if (plannedType === STRUCTURE_CONTAINER && structure.structureType === STRUCTURE_ROAD) {
            continue;
        }

        return true;
    }

    return false;
}

function hasNaturalObject(room, pos, structureType) {
    if (room.lookForAt(LOOK_SOURCES, pos.x, pos.y).length > 0) {
        return true;
    }

    if (room.controller && room.controller.pos.x === pos.x && room.controller.pos.y === pos.y) {
        return true;
    }

    if (structureType !== STRUCTURE_EXTRACTOR && room.lookForAt(LOOK_MINERALS, pos.x, pos.y).length > 0) {
        return true;
    }

    return false;
}

function hasStructureTypeAt(room, pos, structureType) {
    var structures = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);

    for (var i = 0; i < structures.length; i++) {
        if (structures[i].structureType === structureType) {
            return true;
        }
    }

    return false;
}

function hasMineralAt(room, pos) {
    return room.lookForAt(LOOK_MINERALS, pos.x, pos.y).length > 0;
}

function findOpenNear(room, center, target, reserved, structureType, filter) {
    var best = null;

    for (var i = 0; i < NEAR_STORAGE_OFFSETS.length; i++) {
        var offset = NEAR_STORAGE_OFFSETS[i];
        var pos = makeRoomPositionSafe(center.x + offset.x, center.y + offset.y, room.name);

        if (!pos) {
            continue;
        }

        if (filter && !filter(pos)) {
            continue;
        }

        if (!canPlanAt(room, structureType, pos) || hasPlannedConflict(reserved, structureType, pos)) {
            continue;
        }

        var score = target ? pos.getRangeTo(target) * 10 : 0;
        score -= countOpenNeighbors(room, pos);

        if (room.getTerrain().get(pos.x, pos.y) === TERRAIN_MASK_SWAMP) {
            score += 4;
        }

        if (!best || score < best.score) {
            best = {
                pos: pos,
                score: score
            };
        }
    }

    return best ? best.pos : null;
}

function getPlannedCount(plan, structureType) {
    if (!plan || !plan.positions || !plan.positions[structureType]) {
        return 0;
    }

    return plan.positions[structureType].length;
}

function getAllowedAtRcl(structureType, rcl) {
    var level = Math.max(0, Math.min(8, rcl || 0));

    if (
        typeof CONTROLLER_STRUCTURES !== 'undefined' &&
        CONTROLLER_STRUCTURES[structureType] &&
        CONTROLLER_STRUCTURES[structureType][level] !== undefined
    ) {
        return CONTROLLER_STRUCTURES[structureType][level] || 0;
    }

    if (FALLBACK_CONTROLLER_STRUCTURES[structureType]) {
        return FALLBACK_CONTROLLER_STRUCTURES[structureType][level] || 0;
    }

    return 0;
}

function getFirstRclForOrdinal(structureType, ordinal) {
    for (var rcl = 1; rcl <= 8; rcl++) {
        if (getAllowedAtRcl(structureType, rcl) >= ordinal) {
            return rcl;
        }
    }

    return 8;
}

function countOpenNeighbors(room, pos) {
    var count = 0;

    for (var i = 0; i < AROUND.length; i++) {
        var near = makeRoomPositionSafe(pos.x + AROUND[i].x, pos.y + AROUND[i].y, room.name);
        if (!near || isEdge(near)) {
            continue;
        }

        if (room.getTerrain().get(near.x, near.y) === TERRAIN_MASK_WALL) {
            continue;
        }

        if (hasNaturalObject(room, near, null)) {
            continue;
        }

        if (hasBlockingStructure(room, near, null)) {
            continue;
        }

        count++;
    }

    return count;
}

function makeRoomPositionSafe(x, y, roomName) {
    if (x < 0 || x > 49 || y < 0 || y > 49) {
        return null;
    }

    return new RoomPosition(x, y, roomName);
}

function isEdge(pos) {
    return pos.x <= 0 || pos.x >= 49 || pos.y <= 0 || pos.y >= 49;
}

function plainPosition(pos) {
    if (!pos) {
        return null;
    }

    return {
        x: pos.x,
        y: pos.y,
        roomName: pos.roomName
    };
}

function drawVisuals(room) {
    var planner = ensurePlannerMemory(room.name);
    var plan = planner.plan;

    if (!plan || !plan.byRcl) {
        return;
    }

    var currentRcl = room.controller ? room.controller.level || 0 : 0;
    var currentEntries = plan.byRcl[currentRcl] || [];

    room.visual.text('StructurePlanner v' + STRUCTURE_PLANNER_VERSION + ' RCL ' + currentRcl + ' sites ' + currentEntries.length, 1, 1, {
        align: 'left',
        color: '#ffffff',
        font: 0.7,
        opacity: 0.85
    });

    var drawn = 0;
    var seen = {};

    for (var rcl = 1; rcl <= 8 && drawn < MAX_VISUAL_DOTS; rcl++) {
        var entries = plan.byRcl[rcl] || [];

        for (var i = 0; i < entries.length && drawn < MAX_VISUAL_DOTS; i++) {
            var entry = entries[i];
            var structureType = entry.type || entry.structureType;
            var key = structureType + ':' + entry.x + ':' + entry.y;

            if (seen[key]) {
                continue;
            }
            seen[key] = true;

            room.visual.text(VISUAL_LETTERS[structureType] || '?', entry.x, entry.y + 0.15, {
                color: VISUAL_COLORS[structureType] || '#ffffff',
                font: 0.45,
                opacity: 0.9,
                stroke: '#000000',
                strokeWidth: 0.15
            });

            drawn++;
        }
    }
}

module.exports = {
    run: run,
    runRoom: runRoom,
    planRoom: planRoom,
    buildSites: buildSites,
    resetRoom: resetRoom,
    packCoord: packCoord,
    unpackCoord: unpackCoord
};
