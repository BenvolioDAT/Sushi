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
var STRUCTURE_REPLAN_INTERVAL = 5000;
var STRUCTURE_BUILD_INTERVAL = 25;
var STRUCTURE_PLANNER_REPLAN_BUCKET = 5000;
var STRUCTURE_PLANNER_BUILD_BUCKET = 2000;
var STRUCTURE_PLANNER_CPU_BUDGET = 0.8;
var STRUCTURE_PLANNER_MAX_TILES_PER_TICK = 120;
var STRUCTURE_PLANNER_MAX_CANDIDATES = 250;
var CPU_BUFFER = 5;
var MAX_SITES_PER_RUN = 3;
var MAX_TOTAL_CONSTRUCTION_SITES = 90;

var structurePlannerRunCpuStart = 0;

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
    structurePlannerRunCpuStart = Game.cpu && typeof Game.cpu.getUsed === 'function' ?
        Game.cpu.getUsed() :
        0;

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

    if (planner.planJob && hasBucketForStructureReplan() && canContinueStructurePlanning()) {
        continuePlanJob(room, planner);
        planner = ensurePlannerMemory(room.name);
    }

    if (
        !planner.planJob &&
        shouldReplan(room, planner) &&
        hasBucketForStructureReplan() &&
        canContinueStructurePlanning()
    ) {
        startStructurePlanJob(room, planner);
        continuePlanJob(room, planner);
        planner = ensurePlannerMemory(room.name);
    }

    if (
        Game.time - (planner.lastBuilt || 0) >= STRUCTURE_BUILD_INTERVAL &&
        hasBucketForStructureBuild() &&
        canContinueStructurePlanning()
    ) {
        buildSites(room);
        planner.lastBuilt = Game.time;
    }

    planner = ensurePlannerMemory(room.name);
    planner.cpuDebug = {
        tick: Game.time,
        cpuUsed: Math.round(getStructurePlannerCpuUsed() * 100) / 100,
        bucket: Game.cpu && Game.cpu.bucket,
        hasJob: !!planner.planJob,
        phase: planner.planJob ? planner.planJob.phase : null,
        candidates: planner.planJob && planner.planJob.candidates ? planner.planJob.candidates.length : 0,
        lastPlanned: planner.lastPlanned || 0,
        lastBuilt: planner.lastBuilt || 0,
        lastPlanFailed: planner.lastPlanFailed || 0,
        lastPlanFailReason: planner.lastPlanFailReason || null
    };
}

function planRoom(room) {
    if (!room || !room.controller || !room.controller.my) {
        return null;
    }

    var planner = ensurePlannerMemory(room.name);

    if (planner.version !== STRUCTURE_PLANNER_VERSION) {
        resetRoom(room.name);
        planner = ensurePlannerMemory(room.name);
    }

    if (!planner.planJob && hasBucketForStructureReplan() && canContinueStructurePlanning()) {
        startStructurePlanJob(room, planner);
    }

    if (planner.planJob && hasBucketForStructureReplan() && canContinueStructurePlanning()) {
        continuePlanJob(room, planner);
    }

    return planner.plan || null;
}

function startStructurePlanJob(room, planner) {
    planner.planJob = {
        version: STRUCTURE_PLANNER_VERSION,
        roomName: room.name,
        started: Game.time,
        updated: Game.time,
        phase: 'init',
        rcl: room.controller.level || 0,
        draftPlan: makeEmptyPlan(),
        reserved: {},
        anchor: null,
        candidates: [],
        candidateScan: {
            range: 1,
            x: 0,
            y: 0,
            done: false,
            started: false
        },
        fill: null,
        failed: false,
        failReason: null
    };
}

function continuePlanJob(room, planner) {
    var job = planner.planJob;
    if (!job) {
        return planner.plan || null;
    }

    if (job.version !== STRUCTURE_PLANNER_VERSION || job.roomName !== room.name) {
        failPlanJob(planner, 'stale plan job');
        return planner.plan || null;
    }

    ensurePlanJobMemory(job);

    while (planner.planJob && canContinueStructurePlanning()) {
        job = planner.planJob;
        job.updated = Game.time;

        if (job.failed) {
            failPlanJob(planner, job.failReason || 'plan job failed');
            break;
        } else if (job.phase === 'init') {
            if (!runPlanJobInit(room, job)) {
                break;
            }
        } else if (job.phase === 'anchor') {
            if (!runPlanJobAnchor(room, planner, job)) {
                break;
            }
        } else if (job.phase === 'fixed') {
            if (!runPlanJobFixed(room, job)) {
                break;
            }
        } else if (job.phase === 'scanCandidates') {
            if (!runPlanJobCandidateScan(room, job)) {
                break;
            }
        } else if (job.phase === 'towers') {
            if (!runPlanJobFill(room, job, STRUCTURE_TOWER, 'extensions')) {
                break;
            }
        } else if (job.phase === 'extensions') {
            if (!runPlanJobFill(room, job, STRUCTURE_EXTENSION, 'labs')) {
                break;
            }
        } else if (job.phase === 'labs') {
            if (!runPlanJobLabs(room, job)) {
                break;
            }
        } else if (job.phase === 'singletons') {
            if (!runPlanJobSingletons(room, job)) {
                break;
            }
        } else if (job.phase === 'ramparts') {
            if (!runPlanJobRamparts(room, job)) {
                break;
            }
        } else if (job.phase === 'commit') {
            commitPlanJob(room, planner, job);
        } else {
            failPlanJob(planner, 'unknown phase');
        }

        if (planner.planJob && planner.planJob.failed) {
            failPlanJob(planner, planner.planJob.failReason || 'plan job failed');
            break;
        }
    }

    if (planner.planJob) {
        if (planner.planJob.failed) {
            failPlanJob(planner, planner.planJob.failReason || 'plan job failed');
            return planner.plan || null;
        }

        planner.planJob.updated = Game.time;
    }

    return planner.plan || null;
}

function ensurePlanJobMemory(job) {
    job.draftPlan = ensurePlanShape(job.draftPlan);
    job.reserved = job.reserved || {};
    job.candidates = job.candidates || [];
    job.candidateScan = job.candidateScan || {
        range: 1,
        x: 0,
        y: 0,
        done: false,
        started: false
    };

    if (job.rcl === undefined) {
        job.rcl = 0;
    }
}

function ensurePlanShape(plan) {
    var shaped = plan || makeEmptyPlan();

    if (!shaped.byRcl) {
        shaped.byRcl = makeEmptyByRcl();
    }
    if (!shaped.positions) {
        shaped.positions = makeEmptyPositions();
    }
    if (!shaped.links) {
        shaped.links = {
            storage: null,
            controller: null,
            sources: {}
        };
    }
    if (!shaped.containers) {
        shaped.containers = {
            controller: null,
            mineral: null,
            sources: {}
        };
    }

    return shaped;
}

function runPlanJobInit(room, job) {
    var spawns = getSortedOwnedSpawns(room);
    var index = job.initSpawnIndex || 0;

    job.existingSpawnCount = spawns.length;

    for (; index < spawns.length; index++) {
        if (!canContinueStructurePlanning()) {
            job.initSpawnIndex = index;
            return false;
        }

        recordExistingStructure(job.draftPlan, job.reserved, STRUCTURE_SPAWN, spawns[index].pos, 1);
    }

    delete job.initSpawnIndex;
    job.phase = 'anchor';
    return true;
}

function runPlanJobAnchor(room, planner, job) {
    var anchor = pickStorageAnchor(room, planner.plan, getSortedOwnedSpawns(room));
    if (!anchor) {
        planner.lastPlanFailed = Game.time;
        planner.lastPlanFailReason = 'no storage anchor';
        planner.forceReplan = false;
        delete planner.planJob;
        return false;
    }

    job.anchor = packCoord(anchor);
    job.draftPlan.anchor = plainPosition(anchor);
    addPlannedStructure(room, job.draftPlan, job.reserved, STRUCTURE_STORAGE, anchor, 4);
    job.fixedStep = 0;
    job.phase = 'fixed';
    return true;
}

function runPlanJobFixed(room, job) {
    var anchor = unpackCoord(job.anchor, room.name);
    if (!anchor) {
        job.failed = true;
        job.failReason = 'missing anchor';
        return false;
    }

    var step = job.fixedStep || 0;

    if (step <= 0) {
        if (!canContinueStructurePlanning()) {
            return false;
        }
        planSourceContainers(room, job.draftPlan, job.reserved, anchor);
        job.fixedStep = 1;
        step = 1;
    }

    if (step <= 1) {
        if (!canContinueStructurePlanning()) {
            return false;
        }
        planControllerContainer(room, job.draftPlan, job.reserved, anchor);
        job.fixedStep = 2;
        step = 2;
    }

    if (step <= 2) {
        if (!canContinueStructurePlanning()) {
            return false;
        }
        planMineral(room, job.draftPlan, job.reserved, anchor);
        job.fixedStep = 3;
        step = 3;
    }

    if (step <= 3) {
        if (!canContinueStructurePlanning()) {
            return false;
        }
        planStorageLink(room, job.draftPlan, job.reserved, anchor);
        planControllerLink(room, job.draftPlan, job.reserved, anchor);
        planSourceLinks(room, job.draftPlan, job.reserved, anchor);
        job.fixedStep = 4;
    }

    delete job.fixedStep;
    job.candidateScan = {
        range: 1,
        x: 0,
        y: 0,
        done: false,
        started: false
    };
    job.phase = 'scanCandidates';
    return true;
}

function runPlanJobCandidateScan(room, job) {
    if (!continueCandidateScan(room, job)) {
        return false;
    }

    if (job.failed) {
        return false;
    }

    sortPlanJobCandidates(job);
    beginFillJob(job, STRUCTURE_TOWER, 'extensions');
    job.phase = 'towers';
    return true;
}

function runPlanJobFill(room, job, structureType, nextPhase) {
    if (!job.fill) {
        beginFillJob(job, structureType, nextPhase);
    }

    if (!continueFillFromCandidates(room, job)) {
        return false;
    }

    job.phase = nextPhase;
    return true;
}

function runPlanJobLabs(room, job) {
    if (!continueLabsFromCandidates(room, job)) {
        return false;
    }

    job.phase = 'singletons';
    return true;
}

function runPlanJobSingletons(room, job) {
    if (!continueSingletonsFromCandidates(room, job)) {
        return false;
    }

    job.phase = 'ramparts';
    return true;
}

function runPlanJobRamparts(room, job) {
    if (!continueKeyRamparts(room, job)) {
        return false;
    }

    job.phase = 'commit';
    return true;
}

function commitPlanJob(room, planner, job) {
    planner.plan = ensurePlanShape(job.draftPlan);
    planner.lastPlanned = Game.time;
    planner.lastRcl = room.controller.level || 0;
    planner.forceReplan = false;
    planner.lastPlanFailed = 0;
    planner.lastPlanFailReason = null;
    planner.currentPhase = null;
    delete planner.planJob;
}

function failPlanJob(planner, reason) {
    planner.lastPlanFailed = Game.time;
    planner.lastPlanFailReason = reason;
    planner.forceReplan = false;
    delete planner.planJob;
}

function buildSites(room) {
    if (!room || !room.controller || !room.controller.my) {
        return 0;
    }

    if (!canContinueStructurePlanning() || !canBuildSites()) {
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
    var counts = getExistingAndSiteCounts(room);

    if (index >= entries.length) {
        index = 0;
    }

    while (checked < entries.length && built < MAX_SITES_PER_RUN) {
        if (!canContinueStructurePlanning() || !canBuildSites()) {
            planner.buildIndex = index;
            return built;
        }

        var entry = entries[index];
        index++;
        checked++;

        if (index >= entries.length) {
            index = 0;
        }

        var result = tryCreateSite(room, entry, counts);
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

    if (
        planner.lastPlanFailed &&
        planner.lastPlanFailReason === 'cpu budget' &&
        Game.time - planner.lastPlanFailed < STRUCTURE_REPLAN_INTERVAL
    ) {
        return false;
    }

    return Game.time - (planner.lastPlanned || 0) >= STRUCTURE_REPLAN_INTERVAL;
}

function canSpendCpu() {
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

function getStructurePlannerCpuUsed() {
    if (!Game.cpu || typeof Game.cpu.getUsed !== 'function') {
        return 0;
    }

    return Game.cpu.getUsed() - structurePlannerRunCpuStart;
}

function canContinueStructurePlanning() {
    if (!canSpendCpu()) {
        return false;
    }

    if (
        Game.cpu &&
        typeof Game.cpu.getUsed === 'function' &&
        getStructurePlannerCpuUsed() >= STRUCTURE_PLANNER_CPU_BUDGET
    ) {
        return false;
    }

    return true;
}

function hasBucketForStructureReplan() {
    if (!Game.cpu || Game.cpu.bucket === undefined) {
        return true;
    }

    return Game.cpu.bucket >= STRUCTURE_PLANNER_REPLAN_BUCKET;
}

function hasBucketForStructureBuild() {
    if (!Game.cpu || Game.cpu.bucket === undefined) {
        return true;
    }

    return Game.cpu.bucket >= STRUCTURE_PLANNER_BUILD_BUCKET;
}

function canBuildSites() {
    if (!canSpendCpu()) {
        return false;
    }

    if (!hasBucketForStructureBuild()) {
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
        if (!canContinueStructurePlanning()) {
            return candidates;
        }

        for (var x = anchor.x - range; x <= anchor.x + range; x++) {
            if (!canContinueStructurePlanning()) {
                return candidates;
            }

            for (var y = anchor.y - range; y <= anchor.y + range; y++) {
                if (!canContinueStructurePlanning()) {
                    return candidates;
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

function continueCandidateScan(room, job) {
    var anchor = unpackCoord(job.anchor, room.name);
    if (!anchor) {
        job.failed = true;
        job.failReason = 'missing anchor';
        return true;
    }

    var scan = job.candidateScan || {
        range: 1,
        x: 0,
        y: 0,
        done: false,
        started: false
    };
    var processed = 0;
    var maxRange = 46;

    while (scan.range <= maxRange && job.candidates.length < STRUCTURE_PLANNER_MAX_CANDIDATES) {
        if (!scan.started) {
            scan.x = anchor.x - scan.range;
            scan.y = anchor.y - scan.range;
            scan.started = true;
        }

        var endX = anchor.x + scan.range;
        var endY = anchor.y + scan.range;

        while (scan.x <= endX) {
            while (scan.y <= endY) {
                if (processed >= STRUCTURE_PLANNER_MAX_TILES_PER_TICK || !canContinueStructurePlanning()) {
                    job.candidateScan = scan;
                    return false;
                }

                var x = scan.x;
                var y = scan.y;
                scan.y++;
                processed++;

                if (Math.max(Math.abs(anchor.x - x), Math.abs(anchor.y - y)) !== scan.range) {
                    continue;
                }

                var pos = makeRoomPositionSafe(x, y, room.name);
                if (!pos) {
                    continue;
                }

                if (!isOpenBuildPosition(room, pos, job.reserved)) {
                    continue;
                }

                addPlanJobCandidate(room, job, pos, anchor);
                if (job.candidates.length >= STRUCTURE_PLANNER_MAX_CANDIDATES) {
                    scan.done = true;
                    job.candidateScan = scan;
                    return true;
                }
            }

            scan.x++;
            scan.y = anchor.y - scan.range;
        }

        scan.range++;
        scan.started = false;
    }

    scan.done = true;
    job.candidateScan = scan;
    return true;
}

function addPlanJobCandidate(room, job, pos, anchor) {
    var packed = packCoord(pos);
    var candidates = job.candidates || [];

    for (var i = 0; i < candidates.length; i++) {
        if (getCandidatePacked(candidates[i]) === packed) {
            return;
        }
    }

    candidates.push({
        p: packed,
        s: scoreBuildPosition(room, pos, anchor)
    });

    if (candidates.length > STRUCTURE_PLANNER_MAX_CANDIDATES) {
        candidates.sort(comparePackedCandidates);
        candidates.length = STRUCTURE_PLANNER_MAX_CANDIDATES;
    }

    job.candidates = candidates;
}

function sortPlanJobCandidates(job) {
    job.candidates = job.candidates || [];
    job.candidates.sort(comparePackedCandidates);

    if (job.candidates.length > STRUCTURE_PLANNER_MAX_CANDIDATES) {
        job.candidates.length = STRUCTURE_PLANNER_MAX_CANDIDATES;
    }
}

function comparePackedCandidates(a, b) {
    var aScore = 0;
    var bScore = 0;

    if (a) {
        aScore = a.s !== undefined ? a.s : a.score || 0;
    }
    if (b) {
        bScore = b.s !== undefined ? b.s : b.score || 0;
    }

    if (aScore !== bScore) {
        return aScore - bScore;
    }

    return (getCandidatePacked(a) || 0) - (getCandidatePacked(b) || 0);
}

function getCandidatePacked(candidate) {
    if (candidate && candidate.p !== undefined) {
        return candidate.p;
    }

    if (typeof candidate === 'number') {
        return candidate;
    }

    if (candidate && candidate.pos) {
        return packCoord(candidate.pos);
    }

    return null;
}

function getCandidatePosition(candidate, roomName) {
    if (candidate && candidate.pos) {
        return candidate.pos;
    }

    var packed = getCandidatePacked(candidate);
    if (packed === null) {
        return null;
    }

    return unpackCoord(packed, roomName);
}

function beginFillJob(job, structureType, nextPhase) {
    job.fill = {
        structureType: structureType,
        candidateIndex: 0,
        nextPhase: nextPhase
    };
}

function continueFillFromCandidates(room, job) {
    if (!job || !job.fill) {
        return true;
    }

    var plan = job.draftPlan;
    var reserved = job.reserved;
    var structureType = job.fill.structureType;
    var finalAllowed = getAllowedAtRcl(structureType, 8);
    var candidates = job.candidates || [];
    var i = job.fill.candidateIndex || 0;

    while (
        i < candidates.length &&
        getPlannedCount(plan, structureType) < finalAllowed
    ) {
        if (!canContinueStructurePlanning()) {
            job.fill.candidateIndex = i;
            return false;
        }

        var candidate = candidates[i];
        i++;

        var pos = getCandidatePosition(candidate, room.name);
        if (!pos) {
            continue;
        }

        var ordinal = getPlannedCount(plan, structureType) + 1;
        var rcl = getFirstRclForOrdinal(structureType, ordinal);

        addPlannedStructure(room, plan, reserved, structureType, pos, rcl);
    }

    job.fill = null;
    return true;
}

function continueLabsFromCandidates(room, job) {
    var maxLabs = Math.min(3, getAllowedAtRcl(STRUCTURE_LAB, 8));
    var candidates = job.candidates || [];
    var i = job.labCandidateIndex || 0;

    while (i < candidates.length && getPlannedCount(job.draftPlan, STRUCTURE_LAB) < maxLabs) {
        if (!canContinueStructurePlanning()) {
            job.labCandidateIndex = i;
            return false;
        }

        var pos = getCandidatePosition(candidates[i], room.name);
        i++;

        if (!pos) {
            continue;
        }

        var ordinal = getPlannedCount(job.draftPlan, STRUCTURE_LAB) + 1;
        var rcl = getFirstRclForOrdinal(STRUCTURE_LAB, ordinal);

        addPlannedStructure(room, job.draftPlan, job.reserved, STRUCTURE_LAB, pos, rcl);
    }

    delete job.labCandidateIndex;
    return true;
}

function continueSingletonsFromCandidates(room, job) {
    var singletons = [
        { type: STRUCTURE_TERMINAL, rcl: 6 },
        { type: STRUCTURE_FACTORY, rcl: 7 },
        { type: STRUCTURE_OBSERVER, rcl: 8 },
        { type: STRUCTURE_POWER_SPAWN, rcl: 8 },
        { type: STRUCTURE_NUKER, rcl: 8 }
    ];
    var step = job.singletonStep || 0;
    var candidateIndex = job.singletonCandidateIndex || 0;
    var candidates = job.candidates || [];

    while (step < singletons.length) {
        var target = singletons[step];

        if (getAllowedAtRcl(target.type, 8) <= 0 || getPlannedCount(job.draftPlan, target.type) > 0) {
            step++;
            candidateIndex = 0;
            continue;
        }

        while (candidateIndex < candidates.length) {
            if (!canContinueStructurePlanning()) {
                job.singletonStep = step;
                job.singletonCandidateIndex = candidateIndex;
                return false;
            }

            var pos = getCandidatePosition(candidates[candidateIndex], room.name);
            candidateIndex++;

            if (pos && addPlannedStructure(room, job.draftPlan, job.reserved, target.type, pos, target.rcl)) {
                step++;
                candidateIndex = 0;
                break;
            }
        }

        if (candidateIndex >= candidates.length) {
            step++;
            candidateIndex = 0;
        }
    }

    job.singletonStep = step;
    job.singletonCandidateIndex = candidateIndex;

    if (!continueExtraSpawnsFromCandidates(room, job)) {
        return false;
    }

    delete job.singletonStep;
    delete job.singletonCandidateIndex;
    return true;
}

function continueExtraSpawnsFromCandidates(room, job) {
    if (job.extraSpawnsDone) {
        return true;
    }

    var finalAllowed = getAllowedAtRcl(STRUCTURE_SPAWN, 8);
    var candidates = job.candidates || [];
    var i = job.extraSpawnCandidateIndex || 0;
    var existingSpawnCount = job.existingSpawnCount || 0;

    while (getPlannedCount(job.draftPlan, STRUCTURE_SPAWN) < finalAllowed) {
        var ordinal = getPlannedCount(job.draftPlan, STRUCTURE_SPAWN) + 1;
        var rcl = getFirstRclForOrdinal(STRUCTURE_SPAWN, ordinal);

        if (rcl < 7 || ordinal <= existingSpawnCount) {
            job.extraSpawnsDone = true;
            delete job.extraSpawnCandidateIndex;
            return true;
        }

        if (i >= candidates.length) {
            job.extraSpawnsDone = true;
            delete job.extraSpawnCandidateIndex;
            return true;
        }

        if (!canContinueStructurePlanning()) {
            job.extraSpawnCandidateIndex = i;
            return false;
        }

        var pos = getCandidatePosition(candidates[i], room.name);
        i++;

        if (pos) {
            addPlannedStructure(room, job.draftPlan, job.reserved, STRUCTURE_SPAWN, pos, rcl);
        }
    }

    job.extraSpawnsDone = true;
    delete job.extraSpawnCandidateIndex;
    return true;
}

function continueKeyRamparts(room, job) {
    var targetIndex = job.rampartTargetIndex || 0;
    var positionIndex = job.rampartPositionIndex || 0;

    while (targetIndex < RAMPART_TARGETS.length) {
        var structureType = RAMPART_TARGETS[targetIndex];
        var positions = job.draftPlan.positions[structureType] || [];

        while (positionIndex < positions.length) {
            if (!canContinueStructurePlanning()) {
                job.rampartTargetIndex = targetIndex;
                job.rampartPositionIndex = positionIndex;
                return false;
            }

            var plain = positions[positionIndex];
            positionIndex++;

            var pos = makeRoomPositionSafe(plain.x, plain.y, plain.roomName || room.name);
            addPlannedStructure(room, job.draftPlan, job.reserved, STRUCTURE_RAMPART, pos, 5);
        }

        targetIndex++;
        positionIndex = 0;
    }

    delete job.rampartTargetIndex;
    delete job.rampartPositionIndex;
    return true;
}

function planSingleNearAnchor(room, plan, reserved, candidates, structureType, rcl) {
    if (getAllowedAtRcl(structureType, 8) <= 0 || getPlannedCount(plan, structureType) > 0) {
        return;
    }

    for (var i = 0; i < candidates.length; i++) {
        if (!canContinueStructurePlanning()) {
            return;
        }

        var pos = getCandidatePosition(candidates[i], room.name);

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
        if (!canContinueStructurePlanning()) {
            return;
        }

        var ordinal = getPlannedCount(plan, STRUCTURE_LAB) + 1;
        var rcl = getFirstRclForOrdinal(STRUCTURE_LAB, ordinal);

        var pos = getCandidatePosition(candidates[i], room.name);
        addPlannedStructure(room, plan, reserved, STRUCTURE_LAB, pos, rcl);
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

    for (var i = 0; i < candidates.length && getPlannedCount(plan, STRUCTURE_SPAWN) < finalAllowed; i++) {
        if (!canContinueStructurePlanning()) {
            return;
        }

        var ordinal = getPlannedCount(plan, STRUCTURE_SPAWN) + 1;
        var rcl = getFirstRclForOrdinal(STRUCTURE_SPAWN, ordinal);

        if (rcl < 7 || ordinal <= existingSpawnCount) {
            /*
             * The first spawn already exists and is not created by this planner.
             * Extra spawns begin at the RCL allowed by CONTROLLER_STRUCTURES.
             */
            break;
        }

        var pos = getCandidatePosition(candidates[i], room.name);
        if (pos) {
            addPlannedStructure(room, plan, reserved, STRUCTURE_SPAWN, pos, rcl);
        }
    }
}

function fillFromCandidates(room, plan, reserved, candidates, structureType) {
    var finalAllowed = getAllowedAtRcl(structureType, 8);

    for (
        var i = 0;
        i < candidates.length && getPlannedCount(plan, structureType) < finalAllowed;
        i++
    ) {
        if (!canContinueStructurePlanning()) {
            return;
        }

        var ordinal = getPlannedCount(plan, structureType) + 1;
        var rcl = getFirstRclForOrdinal(structureType, ordinal);

        var pos = getCandidatePosition(candidates[i], room.name);
        addPlannedStructure(room, plan, reserved, structureType, pos, rcl);
    }
}

function addFirstCandidate(room, plan, reserved, candidates, structureType, rcl) {
    for (var i = 0; i < candidates.length; i++) {
        if (!canContinueStructurePlanning()) {
            return false;
        }

        var pos = getCandidatePosition(candidates[i], room.name);
        if (addPlannedStructure(room, plan, reserved, structureType, pos, rcl)) {
            return true;
        }
    }

    return false;
}

function planKeyRamparts(room, plan, reserved) {
    for (var t = 0; t < RAMPART_TARGETS.length; t++) {
        if (!canContinueStructurePlanning()) {
            return;
        }

        var structureType = RAMPART_TARGETS[t];
        var positions = plan.positions[structureType] || [];

        for (var i = 0; i < positions.length; i++) {
            if (!canContinueStructurePlanning()) {
                return;
            }

            var pos = makeRoomPositionSafe(positions[i].x, positions[i].y, positions[i].roomName || room.name);
            addPlannedStructure(room, plan, reserved, STRUCTURE_RAMPART, pos, 5);
        }
    }
}

function getBuildEntries(room, plan) {
    var entries = [];
    var currentRcl = room.controller ? room.controller.level || 0 : 0;

    for (var rcl = 1; rcl <= currentRcl; rcl++) {
        if (!canContinueStructurePlanning()) {
            return entries;
        }

        var rclEntries = plan.byRcl[rcl] || [];

        for (var p = 0; p < BUILD_PRIORITY.length; p++) {
            if (!canContinueStructurePlanning()) {
                return entries;
            }

            var priorityType = BUILD_PRIORITY[p];

            for (var i = 0; i < rclEntries.length; i++) {
                if (!canContinueStructurePlanning()) {
                    return entries;
                }

                var entry = rclEntries[i];
                if ((entry.type || entry.structureType) === priorityType) {
                    entries.push(entry);
                }
            }
        }
    }

    return entries;
}

function tryCreateSite(room, entry, counts) {
    var structureType = entry.type || entry.structureType;
    var pos = makeRoomPositionSafe(entry.x, entry.y, entry.roomName || room.name);

    if (!pos || pos.roomName !== room.name) {
        return ERR_INVALID_TARGET;
    }

    if (!canCreateSite(room, pos, structureType, counts)) {
        return ERR_INVALID_TARGET;
    }

    var spawnCount = counts && counts[STRUCTURE_SPAWN] !== undefined ?
        counts[STRUCTURE_SPAWN] :
        countExistingAndSites(room, STRUCTURE_SPAWN);
    var name = structureType === STRUCTURE_SPAWN ?
        'Sushi-' + room.name + '-' + (spawnCount + 1) :
        undefined;

    var result = name ?
        room.createConstructionSite(pos.x, pos.y, structureType, name) :
        room.createConstructionSite(pos.x, pos.y, structureType);

    if (result === OK && counts) {
        counts[structureType] = (counts[structureType] || 0) + 1;
    }

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

function canCreateSite(room, pos, structureType, counts) {
    if (getTotalConstructionSites() >= MAX_TOTAL_CONSTRUCTION_SITES) {
        return false;
    }

    var allowed = getAllowedAtRcl(structureType, room.controller ? room.controller.level || 0 : 0);
    if (allowed <= 0) {
        return false;
    }

    var existingCount = counts && counts[structureType] !== undefined ?
        counts[structureType] :
        countExistingAndSites(room, structureType);

    if (existingCount >= allowed) {
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

function getExistingAndSiteCounts(room) {
    var counts = {};
    var structures = room.find(FIND_STRUCTURES);

    for (var i = 0; i < structures.length; i++) {
        var structureType = structures[i].structureType;
        counts[structureType] = (counts[structureType] || 0) + 1;
    }

    var sites = room.find(FIND_CONSTRUCTION_SITES);
    for (var j = 0; j < sites.length; j++) {
        if (sites[j].my === false) {
            continue;
        }

        counts[sites[j].structureType] = (counts[sites[j].structureType] || 0) + 1;
    }

    return counts;
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

module.exports = {
    run: run,
    runRoom: runRoom,
    planRoom: planRoom,
    buildSites: buildSites,
    resetRoom: resetRoom,
    packCoord: packCoord,
    unpackCoord: unpackCoord
};
