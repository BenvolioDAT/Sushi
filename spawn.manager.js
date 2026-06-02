/*
 * spawn.manager.js
 *
 * Basic Sushi spawn queue manager.
 *
 * Job:
 * - main.js asks for creep counts
 * - this file adds missing creeps to a room queue
 * - this file tries to spawn queued creeps
 *
 * This is intentionally simple.
 */

var spawnUtility = require('utility.spawn');

/**
 * Make sure the room memory and spawn queue exist.
 *
 * Queue path:
 * Memory.rooms[roomName].spawnQueue
 *
 * @param {string} roomName
 * @returns {array|null}
 */
function getSpawnQueue(roomName) {
    if (!roomName) {
        return null;
    }

    if (!Memory.rooms) {
        Memory.rooms = {};
    }

    if (!Memory.rooms[roomName]) {
        Memory.rooms[roomName] = {};
    }

    if (!Memory.rooms[roomName].spawnQueue) {
        Memory.rooms[roomName].spawnQueue = [];
    }

    return Memory.rooms[roomName].spawnQueue;
}

/**
 * Count alive creeps that belong to this room and role.
 *
 * This checks:
 * - creep.memory.role
 * - creep.memory.homeRoom
 *
 * If homeRoom is missing, it falls back to creep.room.name.
 * That helps early simple creeps still count.
 *
 * @param {string} roomName
 * @param {string} role
 * @returns {number}
 */
function countAliveRole(roomName, role) {
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

        var creepHomeRoom = creep.memory.homeRoom || creep.room.name;

        if (creepHomeRoom !== roomName) {
            continue;
        }

        count++;
    }

    return count;
}

/**
 * Count queued creeps for this room and role.
 *
 * This stops main.js from adding the same request every tick.
 *
 * @param {string} roomName
 * @param {string} role
 * @returns {number}
 */
function countQueuedRole(roomName, role) {
    var queue = getSpawnQueue(roomName);

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
 * Ask the spawn manager to maintain a desired number of creeps.
 *
 * Example:
 * requestRoleCount("W1N1", "Veinseeker", 2, [WORK, CARRY, MOVE], 20);
 *
 * If alive + queued is less than desiredCount, this adds missing creeps
 * to the room spawn queue.
 *
 * @param {string} roomName
 * @param {string} role
 * @param {number} desiredCount
 * @param {array} body
 * @param {number} priority
 * @param {object} extraMemory
 * @returns {object}
 */
function requestRoleCount(roomName, role, desiredCount, body, priority, extraMemory) {
    var queue = getSpawnQueue(roomName);

    if (!queue || !role || !body || desiredCount <= 0) {
        return {
            ok: false,
            added: 0,
            reason: 'Invalid spawn request'
        };
    }

    var aliveCount = countAliveRole(roomName, role);
    var queuedCount = countQueuedRole(roomName, role);
    var totalPlanned = aliveCount + queuedCount;
    var missingCount = desiredCount - totalPlanned;
    var added = 0;

    /*
     * Nothing missing, so do not add anything.
     */
    if (missingCount <= 0) {
        return {
            ok: true,
            added: 0,
            alive: aliveCount,
            queued: queuedCount,
            desired: desiredCount
        };
    }

    for (var missingIndex = 0; missingIndex < missingCount; missingIndex++) {
        var memory = {
            role: role,
            homeRoom: roomName
        };

        /*
         * Add optional memory fields.
         * This lets main.js pass things like targetRoom later.
         */
        if (extraMemory) {
            for (var key in extraMemory) {
                if (extraMemory.hasOwnProperty(key)) {
                    memory[key] = extraMemory[key];
                }
            }
        }

        queue.push({
            role: role,
            body: body,
            priority: priority || 0,
            memory: memory,
            requestedAt: Game.time
        });

        added++;
    }

    /*
     * Sort highest priority first.
     * If priorities match, older request goes first.
     */
    queue.sort(function(a, b) {
        if (b.priority !== a.priority) {
            return b.priority - a.priority;
        }

        return a.requestedAt - b.requestedAt;
    });

    return {
        ok: true,
        added: added,
        alive: aliveCount,
        queued: queuedCount,
        desired: desiredCount
    };
}

/**
 * Find an idle spawn in this room.
 *
 * @param {string} roomName
 * @returns {StructureSpawn|null}
 */
function findIdleSpawn(roomName) {
    for (var spawnName in Game.spawns) {
        if (!Game.spawns.hasOwnProperty(spawnName)) {
            continue;
        }

        var spawn = Game.spawns[spawnName];

        if (!spawn || !spawn.room) {
            continue;
        }

        if (spawn.room.name !== roomName) {
            continue;
        }

        if (spawn.spawning) {
            continue;
        }

        return spawn;
    }

    return null;
}

/**
 * Try to spawn the first creep in this room's queue.
 *
 * Important behavior:
 * - OK: remove the request from queue
 * - ERR_NOT_ENOUGH_ENERGY: keep request in queue and try again later
 * - ERR_BUSY: keep request in queue
 * - ERR_NAME_EXISTS: try a new generated name next tick
 *
 * @param {string} roomName
 * @returns {object}
 */
function runRoom(roomName) {
    var queue = getSpawnQueue(roomName);

    if (!queue || queue.length === 0) {
        return {
            ok: true,
            result: null,
            reason: 'Queue empty'
        };
    }

    var spawn = findIdleSpawn(roomName);

    if (!spawn) {
        return {
            ok: false,
            result: ERR_BUSY,
            reason: 'No idle spawn found'
        };
    }

    /*
     * Highest priority request should already be first because requestRoleCount()
     * sorts the queue. We sort again just in case something else added to queue.
     */
    queue.sort(function(a, b) {
        if (b.priority !== a.priority) {
            return b.priority - a.priority;
        }

        return a.requestedAt - b.requestedAt;
    });

    var request = queue[0];

    if (!request || !request.role || !request.body) {
        /*
         * Bad request. Remove it so it does not block the queue forever.
         */
        queue.shift();

        return {
            ok: false,
            result: ERR_INVALID_ARGS,
            reason: 'Removed bad spawn request'
        };
    }

    var creepName = spawnUtility.genCreepName(request.role);

    if (!creepName) {
        return {
            ok: false,
            result: ERR_NAME_EXISTS,
            reason: 'No free creep name available for ' + request.role
        };
    }

    var result = spawn.spawnCreep(
        request.body,
        creepName,
        {
            memory: request.memory
        }
    );

    /*
     * spawnCreep returns OK when spawning is scheduled.
     * If there is not enough energy, leave the request in queue.
     */
    if (result === OK) {
        queue.shift();

        console.log(
            'Spawning ' + creepName +
            ' as ' + request.role +
            ' in room ' + roomName
        );

        return {
            ok: true,
            result: result,
            name: creepName,
            role: request.role
        };
    }

    /*
     * Not enough energy is normal.
     * Leave the request in the queue.
     */
    if (result === ERR_NOT_ENOUGH_ENERGY) {
        return {
            ok: false,
            result: result,
            role: request.role,
            reason: 'Not enough energy yet'
        };
    }

    /*
     * Busy is also normal, though findIdleSpawn should avoid it.
     * Leave the request in the queue.
     */
    if (result === ERR_BUSY) {
        return {
            ok: false,
            result: result,
            role: request.role,
            reason: 'Spawn is busy'
        };
    }

    /*
     * Name exists should be rare because genCreepName checks names.
     * Leave the request in queue so it can try again next tick.
     */
    if (result === ERR_NAME_EXISTS) {
        return {
            ok: false,
            result: result,
            role: request.role,
            reason: 'Generated name already exists'
        };
    }

    /*
     * Other errors probably mean the request is bad.
     * Remove it so the queue does not get stuck forever.
     */
    queue.shift();

    return {
        ok: false,
        result: result,
        role: request.role,
        reason: 'Spawn request failed and was removed'
    };
}

module.exports = {
    getSpawnQueue: getSpawnQueue,
    countAliveRole: countAliveRole,
    countQueuedRole: countQueuedRole,
    requestRoleCount: requestRoleCount,
    findIdleSpawn: findIdleSpawn,
    runRoom: runRoom
};