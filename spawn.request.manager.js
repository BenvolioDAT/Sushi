/*
 * spawn.request.manager.js
 *
 * This file decides what creeps the room should request.
 *
 * It does not directly spawn creeps.
 * It asks spawn.manager.js to queue the creeps.
 *
 * Current simple setup:
 * - Uses Spawn1's room as the room to manage.
 * - Later we can make this loop all owned rooms.
 */

var spawnManager = require('spawn.manager');
var creepBodyConfig = require('role.creepBodyConfig');
var RemotePlanner = require('Planner.Remote');

var RESERVE_DESIRED_TICKS = 4000;
var RESERVE_SPAWN_AT_TICKS = 2500;
var ANNEX_LIVING_MIN_TTL = 100;
var TECH_DOWNGRADE_DANGER_TICKS = 5000;
var TECH_MAX_DESIRED_WORK = 24;
var TECH_RCL8_MAX_WORK = 15;

/*
 * How many creeps we want for now.
 *
 * Later, room.manager.js can calculate these numbers dynamically.
 */
var DESIRED_COUNTS = {
    Foreman: 1,
    Extractor: 6,
    Freighter: 4,
    /*
     * Annex uses this as a maximum cap, not a fixed desired count. It only
     * spawns when an active remote room needs controller reservation help.
     */
    Annex: 6,
    ScoreRunner: 0,
    Artificer: 2,
    Scout: 1,
    Ronin: 1,
    Volley: 1,
    Cleric: 1
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
    ScoreRunner: 5,
    Tech: 30,
    Artificer: 20,
    Scout: 10,
    Ronin: 15,
    Volley: 15,
    Cleric: 16,
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
    Scout: 10,
    Ronin: 40,
    Volley: 40,
    Cleric: 40,
    ScoreRunner: 20
};

/*
 * This manager is the "demand planner" for spawning.
 *
 * It deliberately does not call spawn.spawnCreep directly. Instead, it writes
 * requests into Memory.rooms[roomName].spawnQueue and lets spawn.manager.js be
 * the single place that actually consumes the queue. Keeping demand planning
 * separate from spawning makes it easier to reason about duplicate requests.
 */

/**
 * Get the first spawn we own.
 *
 * For now, this lets us avoid hard-coding:
 *
 * Game.spawns['Spawn1']
 *
 * If you only have Spawn1, this returns Spawn1.
 *
 * Later, we can replace this with room manager logic.
 *
 * @returns {StructureSpawn|null}
 */
function getFirstSpawn() {
    /*
     * Game.spawns is an object keyed by spawn name. This loop returns the first
     * owned spawn it finds, which is enough while Sushi manages one main room.
     */
    for (var spawnName in Game.spawns) {
        if (!Game.spawns.hasOwnProperty(spawnName)) {
            continue;
        }

        return Game.spawns[spawnName];
    }

    return null;
}

/**
 * Get the room we are managing for now.
 *
 * Current simple rule:
 * - use the first spawn's room
 *
 * @returns {Room|null}
 */
function getManagedRoom() {
    var spawn = getFirstSpawn();

    /*
     * If there are no spawns, there is no owned room anchor for this simple
     * manager yet, so return null and let run() exit quietly.
     */
    if (!spawn || !spawn.room) {
        return null;
    }

    return spawn.room;
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
    var count = 0;

    /*
     * Loop through living creeps and count only matching role/homeRoom creeps
     * that are not too close to death.
     */
    for (var creepName in Game.creeps) {
        if (!Game.creeps.hasOwnProperty(creepName)) {
            continue;
        }

        var creep = Game.creeps[creepName];

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

function getConstructionSiteCount(room) {
    if (!room) {
        return 0;
    }

    var sites = room.find(FIND_CONSTRUCTION_SITES);
    return sites ? sites.length : 0;
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
    var constructionSites = getConstructionSiteCount(room);

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

    desiredWork = Math.max(2, Math.min(desiredWork, TECH_MAX_DESIRED_WORK));

    /* RCL 8 controllers accept at most 15 normal upgrade energy per tick. */
    if (level === 8) {
        desiredWork = Math.min(desiredWork, TECH_RCL8_MAX_WORK);
    }

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

function countLivingRoleWork(roomName, role) {
    var work = 0;

    for (var creepName in Game.creeps) {
        if (!Game.creeps.hasOwnProperty(creepName)) {
            continue;
        }

        var creep = Game.creeps[creepName];

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

        work += getCreepActiveBodyParts(creep, WORK);
    }

    return work;
}

function countQueuedRoleWork(roomName, role) {
    var queue = spawnManager.getSpawnQueue(roomName);
    var work = 0;

    if (!queue) {
        return work;
    }

    for (var i = 0; i < queue.length; i++) {
        var request = queue[i];
        var requestRole = request && (request.role ||
            (request.memory && request.memory.role));

        if (requestRole === role) {
            work += countBodyParts(request.body, WORK);
        }
    }

    return work;
}

function saveTechWorkDebug(roomName, desiredWork, livingWork, queuedWork) {
    if (!Memory.rooms) {
        Memory.rooms = {};
    }

    if (!Memory.rooms[roomName]) {
        Memory.rooms[roomName] = {};
    }

    Memory.rooms[roomName].techDesiredWork = desiredWork;
    Memory.rooms[roomName].techLivingWork = livingWork;
    Memory.rooms[roomName].techQueuedWork = queuedWork;
}

function requestTechWorkForRoom(room) {
    if (!room) {
        return {
            ok: false,
            role: 'Tech',
            requested: 0,
            reason: 'Missing room'
        };
    }

    var desiredWork = getDesiredTechWork(room);
    var livingWork = countLivingRoleWork(room.name, 'Tech');
    var queuedWork = countQueuedRoleWork(room.name, 'Tech');
    var missingWork = desiredWork - livingWork - queuedWork;
    var result = {
        ok: true,
        role: 'Tech',
        requested: 0,
        desiredWork: desiredWork,
        livingWork: livingWork,
        queuedWork: queuedWork,
        missingWork: Math.max(0, missingWork)
    };

    saveTechWorkDebug(room.name, desiredWork, livingWork, queuedWork);

    if (missingWork <= 0) {
        return result;
    }

    var body = creepBodyConfig.getTechBodyForWork(room, missingWork);
    var requestedWork = countBodyParts(body, WORK);
    var queue = spawnManager.getSpawnQueue(room.name);

    if (!body || requestedWork <= 0 || !queue) {
        result.ok = false;
        result.reason = 'No Tech body or spawn queue available';
        return result;
    }

    /* Add exactly one Tech request per tick. Later ticks can fill more WORK. */
    queue.push({
        role: 'Tech',
        body: body,
        maxWorkParts: requestedWork,
        priority: PRIORITY.Tech,
        memory: {
            role: 'Tech',
            homeRoom: room.name
        },
        requestedAt: Game.time
    });
    sortSpawnQueue(queue);

    result.requested = 1;
    result.requestedWork = requestedWork;
    result.queuedWork += requestedWork;
    saveTechWorkDebug(room.name, desiredWork, livingWork, result.queuedWork);

    return result;
}


function requestRemoteExtractorsForRoom(room, extractorBody, priority) {
    var queue = spawnManager.getSpawnQueue(room.name);
    var demands = RemotePlanner.getRemoteExtractorDemand(room.name, extractorBody, queue);
    var added = 0;

    if (!queue || !demands || demands.length === 0) {
        return {
            ok: true,
            role: 'Extractor',
            requested: 0,
            remote: true
        };
    }

    for (var i = 0; i < demands.length; i++) {
        var demand = demands[i];

        /*
         * Queue one source-targeted normal Extractor. remoteMining is assignment
         * state only, and Planner.Remote caps each remote source at one Extractor.
         */
        queue.push({
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
        });

        added++;
    }

    sortSpawnQueue(queue);

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
    for (var creepName in Game.creeps) {
        if (!Game.creeps.hasOwnProperty(creepName)) {
            continue;
        }

        if (isLivingAnnexForHome(Game.creeps[creepName], room.name)) {
            livingAnnexes.push(Game.creeps[creepName]);
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

        queue.push({
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
        sortSpawnQueue(queue);

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
 * @returns {object}
 */
function requestRoleForRoom(room, role, desiredCount) {
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
    var priority = PRIORITY[role] || 0;
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
            for (var creepName in Game.creeps) {
                if (!Game.creeps.hasOwnProperty(creepName)) {
                    continue;
                }

                var livingCreep = Game.creeps[creepName];

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

            queue.push({
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
            });

            sourceRequestsAdded++;
        }

        if (managedSourceCount > 0) {
            queue.sort(function(a, b) {
                if (b.priority !== a.priority) {
                    return b.priority - a.priority;
                }

                return a.requestedAt - b.requestedAt;
            });

            var remoteExtractorReport = requestRemoteExtractorsForRoom(room, body, priority - 1);

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
                freighterQueue.push({
                    role: 'Freighter',
                    body: body,
                    priority: priority,
                    memory: {
                        role: 'Freighter',
                        homeRoom: roomName
                    },
                    requestedAt: Game.time
                });
                freightersAdded++;
            }

            sortSpawnQueue(freighterQueue);
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

    /*
     * Ask spawn.manager.js to maintain enough creeps.
     *
     * Important:
     * We pass healthyCount + missingCount as the target instead of desiredCount.
     *
     * Why?
     * spawn.manager.js may count dying creeps as alive.
     * This request manager is the smarter layer that knows dying creeps
     * should stop counting when they are close to death.
     */
    var requestResult = spawnManager.requestRoleCount(
        roomName,
        role,
        healthyCount + missingCount,
        body,
        priority,
        {
            homeRoom: roomName
        }
    );

    return {
        ok: requestResult.ok,
        role: role,
        requested: requestResult.added || 0,
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


function getPlannedRoleCount(room, role) {
    var body = creepBodyConfig.getBody(role, room);
    var replacementLeadTicks = getReplacementLeadTicks(role, body);

    var healthyCount = countHealthyCreeps(room.name, role, replacementLeadTicks);
    var queuedCount = countQueuedRequests(room.name, role);

    return healthyCount + queuedCount;
}

function runStartupBootstrap(room, report) {
    /*
     * Startup order:
     * 1. Foreman first.
     * 2. Then two Extractors.
     * 3. Then one Freighter.
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

function getSourceCount(room) {
    if (!room) {
        return 0;
    }

    var sources = room.find(FIND_SOURCES);

    if (!sources) {
        return 0;
    }

    return sources.length;
}

function getDesiredExtractorCount(room) {
    var sourceCount = getSourceCount(room);

    if (sourceCount <= 0) {
        return 0;
    }

    var extractorBody = creepBodyConfig.getBody('Extractor', room);
    var workPartsPerExtractor = countBodyParts(extractorBody, WORK);

    /*
     * Safety fallback:
     * If something goes wrong and the Extractor body has no WORK parts,
     * ask for one per source instead of crashing or asking for zero forever.
     */
    if (workPartsPerExtractor <= 0) {
        return sourceCount;
    }

    /*
     * Each normal source wants 6 WORK parts.
     *
     * Example:
     * 2 sources * 6 WORK = 12 total WORK wanted.
     *
     * If each Extractor has 6 WORK:
     * Math.ceil(12 / 6) = 2 Extractors.
     *
     * If each Extractor has 2 WORK:
     * Math.ceil(12 / 2) = 6 Extractors.
     */
    var desiredCount = Math.ceil((sourceCount * SOURCE_WORK_TARGET) / workPartsPerExtractor);

    /*
     * Keep at least one Extractor per source.
     */
    if (desiredCount < sourceCount) {
        desiredCount = sourceCount;
    }

    /*
     * Do not go above your old emergency cap.
     * This prevents early tiny bodies from requesting a silly swarm.
     */
    if (desiredCount > DESIRED_COUNTS.Extractor) {
        desiredCount = DESIRED_COUNTS.Extractor;
    }

    return desiredCount;
}

/**
 * Run spawn requests for the current simple managed room.
 *
 * For now:
 * - get first spawn
 * - use that spawn's room
 * - request hard-coded creep counts
 *
 * Later:
 * - room.manager.js can call requestRoleForRoom(room, ...)
 * - or this file can loop all owned rooms
 *
 * @returns {object|null}
 */
function run() {
    var room = getManagedRoom();
    /*
     * No managed room is not an error during startup or after losing all spawns.
     * Returning null lets main.js skip spawnManager.runRoom safely.
     */
    if (!room) {
        return null;
    }

    var report = {
        roomName: room.name,
        requests: []
    };

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

    report.requests.push(requestRoleForRoom(room, 'Extractor', getDesiredExtractorCount(room)));
    report.requests.push(requestRoleForRoom(room, 'Freighter', DESIRED_COUNTS.Freighter));
    report.requests.push(requestAnnexForRoom(room));
    report.requests.push(requestRoleForRoom(room, 'ScoreRunner', DESIRED_COUNTS.ScoreRunner));
    report.requests.push(requestTechWorkForRoom(room));
    report.requests.push(requestRoleForRoom(room, 'Artificer', DESIRED_COUNTS.Artificer));
    report.requests.push(requestRoleForRoom(room, 'Scout', DESIRED_COUNTS.Scout));
    report.requests.push(requestRoleForRoom(room, 'Ronin', DESIRED_COUNTS.Ronin));
    report.requests.push(requestRoleForRoom(room, 'Volley', DESIRED_COUNTS.Volley));
    report.requests.push(requestRoleForRoom(room, 'Cleric', DESIRED_COUNTS.Cleric));

    return report;
}

module.exports = {
    run: run,

    /*
     * Exporting these helps testing from console later.
     */
    getFirstSpawn: getFirstSpawn,
    getManagedRoom: getManagedRoom,
    requestRoleForRoom: requestRoleForRoom,
    requestTechWorkForRoom: requestTechWorkForRoom,
    countHealthyCreeps: countHealthyCreeps,
    countLivingRoleWork: countLivingRoleWork,
    countQueuedRoleWork: countQueuedRoleWork,
    countBodyParts: countBodyParts,
    getDesiredTechWork: getDesiredTechWork,
    getReplacementLeadTicks: getReplacementLeadTicks,
    requestRemoteExtractorsForRoom: requestRemoteExtractorsForRoom,
    requestAnnexForRoom: requestAnnexForRoom
};
