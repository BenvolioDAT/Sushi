/*
 * Planner.Structures.js
 *
 * CPU-safe automatic structure planner for Sushi.
 *
 * This planner saves a plain Memory plan first, then creates only a few
 * construction sites at a time. It does not move creeps and it does not plan
 * roads. Planner.Roads.js still owns roads.
 */

var STRUCTURE_PLANNER_VERSION = 1;
var STRUCTURE_REPLAN_INTERVAL = 500;
var STRUCTURE_BUILD_INTERVAL = 25;
var LOW_BUCKET_SKIP = 1500;
var CPU_BUFFER = 5;
var MAX_SITES_PER_RUN = 3;
var MAX_TOTAL_CONSTRUCTION_SITES = 90;
var MAX_VISUAL_DOTS = 120;
var MAX_FLOOD_TILES = 2500;

var BUILD_PRIORITY = [
    STRUCTURE_SPAWN,
    STRUCTURE_STORAGE,
    STRUCTURE_CONTAINER,
    STRUCTURE_EXTENSION,
    STRUCTURE_TOWER,
    STRUCTURE_LINK,
    STRUCTURE_EXTRACTOR,
    STRUCTURE_TERMINAL,
    STRUCTURE_LAB,
    STRUCTURE_FACTORY,
    STRUCTURE_OBSERVER,
    STRUCTURE_POWER_SPAWN,
    STRUCTURE_NUKER,
    STRUCTURE_RAMPART
];

var POSITION_KEYS = [
    STRUCTURE_SPAWN,
    STRUCTURE_EXTENSION,
    STRUCTURE_TOWER,
    STRUCTURE_STORAGE,
    STRUCTURE_LINK,
    STRUCTURE_TERMINAL,
    STRUCTURE_LAB,
    STRUCTURE_FACTORY,
    STRUCTURE_OBSERVER,
    STRUCTURE_POWER_SPAWN,
    STRUCTURE_NUKER,
    STRUCTURE_EXTRACTOR,
    STRUCTURE_CONTAINER,
    STRUCTURE_RAMPART
];

var ADOPT_EXISTING_TYPES = [
    STRUCTURE_SPAWN,
    STRUCTURE_EXTENSION,
    STRUCTURE_TOWER,
    STRUCTURE_STORAGE,
    STRUCTURE_LINK,
    STRUCTURE_TERMINAL,
    STRUCTURE_LAB,
    STRUCTURE_FACTORY,
    STRUCTURE_OBSERVER,
    STRUCTURE_POWER_SPAWN,
    STRUCTURE_NUKER,
    STRUCTURE_EXTRACTOR
];

var RAMPARTED_TYPES = [
    STRUCTURE_STORAGE,
    STRUCTURE_TERMINAL,
    STRUCTURE_TOWER,
    STRUCTURE_SPAWN,
    STRUCTURE_LINK,
    STRUCTURE_LAB,
    STRUCTURE_NUKER,
    STRUCTURE_FACTORY,
    STRUCTURE_POWER_SPAWN
];

var VISUAL_LETTERS = {};
VISUAL_LETTERS[STRUCTURE_SPAWN] = 'S';
VISUAL_LETTERS[STRUCTURE_EXTENSION] = 'E';
VISUAL_LETTERS[STRUCTURE_TOWER] = 'T';
VISUAL_LETTERS[STRUCTURE_CONTAINER] = 'C';
VISUAL_LETTERS[STRUCTURE_LINK] = 'K';
VISUAL_LETTERS[STRUCTURE_STORAGE] = 'G';
VISUAL_LETTERS[STRUCTURE_TERMINAL] = 'M';
VISUAL_LETTERS[STRUCTURE_LAB] = 'L';
VISUAL_LETTERS[STRUCTURE_FACTORY] = 'F';
VISUAL_LETTERS[STRUCTURE_OBSERVER] = 'O';
VISUAL_LETTERS[STRUCTURE_POWER_SPAWN] = 'P';
VISUAL_LETTERS[STRUCTURE_NUKER] = 'N';
VISUAL_LETTERS[STRUCTURE_EXTRACTOR] = 'X';
VISUAL_LETTERS[STRUCTURE_RAMPART] = 'R';

var VISUAL_COLORS = {};
VISUAL_COLORS[STRUCTURE_SPAWN] = '#ffffff';
VISUAL_COLORS[STRUCTURE_EXTENSION] = '#7fd1ff';
VISUAL_COLORS[STRUCTURE_TOWER] = '#ffcc66';
VISUAL_COLORS[STRUCTURE_CONTAINER] = '#c49a6c';
VISUAL_COLORS[STRUCTURE_LINK] = '#78f0c4';
VISUAL_COLORS[STRUCTURE_STORAGE] = '#f7f06d';
VISUAL_COLORS[STRUCTURE_TERMINAL] = '#ff9ad5';
VISUAL_COLORS[STRUCTURE_LAB] = '#b58cff';
VISUAL_COLORS[STRUCTURE_FACTORY] = '#b8b8b8';
VISUAL_COLORS[STRUCTURE_OBSERVER] = '#8fc7ff';
VISUAL_COLORS[STRUCTURE_POWER_SPAWN] = '#ff7070';
VISUAL_COLORS[STRUCTURE_NUKER] = '#d9ff5c';
VISUAL_COLORS[STRUCTURE_EXTRACTOR] = '#ffaa44';
VISUAL_COLORS[STRUCTURE_RAMPART] = '#62e36f';

var AROUND_DIRS = [
    { x: -1, y: -1 },
    { x: 0, y: -1 },
    { x: 1, y: -1 },
    { x: -1, y: 0 },
    { x: 1, y: 0 },
    { x: -1, y: 1 },
    { x: 0, y: 1 },
    { x: 1, y: 1 }
];

var CARDINAL_DIRS = [
    { x: 0, y: -1 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 }
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

var LAB_STAMP = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 2, y: 0 },
    { x: -1, y: 1 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 0, y: 2 },
    { x: 1, y: 2 }
];

var FALLBACK_CONTROLLER_STRUCTURES = {};
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_SPAWN] = [0, 1, 1, 1, 1, 1, 1, 2, 3];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION] = [0, 0, 5, 10, 20, 30, 40, 50, 60];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_TOWER] = [0, 0, 0, 1, 1, 2, 2, 3, 6];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_STORAGE] = [0, 0, 0, 0, 1, 1, 1, 1, 1];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_LINK] = [0, 0, 0, 0, 0, 2, 3, 4, 6];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_TERMINAL] = [0, 0, 0, 0, 0, 0, 1, 1, 1];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_LAB] = [0, 0, 0, 0, 0, 0, 3, 6, 10];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_EXTRACTOR] = [0, 0, 0, 0, 0, 0, 1, 1, 1];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_FACTORY] = [0, 0, 0, 0, 0, 0, 0, 1, 1];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_OBSERVER] = [0, 0, 0, 0, 0, 0, 0, 0, 1];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_POWER_SPAWN] = [0, 0, 0, 0, 0, 0, 0, 0, 1];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_NUKER] = [0, 0, 0, 0, 0, 0, 0, 0, 1];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_CONTAINER] = [5, 5, 5, 5, 5, 5, 5, 5, 5];
FALLBACK_CONTROLLER_STRUCTURES[STRUCTURE_RAMPART] = [0, 0, 300, 300, 300, 300, 300, 300, 300];

function run() {
    if (!canSpendCpu()) {
        return;
    }

    var ownedRooms = getOwnedVisibleRooms();
    if (ownedRooms.length === 0) {
        return;
    }

    /*
     * Process only one owned room each tick. This keeps mature empires from
     * doing every room's planning work on the same tick.
     */
    var room = ownedRooms[Game.time % ownedRooms.length];
    runRoom(room);
}

function runRoom(room) {
    if (!room || !room.controller || !room.controller.my) {
        return;
    }

    var planner = ensureStructurePlannerMemory(room.name);

    if (planner.version !== STRUCTURE_PLANNER_VERSION) {
        resetRoom(room.name);
        planner = ensureStructurePlannerMemory(room.name);
    }

    if (shouldReplanRoom(room, planner)) {
        planRoom(room);
        planner = ensureStructurePlannerMemory(room.name);
    }

    if (Game.time - (planner.lastBuilt || 0) >= STRUCTURE_BUILD_INTERVAL) {
        buildSites(room);
        planner.lastBuilt = Game.time;
    }

    if (Memory.settings && Memory.settings.showStructurePlanner === true) {
        drawStructurePlannerVisuals(room);
    }
}

function planRoom(room) {
    if (!room || !room.controller || !room.controller.my) {
        return null;
    }

    if (!canSpendCpu()) {
        return null;
    }

    var planner = ensureStructurePlannerMemory(room.name);
    var oldPlan = planner.plan;
    var plan = makeEmptyPlan();
    var reserved = {};
    var anchor = pickAnchor(room, oldPlan);

    if (!anchor) {
        return null;
    }

    plan.anchor = plainPosition(anchor);

    adoptExistingOwnedStructures(room, plan, reserved);

    var storagePos = addSingleCoreStructure(room, plan, reserved, STRUCTURE_STORAGE, anchor, 4, [
        { x: 0, y: 0 }
    ]);

    if (storagePos) {
        plan.anchor = plainPosition(storagePos);
        anchor = storagePos;
    }

    planCoreStructures(room, plan, reserved, anchor);
    planSources(room, plan, reserved, anchor);
    planController(room, plan, reserved, anchor);
    planMineral(room, plan, reserved, anchor);

    var candidates = buildOpenPositionList(room, anchor, reserved);

    tryPlaceLabCluster(room, plan, reserved, candidates);
    fillStructureFromCandidates(room, plan, reserved, candidates, STRUCTURE_SPAWN);
    fillStructureFromCandidates(room, plan, reserved, candidates, STRUCTURE_TOWER);
    fillStructureFromCandidates(room, plan, reserved, candidates, STRUCTURE_EXTENSION);

    /*
     * TODO: Replace key-structure ramparts with a real mincut rampart planner.
     * The first phase is intentionally conservative and cheap.
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

    var planner = ensureStructurePlannerMemory(room.name);
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

        var result = tryBuildEntry(room, planner, entry);

        if (result === OK) {
            built++;
            continue;
        }

        if (result === ERR_FULL) {
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

    Memory.rooms[roomName].structurePlanner = makeEmptyStructurePlannerMemory();
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

function ensureStructurePlannerMemory(roomName) {
    if (!Memory.rooms) {
        Memory.rooms = {};
    }
    if (!Memory.rooms[roomName]) {
        Memory.rooms[roomName] = {};
    }
    if (!Memory.rooms[roomName].structurePlanner) {
        Memory.rooms[roomName].structurePlanner = makeEmptyStructurePlannerMemory();
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
    if (!planner.failedSites) {
        planner.failedSites = {};
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

function makeEmptyStructurePlannerMemory() {
    return {
        version: STRUCTURE_PLANNER_VERSION,
        lastPlanned: 0,
        lastBuilt: 0,
        lastRcl: 0,
        buildIndex: 0,
        failedSites: {},
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

function shouldReplanRoom(room, planner) {
    if (!planner || !planner.plan || !planner.plan.byRcl || !planner.plan.anchor) {
        return true;
    }

    if (planner.forceReplan === true) {
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

    return getTotalConstructionSiteCount() < MAX_TOTAL_CONSTRUCTION_SITES;
}

function getTotalConstructionSiteCount() {
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

function pickAnchor(room, oldPlan) {
    if (room.storage) {
        return room.storage.pos;
    }

    var plannedStorage = getOldPlannedStorage(room, oldPlan);
    if (plannedStorage && isValidAnchorTile(room, plannedStorage)) {
        return plannedStorage;
    }

    var spawns = room.find(FIND_MY_SPAWNS);
    spawns.sort(function(a, b) {
        return a.name < b.name ? -1 : 1;
    });

    if (spawns.length > 0) {
        return pickAnchorNearSpawn(room, spawns[0]);
    }

    if (room.controller) {
        var controllerAnchor = findOpenTileNear(room, room.controller.pos, 3, 8);
        if (controllerAnchor) {
            return controllerAnchor;
        }

        return room.controller.pos;
    }

    return makeRoomPositionSafe(25, 25, room.name);
}

function getOldPlannedStorage(room, oldPlan) {
    if (!oldPlan || !oldPlan.positions || !oldPlan.positions[STRUCTURE_STORAGE]) {
        return null;
    }

    var storagePositions = oldPlan.positions[STRUCTURE_STORAGE];
    if (storagePositions.length === 0) {
        return null;
    }

    return makeRoomPositionSafe(storagePositions[0].x, storagePositions[0].y, storagePositions[0].roomName || room.name);
}

function pickAnchorNearSpawn(room, spawn) {
    var best = null;
    var sources = room.find(FIND_SOURCES);

    for (var range = 1; range <= 3; range++) {
        for (var x = spawn.pos.x - range; x <= spawn.pos.x + range; x++) {
            for (var y = spawn.pos.y - range; y <= spawn.pos.y + range; y++) {
                if (Math.max(Math.abs(spawn.pos.x - x), Math.abs(spawn.pos.y - y)) !== range) {
                    continue;
                }

                var pos = makeRoomPositionSafe(x, y, room.name);
                if (!pos || !isValidAnchorTile(room, pos)) {
                    continue;
                }

                var score = scoreAnchorCandidate(room, pos, sources);
                if (!best || score < best.score) {
                    best = {
                        pos: pos,
                        score: score
                    };
                }
            }
        }
    }

    if (best) {
        return best.pos;
    }

    /*
     * The requested fallback is the spawn tile. Later validation still avoids
     * placing storage on top of the spawn.
     */
    return spawn.pos;
}

function scoreAnchorCandidate(room, pos, sources) {
    var score = 0;
    var terrain = room.getTerrain();

    if (room.controller) {
        score += pos.getRangeTo(room.controller.pos) * 4;
    }

    for (var i = 0; i < sources.length; i++) {
        score += pos.getRangeTo(sources[i].pos) * 3;
    }

    if (terrain.get(pos.x, pos.y) === TERRAIN_MASK_SWAMP) {
        score += 8;
    }

    score -= countOpenNeighbors(room, pos) * 2;

    return score;
}

function isValidAnchorTile(room, pos) {
    if (!room || !pos || room.name !== pos.roomName) {
        return false;
    }

    if (pos.x < 3 || pos.x > 46 || pos.y < 3 || pos.y > 46) {
        return false;
    }

    if (room.getTerrain().get(pos.x, pos.y) === TERRAIN_MASK_WALL) {
        return false;
    }

    if (hasNaturalObject(room, pos, null)) {
        return false;
    }

    if (hasAnyStructureExcept(room, pos, STRUCTURE_STORAGE)) {
        return false;
    }

    if (room.lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y).length > 0) {
        return false;
    }

    return true;
}

function adoptExistingOwnedStructures(room, plan, reserved) {
    var structures = room.find(FIND_MY_STRUCTURES);

    structures.sort(function(a, b) {
        var packedA = packCoord(a.pos);
        var packedB = packCoord(b.pos);
        return packedA - packedB;
    });

    for (var i = 0; i < structures.length; i++) {
        var structure = structures[i];

        if (ADOPT_EXISTING_TYPES.indexOf(structure.structureType) === -1) {
            continue;
        }

        var ordinal = getPlannedCount(plan, structure.structureType) + 1;
        var rcl = getFirstRclForOrdinal(structure.structureType, ordinal);

        addStructureIfValid(room, plan, reserved, structure.structureType, structure.pos, rcl, {
            allowExistingSameType: true
        });
    }
}

function planCoreStructures(room, plan, reserved, anchor) {
    if (!anchor) {
        return;
    }

    var storageLink = addSingleCoreStructure(room, plan, reserved, STRUCTURE_LINK, anchor, 5, NEAR_STORAGE_OFFSETS);
    if (storageLink) {
        plan.links.storage = plainPosition(storageLink);
    } else {
        var existingStorageLink = findPlannedPositionNear(plan, STRUCTURE_LINK, anchor, 2);
        if (existingStorageLink) {
            plan.links.storage = plainPosition(existingStorageLink);
        }
    }

    addSingleCoreStructure(room, plan, reserved, STRUCTURE_TERMINAL, anchor, 6, [
        { x: 0, y: 1 },
        { x: 1, y: 0 },
        { x: -1, y: 0 },
        { x: 0, y: -1 },
        { x: 1, y: 1 },
        { x: -1, y: 1 },
        { x: 1, y: -1 },
        { x: -1, y: -1 }
    ]);

    addSingleCoreStructure(room, plan, reserved, STRUCTURE_FACTORY, anchor, 7, [
        { x: -1, y: 0 },
        { x: 0, y: -1 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
        { x: -1, y: -1 },
        { x: 1, y: -1 }
    ]);

    addSingleCoreStructure(room, plan, reserved, STRUCTURE_POWER_SPAWN, anchor, 8, [
        { x: 1, y: 1 },
        { x: -1, y: 1 },
        { x: 1, y: -1 },
        { x: -1, y: -1 },
        { x: 2, y: 1 },
        { x: -2, y: 1 }
    ]);

    addSingleCoreStructure(room, plan, reserved, STRUCTURE_NUKER, anchor, 8, [
        { x: -1, y: 1 },
        { x: 1, y: 1 },
        { x: -1, y: -1 },
        { x: 1, y: -1 },
        { x: -2, y: 0 },
        { x: 2, y: 0 }
    ]);

    addSingleCoreStructure(room, plan, reserved, STRUCTURE_OBSERVER, anchor, 8, [
        { x: 0, y: -1 },
        { x: 0, y: 1 },
        { x: 1, y: 0 },
        { x: -1, y: 0 },
        { x: 0, y: -2 },
        { x: 0, y: 2 }
    ]);
}

function addSingleCoreStructure(room, plan, reserved, structureType, anchor, rcl, offsets) {
    var finalAllowed = getAllowedAtRcl(structureType, 8);
    if (finalAllowed <= 0 || getPlannedCount(plan, structureType) >= finalAllowed) {
        return null;
    }

    for (var i = 0; i < offsets.length; i++) {
        var pos = makeRoomPositionSafe(anchor.x + offsets[i].x, anchor.y + offsets[i].y, room.name);
        if (addStructureIfValid(room, plan, reserved, structureType, pos, rcl, null)) {
            return pos;
        }
    }

    return null;
}

function planSources(room, plan, reserved, anchor) {
    var sources = room.find(FIND_SOURCES);
    sources.sort(function(a, b) {
        return a.id < b.id ? -1 : 1;
    });

    ensureRoomSourceMemory(room, sources);

    for (var i = 0; i < sources.length; i++) {
        var source = sources[i];
        var containerPos = findBestSourceContainerPosition(room, source, anchor, reserved);

        if (containerPos && addStructureIfValid(room, plan, reserved, STRUCTURE_CONTAINER, containerPos, 2, null)) {
            plan.containers.sources[source.id] = plainPosition(containerPos);
            rememberSourceContainer(room, source, containerPos);
        }

        var sourceLink = findExistingSourceLink(room, source, containerPos);
        if (!sourceLink && containerPos) {
            sourceLink = findBestAdjacentStructurePosition(
                room,
                containerPos,
                getStorageLinkPosition(plan, anchor),
                reserved,
                STRUCTURE_LINK,
                function(pos) {
                    return pos.getRangeTo(source.pos) <= 2;
                },
                null
            );
        }

        if (sourceLink && addStructureIfValid(room, plan, reserved, STRUCTURE_LINK, sourceLink, 5, null)) {
            plan.links.sources[source.id] = plainPosition(sourceLink);
            rememberSourceLink(room, source, sourceLink);
        }
    }
}

function ensureRoomSourceMemory(room, sources) {
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
        sourceMemory.lastScanned = sourceMemory.lastScanned || Game.time;

        if (!Array.isArray(sourceMemory.seats) || sourceMemory.seats.length === 0) {
            sourceMemory.seats = buildSourceSeats(room, source);
            sourceMemory.seatCount = sourceMemory.seats.length;
        }

        Memory.rooms[room.name].sources[source.id] = sourceMemory;
    }
}

function buildSourceSeats(room, source) {
    var seats = [];

    for (var i = 0; i < AROUND_DIRS.length; i++) {
        var pos = makeRoomPositionSafe(source.pos.x + AROUND_DIRS[i].x, source.pos.y + AROUND_DIRS[i].y, room.name);
        if (!pos || isEdge(pos) || room.getTerrain().get(pos.x, pos.y) === TERRAIN_MASK_WALL) {
            continue;
        }

        seats.push(plainPosition(pos));
    }

    return seats;
}

function findBestSourceContainerPosition(room, source, anchor, reserved) {
    var existing = source.pos.findInRange(FIND_STRUCTURES, 1, {
        filter: function(structure) {
            return structure.structureType === STRUCTURE_CONTAINER;
        }
    });

    if (existing.length > 0) {
        existing.sort(function(a, b) {
            return a.pos.getRangeTo(anchor) - b.pos.getRangeTo(anchor);
        });
        return existing[0].pos;
    }

    var sites = source.pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
        filter: function(site) {
            return site.structureType === STRUCTURE_CONTAINER;
        }
    });

    if (sites.length > 0) {
        sites.sort(function(a, b) {
            return a.pos.getRangeTo(anchor) - b.pos.getRangeTo(anchor);
        });
        return sites[0].pos;
    }

    var best = null;

    for (var i = 0; i < AROUND_DIRS.length; i++) {
        var pos = makeRoomPositionSafe(source.pos.x + AROUND_DIRS[i].x, source.pos.y + AROUND_DIRS[i].y, room.name);
        if (!pos || isEdge(pos)) {
            continue;
        }

        if (!canPlanStructureAt(room, STRUCTURE_CONTAINER, pos, null) || hasPlannedConflict(reserved, STRUCTURE_CONTAINER, pos, null)) {
            continue;
        }

        var openNeighbors = countOpenNeighbors(room, pos);
        if (openNeighbors <= 0) {
            continue;
        }

        var score = pos.getRangeTo(anchor) * 10;
        score += room.getTerrain().get(pos.x, pos.y) === TERRAIN_MASK_SWAMP ? 4 : 0;
        score -= openNeighbors * 2;

        if (!best || score < best.score) {
            best = {
                pos: pos,
                score: score
            };
        }
    }

    return best ? best.pos : null;
}

function rememberSourceContainer(room, source, pos) {
    if (!Memory.rooms || !Memory.rooms[room.name] || !Memory.rooms[room.name].sources) {
        return;
    }

    var sourceMemory = Memory.rooms[room.name].sources[source.id] || {};
    var existingContainers = pos.lookFor(LOOK_STRUCTURES);

    sourceMemory.containerPlanned = true;
    sourceMemory.containerPlannedAt = Game.time;
    sourceMemory.containerPlannedPos = plainPosition(pos);

    for (var i = 0; i < existingContainers.length; i++) {
        if (existingContainers[i].structureType === STRUCTURE_CONTAINER) {
            sourceMemory.containerId = existingContainers[i].id;
            break;
        }
    }

    Memory.rooms[room.name].sources[source.id] = sourceMemory;
}

function rememberSourceLink(room, source, pos) {
    if (!Memory.rooms || !Memory.rooms[room.name] || !Memory.rooms[room.name].sources) {
        return;
    }

    var sourceMemory = Memory.rooms[room.name].sources[source.id] || {};
    sourceMemory.linkPlanned = true;
    sourceMemory.linkPlannedAt = Game.time;
    sourceMemory.linkPlannedPos = plainPosition(pos);
    Memory.rooms[room.name].sources[source.id] = sourceMemory;
}

function findExistingSourceLink(room, source, containerPos) {
    var links = source.pos.findInRange(FIND_MY_STRUCTURES, 2, {
        filter: function(structure) {
            return structure.structureType === STRUCTURE_LINK;
        }
    });

    if (links.length === 0) {
        return null;
    }

    links.sort(function(a, b) {
        var aScore = containerPos ? a.pos.getRangeTo(containerPos) : a.pos.getRangeTo(source.pos);
        var bScore = containerPos ? b.pos.getRangeTo(containerPos) : b.pos.getRangeTo(source.pos);
        return aScore - bScore;
    });

    return links[0].pos;
}

function planController(room, plan, reserved, anchor) {
    if (!room.controller) {
        return;
    }

    var containerPos = findControllerContainerPosition(room, anchor, reserved);

    if (containerPos && addStructureIfValid(room, plan, reserved, STRUCTURE_CONTAINER, containerPos, 2, null)) {
        plan.containers.controller = plainPosition(containerPos);
        rememberControllerContainer(room, containerPos);
    }

    var linkPos = findControllerLinkPosition(room, containerPos, anchor, reserved);
    if (linkPos && addStructureIfValid(room, plan, reserved, STRUCTURE_LINK, linkPos, 5, {
        allowContainerLinkReplacement: true
    })) {
        plan.links.controller = plainPosition(linkPos);
        rememberControllerLink(room, linkPos);
    }
}

function findControllerContainerPosition(room, anchor, reserved) {
    var controller = room.controller;
    var existing = controller.pos.findInRange(FIND_STRUCTURES, 3, {
        filter: function(structure) {
            return structure.structureType === STRUCTURE_CONTAINER;
        }
    });

    if (existing.length > 0) {
        existing.sort(function(a, b) {
            return a.pos.getRangeTo(anchor) - b.pos.getRangeTo(anchor);
        });
        return existing[0].pos;
    }

    var sites = controller.pos.findInRange(FIND_CONSTRUCTION_SITES, 3, {
        filter: function(site) {
            return site.structureType === STRUCTURE_CONTAINER;
        }
    });

    if (sites.length > 0) {
        sites.sort(function(a, b) {
            return a.pos.getRangeTo(anchor) - b.pos.getRangeTo(anchor);
        });
        return sites[0].pos;
    }

    var best = null;

    for (var x = controller.pos.x - 3; x <= controller.pos.x + 3; x++) {
        for (var y = controller.pos.y - 3; y <= controller.pos.y + 3; y++) {
            var pos = makeRoomPositionSafe(x, y, room.name);
            if (!pos || isEdge(pos) || pos.getRangeTo(controller.pos) > 3) {
                continue;
            }

            if (!canPlanStructureAt(room, STRUCTURE_CONTAINER, pos, null) || hasPlannedConflict(reserved, STRUCTURE_CONTAINER, pos, null)) {
                continue;
            }

            var openNeighbors = countOpenNeighbors(room, pos);
            if (openNeighbors <= 0) {
                continue;
            }

            var score = (8 - openNeighbors) * 5;
            score += pos.getRangeTo(anchor) * 2;
            score += room.getTerrain().get(pos.x, pos.y) === TERRAIN_MASK_SWAMP ? 3 : 0;

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

function findControllerLinkPosition(room, containerPos, anchor, reserved) {
    var controller = room.controller;
    var existing = controller.pos.findInRange(FIND_MY_STRUCTURES, 3, {
        filter: function(structure) {
            return structure.structureType === STRUCTURE_LINK;
        }
    });

    if (existing.length > 0) {
        existing.sort(function(a, b) {
            return a.pos.getRangeTo(anchor) - b.pos.getRangeTo(anchor);
        });
        return existing[0].pos;
    }

    if (!containerPos) {
        return null;
    }

    var adjacent = findBestAdjacentStructurePosition(
        room,
        containerPos,
        anchor,
        reserved,
        STRUCTURE_LINK,
        function(pos) {
            return pos.getRangeTo(controller.pos) <= 3;
        },
        null
    );

    if (adjacent) {
        return adjacent;
    }

    /*
     * If the controller area is cramped, let the future link replace the
     * controller container. buildSites() performs the actual safety check.
     */
    if (
        canPlanStructureAt(room, STRUCTURE_LINK, containerPos, {
            allowContainerLinkReplacement: true
        }) &&
        !hasPlannedConflict(reserved, STRUCTURE_LINK, containerPos, {
            allowContainerLinkReplacement: true
        })
    ) {
        return containerPos;
    }

    return null;
}

function rememberControllerContainer(room, pos) {
    if (!Memory.rooms) {
        Memory.rooms = {};
    }
    if (!Memory.rooms[room.name]) {
        Memory.rooms[room.name] = {};
    }
    if (!Memory.rooms[room.name].controller) {
        Memory.rooms[room.name].controller = {};
    }

    Memory.rooms[room.name].controller.containerPlanned = true;
    Memory.rooms[room.name].controller.containerPlannedAt = Game.time;
    Memory.rooms[room.name].controller.containerPlannedPos = plainPosition(pos);
}

function rememberControllerLink(room, pos) {
    if (!Memory.rooms) {
        Memory.rooms = {};
    }
    if (!Memory.rooms[room.name]) {
        Memory.rooms[room.name] = {};
    }
    if (!Memory.rooms[room.name].controller) {
        Memory.rooms[room.name].controller = {};
    }

    Memory.rooms[room.name].controller.linkPlanned = true;
    Memory.rooms[room.name].controller.linkPlannedAt = Game.time;
    Memory.rooms[room.name].controller.linkPlannedPos = plainPosition(pos);
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
    if (addStructureIfValid(room, plan, reserved, STRUCTURE_EXTRACTOR, mineral.pos, 6, null)) {
        rememberMineralExtractor(room, mineral, mineral.pos);
    }

    var containerPos = findBestMineralContainerPosition(room, mineral, anchor, reserved);
    if (containerPos && addStructureIfValid(room, plan, reserved, STRUCTURE_CONTAINER, containerPos, 6, null)) {
        plan.containers.mineral = plainPosition(containerPos);
        rememberMineralContainer(room, mineral, containerPos);
    }
}

function findBestMineralContainerPosition(room, mineral, anchor, reserved) {
    var existing = mineral.pos.findInRange(FIND_STRUCTURES, 1, {
        filter: function(structure) {
            return structure.structureType === STRUCTURE_CONTAINER;
        }
    });

    if (existing.length > 0) {
        existing.sort(function(a, b) {
            return a.pos.getRangeTo(anchor) - b.pos.getRangeTo(anchor);
        });
        return existing[0].pos;
    }

    var best = null;

    for (var i = 0; i < AROUND_DIRS.length; i++) {
        var pos = makeRoomPositionSafe(mineral.pos.x + AROUND_DIRS[i].x, mineral.pos.y + AROUND_DIRS[i].y, room.name);
        if (!pos || isEdge(pos)) {
            continue;
        }

        if (!canPlanStructureAt(room, STRUCTURE_CONTAINER, pos, null) || hasPlannedConflict(reserved, STRUCTURE_CONTAINER, pos, null)) {
            continue;
        }

        var score = pos.getRangeTo(anchor) * 10;
        score -= countOpenNeighbors(room, pos) * 2;

        if (!best || score < best.score) {
            best = {
                pos: pos,
                score: score
            };
        }
    }

    return best ? best.pos : null;
}

function rememberMineralExtractor(room, mineral, pos) {
    ensureMineralMemory(room, mineral).extractorPlannedPos = plainPosition(pos);
}

function rememberMineralContainer(room, mineral, pos) {
    var mineralMemory = ensureMineralMemory(room, mineral);
    mineralMemory.containerPlanned = true;
    mineralMemory.containerPlannedAt = Game.time;
    mineralMemory.containerPlannedPos = plainPosition(pos);
}

function ensureMineralMemory(room, mineral) {
    if (!Memory.rooms) {
        Memory.rooms = {};
    }
    if (!Memory.rooms[room.name]) {
        Memory.rooms[room.name] = {};
    }
    if (!Memory.rooms[room.name].Mineral) {
        Memory.rooms[room.name].Mineral = {};
    }

    var mineralMemory = Memory.rooms[room.name].Mineral[mineral.id] || {};
    mineralMemory.id = mineral.id;
    mineralMemory.pos = plainPosition(mineral.pos);
    Memory.rooms[room.name].Mineral[mineral.id] = mineralMemory;

    return mineralMemory;
}

function buildOpenPositionList(room, anchor, reserved) {
    var candidates = [];
    var visited = {};
    var queue = [];
    var queueHead = 0;
    var visitedCount = 0;
    var terrain = room.getTerrain();
    var seed = anchor;

    if (!seed || terrain.get(seed.x, seed.y) === TERRAIN_MASK_WALL) {
        seed = findOpenTileNear(room, anchor || makeRoomPositionSafe(25, 25, room.name), 1, 10);
    }

    if (!seed) {
        return candidates;
    }

    queue.push(seed);
    visited[packCoord(seed)] = true;
    visitedCount++;

    while (queueHead < queue.length && visitedCount < MAX_FLOOD_TILES) {
        var pos = queue[queueHead];
        queueHead++;

        if (isOpenBuildCandidate(room, pos, reserved)) {
            candidates.push(scoreBuildCandidate(room, pos, anchor));
        }

        for (var i = 0; i < CARDINAL_DIRS.length; i++) {
            var next = makeRoomPositionSafe(pos.x + CARDINAL_DIRS[i].x, pos.y + CARDINAL_DIRS[i].y, room.name);
            if (!next) {
                continue;
            }

            var packed = packCoord(next);
            if (visited[packed]) {
                continue;
            }

            visited[packed] = true;
            visitedCount++;

            if (isFloodWalkable(room, next)) {
                queue.push(next);
            }
        }
    }

    /*
     * If the anchor is boxed in, fall back to a cheap whole-room scan. This
     * keeps planning useful in awkward bunker or wall layouts.
     */
    if (candidates.length < 30) {
        addWholeRoomCandidates(room, anchor, reserved, candidates);
    }

    candidates.sort(function(a, b) {
        if (a.score !== b.score) {
            return a.score - b.score;
        }

        return packCoord(a.pos) - packCoord(b.pos);
    });

    return candidates;
}

function addWholeRoomCandidates(room, anchor, reserved, candidates) {
    var existing = {};

    for (var i = 0; i < candidates.length; i++) {
        existing[packCoord(candidates[i].pos)] = true;
    }

    for (var x = 3; x <= 46; x++) {
        for (var y = 3; y <= 46; y++) {
            var pos = makeRoomPositionSafe(x, y, room.name);
            if (!pos || existing[packCoord(pos)] || !isOpenBuildCandidate(room, pos, reserved)) {
                continue;
            }

            candidates.push(scoreBuildCandidate(room, pos, anchor));
            existing[packCoord(pos)] = true;
        }
    }
}

function isFloodWalkable(room, pos) {
    if (!room || !pos || isEdge(pos)) {
        return false;
    }

    if (room.getTerrain().get(pos.x, pos.y) === TERRAIN_MASK_WALL) {
        return false;
    }

    if (hasNaturalObject(room, pos, null)) {
        return false;
    }

    return !hasHardBlockingStructure(room, pos);
}

function isOpenBuildCandidate(room, pos, reserved) {
    if (!room || !pos || pos.x < 3 || pos.x > 46 || pos.y < 3 || pos.y > 46) {
        return false;
    }

    if (room.getTerrain().get(pos.x, pos.y) === TERRAIN_MASK_WALL) {
        return false;
    }

    if (reserved[packCoord(pos)]) {
        return false;
    }

    if (hasNaturalObject(room, pos, null)) {
        return false;
    }

    if (isNearSource(room, pos) || isNearController(room, pos)) {
        return false;
    }

    if (hasAnyStructureExcept(room, pos, null)) {
        return false;
    }

    if (room.lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y).length > 0) {
        return false;
    }

    return countOpenNeighbors(room, pos) > 0;
}

function scoreBuildCandidate(room, pos, anchor) {
    var openNeighbors = countOpenNeighbors(room, pos);
    var score = pos.getRangeTo(anchor) * 10;

    if (room.getTerrain().get(pos.x, pos.y) === TERRAIN_MASK_SWAMP) {
        score += 6;
    }

    /*
     * A checker pattern leaves more walking lanes through extension fields. It
     * is a preference, not a hard rule, so cramped rooms can still fill out.
     */
    if (((pos.x + pos.y) % 2) !== ((anchor.x + anchor.y) % 2)) {
        score += 7;
    }

    score -= openNeighbors * 2;

    return {
        pos: pos,
        score: score
    };
}

function tryPlaceLabCluster(room, plan, reserved, candidates) {
    var finalAllowed = getAllowedAtRcl(STRUCTURE_LAB, 8);
    if (finalAllowed <= 0 || getPlannedCount(plan, STRUCTURE_LAB) > 0) {
        return false;
    }

    var count = Math.min(finalAllowed, LAB_STAMP.length);

    for (var c = 0; c < candidates.length; c++) {
        var origin = candidates[c].pos;
        var positions = [];
        var ok = true;

        for (var i = 0; i < count; i++) {
            var pos = makeRoomPositionSafe(origin.x + LAB_STAMP[i].x, origin.y + LAB_STAMP[i].y, room.name);
            if (!pos || !canPlanStructureAt(room, STRUCTURE_LAB, pos, null) || hasPlannedConflict(reserved, STRUCTURE_LAB, pos, null)) {
                ok = false;
                break;
            }

            positions.push(pos);
        }

        if (!ok || !labStampHasGoodSourceLabs(positions)) {
            continue;
        }

        for (var p = 0; p < positions.length; p++) {
            var ordinal = getPlannedCount(plan, STRUCTURE_LAB) + 1;
            var rcl = getFirstRclForOrdinal(STRUCTURE_LAB, ordinal);
            addStructureIfValid(room, plan, reserved, STRUCTURE_LAB, positions[p], rcl, null);
        }

        return true;
    }

    return false;
}

function labStampHasGoodSourceLabs(positions) {
    if (!positions || positions.length < 3) {
        return false;
    }

    var sourceA = positions[0];
    var sourceB = positions[1];

    for (var i = 2; i < positions.length; i++) {
        if (positions[i].getRangeTo(sourceA) > 2 || positions[i].getRangeTo(sourceB) > 2) {
            return false;
        }
    }

    return true;
}

function fillStructureFromCandidates(room, plan, reserved, candidates, structureType) {
    var finalAllowed = getAllowedAtRcl(structureType, 8);
    if (finalAllowed <= 0) {
        return;
    }

    var candidateIndex = 0;

    while (getPlannedCount(plan, structureType) < finalAllowed && candidateIndex < candidates.length) {
        var pos = candidates[candidateIndex].pos;
        candidateIndex++;

        if (!canPlanStructureAt(room, structureType, pos, null) || hasPlannedConflict(reserved, structureType, pos, null)) {
            continue;
        }

        var ordinal = getPlannedCount(plan, structureType) + 1;
        var rcl = getFirstRclForOrdinal(structureType, ordinal);
        addStructureIfValid(room, plan, reserved, structureType, pos, rcl, null);
    }
}

function planKeyRamparts(room, plan, reserved) {
    for (var t = 0; t < RAMPARTED_TYPES.length; t++) {
        var structureType = RAMPARTED_TYPES[t];
        var positions = plan.positions[structureType] || [];

        for (var i = 0; i < positions.length; i++) {
            var pos = makeRoomPositionSafe(positions[i].x, positions[i].y, positions[i].roomName || room.name);
            addStructureIfValid(room, plan, reserved, STRUCTURE_RAMPART, pos, 5, null);
        }
    }
}

function getBuildEntries(room, plan) {
    var entries = [];
    var currentRcl = room.controller ? room.controller.level || 0 : 0;

    for (var rcl = 1; rcl <= currentRcl; rcl++) {
        var rclEntries = plan.byRcl[rcl] || [];

        for (var priorityIndex = 0; priorityIndex < BUILD_PRIORITY.length; priorityIndex++) {
            var structureType = BUILD_PRIORITY[priorityIndex];

            for (var i = 0; i < rclEntries.length; i++) {
                var entry = rclEntries[i];
                if ((entry.type || entry.structureType) === structureType) {
                    entries.push(entry);
                }
            }
        }
    }

    return entries;
}

function tryBuildEntry(room, planner, entry) {
    var structureType = entry.type || entry.structureType;
    var pos = makeRoomPositionSafe(entry.x, entry.y, entry.roomName || room.name);

    if (!pos || pos.roomName !== room.name) {
        return ERR_INVALID_TARGET;
    }

    if (!canAttemptStructureSite(room, planner, pos, structureType)) {
        return ERR_INVALID_TARGET;
    }

    var name = null;
    if (structureType === STRUCTURE_SPAWN) {
        name = getSpawnSiteName(room, planner.plan, pos);
    }

    var result = name ?
        room.createConstructionSite(pos.x, pos.y, structureType, name) :
        room.createConstructionSite(pos.x, pos.y, structureType);

    if (result === OK) {
        return OK;
    }

    if (result === ERR_FULL || result === ERR_RCL_NOT_ENOUGH) {
        return result;
    }

    if (result === ERR_INVALID_TARGET) {
        rememberFailedSite(planner, pos, structureType);
        return result;
    }

    if (Game.time % 100 === 0) {
        console.log('[StructurePlanner] ' + room.name + ' createConstructionSite ' + structureType + ' at ' + pos.x + ',' + pos.y + ' returned ' + result);
    }

    return result;
}

function canAttemptStructureSite(room, planner, pos, structureType) {
    if (getTotalConstructionSiteCount() >= MAX_TOTAL_CONSTRUCTION_SITES) {
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

    if (structureType === STRUCTURE_EXTRACTOR && !isMineralTile(room, pos)) {
        return false;
    }

    if (structureType !== STRUCTURE_EXTRACTOR && hasNaturalObject(room, pos, structureType)) {
        return false;
    }

    if (structureType === STRUCTURE_RAMPART) {
        return canBuildRampartAt(room, pos);
    }

    if (structureType === STRUCTURE_LINK && maybeDestroyControllerContainerForLink(room, planner, pos)) {
        return true;
    }

    return !hasBlockingStructureForBuild(room, pos, structureType);
}

function maybeDestroyControllerContainerForLink(room, planner, pos) {
    var plan = planner.plan;
    if (!plan || !plan.links || !plan.containers) {
        return false;
    }

    if (!samePlainPosition(plan.links.controller, pos) || !samePlainPosition(plan.containers.controller, pos)) {
        return false;
    }

    if (!room.storage && room.energyCapacityAvailable < 800) {
        return false;
    }

    if (hasStructureTypeAt(room, pos, STRUCTURE_LINK)) {
        return false;
    }

    var structures = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);

    for (var i = 0; i < structures.length; i++) {
        var structure = structures[i];
        if (structure.structureType !== STRUCTURE_CONTAINER) {
            continue;
        }

        return structure.destroy() === OK;
    }

    return false;
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

function rememberFailedSite(planner, pos, structureType) {
    if (!planner.failedSites) {
        planner.failedSites = {};
    }

    var key = structureType + ':' + packCoord(pos);
    planner.failedSites[key] = (planner.failedSites[key] || 0) + 1;
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

function getSpawnSiteName(room, plan, pos) {
    var positions = plan.positions[STRUCTURE_SPAWN] || [];

    for (var i = 0; i < positions.length; i++) {
        if (positions[i].x === pos.x && positions[i].y === pos.y && (positions[i].roomName || room.name) === room.name) {
            return 'Sushi-' + room.name + '-' + (i + 1);
        }
    }

    return 'Sushi-' + room.name + '-' + (countExistingAndSites(room, STRUCTURE_SPAWN) + 1);
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

function addStructureIfValid(room, plan, reserved, structureType, pos, rcl, options) {
    if (!pos || !canPlanStructureAt(room, structureType, pos, options)) {
        return false;
    }

    return addPlanStructure(plan, reserved, structureType, pos, rcl, options);
}

function canPlanStructureAt(room, structureType, pos, options) {
    if (!room || !pos || room.name !== pos.roomName) {
        return false;
    }

    if (isEdge(pos)) {
        return false;
    }

    if (room.getTerrain().get(pos.x, pos.y) === TERRAIN_MASK_WALL) {
        return false;
    }

    if (structureType === STRUCTURE_EXTRACTOR) {
        if (!isMineralTile(room, pos)) {
            return false;
        }
    } else if (hasNaturalObject(room, pos, structureType)) {
        return false;
    }

    if (structureType === STRUCTURE_RAMPART) {
        return canPlanRampartAt(room, pos);
    }

    return !hasBlockingStructureForPlan(room, pos, structureType, options) &&
        !hasBlockingConstructionSiteForPlan(room, pos, structureType);
}

function addPlanStructure(plan, reserved, structureType, pos, rcl, options) {
    var packed = packCoord(pos);
    var targetRcl = Math.max(1, Math.min(8, rcl || 1));

    if (hasPlannedConflict(reserved, structureType, pos, options)) {
        return false;
    }

    if (!plan.positions[structureType]) {
        plan.positions[structureType] = [];
    }

    if (!hasPlannedTypeAt(plan, structureType, pos)) {
        plan.positions[structureType].push({
            x: pos.x,
            y: pos.y,
            roomName: pos.roomName,
            rcl: targetRcl
        });
    }

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

    if (!reserved[packed]) {
        reserved[packed] = {
            types: {}
        };
    }

    reserved[packed].types[structureType] = true;

    return true;
}

function hasPlannedConflict(reserved, structureType, pos, options) {
    var reservedTile = reserved[packCoord(pos)];
    if (!reservedTile || !reservedTile.types) {
        return false;
    }

    for (var existingType in reservedTile.types) {
        if (!reservedTile.types.hasOwnProperty(existingType)) {
            continue;
        }

        if (existingType === structureType) {
            continue;
        }

        if (existingType === STRUCTURE_RAMPART || structureType === STRUCTURE_RAMPART) {
            continue;
        }

        if (
            options &&
            options.allowContainerLinkReplacement === true &&
            structureType === STRUCTURE_LINK &&
            existingType === STRUCTURE_CONTAINER
        ) {
            continue;
        }

        return true;
    }

    return false;
}

function hasPlannedTypeAt(plan, structureType, pos) {
    var positions = plan.positions[structureType] || [];

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

function getPlannedCount(plan, structureType) {
    if (!plan || !plan.positions || !plan.positions[structureType]) {
        return 0;
    }

    return plan.positions[structureType].length;
}

function canPlanRampartAt(room, pos) {
    if (hasNaturalObject(room, pos, STRUCTURE_RAMPART)) {
        return false;
    }

    var structures = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);
    for (var i = 0; i < structures.length; i++) {
        var structure = structures[i];

        if (structure.structureType === STRUCTURE_RAMPART) {
            return true;
        }

        if (structure.my || structure.structureType === STRUCTURE_ROAD || structure.structureType === STRUCTURE_CONTAINER) {
            continue;
        }

        return false;
    }

    return true;
}

function hasBlockingStructureForPlan(room, pos, structureType, options) {
    var structures = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);

    for (var i = 0; i < structures.length; i++) {
        var structure = structures[i];

        if (structure.structureType === structureType) {
            continue;
        }

        if (structure.structureType === STRUCTURE_RAMPART) {
            continue;
        }

        if (structureType === STRUCTURE_CONTAINER && structure.structureType === STRUCTURE_ROAD) {
            continue;
        }

        if (
            structureType === STRUCTURE_LINK &&
            structure.structureType === STRUCTURE_CONTAINER &&
            options &&
            options.allowContainerLinkReplacement === true
        ) {
            continue;
        }

        return true;
    }

    return false;
}

function hasBlockingStructureForBuild(room, pos, structureType) {
    var structures = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);

    for (var i = 0; i < structures.length; i++) {
        var structure = structures[i];

        if (structure.structureType === structureType) {
            continue;
        }

        if (structure.structureType === STRUCTURE_RAMPART) {
            continue;
        }

        if (structureType === STRUCTURE_CONTAINER && structure.structureType === STRUCTURE_ROAD) {
            continue;
        }

        return true;
    }

    return false;
}

function hasBlockingConstructionSiteForPlan(room, pos, structureType) {
    var sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y);

    for (var i = 0; i < sites.length; i++) {
        if (sites[i].structureType === structureType) {
            continue;
        }

        if (structureType === STRUCTURE_RAMPART) {
            continue;
        }

        return true;
    }

    return false;
}

function hasHardBlockingStructure(room, pos) {
    var structures = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);

    for (var i = 0; i < structures.length; i++) {
        var structure = structures[i];

        if (
            structure.structureType === STRUCTURE_ROAD ||
            structure.structureType === STRUCTURE_CONTAINER ||
            structure.structureType === STRUCTURE_RAMPART
        ) {
            continue;
        }

        return true;
    }

    return false;
}

function hasAnyStructureExcept(room, pos, allowedType) {
    var structures = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);

    for (var i = 0; i < structures.length; i++) {
        if (allowedType && structures[i].structureType === allowedType) {
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

function isMineralTile(room, pos) {
    return room.lookForAt(LOOK_MINERALS, pos.x, pos.y).length > 0;
}

function isNearSource(room, pos) {
    var sources = room.find(FIND_SOURCES);

    for (var i = 0; i < sources.length; i++) {
        if (pos.getRangeTo(sources[i].pos) <= 1) {
            return true;
        }
    }

    return false;
}

function isNearController(room, pos) {
    return room.controller && pos.getRangeTo(room.controller.pos) <= 3;
}

function findBestAdjacentStructurePosition(room, center, target, reserved, structureType, extraFilter, options) {
    var best = null;

    for (var i = 0; i < AROUND_DIRS.length; i++) {
        var pos = makeRoomPositionSafe(center.x + AROUND_DIRS[i].x, center.y + AROUND_DIRS[i].y, room.name);
        if (!pos || isEdge(pos)) {
            continue;
        }

        if (extraFilter && !extraFilter(pos)) {
            continue;
        }

        if (!canPlanStructureAt(room, structureType, pos, options) || hasPlannedConflict(reserved, structureType, pos, options)) {
            continue;
        }

        var score = target ? pos.getRangeTo(target) * 10 : 0;
        score += room.getTerrain().get(pos.x, pos.y) === TERRAIN_MASK_SWAMP ? 4 : 0;
        score -= countOpenNeighbors(room, pos);

        if (!best || score < best.score) {
            best = {
                pos: pos,
                score: score
            };
        }
    }

    return best ? best.pos : null;
}

function findPlannedPositionNear(plan, structureType, center, range) {
    var positions = plan.positions[structureType] || [];
    var best = null;

    for (var i = 0; i < positions.length; i++) {
        var pos = makeRoomPositionSafe(positions[i].x, positions[i].y, positions[i].roomName || center.roomName);
        if (!pos || pos.getRangeTo(center) > range) {
            continue;
        }

        if (!best || pos.getRangeTo(center) < best.getRangeTo(center)) {
            best = pos;
        }
    }

    return best;
}

function getStorageLinkPosition(plan, fallback) {
    if (plan.links && plan.links.storage) {
        return makeRoomPositionSafe(plan.links.storage.x, plan.links.storage.y, plan.links.storage.roomName || fallback.roomName);
    }

    return fallback;
}

function countOpenNeighbors(room, pos) {
    var count = 0;

    for (var i = 0; i < AROUND_DIRS.length; i++) {
        var near = makeRoomPositionSafe(pos.x + AROUND_DIRS[i].x, pos.y + AROUND_DIRS[i].y, room.name);
        if (!near || isEdge(near)) {
            continue;
        }

        if (room.getTerrain().get(near.x, near.y) === TERRAIN_MASK_WALL) {
            continue;
        }

        if (hasNaturalObject(room, near, null)) {
            continue;
        }

        if (hasHardBlockingStructure(room, near)) {
            continue;
        }

        count++;
    }

    return count;
}

function findOpenTileNear(room, center, minRange, maxRange) {
    if (!room || !center) {
        return null;
    }

    var best = null;

    for (var range = minRange; range <= maxRange; range++) {
        for (var x = center.x - range; x <= center.x + range; x++) {
            for (var y = center.y - range; y <= center.y + range; y++) {
                if (Math.max(Math.abs(center.x - x), Math.abs(center.y - y)) !== range) {
                    continue;
                }

                var pos = makeRoomPositionSafe(x, y, room.name);
                if (!pos || !isValidAnchorTile(room, pos)) {
                    continue;
                }

                var score = pos.getRangeTo(center) * 10 - countOpenNeighbors(room, pos);
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

function samePlainPosition(plain, pos) {
    return plain &&
        pos &&
        plain.x === pos.x &&
        plain.y === pos.y &&
        (!plain.roomName || plain.roomName === pos.roomName);
}

function drawStructurePlannerVisuals(room) {
    var planner = ensureStructurePlannerMemory(room.name);
    var plan = planner.plan;

    if (!plan || !plan.byRcl) {
        return;
    }

    var siteCount = room.find(FIND_CONSTRUCTION_SITES).length;
    room.visual.text('StructurePlanner v' + STRUCTURE_PLANNER_VERSION + ' RCL ' + room.controller.level + ' sites ' + siteCount, 1, 1, {
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
