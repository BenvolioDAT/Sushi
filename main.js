var globalLoadCpuStart = typeof Game !== 'undefined' && Game.cpu &&
    typeof Game.cpu.getUsed === 'function' ? Game.cpu.getUsed() : null;
var TowerLogic = require('Logic.Tower');
var spawnManager = require('spawn.manager');
var spawnRequestManager = require('spawn.request.manager');
var trafficManager = require('traffic_manager');
var travelUtility = require('utility.Travel.Creep');
var scoreSeason = require('Season.Score');
var cpuStatusUtility = require('CPU.Status');
var tickCache = require('Tick.Cache');
var cpuProfiler = require('CPU.Profiler');

/* Optional planners, visuals, and role modules are loaded on first use. This
 * shortens resets for colonies that do not currently need every subsystem. */
var optionalModules = {};
var roleModules = {};
var globalResetTick = null;
var globalLoadRecorded = false;
var ROLE_MODULE_NAMES = {
    Foreman: 'role.Foreman',
    Extractor: 'role.Extractor',
    Tech: 'role.Tech',
    Freighter: 'role.Freighter',
    Annex: 'role.Annex',
    Artificer: 'role.Artificer',
    Pioneer: 'role.Pioneer',
    SupplyRunner: 'role.SupplyRunner',
    Scout: 'role.Scout',
    Ronin: 'role.Ronin',
    Volley: 'role.Volley',
    Cleric: 'role.Cleric',
    ScoreRunner: 'role.scorerunner'
};

function getOptionalModule(moduleName) {
    if (!optionalModules[moduleName]) {
        optionalModules[moduleName] = require(moduleName);
    }
    return optionalModules[moduleName];
}

function getRoleModule(role) {
    if (roleModules[role]) {
        return roleModules[role];
    }

    var moduleName = ROLE_MODULE_NAMES[role];
    if (!moduleName) {
        return null;
    }
    roleModules[role] = require(moduleName);
    return roleModules[role];
}

/*
 * Harabi-style traffic movement is initialized once when this global is loaded.
 * Role code should keep asking Sushi's travel utility to move. The travel
 * utility registers the intended step, and the end-of-tick traffic pass below
 * performs the actual creep.move calls for each room.
 */
trafficManager.init();

/*
 * Tiles at or above this cost are avoided when traffic manager needs to shuffle
 * idle creeps out of the way. Intentional pathing still comes from Traveler.
 */
var TRAFFIC_MANAGER_THRESHOLD = 20;

/*
 * Save damaged structures into room memory.
 *
 * Memory path:
 * Memory.rooms[room.name].RepairStructure
 *
 * Example:
 * Memory.rooms.W39S47.RepairStructure = [
 *     "abc123",
 *     "def456"
 * ];
 */
function updateRepairStructureMemory(room) {
    /*
     * Safety check.
     * If no room was passed in, stop.
     */
    if (!room) {
        return;
    }

    /*
     * Make sure Memory.rooms exists.
     */
    if (!Memory.rooms) {
        Memory.rooms = {};
    }

    /*
     * Make sure this room has a memory object.
     *
     * Example:
     * Memory.rooms["W39S47"]
     */
    if (!Memory.rooms[room.name]) {
        Memory.rooms[room.name] = {};
    }

    /*
     * Find all structures in the room that are damaged.
     *
     * A structure needs repair when:
     * structure.hits < structure.hitsMax
     */
    var roomStructures = tickCache.getRoomStructures(room);
    var damagedStructures = [];
    for (var structureIndex = 0; structureIndex < roomStructures.length; structureIndex++) {
        if (roomStructures[structureIndex].hits < roomStructures[structureIndex].hitsMax) {
            damagedStructures.push(roomStructures[structureIndex]);
        }
    }

    /*
     * Clear the old repair list.
     *
     * This is important because some structures may get repaired later.
     * We do not want old repaired structures staying in memory forever.
     */
    var newRepairList = [];

    /*
     * Save only the structure IDs into memory.
     *
     * We save IDs because Memory should store simple data:
     * strings, numbers, arrays, objects.
     *
     * Do not store the full structure object in Memory.
     */
    for (var i = 0; i < damagedStructures.length; i++) {
        newRepairList.push(damagedStructures[i].id);
    }

    var oldRepairList = Memory.rooms[room.name].RepairStructure;
    var changed = !oldRepairList || oldRepairList.length !== newRepairList.length;
    if (!changed) {
        for (var repairIndex = 0; repairIndex < newRepairList.length; repairIndex++) {
            if (oldRepairList[repairIndex] !== newRepairList[repairIndex]) {
                changed = true;
                break;
            }
        }
    }
    if (changed) {
        Memory.rooms[room.name].RepairStructure = newRepairList;
    }
}


function maybeGeneratePixel() {
    /*
     * Pixel generation is optional.
     *
     * enabled:
     * - false means Sushi will never generate pixels.
     * - true means Sushi may generate pixels when the bucket is healthy.
     *
     * bucketThreshold:
     * - Only generate pixels when Game.cpu.bucket is at or above this number.
     * - Higher numbers are safer because they leave more CPU saved for creeps.
     *
     * tickModulo:
     * - 100 means "only check every 100 ticks."
     * - Use 1 if you want to allow the check every tick.
     */
    var pixelCfg = {
        enabled: true,
        bucketThreshold: 9800,
        tickModulo: 10
    };

    if (!pixelCfg.enabled) {
        return;
    }

    /*
     * Some environments do not support pixel generation.
     */
    if (!Game.cpu || typeof Game.cpu.generatePixel !== 'function') {
        return;
    }

    /*
     * The sim shard is for simulation, not real pixel generation.
     */
    if (Game.shard && Game.shard.name === 'sim') {
        return;
    }

    /*
     * Some environments may not expose Game.cpu.bucket.
     */
    if (typeof Game.cpu.bucket !== 'number') {
        return;
    }

    if (Game.cpu.bucket < pixelCfg.bucketThreshold) {
        return;
    }

    if (pixelCfg.tickModulo > 1 && (Game.time % pixelCfg.tickModulo) !== 0) {
        return;
    }

    Game.cpu.generatePixel();
}

function ensureTrafficManagerSetting() {
    /*
     * Default traffic movement on, but keep the setting in Memory so it can be
     * disabled from the console without changing code:
     * Memory.settings.useTrafficManager = false
     */
    if (!Memory.settings) {
        Memory.settings = {};
    }

    if (Memory.settings.useTrafficManager === undefined) {
        Memory.settings.useTrafficManager = true;
    }
}

function isTrafficManagerEnabled() {
    ensureTrafficManagerSetting();
    return Memory.settings.useTrafficManager !== false;
}

function ensureWarRoomSetting() {
    /*
     * Automatic WarRoom scanning defaults off and can be enabled from the
     * console without changing code:
     * Memory.settings.useWarRoom = true
     */
    if (!Memory.settings) {
        Memory.settings = {};
    }

    if (Memory.settings.useWarRoom === undefined) {
        Memory.settings.useWarRoom = false;
    }
}

function isWarRoomEnabled() {
    ensureWarRoomSetting();
    return Memory.settings.useWarRoom === true;
}

function ensureStructurePlannerSetting() {
    /*
     * Structure planner visuals default off, but keep the setting in Memory so
     * it can be toggled from the console without first creating Memory.settings:
     * Memory.settings.showStructurePlanner = true
     */
    if (!Memory.settings) {
        Memory.settings = {};
    }

    if (Memory.settings.showStructurePlanner === undefined) {
        Memory.settings.showStructurePlanner = false;
    }
}

function ensurePerformanceSettings() {
    if (!Memory.settings) {
        Memory.settings = {};
    }
    if (Memory.settings.showSourceMapFlags === undefined) {
        Memory.settings.showSourceMapFlags = false;
    }
    if (typeof Memory.settings.sourceMapFlagInterval !== 'number') {
        Memory.settings.sourceMapFlagInterval = 5;
    }
    if (Memory.settings.enableCpuProfiling === undefined) {
        Memory.settings.enableCpuProfiling = false;
    }
}

function getStableRoomOffset(roomName, interval) {
    var hash = 0;
    roomName = roomName || '';
    for (var i = 0; i < roomName.length; i++) {
        hash = ((hash * 31) + roomName.charCodeAt(i)) & 2147483647;
    }
    return interval > 0 ? hash % interval : 0;
}

function shouldRunForRoom(roomName, interval) {
    interval = Math.max(1, Math.floor(interval || 1));
    return (Game.time + getStableRoomOffset(roomName, interval)) % interval === 0;
}

function isResetWarmup(delayTicks) {
    if (globalResetTick === null) {
        return true;
    }
    return Game.time - globalResetTick < delayTicks;
}

function getStartupState() {
    return {
        resetTick: globalResetTick,
        currentTick: typeof Game !== 'undefined' ? Game.time : null,
        warmup: globalResetTick === null ? true : isResetWarmup(2),
        loadedOptionalModules: Object.keys(optionalModules),
        loadedRoleModules: Object.keys(roleModules),
        tickCache: tickCache.getDebugStats()
    };
}

function runTrafficManagerForVisibleRooms() {
    if (!isTrafficManagerEnabled()) {
        return;
    }

    /*
     * This is intentionally at the end of the tick:
     * - roles/tasks decide where creeps want to move
     * - utility.Travel.Creep registers those intended steps
     * - traffic manager resolves the room together
     * - traffic manager performs the real creep.move(direction) calls
     */
    var visibleRooms = tickCache.getVisibleRooms();
    for (var roomIndex = 0; roomIndex < visibleRooms.length; roomIndex++) {
        var room = visibleRooms[roomIndex];
        var roomCreeps = tickCache.getMyCreepsInRoom(room);

        /* An empty room has no movement conflicts to solve. Avoid allocating a
         * CostMatrix solely because remote vision happens to be present. */
        if (roomCreeps.length === 0) {
            continue;
        }

        var costs = buildTrafficCostMatrix(room);

        trafficManager.run(room, costs, TRAFFIC_MANAGER_THRESHOLD, roomCreeps);
    }
}

function buildTrafficCostMatrix(room) {
    /*
     * Sushi does not have a separate Harabi-style pathUtils matrix. This small
     * matrix is only for traffic-manager idle shuffling, so keep it cheap:
     * roads are preferred, containers are passable, hard obstacles are blocked.
     */
    var costs = new PathFinder.CostMatrix();
    var structures = tickCache.getRoomStructures(room);

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

        if (isTrafficBlockedStructure(structure)) {
            costs.set(structure.pos.x, structure.pos.y, 255);
        }
    }

    var sites = tickCache.getRoomConstructionSites(room);

    for (var j = 0; j < sites.length; j++) {
        var site = sites[j];

        if (
            site.structureType === STRUCTURE_ROAD ||
            site.structureType === STRUCTURE_CONTAINER ||
            site.structureType === STRUCTURE_RAMPART
        ) {
            continue;
        }

        costs.set(site.pos.x, site.pos.y, 255);
    }

    return costs;
}

function isTrafficBlockedStructure(structure) {
    if (structure.structureType === STRUCTURE_ROAD) {
        return false;
    }

    if (structure.structureType === STRUCTURE_CONTAINER) {
        return false;
    }

    if (structure.structureType === STRUCTURE_RAMPART) {
        return !structure.my && !structure.isPublic;
    }

    return (
        typeof OBSTACLE_OBJECT_TYPES !== 'undefined' &&
        OBSTACLE_OBJECT_TYPES.indexOf(structure.structureType) !== -1
    );
}


/*
 * Screeps calls module.exports.loop once every game tick.
 * A "tick" is one step of the simulation: creeps move once, spawns work once,
 * construction progresses, and your JavaScript runs from top to bottom.
 */
module.exports.loop = function () {
    if (globalResetTick === null) {
        globalResetTick = Game.time;
    }

    ensurePerformanceSettings();
    ensureStructurePlannerSetting();
    tickCache.build();

    if (!globalLoadRecorded) {
        cpuProfiler.end('globalModuleLoad', globalLoadCpuStart);
        globalLoadRecorded = true;
    }

    var profileStart = cpuProfiler.start();
    travelUtility.cleanupRouteCaches();
    cpuProfiler.end('routeCacheCleanup', profileStart);

    profileStart = cpuProfiler.start();
    cpuStatusUtility.getCpuStatus();
    cpuProfiler.end('cpuStatus', profileStart);

    profileStart = cpuProfiler.start();
    scoreSeason.maintain();
    cpuProfiler.end('seasonScore', profileStart);
    if (!isResetWarmup(1)) {
        maybeGeneratePixel();
    }

    /* WarRoom is user-enabled and urgent, so it is not delayed after a reset. */
    if (isWarRoomEnabled()) {
        profileStart = cpuProfiler.start();
        getOptionalModule('Logic.WarRoom').run();
        cpuProfiler.end('warRoom', profileStart);
    }

    /* The first tick keeps defense, spawning, creep actions, and movement only. */
    if (!isResetWarmup(1)) {
        profileStart = cpuProfiler.start();
        getOptionalModule('Planner.Remote').run();
        cpuProfiler.end('remotePlanner', profileStart);

        profileStart = cpuProfiler.start();
        getOptionalModule('Planner.Brain').run();
        cpuProfiler.end('plannerBrain', profileStart);

        profileStart = cpuProfiler.start();
        getOptionalModule('Planner.Roads').run();
        cpuProfiler.end('plannerRoads', profileStart);
    }

    var ownedRooms = tickCache.getOwnedRooms();
    profileStart = cpuProfiler.start();
    for (var towerRoomIndex = 0; towerRoomIndex < ownedRooms.length; towerRoomIndex++) {
        TowerLogic.run(ownedRooms[towerRoomIndex]);
    }
    cpuProfiler.end('towerDefense', profileStart);

    /* Repair-list scans are stable-staggered instead of synchronized by tick. */
    if (!isResetWarmup(1)) {
        for (var repairRoomIndex = 0; repairRoomIndex < ownedRooms.length; repairRoomIndex++) {
            var repairRoom = ownedRooms[repairRoomIndex];
            if (shouldRunForRoom(repairRoom.name, 10)) {
                updateRepairStructureMemory(repairRoom);
            }
        }
    }

    if (
        !isResetWarmup(1) &&
        Memory.settings.showSourceMapFlags === true
    ) {
        var sourceVisual = getOptionalModule('utility.Visual');
        var sourceInterval = Math.max(1, Math.floor(
            Memory.settings.sourceMapFlagInterval || 1
        ));
        var visibleRooms = tickCache.getVisibleRooms();
        for (var sourceRoomIndex = 0; sourceRoomIndex < visibleRooms.length; sourceRoomIndex++) {
            if (shouldRunForRoom(visibleRooms[sourceRoomIndex].name, sourceInterval)) {
                sourceVisual.drawSourceFlags(visibleRooms[sourceRoomIndex].name);
            }
        }
    }

    if (!isResetWarmup(1)) {
        if (!Memory.creeps) {
            Memory.creeps = {};
        }
        for (var memoryCreepName in Memory.creeps) {
            if (!Game.creeps[memoryCreepName]) {
                delete Memory.creeps[memoryCreepName];
            }
        }
    }

    if (!isResetWarmup(1)) {
        getOptionalModule('Logic.Expansion').run();
    }

    profileStart = cpuProfiler.start();
    var requestReport = spawnRequestManager.run({
        emergencyOnly: isResetWarmup(1)
    });
    cpuProfiler.end('spawnPlanning', profileStart);

    if (requestReport && requestReport.rooms) {
        for (var spawnRoomName in requestReport.rooms) {
            if (requestReport.rooms.hasOwnProperty(spawnRoomName)) {
                spawnManager.runAllIdleSpawns(spawnRoomName);
            }
        }
    }

    profileStart = cpuProfiler.start();
    var creeps = tickCache.getAllCreeps();
    for (var creepIndex = 0; creepIndex < creeps.length; creepIndex++) {
        var creep = creeps[creepIndex];
        var role = creep && creep.memory ? creep.memory.role : null;
        var roleModule = getRoleModule(role);
        if (roleModule && typeof roleModule.run === 'function') {
            roleModule.run(creep);
        }
    }
    cpuProfiler.end('creepRoles', profileStart);

    if (!isResetWarmup(1)) {
        profileStart = cpuProfiler.start();
        var scoreRooms = tickCache.getVisibleRooms();
        for (var scoreRoomIndex = 0; scoreRoomIndex < scoreRooms.length; scoreRoomIndex++) {
            scoreSeason.reportVisibleRoom(scoreRooms[scoreRoomIndex], 'main', false);
        }
        cpuProfiler.end('seasonScore', profileStart);
    }

    profileStart = cpuProfiler.start();
    runTrafficManagerForVisibleRooms();
    cpuProfiler.end('trafficManager', profileStart);

    if (!isResetWarmup(1)) {
        profileStart = cpuProfiler.start();
        getOptionalModule('Visual.Planner.Structures').run();
        cpuProfiler.end('structurePlannerVisuals', profileStart);

        profileStart = cpuProfiler.start();
        getOptionalModule('Visual.Dashboard').run();
        cpuProfiler.end('dashboard', profileStart);
    }

    cpuStatusUtility.finalizeCpuStatus();
    cpuProfiler.flush();
};

module.exports.getStartupState = getStartupState;
