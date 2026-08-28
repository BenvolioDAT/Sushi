/*
 * spawn.request.manager.js
 *
 * This file decides what creeps the room should request.
 *
 * It does not directly spawn creeps.
 * It asks spawn.manager.js to queue the creeps.
 *
 * Current setup:
 * - Loops every visible owned room that has at least one owned spawn.
 * - Rooms without an owned spawn are not managed as mature spawn rooms yet.
 */

var spawnManager = require('spawn.manager');
var creepBodyConfig = require('role.creepBodyConfig');
var RemotePlanner = require('Planner.Remote');
var creepUtility = require('utility.Creep');
var cpuStatusUtility = require('CPU.Status');
var Season11 = require('Logic.Season11');
var TickIndex = require('HiveMind.Index');
var defenseDemand = require('Defense.Demand');
var DemandBoard = require('Spawn.DemandBoard');
var SquadController = require('Squad.Controller');

var RESERVE_DESIRED_TICKS = 4000;
var RESERVE_SPAWN_AT_TICKS = 2500;
var ANNEX_LIVING_MIN_TTL = 100;
var TECH_DOWNGRADE_DANGER_TICKS = 5000;
var TECH_BASE_MAX_DESIRED_WORK = 24;
var TECH_MAX_DESIRED_WORK = 36;
var TECH_RCL8_MAX_WORK = 15;
var TECH_ABSOLUTE_CREEP_CAP = 5;
var ARTIFICER_MAX_DESIRED_WORK = 24;
var ARTIFICER_LOW_STORAGE_ENERGY = 20000;
var ARTIFICER_CRITICAL_STORAGE_ENERGY = 5000;
var ARTIFICER_HEALTHY_STORAGE_ENERGY = 50000;
var REMOTE_CONTAINER_REPAIR_START_PERCENT = 0.80;
var REMOTE_ROAD_REPAIR_START_PERCENT = 0.60;

var DEFAULT_CPU_POLICY = {
    spawnPlanningCpuBudget: 1.5,
    roomPlanningInterval: 3,
    remotePlanningInterval: 10,
    constructionDemandInterval: 10,
    repairDemandInterval: 25
};

var DEFAULT_SPAWN_POLICY = {
    enabled: true,
    maxQueueLengthPerRoom: 8,
    maxNewRequestsPerRoomPerTick: 2,
    roleCaps: {
        Foreman: 1,
        Scout: 1,
        Annex: 4,
        Ronin: 4,
        Volley: 4,
        Cleric: 3,
        Tech: 3,
        Artificer: 3,
        Extractor: 6,
        Freighter: 6,
        Pioneer: 2,
        SupplyRunner: 2,
        ThoriumMiner: 2,
        ThoriumHauler: 4,
        ReactorClaimer: 1
    },
    maxCreepsPerRoomByRcl: {
        RCL1: 10,
        RCL2: 16,
        RCL3: 20,
        RCL4: 26,
        RCL5: 30,
        RCL6: 36,
        RCL7: 40,
        RCL8: 46
    }
};

var activePlanningContext = null;

/*
 * How many creeps we want for now.
 *
 * Later, room.manager.js can calculate these numbers dynamically.
 */
var DESIRED_COUNTS = {
    Foreman: 1,
    /*
     * Annex uses this as a maximum cap, not a fixed desired count. It only
     * spawns when an active remote room needs controller reservation help.
     */
    Annex: 6,
    Scout: 1,
    Ronin: 0,
    Volley: 0,
    Cleric: 0
};

/*
 * Higher number = more important.
 *
 * Foreman is highest because you said Foreman should always be alive.
 * These priorities are saved onto spawn queue requests. spawn.manager.js sorts
 * the queue so higher priority requests are attempted first.
 */
var PRIORITY = {
    Foreman: 100,
    Extractor: 80,
    Freighter: 60,
    Annex: 8,
    Tech: 30,
    Artificer: 20,
    Pioneer: 55,
    SupplyRunner: 54,
    Scout: 10,
    Ronin: 85,
    Volley: 86,
    Cleric: 84,
    ThoriumMiner: 35,
    ThoriumHauler: 42,
    ReactorClaimer: 38,
    MineralMiner: 32,
    ResourceCourier: 48
};

/*
 * Extra safety ticks.
 *
 * The spawn time only covers time inside the spawn.
 * This buffer gives the new creep a little time to move into position.
 */
var REPLACEMENT_BUFFER_TICKS = {
    Foreman: 30,
    Extractor: 30,
    Freighter: 40,
    Annex: 80,
    Tech: 40,
    Artificer: 40,
    Pioneer: 60,
    SupplyRunner: 80,
    Scout: 10,
    Ronin: 40,
    Volley: 40,
    Cleric: 40,
    MineralMiner: 75,
    ResourceCourier: 60,
    ThoriumMiner: 120,
    ThoriumHauler: 180,
    ReactorClaimer: 180
};

/*
 * This manager is the "demand planner" for spawning.
 *
 * It deliberately does not call spawn.spawnCreep directly. Instead, it writes
 * requests into Memory.rooms[roomName].spawnQueue and lets spawn.manager.js be
 * the single place that actually consumes the queue. Keeping demand planning
 * separate from spawning makes it easier to reason about duplicate requests.
 */

function roomHasOwnedSpawn(room) {
    if (!room) {
        return false;
    }

    for (var spawnName in Game.spawns) {
        if (!Game.spawns.hasOwnProperty(spawnName)) {
            continue;
        }

        var spawn = Game.spawns[spawnName];

        if (!spawn || !spawn.room) {
            continue;
        }

        if (spawn.my === false) {
            continue;
        }

        if (spawn.room.name === room.name) {
            return true;
        }
    }

    return false;
}

/**
 * Get every visible owned room that has at least one owned spawn.
 *
 * This intentionally excludes owned rooms without spawns so expansion/bootstrap
 * code can be added later without treating those rooms as normal mature rooms.
 *
 * @returns {Room[]}
 */
function getOwnedSpawnRooms() {
    return TickIndex.get().ownedSpawnRooms.slice();
}

/**
 * Calculate how soon we should request a replacement.
 *
 * Spawn time is body parts * 3 ticks.
 * Then we add a small buffer for walking / delay.
 *
 * Example:
 * body length 5 = 15 spawn ticks
 * buffer 30
 * replacement lead = 45 ticks
 *
 * @param {string} role
 * @param {array} body
 * @returns {number}
 */
function getReplacementLeadTicks(role, body) {
    /*
     * In Screeps, spawning takes 3 ticks per body part. A larger body needs to
     * be requested earlier so the replacement finishes before the old creep dies.
     */
    var bodyPartCount = body ? body.length : 0;
    var spawnTime = bodyPartCount * 3;
    var buffer = REPLACEMENT_BUFFER_TICKS[role] || 30;

    return spawnTime + buffer;
}

function ensureNumberSetting(target, key, defaultValue) {
    if (typeof target[key] !== 'number') {
        target[key] = defaultValue;
    }
}

function ensureCpuPolicyMemory() {
    if (!Memory.cpuPolicy) {
        Memory.cpuPolicy = {};
    }

    for (var key in DEFAULT_CPU_POLICY) {
        if (DEFAULT_CPU_POLICY.hasOwnProperty(key)) {
            ensureNumberSetting(Memory.cpuPolicy, key, DEFAULT_CPU_POLICY[key]);
        }
    }

    return Memory.cpuPolicy;
}

function ensureUpgradeSettings() {
    if (!Memory.settings) {
        Memory.settings = {};
    }

    if (Memory.settings.autoCpuUpgradeBoost === undefined) {
        Memory.settings.autoCpuUpgradeBoost = true;
    }
    if (typeof Memory.settings.cpuUpgradeBoostMaximum !== 'number') {
        Memory.settings.cpuUpgradeBoostMaximum = 1.75;
    }
    if (typeof Memory.settings.cpuUpgradeMinimumBucket !== 'number') {
        Memory.settings.cpuUpgradeMinimumBucket = 7000;
    }
    if (typeof Memory.settings.cpuUpgradeMinimumStorage !== 'number') {
        Memory.settings.cpuUpgradeMinimumStorage = 50000;
    }

    return Memory.settings;
}

function ensureSpawnPolicyMemory() {
    if (!Memory.spawnPolicy) {
        Memory.spawnPolicy = {};
    }

    var policy = Memory.spawnPolicy;

    if (policy.enabled === undefined) {
        policy.enabled = DEFAULT_SPAWN_POLICY.enabled;
    }

    ensureNumberSetting(
        policy,
        'maxQueueLengthPerRoom',
        DEFAULT_SPAWN_POLICY.maxQueueLengthPerRoom
    );
    ensureNumberSetting(
        policy,
        'maxNewRequestsPerRoomPerTick',
        DEFAULT_SPAWN_POLICY.maxNewRequestsPerRoomPerTick
    );

    if (!policy.roleCaps) {
        policy.roleCaps = {};
    }

    for (var role in DEFAULT_SPAWN_POLICY.roleCaps) {
        if (
            DEFAULT_SPAWN_POLICY.roleCaps.hasOwnProperty(role) &&
            typeof policy.roleCaps[role] !== 'number'
        ) {
            policy.roleCaps[role] = DEFAULT_SPAWN_POLICY.roleCaps[role];
        }
    }

    if (!policy.maxCreepsPerRoomByRcl) {
        policy.maxCreepsPerRoomByRcl = {};
    }

    for (var rclKey in DEFAULT_SPAWN_POLICY.maxCreepsPerRoomByRcl) {
        if (
            DEFAULT_SPAWN_POLICY.maxCreepsPerRoomByRcl.hasOwnProperty(rclKey) &&
            typeof policy.maxCreepsPerRoomByRcl[rclKey] !== 'number'
        ) {
            policy.maxCreepsPerRoomByRcl[rclKey] =
                DEFAULT_SPAWN_POLICY.maxCreepsPerRoomByRcl[rclKey];
        }
    }

    return policy;
}

function ensureRoomMemory(roomName) {
    if (!Memory.rooms) {
        Memory.rooms = {};
    }

    if (!Memory.rooms[roomName]) {
        Memory.rooms[roomName] = {};
    }

    return Memory.rooms[roomName];
}

function getSpawnDemandCache(roomName) {
    var roomMemory = ensureRoomMemory(roomName);

    if (!roomMemory.spawnDemandCache) {
        roomMemory.spawnDemandCache = {};
    }

    return roomMemory.spawnDemandCache;
}

function getCpuUsed() {
    if (!Game.cpu || typeof Game.cpu.getUsed !== 'function') {
        return 0;
    }

    return Game.cpu.getUsed();
}

function getPositiveInterval(value, fallback) {
    if (typeof value !== 'number' || value < 1) {
        return fallback;
    }

    return Math.max(1, Math.floor(value));
}

function getNextStaggeredFullPlanTick(startTick, interval, roomIndex) {
    if (interval <= 1) {
        return startTick;
    }

    var offset = (interval - ((startTick + roomIndex) % interval)) % interval;
    return startTick + offset;
}

function shouldRunFullPlan(cache, cpuPolicy, roomIndex, skipNormalPlanning) {
    if (skipNormalPlanning) {
        return false;
    }

    var interval = getPositiveInterval(
        cpuPolicy.roomPlanningInterval,
        DEFAULT_CPU_POLICY.roomPlanningInterval
    );

    if (interval <= 1) {
        return true;
    }

    if (typeof cache.nextFullPlanTick !== 'number') {
        cache.nextFullPlanTick = getNextStaggeredFullPlanTick(
            Game.time,
            interval,
            roomIndex
        );
    }

    return Game.time >= cache.nextFullPlanTick;
}

function setNextFullPlanTick(cache, cpuPolicy, roomIndex) {
    var interval = getPositiveInterval(
        cpuPolicy.roomPlanningInterval,
        DEFAULT_CPU_POLICY.roomPlanningInterval
    );

    cache.nextFullPlanTick = getNextStaggeredFullPlanTick(
        Game.time + 1,
        interval,
        roomIndex
    );
}

function getActiveContext(roomName) {
    if (activePlanningContext && activePlanningContext.roomName === roomName) {
        return activePlanningContext;
    }

    return null;
}

function addCount(map, key, amount) {
    if (!key) {
        return;
    }

    map[key] = (map[key] || 0) + (amount || 1);
}

function addBodyPartCount(map, role, partType, amount) {
    if (!role || !partType || amount <= 0) {
        return;
    }

    if (!map[role]) {
        map[role] = {};
    }

    addCount(map[role], partType, amount);
}

function getBodyPartCount(map, role, partType) {
    if (!map || !map[role]) {
        return 0;
    }

    return map[role][partType] || 0;
}

function isHealthyForReplacement(creep, role) {
    if (!creep) {
        return false;
    }

    if (creep.ticksToLive === undefined) {
        return true;
    }

    return creep.ticksToLive > getReplacementLeadTicks(role, creep.body || []);
}

function getRequestRole(request) {
    if (!request) {
        return null;
    }

    return request.role || (request.memory && request.memory.role) || null;
}

function requestBelongsToRoom(request, roomName) {
    var memory = request && request.memory;

    if (!request || !roomName) {
        return false;
    }

    return !memory || !memory.homeRoom || memory.homeRoom === roomName;
}

function isLocalExtractorMemory(memory, roomName) {
    if (!memory) {
        return true;
    }

    if (memory.remoteMining === true) {
        return false;
    }

    if (memory.sourceRoom && memory.sourceRoom !== roomName) {
        return false;
    }

    if (memory.targetRoom && memory.targetRoom !== roomName) {
        return false;
    }

    return true;
}

function isQueuedLocalExtractorRequest(request, roomName) {
    var role = getRequestRole(request);

    return role === 'Extractor' &&
        requestBelongsToRoom(request, roomName) &&
        isLocalExtractorMemory(request.memory, roomName);
}

function countQueueRequestsAtTick(queue, tick) {
    var count = 0;

    if (!queue) {
        return count;
    }

    for (var i = 0; i < queue.length; i++) {
        if (queue[i] && queue[i].requestedAt === tick) {
            count++;
        }
    }

    return count;
}

function summarizeQueue(queue, roomName) {
    var summary = {
        totalQueued: 0,
        queuedByRole: {},
        queuedBodyPartsByRole: {},
        queuedLocalExtractors: 0
    };

    if (!queue) {
        return summary;
    }

    for (var i = 0; i < queue.length; i++) {
        var request = queue[i];

        if (!requestBelongsToRoom(request, roomName)) {
            continue;
        }

        var role = getRequestRole(request);
        summary.totalQueued++;
        addCount(summary.queuedByRole, role, 1);

        if (isQueuedLocalExtractorRequest(request, roomName)) {
            summary.queuedLocalExtractors++;
        }

        var body = request.body || [];
        for (var bodyIndex = 0; bodyIndex < body.length; bodyIndex++) {
            addBodyPartCount(summary.queuedBodyPartsByRole, role, body[bodyIndex], 1);
        }
    }

    return summary;
}

function buildRoomPlanningContext(room, roomIndex, skipNormalPlanning) {
    var roomName = room.name;
    var cpuPolicy = ensureCpuPolicyMemory();
    var spawnPolicy = ensureSpawnPolicyMemory();
    var cache = getSpawnDemandCache(roomName);
    var queue = spawnManager.getSpawnQueue(roomName);
    var queueSummary = summarizeQueue(queue, roomName);
    var context = {
        room: room,
        roomName: roomName,
        roomIndex: roomIndex || 0,
        cpuPolicy: cpuPolicy,
        spawnPolicy: spawnPolicy,
        demandCache: cache,
        queue: queue,
        cpuStart: getCpuUsed(),
        skippedForCpu: skipNormalPlanning === true,
        fullPlan: false,
        denied: {},
        newRequests: countQueueRequestsAtTick(queue, Game.time),
        totalLiving: 0,
        healthyTotal: 0,
        totalQueued: queueSummary.totalQueued,
        livingByRole: {},
        healthyByRole: {},
        bodyPartsByRole: {},
        queuedByRole: queueSummary.queuedByRole,
        queuedBodyPartsByRole: queueSummary.queuedBodyPartsByRole,
        livingCreeps: [],
        idleFreighters: 0,
        healthyLocalExtractors: 0,
        queuedLocalExtractors: queueSummary.queuedLocalExtractors,
        emergencyMinimumBypassByRole: {}
    };

    var indexedCreeps = TickIndex.get().creepsByHomeRoom.get(roomName) || [];
    for (var creepIndex = 0; creepIndex < indexedCreeps.length; creepIndex++) {
        var creep = indexedCreeps[creepIndex];

        if (!creep || !creep.memory) {
            continue;
        }

        var role = creep.memory.role;
        var healthy = isHealthyForReplacement(creep, role);

        context.totalLiving++;
        context.livingCreeps.push(creep);
        addCount(context.livingByRole, role, 1);

        if (!healthy) {
            continue;
        }

        context.healthyTotal++;
        addCount(context.healthyByRole, role, 1);

        if (role === 'Extractor' && isLocalExtractorMemory(creep.memory, roomName)) {
            context.healthyLocalExtractors++;
        }

        if (
            role === 'Freighter' &&
            !creep.memory.freighterJob &&
            !creep.memory.FreighterWorking
        ) {
            var carriedEnergy = creep.store ? (creep.store[RESOURCE_ENERGY] || 0) : 0;

            if (carriedEnergy === 0) {
                context.idleFreighters++;
            }
        }

        var body = creep.body || [];
        for (var bodyIndex = 0; bodyIndex < body.length; bodyIndex++) {
            var part = body[bodyIndex] && body[bodyIndex].type;

            if (part && body[bodyIndex].hits !== 0) {
                addBodyPartCount(context.bodyPartsByRole, role, part, 1);
            }
        }
    }

    context.fullPlan = shouldRunFullPlan(
        cache,
        cpuPolicy,
        context.roomIndex,
        context.skippedForCpu
    );

    return context;
}

function getMaxCreepsForRoom(room, policy) {
    var level = room && room.controller ? (room.controller.level || 1) : 1;
    var key = 'RCL' + level;
    var maxByRcl = policy.maxCreepsPerRoomByRcl || {};

    return maxByRcl[key] ||
        DEFAULT_SPAWN_POLICY.maxCreepsPerRoomByRcl[key] ||
        DEFAULT_SPAWN_POLICY.maxCreepsPerRoomByRcl.RCL1;
}

function getPlannedRoleCount(context, role) {
    return (context.healthyByRole[role] || 0) +
        (context.queuedByRole[role] || 0);
}

function getPlannedTotal(context) {
    return context.healthyTotal + context.totalQueued;
}

function getHomeLivingCreeps(roomName) {
    var context = getActiveContext(roomName);

    if (context) {
        return context.livingCreeps;
    }

    return (TickIndex.get().creepsByHomeRoom.get(roomName) || []).slice();
}

function recordDenied(context, role, reason) {
    if (!context) {
        return;
    }

    context.denied[role || 'unknown'] = reason;
}

function canAddSpawnRequest(context, request, options) {
    if (!context || !request) {
        return {
            ok: true
        };
    }

    var policy = context.spawnPolicy;

    if (!policy || policy.enabled === false) {
        return {
            ok: true
        };
    }

    var role = getRequestRole(request);
    var emergency = options && options.emergency === true;
    var plannedRole = getPlannedRoleCount(context, role);
    var roleCap = policy.roleCaps ? policy.roleCaps[role] : null;
    var maxCreeps = getMaxCreepsForRoom(context.room, policy);

    var maxQueueLength = policy.maxQueueLengthPerRoom;
    var maxNewRequests = policy.maxNewRequestsPerRoomPerTick;
    var emergencyMinimumBypass = emergency &&
        options &&
        options.bypassRoleCap === true;
    var techWorkRoleCapBypass = role === 'Tech' &&
        options &&
        options.allowTechWorkRoleCapBypass === true;
    var absoluteTechCap = techWorkRoleCapBypass &&
        typeof options.absoluteTechCreepCap === 'number' ?
        options.absoluteTechCreepCap : TECH_ABSOLUTE_CREEP_CAP;

    if (techWorkRoleCapBypass && plannedRole >= absoluteTechCap) {
        return {
            ok: false,
            reason: 'absolute Tech creep cap reached'
        };
    }

    if (
        emergencyMinimumBypass &&
        context.emergencyMinimumBypassByRole[role]
    ) {
        return {
            ok: false,
            reason: 'emergency minimum already queued'
        };
    }

    if (
        typeof roleCap === 'number' &&
        plannedRole >= roleCap &&
        !emergencyMinimumBypass &&
        !techWorkRoleCapBypass
    ) {
        return {
            ok: false,
            reason: 'role cap reached'
        };
    }

    if (
        getPlannedTotal(context) >= maxCreeps &&
        !emergencyMinimumBypass
    ) {
        return {
            ok: false,
            reason: 'room creep cap reached'
        };
    }

    if (
        context.queue &&
        context.queue.length >= maxQueueLength &&
        !emergencyMinimumBypass
    ) {
        return {
            ok: false,
            reason: 'spawn queue full'
        };
    }

    if (
        context.newRequests >= maxNewRequests &&
        !emergencyMinimumBypass
    ) {
        return {
            ok: false,
            reason: 'new request cap reached'
        };
    }

    return {
        ok: true
    };
}

function updateContextForQueuedRequest(context, request) {
    if (!context || !request) {
        return;
    }

    var role = getRequestRole(request);
    context.totalQueued++;
    context.newRequests++;
    addCount(context.queuedByRole, role, 1);

    if (isQueuedLocalExtractorRequest(request, context.roomName)) {
        context.queuedLocalExtractors++;
    }

    var body = request.body || [];
    for (var i = 0; i < body.length; i++) {
        addBodyPartCount(context.queuedBodyPartsByRole, role, body[i], 1);
    }
}

function addSpawnRequest(roomName, request, options) {
    var queue = spawnManager.getSpawnQueue(roomName);
    var context = getActiveContext(roomName);
    var role = getRequestRole(request);

    if (!queue || !request || !role) {
        return {
            ok: false,
            role: role,
            requested: 0,
            reason: 'Missing spawn queue or request'
        };
    }

    var allowed = canAddSpawnRequest(context, request, options);

    if (!allowed.ok) {
        recordDenied(context, role, allowed.reason);

        return {
            ok: false,
            role: role,
            requested: 0,
            reason: allowed.reason
        };
    }

    if (request.requestedAt === undefined) {
        request.requestedAt = Game.time;
    }

    if (options && options.emergency === true) {
        request.emergency = true;
    }

    queue.push(request);

    if (
        context &&
        options &&
        options.emergency === true &&
        options.bypassRoleCap === true
    ) {
        context.emergencyMinimumBypassByRole[role] = true;
    }

    updateContextForQueuedRequest(context, request);
    sortSpawnQueue(queue);

    return {
        ok: true,
        role: role,
        requested: 1
    };
}

/**
 * Count creeps that are alive and still healthy enough to count.
 *
 * If a creep is about to die soon, we do NOT count it.
 * That causes the request manager to queue a replacement before death.
 *
 * @param {string} roomName
 * @param {string} role
 * @param {number} replacementLeadTicks
 * @returns {number}
 */
function countHealthyCreeps(roomName, role, replacementLeadTicks) {
    var context = getActiveContext(roomName);

    if (context) {
        return context.healthyByRole[role] || 0;
    }

    var count = 0;

    /*
     * Loop through living creeps and count only matching role/homeRoom creeps
     * that are not too close to death.
     */
    var indexedCreeps = TickIndex.get().creepsByHomeRoom.get(roomName) || [];
    for (var creepIndex = 0; creepIndex < indexedCreeps.length; creepIndex++) {
        var creep = indexedCreeps[creepIndex];

        if (!creep || !creep.memory) {
            continue;
        }

        if (creep.memory.role !== role) {
            continue;
        }

        /*
         * homeRoom tells us which room owns this creep.
         *
         * If homeRoom is missing, fall back to the room the creep is currently in.
         * This keeps early simple creeps from being ignored.
         */
        var creepHomeRoom = creep.memory.homeRoom || creep.room.name;

        if (creepHomeRoom !== roomName) {
            continue;
        }

        /*
         * ticksToLive can be undefined for spawning creeps.
         * If it is undefined, count the creep.
         */
        if (creep.ticksToLive === undefined) {
            count++;
            continue;
        }

        /*
         * If the creep has enough life left, count it.
         * If it is too close to death, do not count it.
         * That triggers an early replacement request.
         */
        if (creep.ticksToLive > replacementLeadTicks) {
            count++;
        }
    }

    return count;
}

/**
 * Count queued requests for a role in this room.
 *
 * This stops us from adding the same replacement every tick.
 *
 * @param {string} roomName
 * @param {string} role
 * @returns {number}
 */
function countQueuedRequests(roomName, role) {
    var context = getActiveContext(roomName);

    if (context) {
        return context.queuedByRole[role] || 0;
    }

    /*
     * This reads Memory.rooms[roomName].spawnQueue through spawn.manager.js.
     */
    var queue = spawnManager.getSpawnQueue(roomName);

    if (!queue) {
        return 0;
    }

    var count = 0;

    for (var index = 0; index < queue.length; index++) {
        var request = queue[index];

        if (!request) {
            continue;
        }

        if (request.role === role) {
            count++;
        }
    }

    return count;
}

function getStoredEnergy(structure) {
    if (!structure || !structure.store) {
        return 0;
    }

    if (typeof structure.store.getUsedCapacity === 'function') {
        return structure.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    }

    return structure.store[RESOURCE_ENERGY] || 0;
}

function getControllerContainerEnergy(room) {
    if (!room || !room.controller) {
        return 0;
    }

    var containers = room.controller.pos.findInRange(FIND_STRUCTURES, 3, {
        filter: function(structure) {
            return structure.structureType === STRUCTURE_CONTAINER;
        }
    });
    var energy = 0;

    for (var i = 0; i < containers.length; i++) {
        energy += getStoredEnergy(containers[i]);
    }

    return energy;
}

function getActiveRemoteNetIncome(roomName) {
    var activeSources = RemotePlanner.getActiveRemoteSourcesForHome(roomName);
    var income = 0;

    if (!activeSources) {
        return income;
    }

    for (var i = 0; i < activeSources.length; i++) {
        var netIncome = activeSources[i] && activeSources[i].netIncome;

        if (typeof netIncome === 'number' && netIncome > 0) {
            income += netIncome;
        }
    }

    return income;
}

function isFreshCacheEntry(entry, interval) {
    return !!(
        entry &&
        typeof entry.tick === 'number' &&
        Game.time - entry.tick < interval
    );
}

function getCachedLocalConstructionDemand(room) {
    if (!room) {
        return {
            tick: Game.time,
            totalSites: 0,
            localBuildProgressRemaining: 0,
            criticalSites: 0,
            criticalProgress: 0,
            regularSites: 0,
            regularProgress: 0,
            lowPrioritySites: 0,
            lowPriorityProgress: 0
        };
    }

    var cpuPolicy = ensureCpuPolicyMemory();
    var interval = getPositiveInterval(
        cpuPolicy.constructionDemandInterval,
        DEFAULT_CPU_POLICY.constructionDemandInterval
    );
    var cache = getSpawnDemandCache(room.name);

    if (isFreshCacheEntry(cache.constructionDemand, interval)) {
        return cache.constructionDemand;
    }

    var sites = room.find(FIND_MY_CONSTRUCTION_SITES);
    var demand = {
        tick: Game.time,
        totalSites: sites.length,
        localBuildProgressRemaining: 0,
        criticalSites: 0,
        criticalProgress: 0,
        regularSites: 0,
        regularProgress: 0,
        lowPrioritySites: 0,
        lowPriorityProgress: 0
    };

    for (var i = 0; i < sites.length; i++) {
        var remaining = getProgressRemaining(sites[i]);
        demand.localBuildProgressRemaining += remaining;

        if (isCriticalArtificerStructureType(sites[i].structureType)) {
            demand.criticalSites++;
            demand.criticalProgress += remaining;
        }
        else if (isLowPriorityArtificerStructureType(sites[i].structureType)) {
            demand.lowPrioritySites++;
            demand.lowPriorityProgress += remaining;
        }
        else {
            demand.regularSites++;
            demand.regularProgress += remaining;
        }
    }

    cache.constructionDemand = demand;
    return demand;
}

function getCachedLocalRepairDemand(room) {
    if (!room) {
        return {
            tick: Game.time,
            targets: 0,
            emergencyTargets: 0
        };
    }

    var cpuPolicy = ensureCpuPolicyMemory();
    var interval = getPositiveInterval(
        cpuPolicy.repairDemandInterval,
        DEFAULT_CPU_POLICY.repairDemandInterval
    );
    var cache = getSpawnDemandCache(room.name);

    if (isFreshCacheEntry(cache.repairDemand, interval)) {
        return cache.repairDemand;
    }

    var demand = getValidLocalRepairDemand(room);
    demand.tick = Game.time;
    cache.repairDemand = demand;
    return demand;
}

function getCachedRemoteArtificerDemand(roomName) {
    var cpuPolicy = ensureCpuPolicyMemory();
    var interval = getPositiveInterval(
        cpuPolicy.remotePlanningInterval,
        DEFAULT_CPU_POLICY.remotePlanningInterval
    );
    var cache = getSpawnDemandCache(roomName);

    if (isFreshCacheEntry(cache.remoteArtificerDemand, interval)) {
        return cache.remoteArtificerDemand;
    }

    var demand = getVisibleRemoteArtificerDemand(roomName);
    demand.tick = Game.time;
    cache.remoteArtificerDemand = demand;
    return demand;
}

function getConstructionSiteCount(room) {
    if (!room) {
        return 0;
    }

    return getCachedLocalConstructionDemand(room).totalSites || 0;
}

/**
 * Calculate the room's desired active Tech WORK parts.
 *
 * Storage is the main long-term signal. Controller-container energy and
 * profitable remote income add small bonuses, while a construction backlog
 * reserves more income for Artificers. The result is a WORK target, not a
 * creep count.
 */
function getDesiredTechWork(room) {
    if (!room || !room.controller) {
        return 0;
    }

    var settings = ensureUpgradeSettings();
    var cpuStatus = cpuStatusUtility.getCpuStatus();
    var level = room.controller.level || 1;
    var energyCapacity = room.energyCapacityAvailable || 300;
    var storageEnergy = getStoredEnergy(room.storage);
    var desiredWork;

    if (!room.storage) {
        if (level <= 2) {
            desiredWork = energyCapacity >= 550 ? 4 :
                energyCapacity >= 400 ? 3 : 2;
        }
        else if (level <= 4) {
            desiredWork = energyCapacity >= 800 ? 6 : 4;
        }
        else {
            /* A high-RCL room without storage is probably recovering. */
            desiredWork = energyCapacity >= 1300 ? 6 : 4;
        }
    }
    else if (storageEnergy < 20000) {
        desiredWork = 4;
    }
    else if (storageEnergy < 50000) {
        desiredWork = 6;
    }
    else if (storageEnergy < 100000) {
        desiredWork = 9;
    }
    else if (storageEnergy < 200000) {
        desiredWork = 14;
    }
    else {
        desiredWork = 20;
    }

    if (getControllerContainerEnergy(room) >= 1000) {
        desiredWork++;
    }

    /* Each 5 net remote energy/tick adds one WORK, up to four. */
    var remoteBonus = Math.min(4, Math.floor(getActiveRemoteNetIncome(room.name) / 5));
    desiredWork += remoteBonus;

    if (!room.storage) {
        desiredWork = Math.min(desiredWork, 8);
    }

    /* A nearly empty storage is a recovery state even if remotes look strong. */
    if (room.storage && storageEnergy < 5000) {
        desiredWork = Math.min(desiredWork, 4);
    }

    var upgradeRush = Memory.settings && Memory.settings.upgradeRush === true;
    var constructionDemand = getCachedLocalConstructionDemand(room);
    var constructionSites = constructionDemand.totalSites || 0;

    if (!upgradeRush) {
        if (constructionSites >= 25) {
            desiredWork = Math.ceil(desiredWork * 0.5);
        }
        else if (constructionSites >= 10) {
            desiredWork = Math.ceil(desiredWork * 0.75);
        }
    }
    else {
        desiredWork = Math.ceil(desiredWork * 1.35);
    }

    if (room.controller.ticksToDowngrade < TECH_DOWNGRADE_DANGER_TICKS) {
        var emergencyMinimum = energyCapacity >= 550 ? 5 : 2;
        desiredWork = Math.max(desiredWork, emergencyMinimum);
    }

    /*
     * Everything above is the established economic demand. CPU can amplify it,
     * but cannot erase recovery, construction, or downgrade safeguards.
     */
    var baseDesiredWork = Math.max(
        2,
        Math.min(desiredWork, TECH_BASE_MAX_DESIRED_WORK)
    );
    var cpuMultiplier = 1;
    var boostReason = 'normal CPU demand';
    var context = getActiveContext(room.name);
    var essentialEconomyReady = true;

    if (context) {
        essentialEconomyReady =
            getPlannedRoleCount(context, 'Foreman') >= 1 &&
            getPlannedRoleCount(context, 'Extractor') >= 1 &&
            getPlannedRoleCount(context, 'Freighter') >= 1;
    }

    if (settings.autoCpuUpgradeBoost === false) {
        boostReason = 'automatic CPU boost disabled';
    }
    else if (cpuStatus.mode !== 'high') {
        boostReason = 'CPU mode ' + cpuStatus.mode;
    }
    else if (cpuStatus.bucket < settings.cpuUpgradeMinimumBucket) {
        boostReason = 'CPU bucket below upgrade threshold';
    }
    else if (!room.storage || storageEnergy < settings.cpuUpgradeMinimumStorage) {
        boostReason = 'room energy reserve is recovering';
    }
    else if (!essentialEconomyReady) {
        boostReason = 'essential economy roles are not ready';
    }
    else if (!upgradeRush && constructionDemand.criticalSites > 0) {
        boostReason = 'critical construction reserves energy';
    }
    else if (!upgradeRush && constructionSites >= 10) {
        boostReason = 'construction backlog reserves energy';
    }
    else {
        var maximumMultiplier = Math.max(
            1,
            Math.min(2.5, settings.cpuUpgradeBoostMaximum)
        );
        var cpuScale = Math.max(0, Math.min(1, (cpuStatus.limit - 20) / 80));
        var bucketScale = Math.max(0, Math.min(1,
            (cpuStatus.bucket - settings.cpuUpgradeMinimumBucket) /
            Math.max(1, 10000 - settings.cpuUpgradeMinimumBucket)
        ));

        /* CPU capacity is primary; bucket health softens the top end. */
        cpuMultiplier = 1 +
            ((maximumMultiplier - 1) * cpuScale * (0.75 + (0.25 * bucketScale)));
        cpuMultiplier = Math.round(cpuMultiplier * 100) / 100;
        boostReason = cpuMultiplier > 1 ? 'healthy CPU and room economy' :
            'CPU limit does not provide extra capacity';
    }

    desiredWork = Math.ceil(baseDesiredWork * cpuMultiplier);
    desiredWork = Math.max(2, Math.min(desiredWork, TECH_MAX_DESIRED_WORK));

    /* RCL 8 controllers accept at most 15 normal upgrade energy per tick. */
    if (level === 8) {
        desiredWork = Math.min(desiredWork, TECH_RCL8_MAX_WORK);
    }

    var roomMemory = ensureRoomMemory(room.name);
    setMemoryValueIfChanged(roomMemory, 'techBaseDesiredWork', baseDesiredWork);
    setMemoryValueIfChanged(roomMemory, 'techCpuMultiplier', cpuMultiplier);
    setMemoryValueIfChanged(roomMemory, 'techCpuMode', cpuStatus.mode);
    setMemoryValueIfChanged(roomMemory, 'techBoostReason', boostReason);

    return desiredWork;
}

function getCreepActiveBodyParts(creep, partType) {
    if (!creep) {
        return 0;
    }

    if (typeof creep.getActiveBodyparts === 'function') {
        return creep.getActiveBodyparts(partType);
    }

    var count = 0;
    var body = creep.body || [];

    for (var i = 0; i < body.length; i++) {
        if (body[i] && body[i].type === partType && body[i].hits !== 0) {
            count++;
        }
    }

    return count;
}

function countLivingRoleBodyParts(roomName, role, partType) {
    var context = getActiveContext(roomName);

    if (context) {
        return getBodyPartCount(context.bodyPartsByRole, role, partType);
    }

    var partCount = 0;

    var indexedCreeps = TickIndex.get().creepsByHomeRoom.get(roomName) || [];
    for (var creepIndex = 0; creepIndex < indexedCreeps.length; creepIndex++) {
        var creep = indexedCreeps[creepIndex];

        if (!creep || !creep.memory || creep.memory.role !== role) {
            continue;
        }

        var creepHomeRoom = creep.memory.homeRoom ||
            (creep.room ? creep.room.name : null);

        if (creepHomeRoom !== roomName) {
            continue;
        }

        var bodyLength = creep.body ? creep.body.length : 0;
        var replacementLeadTicks = (bodyLength * 3) +
            (REPLACEMENT_BUFFER_TICKS[role] || 30);

        if (
            creep.ticksToLive !== undefined &&
            creep.ticksToLive <= replacementLeadTicks
        ) {
            continue;
        }

        partCount += getCreepActiveBodyParts(creep, partType);
    }

    return partCount;
}

function countQueuedRoleBodyParts(roomName, role, partType) {
    var context = getActiveContext(roomName);

    if (context) {
        return getBodyPartCount(context.queuedBodyPartsByRole, role, partType);
    }

    var queue = spawnManager.getSpawnQueue(roomName);
    var partCount = 0;

    if (!queue) {
        return partCount;
    }

    for (var i = 0; i < queue.length; i++) {
        var request = queue[i];
        var requestRole = request && (request.role ||
            (request.memory && request.memory.role));

        if (requestRole === role) {
            partCount += countBodyParts(request.body, partType);
        }
    }

    return partCount;
}

function countLivingRoleWork(roomName, role) {
    return countLivingRoleBodyParts(roomName, role, WORK);
}

function countQueuedRoleWork(roomName, role) {
    return countQueuedRoleBodyParts(roomName, role, WORK);
}

function setMemoryValueIfChanged(target, key, value) {
    if (target[key] !== value) {
        target[key] = value;
    }
}

function saveTechWorkDebug(roomName, desiredWork, livingWork, queuedWork) {
    var roomMemory = ensureRoomMemory(roomName);
    setMemoryValueIfChanged(roomMemory, 'techDesiredWork', desiredWork);
    setMemoryValueIfChanged(roomMemory, 'techLivingWork', livingWork);
    setMemoryValueIfChanged(roomMemory, 'techQueuedWork', queuedWork);
}

function saveTechRequestDebug(roomName, status, reason, demand, plannedCreeps) {
    var roomMemory = ensureRoomMemory(roomName);

    setMemoryValueIfChanged(roomMemory, 'techRequestTick', Game.time);
    setMemoryValueIfChanged(roomMemory, 'techRequestStatus', status);
    setMemoryValueIfChanged(roomMemory, 'techRequestBlockReason', reason || null);
    setMemoryValueIfChanged(roomMemory, 'techPlannedCreeps', plannedCreeps);
    setMemoryValueIfChanged(
        roomMemory,
        'techAbsoluteCreepCap',
        TECH_ABSOLUTE_CREEP_CAP
    );
    setMemoryValueIfChanged(
        roomMemory,
        'techRequestEconomyReason',
        roomMemory.techBoostReason || null
    );

    if (demand) {
        setMemoryValueIfChanged(
            roomMemory,
            'techRequestMissingWork',
            Math.max(0, demand.missingWork || 0)
        );
    }
}

function getTechWorkDemand(room) {
    if (!room) {
        return {
            desiredWork: 0,
            livingWork: 0,
            queuedWork: 0,
            missingWork: 0
        };
    }

    var desiredWork = getDesiredTechWork(room);
    var livingWork = countLivingRoleWork(room.name, 'Tech');
    var queuedWork = countQueuedRoleWork(room.name, 'Tech');

    return {
        desiredWork: desiredWork,
        livingWork: livingWork,
        queuedWork: queuedWork,
        missingWork: Math.max(0, desiredWork - livingWork - queuedWork)
    };
}

function requestTechWorkForRoom(room, demandOverride, options) {
    if (!room) {
        return {
            ok: false,
            role: 'Tech',
            requested: 0,
            reason: 'Missing room'
        };
    }

    var demand = demandOverride || getTechWorkDemand(room);
    var missingWork = demand.missingWork;
    var context = getActiveContext(room.name);
    var techBody = creepBodyConfig.getTechBody(room);
    var techReplacementLead = getReplacementLeadTicks('Tech', techBody);
    var plannedTechCreeps = context ? getPlannedRoleCount(context, 'Tech') :
        countHealthyCreeps(room.name, 'Tech', techReplacementLead) +
            countQueuedRequests(room.name, 'Tech');
    var result = {
        ok: true,
        role: 'Tech',
        requested: 0,
        desiredWork: demand.desiredWork,
        livingWork: demand.livingWork,
        queuedWork: demand.queuedWork,
        missingWork: Math.max(0, missingWork)
    };

    saveTechWorkDebug(
        room.name,
        demand.desiredWork,
        demand.livingWork,
        demand.queuedWork
    );

    if (missingWork <= 0) {
        result.reason = 'Enough Tech WORK already planned';
        saveTechRequestDebug(
            room.name,
            'satisfied',
            'enough WORK already planned',
            demand,
            plannedTechCreeps
        );
        return result;
    }

    if (plannedTechCreeps >= TECH_ABSOLUTE_CREEP_CAP) {
        result.ok = false;
        result.reason = 'Absolute Tech creep cap reached';
        saveTechRequestDebug(
            room.name,
            'blocked',
            'absolute Tech creep cap reached',
            demand,
            plannedTechCreeps
        );
        return result;
    }

    var body = creepBodyConfig.getTechBodyForWork(room, missingWork);
    var requestedWork = countBodyParts(body, WORK);

    if (!body || requestedWork <= 0) {
        result.ok = false;
        result.reason = 'No affordable Tech body for missing WORK';
        saveTechRequestDebug(
            room.name,
            'blocked',
            'insufficient body',
            demand,
            plannedTechCreeps
        );
        return result;
    }

    var requestOptions = {};
    if (options) {
        for (var optionKey in options) {
            if (options.hasOwnProperty(optionKey)) {
                requestOptions[optionKey] = options[optionKey];
            }
        }
    }
    requestOptions.allowTechWorkRoleCapBypass = true;
    requestOptions.absoluteTechCreepCap = TECH_ABSOLUTE_CREEP_CAP;

    /* Add exactly one Tech request per tick. Later ticks can fill more WORK. */
    var addResult = addSpawnRequest(room.name, {
        role: 'Tech',
        body: body,
        maxWorkParts: requestedWork,
        priority: PRIORITY.Tech,
        memory: {
            role: 'Tech',
            homeRoom: room.name
        },
        requestedAt: Game.time
    }, requestOptions);

    if (!addResult.ok) {
        result.ok = false;
        result.reason = addResult.reason;
        saveTechRequestDebug(
            room.name,
            'blocked',
            addResult.reason,
            demand,
            plannedTechCreeps
        );
        return result;
    }

    result.requested = 1;
    result.requestedWork = requestedWork;
    result.queuedWork += requestedWork;
    demand.queuedWork = result.queuedWork;
    demand.missingWork = Math.max(
        0,
        demand.desiredWork - demand.livingWork - demand.queuedWork
    );
    saveTechWorkDebug(
        room.name,
        demand.desiredWork,
        demand.livingWork,
        result.queuedWork
    );
    saveTechRequestDebug(
        room.name,
        'queued',
        null,
        demand,
        plannedTechCreeps + 1
    );

    return result;
}

function isCriticalArtificerStructureType(structureType) {
    return structureType === STRUCTURE_SPAWN ||
        structureType === STRUCTURE_EXTENSION ||
        structureType === STRUCTURE_TOWER ||
        structureType === STRUCTURE_STORAGE ||
        structureType === STRUCTURE_CONTAINER ||
        structureType === STRUCTURE_LINK ||
        structureType === STRUCTURE_TERMINAL;
}

function isLowPriorityArtificerStructureType(structureType) {
    return structureType === STRUCTURE_ROAD ||
        structureType === STRUCTURE_RAMPART ||
        structureType === STRUCTURE_WALL;
}

function getProgressRemaining(site) {
    if (!site) {
        return 0;
    }

    return Math.max(0, (site.progressTotal || 0) - (site.progress || 0));
}

function localStructureNeedsRepair(structure) {
    if (creepUtility.shouldRepairStructure) {
        return creepUtility.shouldRepairStructure(structure);
    }

    return !!(structure && structure.hits < structure.hitsMax);
}

function remoteStructureNeedsArtificerRepair(structure) {
    if (!structure || structure.hits >= structure.hitsMax) {
        return false;
    }

    if (structure.structureType === STRUCTURE_CONTAINER) {
        return structure.hits <
            structure.hitsMax * REMOTE_CONTAINER_REPAIR_START_PERCENT;
    }

    if (structure.structureType === STRUCTURE_ROAD) {
        return structure.hits <
            structure.hitsMax * REMOTE_ROAD_REPAIR_START_PERCENT;
    }

    return false;
}

function getValidLocalRepairDemand(room) {
    var roomMemory = Memory.rooms && Memory.rooms[room.name];
    var repairList = roomMemory && roomMemory.RepairStructure;
    var seen = {};
    var targets = 0;
    var emergencyTargets = 0;

    if (!repairList || !Array.isArray(repairList)) {
        return {
            targets: targets,
            emergencyTargets: emergencyTargets
        };
    }

    for (var i = 0; i < repairList.length; i++) {
        var targetId = repairList[i];

        if (!targetId || seen[targetId]) {
            continue;
        }

        seen[targetId] = true;
        var target = Game.getObjectById(targetId);

        if (
            !target ||
            !target.pos ||
            target.pos.roomName !== room.name ||
            !localStructureNeedsRepair(target)
        ) {
            continue;
        }

        targets++;

        if (isCriticalArtificerStructureType(target.structureType)) {
            emergencyTargets++;
        }
    }

    return {
        targets: targets,
        emergencyTargets: emergencyTargets
    };
}

function getVisibleRemoteArtificerDemand(roomName) {
    var activeSources = RemotePlanner.getActiveRemoteSourcesForHome(roomName);
    var seenRooms = {};
    var result = {
        constructionSites: 0,
        constructionProgressRemaining: 0,
        containerConstructionSites: 0,
        containerConstructionProgressRemaining: 0,
        roadConstructionSites: 0,
        roadConstructionProgressRemaining: 0,
        repairTargets: 0,
        containerRepairTargets: 0,
        roadRepairTargets: 0
    };

    for (var i = 0; i < activeSources.length; i++) {
        var sourceInfo = activeSources[i];
        var remoteRoomName = sourceInfo && sourceInfo.roomName;

        if (!remoteRoomName || seenRooms[remoteRoomName]) {
            continue;
        }

        seenRooms[remoteRoomName] = true;
        var remoteRoom = Game.rooms[remoteRoomName];

        /* Unseen remotes have no trustworthy live construction or repair data. */
        if (!remoteRoom) {
            continue;
        }

        var sites = remoteRoom.find(FIND_MY_CONSTRUCTION_SITES, {
            filter: function(site) {
                return site.structureType === STRUCTURE_CONTAINER ||
                    site.structureType === STRUCTURE_ROAD;
            }
        });

        for (var siteIndex = 0; siteIndex < sites.length; siteIndex++) {
            var site = sites[siteIndex];
            var remaining = getProgressRemaining(site);

            result.constructionSites++;
            result.constructionProgressRemaining += remaining;

            if (site.structureType === STRUCTURE_CONTAINER) {
                result.containerConstructionSites++;
                result.containerConstructionProgressRemaining += remaining;
            }
            else {
                result.roadConstructionSites++;
                result.roadConstructionProgressRemaining += remaining;
            }
        }

        var structures = remoteRoom.find(FIND_STRUCTURES, {
            filter: function(structure) {
                return remoteStructureNeedsArtificerRepair(structure);
            }
        });

        for (var structureIndex = 0;
            structureIndex < structures.length;
            structureIndex++
        ) {
            result.repairTargets++;

            if (structures[structureIndex].structureType === STRUCTURE_CONTAINER) {
                result.containerRepairTargets++;
            }
            else {
                result.roadRepairTargets++;
            }
        }
    }

    return result;
}

function getCountScaledWork(count, baseWork, mediumAt, highAt, maxWork) {
    if (count <= 0) {
        return 0;
    }

    var work = baseWork;

    if (count >= mediumAt) {
        work += 2;
    }

    if (count >= highAt) {
        work += 2;
    }

    return Math.min(maxWork, work);
}

/** Calculate live Artificer WORK demand from local and visible remote work. */
function getArtificerBuildDemand(room) {
    if (!room) {
        return {
            desiredWork: 0,
            livingWork: 0,
            queuedWork: 0,
            missingWork: 0,
            localBuildProgressRemaining: 0,
            localConstructionSites: 0,
            repairTargets: 0,
            remoteConstructionSites: 0,
            remoteRepairTargets: 0,
            mode: 'missing-room'
        };
    }

    var constructionDemand = getCachedLocalConstructionDemand(room);
    var localBuildProgressRemaining =
        constructionDemand.localBuildProgressRemaining || 0;
    var criticalSites = constructionDemand.criticalSites || 0;
    var criticalProgress = constructionDemand.criticalProgress || 0;
    var regularSites = constructionDemand.regularSites || 0;
    var regularProgress = constructionDemand.regularProgress || 0;
    var lowPrioritySites = constructionDemand.lowPrioritySites || 0;
    var lowPriorityProgress = constructionDemand.lowPriorityProgress || 0;
    var repairDemand = getCachedLocalRepairDemand(room);
    var remoteDemand = getCachedRemoteArtificerDemand(room.name);
    var energyCapacity = room.energyCapacityAvailable || 300;
    var storageEnergy = getStoredEnergy(room.storage);
    var criticalBuildWork = 0;

    if (criticalSites > 0) {
        criticalBuildWork = energyCapacity >= 1300 ? 10 :
            energyCapacity >= 800 ? 8 : 6;

        if (room.storage && storageEnergy >= 100000) {
            criticalBuildWork += 2;
        }

        criticalBuildWork += Math.min(2, Math.floor(criticalProgress / 25000));

        if (criticalSites >= 10) {
            criticalBuildWork += 2;
        }

        criticalBuildWork = Math.min(16, criticalBuildWork);
    }

    var regularBuildWork = getCountScaledWork(
        regularSites,
        4,
        5,
        15,
        10
    );
    regularBuildWork += Math.min(2, Math.floor(regularProgress / 50000));
    regularBuildWork = Math.min(10, regularBuildWork);

    var lowPriorityBuildWork = getCountScaledWork(
        lowPrioritySites,
        2,
        10,
        30,
        6
    );
    lowPriorityBuildWork += Math.min(2, Math.floor(lowPriorityProgress / 75000));
    lowPriorityBuildWork = Math.min(6, lowPriorityBuildWork);

    /* Critical sites dominate; lower priority local sites wait behind them. */
    var localBuildWork = criticalBuildWork || regularBuildWork ||
        lowPriorityBuildWork;
    var repairWork = getCountScaledWork(
        repairDemand.targets,
        2,
        5,
        15,
        6
    );
    var remoteContainerBuildWork = getCountScaledWork(
        remoteDemand.containerConstructionSites,
        4,
        2,
        5,
        8
    );
    var remoteRoadBuildWork = getCountScaledWork(
        remoteDemand.roadConstructionSites,
        2,
        10,
        25,
        6
    );
    var remoteContainerRepairWork = getCountScaledWork(
        remoteDemand.containerRepairTargets,
        2,
        3,
        8,
        4
    );
    var remoteRoadRepairWork = getCountScaledWork(
        remoteDemand.roadRepairTargets,
        1,
        10,
        30,
        3
    );
    var desiredWork = localBuildWork + repairWork +
        remoteContainerBuildWork + remoteRoadBuildWork +
        remoteContainerRepairWork + remoteRoadRepairWork;
    var mode = 'idle';

    if (criticalSites > 0) {
        mode = 'critical-local-build';
    }
    else if (regularSites > 0) {
        mode = 'local-build';
    }
    else if (lowPrioritySites > 0) {
        mode = 'low-priority-build';
    }
    else if (remoteDemand.containerConstructionSites > 0) {
        mode = 'remote-container-build';
    }
    else if (remoteDemand.roadConstructionSites > 0) {
        mode = 'remote-road-build';
    }
    else if (repairDemand.targets > 0) {
        mode = 'repair';
    }
    else if (remoteDemand.repairTargets > 0) {
        mode = 'remote-repair';
    }

    var upgradeRush = Memory.settings &&
        Memory.settings.upgradeRush === true;

    if (upgradeRush) {
        var emergencyRepairWork = repairDemand.emergencyTargets > 0 ?
            repairWork : Math.min(2, Math.floor(repairWork / 2));
        var reducedWork = regularBuildWork + lowPriorityBuildWork +
            remoteRoadBuildWork + remoteRoadRepairWork;

        desiredWork = criticalBuildWork + remoteContainerBuildWork +
            remoteContainerRepairWork + emergencyRepairWork +
            Math.floor(reducedWork / 2);
        mode = desiredWork > 0 ? 'upgrade-rush-' + mode : 'upgrade-rush';
    }

    var controllerDanger = room.controller &&
        room.controller.ticksToDowngrade < TECH_DOWNGRADE_DANGER_TICKS;
    var hasCriticalWork = criticalSites > 0 ||
        remoteDemand.containerConstructionSites > 0 ||
        repairDemand.emergencyTargets > 0;

    if (room.storage && !hasCriticalWork) {
        if (storageEnergy < ARTIFICER_CRITICAL_STORAGE_ENERGY) {
            desiredWork = Math.min(desiredWork, 2);
            mode = desiredWork > 0 ? 'low-energy-' + mode : mode;
        }
        else if (storageEnergy < ARTIFICER_LOW_STORAGE_ENERGY) {
            desiredWork = Math.min(desiredWork, 4);
            mode = desiredWork > 0 ? 'energy-safe-' + mode : mode;
        }
    }

    if (controllerDanger) {
        desiredWork = Math.min(desiredWork, hasCriticalWork ? 8 : 2);
        mode = desiredWork > 0 ? 'downgrade-safe-' + mode : mode;
    }

    if (
        desiredWork === 0 &&
        room.storage &&
        storageEnergy >= ARTIFICER_HEALTHY_STORAGE_ENERGY &&
        !upgradeRush &&
        !controllerDanger
    ) {
        desiredWork = 1;
        mode = 'fallback-upgrade';
    }

    desiredWork = Math.max(0, Math.min(
        ARTIFICER_MAX_DESIRED_WORK,
        Math.ceil(desiredWork)
    ));
    var livingWork = countLivingRoleBodyParts(room.name, 'Artificer', WORK);
    var queuedWork = countQueuedRoleBodyParts(room.name, 'Artificer', WORK);

    return {
        desiredWork: desiredWork,
        livingWork: livingWork,
        queuedWork: queuedWork,
        missingWork: Math.max(0, desiredWork - livingWork - queuedWork),
        localBuildProgressRemaining: localBuildProgressRemaining,
        localConstructionSites: constructionDemand.totalSites || 0,
        repairTargets: repairDemand.targets,
        remoteConstructionSites: remoteDemand.constructionSites,
        remoteRepairTargets: remoteDemand.repairTargets,
        mode: mode
    };
}

function saveArtificerDemandDebug(roomName, demand) {
    if (!Memory.rooms) {
        Memory.rooms = {};
    }

    if (!Memory.rooms[roomName]) {
        Memory.rooms[roomName] = {};
    }

    var roomMemory = Memory.rooms[roomName];
    roomMemory.artificerDesiredWork = demand.desiredWork;
    roomMemory.artificerLivingWork = demand.livingWork;
    roomMemory.artificerQueuedWork = demand.queuedWork;
    roomMemory.artificerBuildBacklog = demand.localBuildProgressRemaining;
    roomMemory.artificerRepairTargets = demand.repairTargets;
    roomMemory.artificerRemoteBuildTargets = demand.remoteConstructionSites;
    roomMemory.artificerRemoteRepairTargets = demand.remoteRepairTargets;
    roomMemory.artificerMode = demand.mode;
}

function requestDynamicArtificersForRoom(room, demandOverride, options) {
    if (!room) {
        return {
            ok: false,
            role: 'Artificer',
            requested: 0,
            reason: 'Missing room'
        };
    }

    var demand = demandOverride || getArtificerBuildDemand(room);
    var result = {
        ok: true,
        role: 'Artificer',
        requested: 0,
        requestedWork: 0,
        desiredWork: demand.desiredWork,
        livingWork: demand.livingWork,
        queuedWork: demand.queuedWork,
        missingWork: demand.missingWork,
        mode: demand.mode
    };

    saveArtificerDemandDebug(room.name, demand);

    if (demand.missingWork <= 0) {
        return result;
    }

    var body = creepBodyConfig.getArtificerBodyForWork(
        room,
        demand.missingWork
    );
    var requestedWork = countBodyParts(body, WORK);

    if (!body || requestedWork <= 0) {
        result.ok = false;
        result.reason = 'No Artificer body or spawn queue available';
        return result;
    }

    /* Add one request per tick; queued WORK prevents repeated over-requesting. */
    var addResult = addSpawnRequest(room.name, {
        role: 'Artificer',
        body: body,
        requestedWorkParts: requestedWork,
        maxWorkParts: requestedWork,
        priority: PRIORITY.Artificer,
        memory: {
            role: 'Artificer',
            homeRoom: room.name
        },
        requestedAt: Game.time
    }, options);

    if (!addResult.ok) {
        result.ok = false;
        result.reason = addResult.reason;
        return result;
    }

    demand.queuedWork += requestedWork;
    demand.missingWork = Math.max(
        0,
        demand.desiredWork - demand.livingWork - demand.queuedWork
    );
    saveArtificerDemandDebug(room.name, demand);

    result.requested = 1;
    result.requestedWork = requestedWork;
    result.queuedWork = demand.queuedWork;
    result.missingWork = demand.missingWork;
    return result;
}


function requestRemoteExtractorsForRoom(room, extractorBody, priority, maxRequests, options) {
    var queue = spawnManager.getSpawnQueue(room.name);
    var demands = RemotePlanner.getRemoteExtractorDemand(room.name, extractorBody, queue);
    var added = 0;

    if (typeof maxRequests !== 'number' || maxRequests < 0) {
        maxRequests = demands ? demands.length : 0;
    }

    if (!queue || !demands || demands.length === 0) {
        return {
            ok: true,
            role: 'Extractor',
            requested: 0,
            remote: true
        };
    }

    for (var i = 0; i < demands.length; i++) {
        if (added >= maxRequests) {
            break;
        }

        var demand = demands[i];

        /*
         * Queue one source-targeted normal Extractor. remoteMining is assignment
         * state only, and Planner.Remote caps each remote source at one Extractor.
         */
        var addResult = addSpawnRequest(room.name, {
            role: 'Extractor',
            body: extractorBody,
            priority: priority,
            memory: {
                role: 'Extractor',
                homeRoom: room.name,
                sourceRoom: demand.remoteRoomName,
                targetRoom: demand.remoteRoomName,
                sourceId: demand.sourceId,
                targetSourceId: demand.sourceId,
                remoteMining: true
            },
            requestedAt: Game.time
        }, options);

        if (addResult.ok) {
            added++;
        }
        else {
            break;
        }
    }

    return {
        ok: true,
        role: 'Extractor',
        requested: added,
        remote: true,
        demands: demands.length
    };
}

function sortSpawnQueue(queue) {
    if (!queue) {
        return;
    }

    queue.sort(function(a, b) {
        if (b.priority !== a.priority) {
            return b.priority - a.priority;
        }

        return a.requestedAt - b.requestedAt;
    });
}

function getMyUsername(room) {
    if (room && room.controller && room.controller.owner) {
        return room.controller.owner.username;
    }

    for (var spawnName in Game.spawns) {
        if (
            Game.spawns.hasOwnProperty(spawnName) &&
            Game.spawns[spawnName].owner
        ) {
            return Game.spawns[spawnName].owner.username;
        }
    }

    return Memory.username || null;
}

function getControllerOwnerUsername(controllerMemory) {
    if (!controllerMemory || !controllerMemory.owner) {
        return null;
    }

    if (typeof controllerMemory.owner === 'string') {
        return controllerMemory.owner;
    }

    return controllerMemory.owner.username || null;
}

function getControllerReservation(controllerMemory) {
    if (!controllerMemory || !controllerMemory.reservation) {
        return null;
    }

    if (typeof controllerMemory.reservation === 'string') {
        return {
            username: controllerMemory.reservation,
            ticksToEnd: controllerMemory.ticksToEnd || 0
        };
    }

    return {
        username: controllerMemory.reservation.username || null,
        ticksToEnd: controllerMemory.reservation.ticksToEnd || controllerMemory.ticksToEnd || 0
    };
}

function isLivingAnnexForHome(creep, homeRoomName) {
    return !!(
        creep &&
        creep.memory &&
        creep.memory.role === 'Annex' &&
        creep.memory.homeRoom === homeRoomName &&
        (creep.ticksToLive === undefined || creep.ticksToLive > ANNEX_LIVING_MIN_TTL)
    );
}

function isQueuedAnnexForHome(request, homeRoomName) {
    var memory = request && request.memory;

    return !!(
        request &&
        request.role === 'Annex' &&
        memory &&
        memory.homeRoom === homeRoomName
    );
}

function requestAnnexForRoom(room) {
    var result = {
        ok: true,
        role: 'Annex',
        requested: 0,
        desiredReservationTicks: RESERVE_DESIRED_TICKS,
        spawnAtTicks: RESERVE_SPAWN_AT_TICKS
    };

    if (!room) {
        result.ok = false;
        result.reason = 'Missing home room';
        return result;
    }

    var activeSources = RemotePlanner.getActiveRemoteSourcesForHome(room.name);
    var queue = spawnManager.getSpawnQueue(room.name);
    var annexBody = creepBodyConfig.getAnnexBody(room);

    if (!queue || !annexBody || !activeSources || activeSources.length === 0) {
        result.reason = !annexBody ? 'Room cannot support an Annex body' : 'No active remote rooms';
        return result;
    }

    var livingAnnexes = [];
    var context = getActiveContext(room.name);

    if (context) {
        for (var homeCreepIndex = 0;
            homeCreepIndex < context.livingCreeps.length;
            homeCreepIndex++
        ) {
            if (isLivingAnnexForHome(context.livingCreeps[homeCreepIndex], room.name)) {
                livingAnnexes.push(context.livingCreeps[homeCreepIndex]);
            }
        }
    }
    else {
        var indexedCreeps = TickIndex.get().creepsByHomeRoom.get(room.name) || [];
        for (var creepIndex = 0; creepIndex < indexedCreeps.length; creepIndex++) {
            if (isLivingAnnexForHome(indexedCreeps[creepIndex], room.name)) {
                livingAnnexes.push(indexedCreeps[creepIndex]);
            }
        }
    }

    var queuedAnnexes = [];
    for (var queueIndex = 0; queueIndex < queue.length; queueIndex++) {
        if (isQueuedAnnexForHome(queue[queueIndex], room.name)) {
            queuedAnnexes.push(queue[queueIndex]);
        }
    }

    /* DESIRED_COUNTS.Annex is a max cap, not a fixed desired count. */
    var totalPlannedAnnexes = livingAnnexes.length + queuedAnnexes.length;
    if (totalPlannedAnnexes >= DESIRED_COUNTS.Annex) {
        result.reason = 'Annex max cap reached';
        return result;
    }

    var myUsername = getMyUsername(room);
    var seenRemoteRooms = {};

    for (var sourceIndex = 0; sourceIndex < activeSources.length; sourceIndex++) {
        var sourceInfo = activeSources[sourceIndex];
        var remoteRoomName = sourceInfo && sourceInfo.roomName;

        if (!remoteRoomName || seenRemoteRooms[remoteRoomName]) {
            continue;
        }
        seenRemoteRooms[remoteRoomName] = true;

        var controllerMemory = Memory.rooms && Memory.rooms[remoteRoomName] ?
            Memory.rooms[remoteRoomName].controller : null;
        var ownerUsername = getControllerOwnerUsername(controllerMemory);
        var reservation = getControllerReservation(controllerMemory);

        if (ownerUsername && ownerUsername !== myUsername) {
            continue;
        }

        if (controllerMemory && controllerMemory.my === true) {
            continue;
        }

        if (reservation && reservation.username && reservation.username !== myUsername) {
            continue;
        }

        if (
            reservation &&
            reservation.username === myUsername &&
            reservation.ticksToEnd >= RESERVE_SPAWN_AT_TICKS
        ) {
            continue;
        }

        var duplicate = false;
        for (var livingIndex = 0; livingIndex < livingAnnexes.length; livingIndex++) {
            if (livingAnnexes[livingIndex].memory.targetRoom === remoteRoomName) {
                duplicate = true;
                break;
            }
        }

        for (var queuedIndex = 0; !duplicate && queuedIndex < queuedAnnexes.length; queuedIndex++) {
            if (queuedAnnexes[queuedIndex].memory.targetRoom === remoteRoomName) {
                duplicate = true;
            }
        }

        if (duplicate) {
            continue;
        }

        var addResult = addSpawnRequest(room.name, {
            role: 'Annex',
            body: annexBody,
            priority: PRIORITY.Annex,
            memory: {
                role: 'Annex',
                homeRoom: room.name,
                targetRoom: remoteRoomName,
                annexMode: 'reserve'
            },
            requestedAt: Game.time
        });

        if (!addResult.ok) {
            result.ok = false;
            result.reason = addResult.reason;
            return result;
        }

        result.requested = 1;
        result.targetRoom = remoteRoomName;
        return result;
    }

    result.reason = 'No active remote room needs reservation';
    return result;
}

/**
 * Request one role count for one room.
 *
 * This function:
 * - picks the body
 * - calculates replacement timing
 * - counts healthy creeps
 * - counts queued requests
 * - asks spawn.manager.js to queue missing creeps
 *
 * @param {Room} room
 * @param {string} role
 * @param {number} desiredCount
 * @param {number} priorityOverride
 * @returns {object}
 */
function requestRoleForRoom(room, role, desiredCount, priorityOverride, options) {
    /*
     * Validate the request before doing body calculations or writing anything to
     * the spawn queue.
     */
    if (!room || !role || desiredCount <= 0) {
        return {
            ok: false,
            role: role,
            reason: 'Invalid requestRoleForRoom input'
        };
    }

    var roomName = room.name;
    /*
     * Body selection is separated into role.creepBodyConfig.js so this manager
     * only decides "how many" and not the exact body-part layout.
     */
    var body = creepBodyConfig.getBody(role, room);
    var priority = typeof priorityOverride === 'number' ?
        priorityOverride : (PRIORITY[role] || 0);
    var replacementLeadTicks = getReplacementLeadTicks(role, body);

    var healthyCount = countHealthyCreeps(roomName, role, replacementLeadTicks);
    var queuedCount = countQueuedRequests(roomName, role);

    if (
        role === 'Extractor' &&
        Memory.rooms &&
        Memory.rooms[roomName] &&
        Memory.rooms[roomName].sources
    ) {
        /*
         * Extractors are special because the desired count is source-driven,
         * not just role-driven. This block walks each remembered source and
         * asks whether that exact source still needs mining WORK assigned.
         */
        var queue = spawnManager.getSpawnQueue(roomName);
        var sourcesMemory = Memory.rooms[roomName].sources;
        var sourceRequestsAdded = 0;
        var managedSourceCount = 0;
        var homeLivingCreeps = getHomeLivingCreeps(roomName);

        if (!queue) {
            return {
                ok: false,
                role: role,
                requested: 0,
                healthy: healthyCount,
                queued: queuedCount,
                desired: desiredCount,
                reason: 'Missing spawn queue'
            };
        }

        for (var sourceId in sourcesMemory) {
            if (!sourcesMemory.hasOwnProperty(sourceId)) {
                continue;
            }

            var sourceMemory = sourcesMemory[sourceId];

            if (!sourceMemory) {
                continue;
            }

            managedSourceCount++;

            if (!sourceMemory.assignedMiner) {
                /*
                 * assignedMiner is persistent memory, so normalize its shape
                 * before using it. Old versions may have saved a string or a
                 * non-array value; this keeps the current loop predictable.
                 */
                sourceMemory.assignedMiner = [];
            }
            else if (typeof sourceMemory.assignedMiner === 'string') {
                sourceMemory.assignedMiner = [sourceMemory.assignedMiner];
            }
            else if (!Array.isArray(sourceMemory.assignedMiner)) {
                sourceMemory.assignedMiner = [];
            }

            var realSourceId = sourceMemory.id || sourceId;
            var maxSeats = 1;
            var livingAssignedCount = 0;
            var totalAssignedWorkParts = 0;
            var healthyAssignedCount = 0;
            var hasDyingAssignedExtractor = false;
            var cleanAssignedMiners = [];
            var seenAssignedCreeps = {};

            if (sourceMemory.seatCount && sourceMemory.seatCount > 0) {
                maxSeats = sourceMemory.seatCount;
            }
            else if (sourceMemory.seats && sourceMemory.seats.length > 0) {
                maxSeats = sourceMemory.seats.length;
            }

            for (var assignedIndex = 0; assignedIndex < sourceMemory.assignedMiner.length; assignedIndex++) {
                var assignedReference = sourceMemory.assignedMiner[assignedIndex];
                var assignedCreep = Game.getObjectById(assignedReference) || Game.creeps[assignedReference];

                if (!assignedCreep || !assignedCreep.my || !assignedCreep.memory) {
                    continue;
                }

                var assignedRole = assignedCreep.memory.role;
                var assignedTask = assignedCreep.memory.task;

                if (
                    assignedRole !== 'Extractor' &&
                    assignedRole !== 'Miner' &&
                    assignedTask !== 'Extractor' &&
                    assignedTask !== 'Miner' &&
                    assignedTask !== 'extractor' &&
                    assignedTask !== 'miner'
                ) {
                    continue;
                }

                if (
                    assignedCreep.memory.sourceId !== realSourceId &&
                    assignedCreep.memory.targetSourceId !== realSourceId &&
                    assignedCreep.memory.assignedSource !== realSourceId
                ) {
                    continue;
                }

                if (assignedCreep.memory.sourceRoom && assignedCreep.memory.sourceRoom !== roomName) {
                    continue;
                }

                if (assignedCreep.memory.targetRoom && assignedCreep.memory.targetRoom !== roomName) {
                    continue;
                }

                if (
                    !assignedCreep.memory.sourceRoom &&
                    !assignedCreep.memory.targetRoom &&
                    assignedCreep.memory.homeRoom &&
                    assignedCreep.memory.homeRoom !== roomName
                ) {
                    continue;
                }

                if (seenAssignedCreeps[assignedCreep.id]) {
                    continue;
                }

                seenAssignedCreeps[assignedCreep.id] = true;
                cleanAssignedMiners.push(assignedCreep.id);
                livingAssignedCount++;

                var assignedWorkParts = 0;

                if (typeof assignedCreep.getActiveBodyparts === 'function') {
                    assignedWorkParts = assignedCreep.getActiveBodyparts(WORK);
                }

                if (assignedWorkParts <= 0 && assignedCreep.spawning && assignedCreep.body) {
                    for (var bodyIndex = 0; bodyIndex < assignedCreep.body.length; bodyIndex++) {
                        if (assignedCreep.body[bodyIndex] && assignedCreep.body[bodyIndex].type === WORK) {
                            assignedWorkParts++;
                        }
                    }
                }

                totalAssignedWorkParts += assignedWorkParts;

                if (
                    assignedCreep.ticksToLive !== undefined &&
                    assignedCreep.ticksToLive <= EXTRACTOR_HANDOFF_TICKS
                ) {
                    hasDyingAssignedExtractor = true;
                }
                else {
                    healthyAssignedCount++;
                }
            }

            /*
             * Include living or spawning creeps that already have this targeted
             * source memory, even if assignedMiner has not caught up yet.
             * This closes the race between "request queued/spawned" and
             * "source memory list updated by the running creep."
             */
            for (var livingIndex = 0; livingIndex < homeLivingCreeps.length; livingIndex++) {
                var livingCreep = homeLivingCreeps[livingIndex];

                if (!livingCreep || !livingCreep.my || !livingCreep.memory) {
                    continue;
                }

                var livingRole = livingCreep.memory.role;
                var livingTask = livingCreep.memory.task;

                if (
                    livingRole !== 'Extractor' &&
                    livingRole !== 'Miner' &&
                    livingTask !== 'Extractor' &&
                    livingTask !== 'Miner' &&
                    livingTask !== 'extractor' &&
                    livingTask !== 'miner'
                ) {
                    continue;
                }

                if (
                    livingCreep.memory.sourceId !== realSourceId &&
                    livingCreep.memory.targetSourceId !== realSourceId &&
                    livingCreep.memory.assignedSource !== realSourceId
                ) {
                    continue;
                }

                if (livingCreep.memory.sourceRoom && livingCreep.memory.sourceRoom !== roomName) {
                    continue;
                }

                if (livingCreep.memory.targetRoom && livingCreep.memory.targetRoom !== roomName) {
                    continue;
                }

                if (
                    !livingCreep.memory.sourceRoom &&
                    !livingCreep.memory.targetRoom &&
                    livingCreep.memory.homeRoom &&
                    livingCreep.memory.homeRoom !== roomName
                ) {
                    continue;
                }

                if (seenAssignedCreeps[livingCreep.id]) {
                    continue;
                }

                seenAssignedCreeps[livingCreep.id] = true;
                cleanAssignedMiners.push(livingCreep.id);
                livingAssignedCount++;

                var livingWorkParts = 0;

                if (typeof livingCreep.getActiveBodyparts === 'function') {
                    livingWorkParts = livingCreep.getActiveBodyparts(WORK);
                }

                if (livingWorkParts <= 0 && livingCreep.spawning && livingCreep.body) {
                    for (var livingBodyIndex = 0; livingBodyIndex < livingCreep.body.length; livingBodyIndex++) {
                        if (livingCreep.body[livingBodyIndex] && livingCreep.body[livingBodyIndex].type === WORK) {
                            livingWorkParts++;
                        }
                    }
                }

                totalAssignedWorkParts += livingWorkParts;

                if (
                    livingCreep.ticksToLive !== undefined &&
                    livingCreep.ticksToLive <= EXTRACTOR_HANDOFF_TICKS
                ) {
                    hasDyingAssignedExtractor = true;
                }
                else {
                    healthyAssignedCount++;
                }
            }

            sourceMemory.assignedMiner = cleanAssignedMiners;

            var hasPendingSourceRequest = false;

            for (var queueIndex = 0; queueIndex < queue.length; queueIndex++) {
                var queuedRequest = queue[queueIndex];

                if (!queuedRequest) {
                    continue;
                }

                var queuedMemory = queuedRequest.memory || {};
                var queuedRole = queuedRequest.role || queuedMemory.role;
                var queuedTask = queuedRequest.task || queuedMemory.task;

                if (
                    queuedRole !== 'Extractor' &&
                    queuedRole !== 'Miner' &&
                    queuedTask !== 'Extractor' &&
                    queuedTask !== 'Miner' &&
                    queuedTask !== 'extractor' &&
                    queuedTask !== 'miner'
                ) {
                    continue;
                }

                var queuedRoom = (
                    queuedRequest.roomName ||
                    queuedMemory.sourceRoom ||
                    queuedMemory.targetRoom ||
                    queuedMemory.homeRoom ||
                    roomName
                );

                if (queuedRoom !== roomName) {
                    continue;
                }

                var queuedSourceId = (
                    queuedRequest.sourceId ||
                    queuedRequest.targetSourceId ||
                    queuedRequest.assignedSource ||
                    queuedMemory.sourceId ||
                    queuedMemory.targetSourceId ||
                    queuedMemory.assignedSource
                );

                if (queuedSourceId === realSourceId) {
                    hasPendingSourceRequest = true;
                    break;
                }
            }

            if (hasPendingSourceRequest) {
                continue;
            }

            var hasLiveContainer = sourceHasLiveContainer(realSourceId, sourceMemory);

            if (hasLiveContainer) {
                if (!containerSourceNeedsExtractor(
                    livingAssignedCount,
                    totalAssignedWorkParts,
                    hasDyingAssignedExtractor,
                    healthyAssignedCount
                )) {
                    continue;
                }
            }
            else if (
                livingAssignedCount >= maxSeats ||
                totalAssignedWorkParts >= SOURCE_WORK_TARGET
            ) {
                continue;
            }

            var addSourceResult = addSpawnRequest(roomName, {
                role: role,
                body: body,
                priority: priority,
                memory: {
                    role: role,
                    homeRoom: roomName,
                    sourceRoom: roomName,
                    targetRoom: roomName,
                    sourceId: realSourceId,
                    targetSourceId: realSourceId
                },
                requestedAt: Game.time
            }, options);

            if (!addSourceResult.ok) {
                break;
            }

            sourceRequestsAdded++;

            /* Fill one source assignment per tick instead of creating a wave. */
            break;
        }

        if (managedSourceCount > 0) {
            var remoteExtractorReport = requestRemoteExtractorsForRoom(
                room,
                body,
                priority - 1,
                sourceRequestsAdded > 0 ? 0 : 1,
                options
            );

            return {
                ok: true,
                role: role,
                requested: sourceRequestsAdded + (remoteExtractorReport.requested || 0),
                localRequested: sourceRequestsAdded,
                remoteRequested: remoteExtractorReport.requested || 0,
                healthy: healthyCount,
                queued: queuedCount,
                desired: desiredCount
            };
        }
    }

    if (role === 'Freighter') {
        var freighterQueue = spawnManager.getSpawnQueue(roomName);
        var totalPlannedFreighters = healthyCount + queuedCount;
        var missingFreighters = desiredCount - totalPlannedFreighters;
        var freightersAdded = 0;

        if (freighterQueue && missingFreighters > 0) {
            for (var freighterIndex = 0; freighterIndex < missingFreighters; freighterIndex++) {
                var addFreighterResult = addSpawnRequest(roomName, {
                    role: 'Freighter',
                    body: body,
                    priority: priority,
                    memory: {
                        role: 'Freighter',
                        homeRoom: roomName
                    },
                    requestedAt: Game.time
                }, options);

                if (!addFreighterResult.ok) {
                    break;
                }

                freightersAdded++;
            }
        }

        return {
            ok: true,
            role: role,
            requested: freightersAdded,
            healthy: healthyCount,
            queued: queuedCount,
            desired: desiredCount,
            replacementLeadTicks: replacementLeadTicks
        };
    }

    /*
     * This is the number we want the spawn queue to think about.
     *
     * If desired is 1 Foreman:
     * - healthy Foreman = 1, queued = 0 -> no request
     * - healthy Foreman = 0, queued = 0 -> queue 1
     * - healthy Foreman = 0, queued = 1 -> no extra spam
     */
    var plannedCount = healthyCount + queuedCount;
    var missingCount = desiredCount - plannedCount;

    if (missingCount <= 0) {
        return {
            ok: true,
            role: role,
            requested: 0,
            healthy: healthyCount,
            queued: queuedCount,
            desired: desiredCount
        };
    }

    var added = 0;

    for (var missingIndex = 0; missingIndex < missingCount; missingIndex++) {
        var memory = {
            role: role,
            homeRoom: roomName
        };
        if (options && options.memory) {
            for (var memoryKey in options.memory) {
                if (options.memory.hasOwnProperty(memoryKey)) {
                    memory[memoryKey] = options.memory[memoryKey];
                }
            }
        }

        var addResult = addSpawnRequest(roomName, {
            role: role,
            body: body,
            priority: priority,
            memory: memory,
            requestedAt: Game.time
        }, options);

        if (!addResult.ok) {
            break;
        }

        added++;
    }

    return {
        ok: true,
        role: role,
        requested: added,
        healthy: healthyCount,
        queued: queuedCount,
        desired: desiredCount,
        replacementLeadTicks: replacementLeadTicks
    };
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
function getHealthyRoleCount(room, role) {
    var body = creepBodyConfig.getBody(role, room);
    var replacementLeadTicks = getReplacementLeadTicks(role, body);

    return countHealthyCreeps(room.name, role, replacementLeadTicks);
}


function runStartupBootstrap(room, report) {
    /*
     * Startup order:
     * 1. Foreman first.
     * 2. Then two Extractors.
     * 3. Then two Freighters.
     * 4. Then one Tech.
     * 5. Then one Artificer.
     *
     * Important:
     * This checks healthy living creeps first.
     * Queued creeps should prevent duplicate requests,
     * but queued creeps should not trick startup into thinking the room is already alive.
     */

    if (getHealthyRoleCount(room, 'Foreman') < 1) {
        /*
         * Returning after one startup request keeps the queue focused. The room
         * gets its most important missing role first instead of queuing the full
         * mature-room target set while it is still recovering.
         */
        report.requests.push(requestRoleForRoom(room, 'Foreman', 1));
        return true;
    }

    if (getHealthyRoleCount(room, 'Extractor') < 2) {
        report.requests.push(requestRoleForRoom(room, 'Extractor', 2));
        return true;
    }

    if (getHealthyRoleCount(room, 'Freighter') < 2) {
        report.requests.push(requestRoleForRoom(room, 'Freighter', 2));
        return true;
    }

    if (getHealthyRoleCount(room, 'Tech') < 1) {
        report.requests.push(requestRoleForRoom(room, 'Tech', 1));
        return true;
    }
    if (getHealthyRoleCount(room, 'Artificer') < 1) {
        report.requests.push(requestRoleForRoom(room, 'Artificer', 1));
        return true;
    }

    return false;
}
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
var SOURCE_WORK_TARGET = 6;
var EXTRACTOR_HANDOFF_TICKS = 100;
var FREIGHTER_MAX_DESIRED_CARRY = 50;

function sourceHasLiveContainer(sourceId, sourceMemory) {
    if (!sourceId || !sourceMemory) {
        return false;
    }

    var source = Game.getObjectById(sourceId);

    if (!source || !source.pos) {
        return false;
    }

    if (sourceMemory.containerId) {
        var rememberedContainer = Game.getObjectById(sourceMemory.containerId);

        if (
            rememberedContainer &&
            rememberedContainer.structureType === STRUCTURE_CONTAINER &&
            rememberedContainer.pos.getRangeTo(source.pos) <= 1
        ) {
            return true;
        }

        sourceMemory.containerId = null;
    }

    var nearbyContainers = source.pos.findInRange(FIND_STRUCTURES, 1, {
        filter: function(structure) {
            return structure.structureType === STRUCTURE_CONTAINER;
        }
    });

    if (nearbyContainers.length === 0) {
        return false;
    }

    sourceMemory.containerId = nearbyContainers[0].id;
    return true;
}

function containerSourceNeedsExtractor(
    assignedCount,
    assignedWork,
    hasDyingExtractor,
    healthyAssignedCount
) {
    if (assignedCount <= 0) {
        return true;
    }

    /* A live container gets one primary miner and at most one replacement. */
    if (assignedCount >= 2) {
        return false;
    }

    if (assignedWork < SOURCE_WORK_TARGET) {
        return true;
    }

    return hasDyingExtractor && healthyAssignedCount === 0;
}

function countBodyParts(body, bodyPartType) {
    var count = 0;

    if (!body) {
        return count;
    }

    for (var i = 0; i < body.length; i++) {
        if (body[i] === bodyPartType) {
            count++;
        }
    }

    return count;
}

function getSourceSeatCount(source, sourceMemory) {
    if (sourceMemory) {
        if (sourceMemory.seatCount && sourceMemory.seatCount > 0) {
            return sourceMemory.seatCount;
        }

        if (sourceMemory.seats && sourceMemory.seats.length > 0) {
            return sourceMemory.seats.length;
        }
    }

    if (!source || !source.pos || !source.room) {
        return 1;
    }

    var terrain = source.room.getTerrain();
    var seats = 0;

    for (var x = source.pos.x - 1; x <= source.pos.x + 1; x++) {
        for (var y = source.pos.y - 1; y <= source.pos.y + 1; y++) {
            if (x < 0 || x > 49 || y < 0 || y > 49) {
                continue;
            }

            if (x === source.pos.x && y === source.pos.y) {
                continue;
            }

            if (terrain.get(x, y) !== TERRAIN_MASK_WALL) {
                seats++;
            }
        }
    }

    return Math.max(1, seats);
}

function getRememberedSourceMemory(roomName, sourceId) {
    var roomMemory = Memory.rooms && Memory.rooms[roomName];
    var sourcesMemory = roomMemory && roomMemory.sources;

    if (!sourcesMemory) {
        return null;
    }

    if (sourcesMemory[sourceId]) {
        return sourcesMemory[sourceId];
    }

    for (var key in sourcesMemory) {
        if (
            sourcesMemory.hasOwnProperty(key) &&
            sourcesMemory[key] &&
            sourcesMemory[key].id === sourceId
        ) {
            return sourcesMemory[key];
        }
    }

    return null;
}

function ensureLocalSourceMemory(roomName, sourceId) {
    if (!Memory.rooms) {
        Memory.rooms = {};
    }

    if (!Memory.rooms[roomName]) {
        Memory.rooms[roomName] = {};
    }

    if (!Memory.rooms[roomName].sources) {
        Memory.rooms[roomName].sources = {};
    }

    if (!Memory.rooms[roomName].sources[sourceId]) {
        Memory.rooms[roomName].sources[sourceId] = {
            id: sourceId,
            assignedMiner: []
        };
    }

    return Memory.rooms[roomName].sources[sourceId];
}

function ensureVisibleLocalSourceMemories(room) {
    if (!room) {
        return [];
    }

    var sources = room.find(FIND_SOURCES);

    for (var i = 0; i < sources.length; i++) {
        ensureLocalSourceMemory(room.name, sources[i].id);
    }

    return sources;
}

function getSourceMiningDemand(room) {
    var extractorBody = creepBodyConfig.getBody('Extractor', room);
    var bodyWork = Math.max(1, countBodyParts(extractorBody, WORK));
    var localSources = ensureVisibleLocalSourceMemories(room);
    var activeRemoteSources = room ?
        RemotePlanner.getActiveRemoteSourcesForHome(room.name) : [];
    var desiredWork = 0;

    for (var i = 0; i < localSources.length; i++) {
        var source = localSources[i];
        var sourceMemory = ensureLocalSourceMemory(room.name, source.id);
        var sourceWork = SOURCE_WORK_TARGET;

        /* Without a container, available mining seats cap useful miner bodies. */
        if (!sourceHasLiveContainer(source.id, sourceMemory)) {
            sourceWork = Math.min(
                SOURCE_WORK_TARGET,
                getSourceSeatCount(source, sourceMemory) * bodyWork
            );
        }

        desiredWork += sourceWork;
    }

    desiredWork += activeRemoteSources.length * SOURCE_WORK_TARGET;

    var livingWork = room ?
        countLivingRoleBodyParts(room.name, 'Extractor', WORK) : 0;
    var queuedWork = room ?
        countQueuedRoleBodyParts(room.name, 'Extractor', WORK) : 0;

    return {
        desiredWork: desiredWork,
        livingWork: livingWork,
        queuedWork: queuedWork,
        missingWork: Math.max(0, desiredWork - livingWork - queuedWork),
        localSources: localSources.length,
        activeRemoteSources: activeRemoteSources.length
    };
}

function countIdleFreighters(roomName) {
    var context = getActiveContext(roomName);

    if (context) {
        return context.idleFreighters;
    }

    var idle = 0;

    var indexedCreeps = TickIndex.get().creepsByHomeRoom.get(roomName) || [];
    for (var creepIndex = 0; creepIndex < indexedCreeps.length; creepIndex++) {
        var creep = indexedCreeps[creepIndex];
        if (!creep || !creep.memory || creep.memory.role !== 'Freighter') {
            continue;
        }

        var homeRoom = creep.memory.homeRoom || (creep.room && creep.room.name);
        if (homeRoom !== roomName || creep.memory.freighterJob) {
            continue;
        }

        var replacementLead = getReplacementLeadTicks('Freighter', creep.body || []);
        if (
            creep.ticksToLive !== undefined &&
            creep.ticksToLive <= replacementLead
        ) {
            continue;
        }

        var carriedEnergy = creep.store ? (creep.store[RESOURCE_ENERGY] || 0) : 0;
        if (!creep.memory.FreighterWorking && carriedEnergy === 0) {
            idle++;
        }
    }

    return idle;
}

function getFreighterCarryDemand(room) {
    var energyCapacity = room ? (room.energyCapacityAvailable || 300) : 300;
    var storageEnergy = room ? getStoredEnergy(room.storage) : 0;
    var baseLocalCarry;

    if (!room || !room.storage) {
        baseLocalCarry = energyCapacity >= 800 ? 8 :
            energyCapacity >= 550 ? 6 : 4;
    }
    else {
        baseLocalCarry = storageEnergy >= 100000 ? 12 :
            storageEnergy >= 20000 ? 10 : 8;
    }

    var activeSources = room ?
        RemotePlanner.getActiveRemoteSourcesForHome(room.name) : [];
    var remoteBacklog = 0;
    var remoteReservedCarry = 0;
    var worstHaulAge = 0;

    for (var i = 0; i < activeSources.length; i++) {
        var sourceInfo = activeSources[i];
        var sourceMemory = getRememberedSourceMemory(
            sourceInfo.roomName,
            sourceInfo.sourceId
        );
        var haul = sourceMemory && sourceMemory.haul;

        if (!haul) {
            continue;
        }

        var amount = typeof haul.amount === 'number' ? Math.max(0, haul.amount) : 0;
        var reserved = typeof haul.reservedCarry === 'number' ?
            Math.max(0, haul.reservedCarry) : 0;
        remoteBacklog += amount;
        remoteReservedCarry += reserved;

        if (amount > 0) {
            var age = haul.lastSeen > 0 ? Math.max(0, Game.time - haul.lastSeen) : 101;
            worstHaulAge = Math.max(worstHaulAge, age);
        }
    }

    var activeRemoteSources = activeSources.length;
    var remoteBaseCarry = activeRemoteSources * 4;
    var unreservedBacklog = Math.max(0, remoteBacklog - remoteReservedCarry);
    var backlogBonus = Math.min(12, Math.ceil(unreservedBacklog / 500) * 2);
    var ageBonus = worstHaulAge > 100 ? 4 : worstHaulAge > 50 ? 2 : 0;
    var desiredCarryParts = baseLocalCarry + remoteBaseCarry + backlogBonus + ageBonus;

    if (
        Memory.settings &&
        Memory.settings.upgradeRush === true &&
        getControllerContainerEnergy(room) < 1000
    ) {
        var desiredTechWork = getDesiredTechWork(room);

        if (desiredTechWork >= 8) {
            desiredCarryParts += Math.min(
                6,
                Math.ceil((desiredTechWork - 4) / 3)
            );
        }
    }

    var idleFreighters = room ? countIdleFreighters(room.name) : 0;
    var safeMinimum = baseLocalCarry + remoteBaseCarry;
    var lowStorageRemoteRecovery = room && room.storage &&
        storageEnergy < 10000 && activeRemoteSources > 0;

    if (
        idleFreighters >= 2 &&
        unreservedBacklog < 250 &&
        worstHaulAge <= 50 &&
        !lowStorageRemoteRecovery
    ) {
        desiredCarryParts -= Math.min(4, (idleFreighters - 1) * 2);
    }

    desiredCarryParts = Math.max(safeMinimum, desiredCarryParts);
    desiredCarryParts = Math.min(FREIGHTER_MAX_DESIRED_CARRY, desiredCarryParts);

    var livingCarryParts = room ?
        countLivingRoleBodyParts(room.name, 'Freighter', CARRY) : 0;
    var queuedCarryParts = room ?
        countQueuedRoleBodyParts(room.name, 'Freighter', CARRY) : 0;

    return {
        desiredCarryParts: desiredCarryParts,
        livingCarryParts: livingCarryParts,
        queuedCarryParts: queuedCarryParts,
        missingCarryParts: Math.max(
            0,
            desiredCarryParts - livingCarryParts - queuedCarryParts
        ),
        remoteBacklog: remoteBacklog,
        remoteReservedCarry: remoteReservedCarry,
        worstHaulAge: worstHaulAge,
        idleFreighters: idleFreighters,
        activeRemoteSources: activeRemoteSources
    };
}

function saveExtractorDemandDebug(roomName, demand) {
    if (!Memory.rooms) {
        Memory.rooms = {};
    }

    if (!Memory.rooms[roomName]) {
        Memory.rooms[roomName] = {};
    }

    var roomMemory = Memory.rooms[roomName];
    roomMemory.extractorDesiredWork = demand.desiredWork;
    roomMemory.extractorLivingWork = demand.livingWork;
    roomMemory.extractorQueuedWork = demand.queuedWork;
}

function saveFreighterDemandDebug(roomName, demand) {
    if (!Memory.rooms) {
        Memory.rooms = {};
    }

    if (!Memory.rooms[roomName]) {
        Memory.rooms[roomName] = {};
    }

    var roomMemory = Memory.rooms[roomName];
    roomMemory.freighterDesiredCarry = demand.desiredCarryParts;
    roomMemory.freighterLivingCarry = demand.livingCarryParts;
    roomMemory.freighterQueuedCarry = demand.queuedCarryParts;
    roomMemory.freighterRemoteBacklog = demand.remoteBacklog;
    roomMemory.freighterWorstHaulAge = demand.worstHaulAge;
}

function getEconomyRequestPriorities(miningDemand, freightDemand) {
    var miningPressure = miningDemand.desiredWork > 0 ?
        miningDemand.missingWork / miningDemand.desiredWork : 0;
    var freightPressure = freightDemand.desiredCarryParts > 0 ?
        freightDemand.missingCarryParts / freightDemand.desiredCarryParts : 0;
    var unreservedBacklog = Math.max(
        0,
        freightDemand.remoteBacklog - freightDemand.remoteReservedCarry
    );

    freightPressure += Math.min(0.5, unreservedBacklog / 2000);
    freightPressure += freightDemand.worstHaulAge > 100 ? 0.4 :
        freightDemand.worstHaulAge > 50 ? 0.2 : 0;

    var highPriority = Math.max(PRIORITY.Extractor, PRIORITY.Freighter) + 2;
    var lowPriority = highPriority - 4;

    return {
        extractor: miningPressure >= freightPressure ? highPriority : lowPriority,
        freighter: freightPressure > miningPressure ? highPriority : lowPriority
    };
}

function requestDynamicExtractorsForRoom(room, priorityOverride, demandOverride, options) {
    var demand = demandOverride || getSourceMiningDemand(room);
    var requestPriority = priorityOverride;

    if (typeof requestPriority !== 'number') {
        var freightDemand = getFreighterCarryDemand(room);
        requestPriority = getEconomyRequestPriorities(
            demand,
            freightDemand
        ).extractor;
    }
    var body = creepBodyConfig.getBody('Extractor', room);
    var bodyWork = Math.max(1, countBodyParts(body, WORK));
    var targetCount = Math.ceil(demand.desiredWork / bodyWork);
    var replacementLead = getReplacementLeadTicks('Extractor', body);
    var healthyCount = countHealthyCreeps(room.name, 'Extractor', replacementLead);
    var queuedCount = countQueuedRequests(room.name, 'Extractor');
    var nextCount = Math.min(targetCount, healthyCount + queuedCount + 1);
    var requestResult = {
        ok: true,
        role: 'Extractor',
        requested: 0,
        localRequested: 0,
        remoteRequested: 0
    };

    if (demand.desiredWork > 0 && nextCount > 0) {
        requestResult = requestRoleForRoom(
            room,
            'Extractor',
            nextCount,
            requestPriority,
            options
        );
    }

    demand.queuedWork = countQueuedRoleBodyParts(room.name, 'Extractor', WORK);
    demand.missingWork = Math.max(
        0,
        demand.desiredWork - demand.livingWork - demand.queuedWork
    );
    saveExtractorDemandDebug(room.name, demand);

    return {
        ok: requestResult.ok,
        role: 'Extractor',
        requested: requestResult.requested || 0,
        localRequested: requestResult.localRequested || 0,
        remoteRequested: requestResult.remoteRequested || 0,
        desiredWork: demand.desiredWork,
        livingWork: demand.livingWork,
        queuedWork: demand.queuedWork,
        missingWork: demand.missingWork
    };
}

function requestDynamicFreightersForRoom(room, priorityOverride, demandOverride, options) {
    var demand = demandOverride || getFreighterCarryDemand(room);
    var requestPriority = priorityOverride;

    if (typeof requestPriority !== 'number') {
        var miningDemand = getSourceMiningDemand(room);
        requestPriority = getEconomyRequestPriorities(
            miningDemand,
            demand
        ).freighter;
    }
    var result = {
        ok: true,
        role: 'Freighter',
        requested: 0,
        desiredCarryParts: demand.desiredCarryParts,
        livingCarryParts: demand.livingCarryParts,
        queuedCarryParts: demand.queuedCarryParts,
        missingCarryParts: demand.missingCarryParts,
        requestedCarryParts: 0
    };

    if (demand.missingCarryParts > 0) {
        var body = creepBodyConfig.getFreighterBodyForCarry(
            room,
            demand.missingCarryParts
        );
        var requestedCarry = countBodyParts(body, CARRY);

        if (!body || requestedCarry <= 0) {
            result.ok = false;
            result.reason = 'No Freighter body or spawn queue available';
        }
        else {
            var addResult = addSpawnRequest(room.name, {
                role: 'Freighter',
                body: body,
                requestedCarryParts: requestedCarry,
                maxCarryParts: requestedCarry,
                priority: requestPriority,
                memory: {
                    role: 'Freighter',
                    homeRoom: room.name
                },
                requestedAt: Game.time
            }, options);

            if (!addResult.ok) {
                result.ok = false;
                result.reason = addResult.reason;
                saveFreighterDemandDebug(room.name, demand);
                return result;
            }

            result.requested = 1;
            result.requestedCarryParts = requestedCarry;
            demand.queuedCarryParts += requestedCarry;
            demand.missingCarryParts = Math.max(
                0,
                demand.desiredCarryParts - demand.livingCarryParts - demand.queuedCarryParts
            );
            result.queuedCarryParts = demand.queuedCarryParts;
            result.missingCarryParts = demand.missingCarryParts;
        }
    }

    saveFreighterDemandDebug(room.name, demand);
    return result;
}

function refreshSpawnDemandCache(room, context) {
    var cache = context.demandCache;

    cache.tick = Game.time;
    cache.miningDemand = getSourceMiningDemand(room);
    cache.freightDemand = getFreighterCarryDemand(room);
    cache.techDemand = getTechWorkDemand(room);
    cache.artificerDemand = getArtificerBuildDemand(room);

    /*
     * These totals are built from the shared TickIndex room slice.
     * Keeping a Memory copy makes console inspection cheap.
     */
    cache.roleBodyPartTotals = context.bodyPartsByRole;
    cache.queuedRoleBodyPartTotals = context.queuedBodyPartsByRole;

    setNextFullPlanTick(cache, context.cpuPolicy, context.roomIndex);
    return cache;
}

function getCachedSpawnDemand(roomName) {
    return getSpawnDemandCache(roomName);
}

function requestEmergencyTechForRoom(room) {
    var result = {
        ok: true,
        role: 'Tech',
        requested: 0,
        emergency: true
    };

    if (
        !room ||
        !room.controller ||
        room.controller.ticksToDowngrade >= TECH_DOWNGRADE_DANGER_TICKS
    ) {
        result.reason = 'Controller is not in downgrade danger';
        return result;
    }

    var emergencyMinimum = (room.energyCapacityAvailable || 300) >= 550 ? 5 : 2;
    var livingWork = countLivingRoleWork(room.name, 'Tech');
    var queuedWork = countQueuedRoleWork(room.name, 'Tech');
    var demand = {
        desiredWork: emergencyMinimum,
        livingWork: livingWork,
        queuedWork: queuedWork,
        missingWork: Math.max(0, emergencyMinimum - livingWork - queuedWork)
    };

    if (demand.missingWork <= 0) {
        result.reason = 'Emergency Tech WORK is already planned';
        return result;
    }

    return requestTechWorkForRoom(room, demand, {
        emergency: true,
        bypassRoleCap: true
    });
}

function runEmergencyPlanning(room, report, context) {
    var emergencyOptions = {
        emergency: true,
        bypassRoleCap: true
    };

    if (getPlannedRoleCount(context, 'Foreman') < 1) {
        report.requests.push(requestRoleForRoom(
            room,
            'Foreman',
            1,
            PRIORITY.Foreman,
            emergencyOptions
        ));
    }

    if (context.healthyLocalExtractors + context.queuedLocalExtractors < 1) {
        /* Missing local income is one of the few light-pass cases allowed to
         * scan visible sources so the queued miner gets a concrete source id.
         */
        ensureVisibleLocalSourceMemories(room);
        report.requests.push(requestRoleForRoom(
            room,
            'Extractor',
            1,
            PRIORITY.Extractor + 10,
            emergencyOptions
        ));
    }

    if (getPlannedRoleCount(context, 'Freighter') < 1) {
        report.requests.push(requestRoleForRoom(
            room,
            'Freighter',
            1,
            PRIORITY.Freighter + 10,
            emergencyOptions
        ));
    }

    if (
        room.controller &&
        room.controller.ticksToDowngrade < TECH_DOWNGRADE_DANGER_TICKS
    ) {
        report.requests.push(requestEmergencyTechForRoom(room));
    }

    report.defense = requestDefendersForRoom(room, context);
}

function cleanDefenseQueue(roomName, demand) {
    var queue = spawnManager.getSpawnQueue(roomName) || [];
    var desired = {
        Ronin: demand.desiredMelee,
        Volley: demand.desiredRanged,
        Cleric: demand.desiredHealers
    };
    var removed = 0;
    for (var i = queue.length - 1; i >= 0; i--) {
        var request = queue[i];
        var role = getRequestRole(request);
        var memory = request && request.memory || {};
        if (!desired.hasOwnProperty(role)) continue;
        var belongsToDefense = memory.defenseRequest === true ||
            (!memory.operationId && !memory.manualCombat);
        if (belongsToDefense && (!desired[role] || demand.harmfulHostileCount <= 0)) {
            queue.splice(i, 1);
            removed++;
        }
    }
    return removed;
}

function requestDefendersForRoom(room, context) {
    var demand = defenseDemand.getDemand(room);
    var result = {
        roomName: room && room.name,
        demand: demand,
        requests: [],
        removedStaleRequests: 0
    };
    if (!room || !demand) return result;
    result.removedStaleRequests = cleanDefenseQueue(room.name, demand);
    if (demand.harmfulHostileCount <= 0) return result;
    var demandMemory = {
            defenseRequest: true,
            defendedRoom: room.name,
            targetRoom: room.name,
            operationId: demand.operationId,
            defenseRequestedAt: Game.time,
            trafficPriority: demand.emergency ? 100 : 80
    };
    function emitDefenseRole(role, count, priority) {
        if (count <= 0) return null;
        return DemandBoard.emit({
            id: demand.operationId + ':' + role,
            operationId: demand.operationId,
            role: role,
            count: count,
            priority: priority,
            originRoom: room.name,
            preferredSpawnRoom: room.name,
            targetRoom: room.name,
            emergency: demand.emergency,
            validUntil: Game.time + 5,
            memory: demandMemory,
            reason: 'Dynamic room defense'
        });
    }
    var squadVolley = SquadController.getCommittedRoleCount(demand.operationId, 'Volley');
    var squadCleric = SquadController.getCommittedRoleCount(demand.operationId, 'Cleric');
    var independentRanged = Math.max(0, demand.desiredRanged - squadVolley);
    var independentHealers = Math.max(0, demand.desiredHealers - squadCleric);
    if (demand.desiredMelee > 0) {
        result.requests.push(emitDefenseRole('Ronin', demand.desiredMelee, demand.priority));
    }
    if (independentRanged > 0) {
        result.requests.push(emitDefenseRole('Volley', independentRanged, demand.priority + 1));
    }
    if (independentHealers > 0 && demand.desiredMelee + demand.desiredRanged > 0) {
        result.requests.push(emitDefenseRole('Cleric', independentHealers, demand.priority));
    }
    return result;
}

function saveSpawnGovernorDebug(context) {
    var roomMemory = ensureRoomMemory(context.roomName);
    var policy = context.spawnPolicy;
    var cpuUsed = getCpuUsed() - context.cpuStart;

    context.demandCache.roleSummaryTick = Game.time;
    context.demandCache.roleBodyPartTotals = context.bodyPartsByRole;
    context.demandCache.queuedRoleBodyPartTotals = context.queuedBodyPartsByRole;

    roomMemory.spawnGovernor = {
        tick: Game.time,
        fullPlan: context.fullPlan,
        skippedForCpu: context.skippedForCpu,
        cpuUsed: Math.round(cpuUsed * 1000) / 1000,
        totalLiving: context.totalLiving,
        totalQueued: context.totalQueued,
        maxCreeps: getMaxCreepsForRoom(context.room, policy),
        queueLength: context.queue ? context.queue.length : 0,
        maxQueueLength: policy.maxQueueLengthPerRoom,
        denied: context.denied
    };
}

function countQueuedSeason11Assignment(roomName, assignmentKey) {
    var queue = spawnManager.getSpawnQueue(roomName) || [];
    var count = 0;

    for (var i = 0; i < queue.length; i++) {
        if (
            queue[i] &&
            queue[i].memory &&
            queue[i].memory.season11AssignmentKey === assignmentKey
        ) {
            count++;
        }
    }
    return count;
}

function countHealthySeason11Assignment(roomName, plan) {
    var count = 0;
    var creeps = getHomeLivingCreeps(roomName);

    for (var i = 0; i < creeps.length; i++) {
        var creep = creeps[i];
        if (
            !creep || !creep.memory ||
            creep.memory.season11AssignmentKey !== plan.assignmentKey
        ) {
            continue;
        }

        var lead = getReplacementLeadTicks(plan.role, creep.body || []);
        var routeDistance = Number(creep.memory.season11RouteDistance) || 0;
        if (plan.role === 'ThoriumMiner') {
            routeDistance *= 50;
        }
        lead += Math.min(1000, Math.max(0, routeDistance));

        if (creep.ticksToLive === undefined || creep.ticksToLive > lead) {
            count++;
        }
    }
    return count;
}

function requestSeason11RolesForRoom(room) {
    var result = {
        ok: true,
        role: 'Season11',
        requested: 0,
        plans: []
    };
    var plans = Season11.getSpawnPlanForRoom(room);

    for (var i = 0; i < plans.length; i++) {
        var plan = plans[i];
        var body = plan.role === 'ThoriumHauler' ?
            creepBodyConfig.getThoriumHaulerBodyForCarry(
                room,
                plan.requestedCarryParts || 1
            ) : creepBodyConfig.getBody(plan.role, room);
        var healthy = countHealthySeason11Assignment(room.name, plan);
        var queued = countQueuedSeason11Assignment(
            room.name,
            plan.assignmentKey
        );
        var planReport = {
            role: plan.role,
            assignmentKey: plan.assignmentKey,
            desired: plan.desired,
            healthy: healthy,
            queued: queued,
            requested: 0
        };

        if (!body || body.length === 0) {
            planReport.reason = 'No affordable configured body';
            result.ok = false;
            result.plans.push(planReport);
            continue;
        }

        var operationId = 'season11:' + plan.assignmentKey;
        var emitted = DemandBoard.emit({
            id: operationId + ':' + plan.role,
            operationId: operationId,
            role: plan.role,
            count: plan.desired,
            priority: typeof plan.priority === 'number' ?
                plan.priority : (PRIORITY[plan.role] || 0),
            originRoom: room.name,
            preferredSpawnRoom: room.name,
            targetRoom: plan.memory && (
                plan.memory.season11ThoriumRoom ||
                plan.memory.season11ReactorRoom
            ),
            bodyRequirements: { body: body },
            replacementBuffer: getReplacementLeadTicks(plan.role, body),
            validUntil: Game.time + 10,
            emergency: plan.emergency === true,
            memory: Object.assign({
                role: plan.role,
                homeRoom: room.name
            }, plan.memory || {}),
            reason: 'Season 11 assignment ' + plan.assignmentKey
        });
        planReport.demandId = emitted.id;
        planReport.requested = Math.max(0, plan.desired - healthy - queued);
        result.requested += planReport.requested;
        result.plans.push(planReport);
    }
    return result;
}

/**
 * Run spawn requests for one visible owned spawn room.
 *
 * @param {Room} room
 * @returns {object}
 */
function runForRoom(room, options) {
    var report = {
        roomName: room ? room.name : null,
        requests: []
    };

    if (!room) {
        report.ok = false;
        report.reason = 'Missing room';
        return report;
    }

    if (!room.controller || !room.controller.my) {
        report.ok = false;
        report.reason = 'Room is not owned';
        return report;
    }

    if (!roomHasOwnedSpawn(room)) {
        report.ok = false;
        report.reason = 'Room has no owned spawn';
        return report;
    }

    report.ok = true;
    options = options || {};

    var context = buildRoomPlanningContext(
        room,
        options.roomIndex || 0,
        options.skipNormalPlanning === true
    );
    var previousContext = activePlanningContext;
    activePlanningContext = context;

    try {
        report.fullPlan = context.fullPlan;
        report.skippedForCpu = context.skippedForCpu;
        report.nextFullPlanTick = context.demandCache.nextFullPlanTick || null;

        runEmergencyPlanning(room, report, context);

        if (context.skippedForCpu) {
            report.reason = 'Normal spawn planning skipped by CPU budget';

            if (
                typeof context.demandCache.nextFullPlanTick === 'number' &&
                Game.time >= context.demandCache.nextFullPlanTick
            ) {
                setNextFullPlanTick(
                    context.demandCache,
                    context.cpuPolicy,
                    context.roomIndex
                );
                report.nextFullPlanTick = context.demandCache.nextFullPlanTick;
            }

            return report;
        }

        if (!context.fullPlan) {
            var cachedDemand = getCachedSpawnDemand(room.name);
            report.reason = 'Light spawn planning pass';
            report.cachedDemandTick = cachedDemand.tick || null;
            return report;
        }

        /*
         * A full pass refreshes dynamic demand, then normal request systems may
         * queue work through the governor. Light passes use this cached demand
         * only for debug and emergency context.
         */
        var demandCache = refreshSpawnDemandCache(room, context);

        if (runStartupBootstrap(room, report)) {
            return report;
        }

        /*
         * Foreman first.
         *
         * This matters because Foreman has the highest priority and should always
         * be considered before the other roles.
         */
        report.requests.push(requestRoleForRoom(room, 'Foreman', DESIRED_COUNTS.Foreman));

        var miningDemand = demandCache.miningDemand;
        var freightDemand = demandCache.freightDemand;
        var economyPriorities = getEconomyRequestPriorities(
            miningDemand,
            freightDemand
        );

        report.requests.push(requestDynamicExtractorsForRoom(
            room,
            economyPriorities.extractor,
            miningDemand
        ));
        report.requests.push(requestDynamicFreightersForRoom(
            room,
            economyPriorities.freighter,
            freightDemand
        ));
        report.requests.push(requestAnnexForRoom(room));
        report.requests.push(requestTechWorkForRoom(room, demandCache.techDemand));
        report.requests.push(requestDynamicArtificersForRoom(
            room,
            demandCache.artificerDemand
        ));
        report.requests.push(requestSeason11RolesForRoom(room));
        report.requests.push(requestRoleForRoom(room, 'Scout', DESIRED_COUNTS.Scout));

        return report;
    }
    finally {
        saveSpawnGovernorDebug(context);
        activePlanningContext = previousContext;
    }
}

/**
 * Run spawn requests for every visible owned room that has an owned spawn.
 *
 * @returns {object}
 */
function run() {
    var rooms = getOwnedSpawnRooms();
    var cpuPolicy = ensureCpuPolicyMemory();
    var spawnPolicy = ensureSpawnPolicyMemory();
    var cpuStatus = cpuStatusUtility.getCpuStatus();
    var startCpu = getCpuUsed();
    var planningScale = cpuStatus.mode === 'high' ?
        Math.min(2.5, Math.max(1, cpuStatus.limit / 20)) :
        cpuStatus.mode === 'critical' ? 0.5 : 1;
    var budget = Math.max(0.25, Math.min(
        cpuStatus.remaining,
        cpuPolicy.spawnPlanningCpuBudget * planningScale
    ));
    var skipNormalPlanning = cpuStatus.mode === 'critical';
    var report = {
        rooms: {},
        cpuBudget: budget,
        cpuMode: cpuStatus.mode,
        cpuLimit: cpuStatus.limit,
        spawnPolicyEnabled: spawnPolicy.enabled !== false
    };

    rooms.sort(function(a, b) {
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });

    for (var i = 0; i < rooms.length; i++) {
        if (getCpuUsed() - startCpu > budget) {
            skipNormalPlanning = true;
        }

        var roomReport = runForRoom(rooms[i], {
            roomIndex: i,
            skipNormalPlanning: skipNormalPlanning
        });

        if (roomReport && roomReport.roomName) {
            report.rooms[roomReport.roomName] = roomReport;
        }

        if (getCpuUsed() - startCpu > budget) {
            skipNormalPlanning = true;
        }
    }

    report.cpuUsed = Math.round((getCpuUsed() - startCpu) * 1000) / 1000;
    return report;
}

module.exports = {
    run: run,
    runForRoom: runForRoom,
    runRoom: runForRoom,

    /*
     * Exporting these helps testing from console later.
     */
    getOwnedSpawnRooms: getOwnedSpawnRooms,
    requestRoleForRoom: requestRoleForRoom,
    requestTechWorkForRoom: requestTechWorkForRoom,
    getTechWorkDemand: getTechWorkDemand,
    getArtificerBuildDemand: getArtificerBuildDemand,
    saveArtificerDemandDebug: saveArtificerDemandDebug,
    requestDynamicArtificersForRoom: requestDynamicArtificersForRoom,
    countHealthyCreeps: countHealthyCreeps,
    countLivingRoleBodyParts: countLivingRoleBodyParts,
    countQueuedRoleBodyParts: countQueuedRoleBodyParts,
    countLivingRoleWork: countLivingRoleWork,
    countQueuedRoleWork: countQueuedRoleWork,
    countBodyParts: countBodyParts,
    getSourceMiningDemand: getSourceMiningDemand,
    getFreighterCarryDemand: getFreighterCarryDemand,
    getDesiredTechWork: getDesiredTechWork,
    getCpuStatus: cpuStatusUtility.getCpuStatus,
    getReplacementLeadTicks: getReplacementLeadTicks,
    requestDynamicExtractorsForRoom: requestDynamicExtractorsForRoom,
    requestDynamicFreightersForRoom: requestDynamicFreightersForRoom,
    requestRemoteExtractorsForRoom: requestRemoteExtractorsForRoom,
    requestAnnexForRoom: requestAnnexForRoom,
    requestSeason11RolesForRoom: requestSeason11RolesForRoom,
    requestDefendersForRoom: requestDefendersForRoom,
    cleanDefenseQueue: cleanDefenseQueue
};
