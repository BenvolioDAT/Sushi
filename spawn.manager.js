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
 *
 * Teaching split:
 * - spawn.request.manager.js decides what the room needs.
 * - this file owns the queue mechanics and spawnCreep return handling.
 */

var spawnUtility = require('utility.spawn');
var creepBodyConfig = require('role.creepBodyConfig');

var getBodyCost = creepBodyConfig.getBodyCost;

function countBodyParts(body, partType) {
    var count = 0;

    if (!body) {
        return count;
    }

    for (var index = 0; index < body.length; index++) {
        if (body[index] === partType) {
            count++;
        }
    }

    return count;
}

/**
 * Select the strongest body for this role that current room energy can afford.
 *
 * spawn.request.manager.js decides what roles are needed, but queued Memory can
 * become stale because spawning takes many ticks. spawn.manager.js is the last
 * chance to choose the best body before room energy is spent.
 *
 * This helper changes only request.body. It never rebuilds request.memory, so
 * source assignments, remote mining targets, and other job details survive.
 *
 * @param {StructureSpawn} spawn
 * @param {object} request
 * @returns {object}
 */
function selectAffordableQueuedBodyForSpawn(spawn, request) {
    if (!spawn || !spawn.room || !request || !request.role) {
        return {
            changed: false,
            affordable: false,
            reason: 'missing spawn or request'
        };
    }

    var energyAvailable = spawn.room.energyAvailable;
    var bestBody;

    if (request.role === 'Tech') {
        /*
         * Tech requests are sized to a missing WORK amount. Preserve that cap
         * while still allowing the body to shrink when current energy is low.
         * Reading request.body also keeps old queued Tech requests compatible.
         */
        var requestedWork = request.maxWorkParts || countBodyParts(request.body, WORK);
        bestBody = creepBodyConfig.getTechBodyForAvailableEnergy(
            spawn.room,
            requestedWork
        );
    }
    else {
        bestBody = creepBodyConfig.getBestBodyForAvailableEnergy(
            request.role,
            spawn.room
        );
    }

    if (!bestBody || bestBody.length === 0) {
        return {
            changed: false,
            affordable: false,
            energyAvailable: energyAvailable,
            reason: 'no affordable body for current energy'
        };
    }

    var oldCost = getBodyCost(request.body);
    var newCost = getBodyCost(bestBody);

    request.body = bestBody;

    return {
        changed: oldCost !== newCost,
        affordable: true,
        oldCost: oldCost,
        newCost: newCost,
        energyAvailable: energyAvailable,
        reason: newCost < oldCost ? 'downgraded to affordable body' :
            newCost > oldCost ? 'upgraded to affordable body' :
            'kept affordable body'
    };
}

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
    /*
     * A room name is required because each room keeps its own queue under
     * Memory.rooms[roomName].spawnQueue.
     */
    if (!roomName) {
        return null;
    }

    /*
     * Memory is persistent between ticks. These checks create the nested objects
     * before code tries to read or write spawnQueue.
     */
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

    /*
     * Game.creeps is all living owned creeps. Looping by name lets us inspect
     * each creep's memory and decide if it belongs to this count.
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

    /*
     * If the queue cannot be created or found, there are zero queued requests
     * for this role.
     */
    if (!queue) {
        return 0;
    }

    var count = 0;

    for (var index = 0; index < queue.length; index++) {
        var request = queue[index];

        /*
         * Each request is a plain object saved in Memory. Bad or empty entries
         * are skipped so one damaged queue item does not crash the count.
         */
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

    /*
     * Validate important inputs before writing to Memory. Returning an object
     * instead of throwing keeps the caller able to report what happened.
     */
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
        /*
         * This memory object will become creep.memory when spawnCreep succeeds.
         * role drives main.js dispatch, and homeRoom lets counting stay room-aware.
         */
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

        /*
         * queue.push writes the new request into Memory.rooms[roomName].spawnQueue.
         * The actual creep is not spawned yet; runRoom will process it later.
         */
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
    /*
     * Game.spawns contains every spawn you own, keyed by spawn name.
     * This loop finds the first spawn in the requested room that is not busy.
     */
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

    /*
     * Empty queue is a normal success state. Nothing is wrong; there is simply
     * no creep request to process this tick.
     */
    if (!queue || queue.length === 0) {
        return {
            ok: true,
            result: null,
            reason: 'Queue empty'
        };
    }

    var spawn = findIdleSpawn(roomName);

    /*
     * Spawns can only create one creep at a time. If none are idle, keep the
     * request in queue and try again on a future tick.
     */
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

    var bodySelection = selectAffordableQueuedBodyForSpawn(spawn, request);

    if (!bodySelection.affordable) {
        console.log(
            'Waiting to spawn ' + request.role +
            ' in ' + roomName +
            ': no affordable body for current energy'
        );

        return {
            ok: false,
            result: ERR_NOT_ENOUGH_ENERGY,
            role: request.role,
            bodySelection: bodySelection,
            reason: bodySelection.reason
        };
    }

    var creepName = spawnUtility.genCreepName(request.role);

    /*
     * genCreepName reads Game.creeps and Memory.creeps to avoid collisions.
     * If it returns null, this request stays queued until a name frees up.
     */
    if (!creepName) {
        return {
            ok: false,
            result: ERR_NAME_EXISTS,
            reason: 'No free creep name available for ' + request.role
        };
    }

    /*
     * spawn.spawnCreep is the Screeps API call that starts spawning a creep.
     * The body controls parts, creepName is the unique name, and memory becomes
     * the new creep's creep.memory when it exists.
     */
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
            ' in ' + roomName +
            (bodySelection.reason === 'downgraded to affordable body' ?
                ' after downgrading body from ' + bodySelection.oldCost +
                ' to ' + bodySelection.newCost + ' energy' :
                ' using affordable body cost ' + bodySelection.newCost)
        );

        return {
            ok: true,
            result: result,
            name: creepName,
            role: request.role,
            bodySelection: bodySelection
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
    getBodyCost: getBodyCost,
    selectAffordableQueuedBodyForSpawn: selectAffordableQueuedBodyForSpawn,
    getSpawnQueue: getSpawnQueue,
    countAliveRole: countAliveRole,
    countQueuedRole: countQueuedRole,
    requestRoleCount: requestRoleCount,
    findIdleSpawn: findIdleSpawn,
    runRoom: runRoom
};
