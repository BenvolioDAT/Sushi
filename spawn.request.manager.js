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

/*
 * How many creeps we want for now.
 *
 * Later, room.manager.js can calculate these numbers dynamically.
 */
var DESIRED_COUNTS = {
    Foreman: 1,
    Extractor: 6,
    Freighter: 4,
    Tech: 2,
    Artificer: 1
};

/*
 * Higher number = more important.
 *
 * Foreman is highest because you said Foreman should always be alive.
 */
var PRIORITY = {
    Foreman: 100,
    Extractor: 80,
    Freighter: 60,
    Tech: 20,
    Artificer: 10
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
    Tech: 40,
    Artificer: 40
};

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
    if (!room || !role || desiredCount <= 0) {
        return {
            ok: false,
            role: role,
            reason: 'Invalid requestRoleForRoom input'
        };
    }

    var roomName = room.name;
    var body = creepBodyConfig.getBody(role, room);
    var priority = PRIORITY[role] || 0;
    var replacementLeadTicks = getReplacementLeadTicks(role, body);

    var healthyCount = countHealthyCreeps(roomName, role, replacementLeadTicks);
    var queuedCount = countQueuedRequests(roomName, role);

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

    if (!room) {
        return null;
    }

    var report = {
        roomName: room.name,
        requests: []
    };

    /*
     * Foreman first.
     *
     * This matters because Foreman has the highest priority and should always
     * be considered before the other roles.
     */
    report.requests.push(requestRoleForRoom(room, 'Foreman', DESIRED_COUNTS.Foreman));

    report.requests.push(requestRoleForRoom(room, 'Extractor', DESIRED_COUNTS.Extractor));
    report.requests.push(requestRoleForRoom(room, 'Freighter', DESIRED_COUNTS.Freighter));
    report.requests.push(requestRoleForRoom(room, 'Tech', DESIRED_COUNTS.Tech));
    report.requests.push(requestRoleForRoom(room, 'Artificer', DESIRED_COUNTS.Artificer));

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
    countHealthyCreeps: countHealthyCreeps,
    getReplacementLeadTicks: getReplacementLeadTicks
};