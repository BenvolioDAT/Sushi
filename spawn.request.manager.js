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
    Tech: 3,
    Artificer: 3,
    Scout: 1
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
    Tech: 20,
    Artificer: 10,
    Scout: 5,
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
    Artificer: 40,
    scout: 10
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
function getCheaperBodyForRole(role) {
    /*
     * These are emergency / recovery bodies.
     *
     * They are not the best bodies.
     * They are the "please spawn something useful before the colony turns into soup" bodies.
     */

    if (role === 'Extractor') {
        return [WORK, CARRY, MOVE];
    }

    if (role === 'Foreman') {
        return [CARRY, MOVE];
    }

    if (role === 'Freighter') {
        return [CARRY, MOVE];
    }

    if (role === 'Tech') {
        return [WORK, CARRY, MOVE];
    }

    if (role === 'Artificer') {
        return [WORK, CARRY, MOVE];
    }

    if (role === 'Scout') {
        return [MOVE];
    }

    return null;
}

function getBodyCost(body) {
    var cost = 0;

    if (!body) {
        return cost;
    }

    for (var index = 0; index < body.length; index++) {
        cost += BODYPART_COST[body[index]] || 0;
    }

    return cost;
}

function downgradeFrontQueuedBodyIfNeeded(room) {
    if (!room) {
        return {
            ok: false,
            changed: false,
            reason: 'missing room'
        };
    }

    var queue = spawnManager.getSpawnQueue(room.name);

    if (!queue || queue.length === 0) {
        return {
            ok: true,
            changed: false,
            reason: 'queue empty'
        };
    }

    /*
     * Match spawn.manager.js sorting so we inspect the same request
     * that the spawn will try first.
     */
    queue.sort(function(a, b) {
        if (b.priority !== a.priority) {
            return b.priority - a.priority;
        }

        return a.requestedAt - b.requestedAt;
    });

    var request = queue[0];

    if (!request || !request.role || !request.body) {
        return {
            ok: false,
            changed: false,
            reason: 'front request is invalid'
        };
    }

    var currentBodyCost = getBodyCost(request.body);

    /*
     * If the room can already afford the current body, do nothing.
     */
    if (currentBodyCost <= room.energyAvailable) {
        return {
            ok: true,
            changed: false,
            reason: 'front body is affordable'
        };
    }

    var cheaperBody = getCheaperBodyForRole(request.role);

    if (!cheaperBody) {
        return {
            ok: false,
            changed: false,
            role: request.role,
            reason: 'no cheaper body exists for this role'
        };
    }

    var cheaperBodyCost = getBodyCost(cheaperBody);

    /*
     * If even the cheaper body cannot spawn right now, do not change anything.
     * The room still needs to wait for more energy.
     */
    if (cheaperBodyCost > room.energyAvailable) {
        return {
            ok: true,
            changed: false,
            role: request.role,
            currentBodyCost: currentBodyCost,
            cheaperBodyCost: cheaperBodyCost,
            energyAvailable: room.energyAvailable,
            reason: 'cheaper body is still not affordable'
        };
    }

    /*
     * Replace the expensive queued body with the cheaper one.
     * This keeps the same role, priority, requestedAt, and memory.
     */
    request.originalBody = request.originalBody || request.body;
    request.originalBodyCost = request.originalBodyCost || currentBodyCost;
    request.body = cheaperBody;
    request.downgradedAt = Game.time;
    request.downgradeReason = 'front queued body was too expensive for current room energy';

    return {
        ok: true,
        changed: true,
        role: request.role,
        oldCost: currentBodyCost,
        newCost: cheaperBodyCost,
        energyAvailable: room.energyAvailable,
        reason: 'downgraded front queued body'
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
        report.requests.push(requestRoleForRoom(room, 'Foreman', 1));
        return true;
    }

    var startupExtractorCount = getStartupExtractorCount(room);

    if (getHealthyRoleCount(room, 'Extractor') < startupExtractorCount) {
        report.requests.push(requestRoleForRoom(room, 'Extractor', startupExtractorCount));
        return true;
    }

    if (getHealthyRoleCount(room, 'Freighter') < 1) {
        report.requests.push(requestRoleForRoom(room, 'Freighter', 1));
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
var SOURCE_WORK_TARGET = 5;

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
     * Each normal source wants about 5 WORK parts.
     *
     * Example:
     * 2 sources * 5 WORK = 10 total WORK wanted.
     *
     * If each Extractor has 6 WORK:
     * Math.ceil(10 / 6) = 2 Extractors.
     *
     * If each Extractor has 2 WORK:
     * Math.ceil(10 / 2) = 5 Extractors.
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

function getStartupExtractorCount(room) {
    var sourceCount = getSourceCount(room);

    if (sourceCount <= 0) {
        return 1;
    }

    /*
     * Startup only needs basic coverage before moving on to Freighter, Tech,
     * and Artificer.
     */
    return sourceCount;
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

    /*
     * Before adding more requests, check the front of the queue.
     * If it is too expensive for the room right now, replace it with
     * a cheaper body for the same role.
     */
    downgradeFrontQueuedBodyIfNeeded(room);

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
    report.requests.push(requestRoleForRoom(room, 'Tech', DESIRED_COUNTS.Tech));
    report.requests.push(requestRoleForRoom(room, 'Artificer', DESIRED_COUNTS.Artificer));
    report.requests.push(requestRoleForRoom(room, 'Scout', DESIRED_COUNTS.Scout));

    return report;
}

module.exports = {
    run: run,

    /*
     * Exporting these helps testing from console later.
     */
    downgradeFrontQueuedBodyIfNeeded: downgradeFrontQueuedBodyIfNeeded,
    getCheaperBodyForRole: getCheaperBodyForRole,
    getFirstSpawn: getFirstSpawn,
    getManagedRoom: getManagedRoom,
    requestRoleForRoom: requestRoleForRoom,
    countHealthyCreeps: countHealthyCreeps,
    getReplacementLeadTicks: getReplacementLeadTicks
};
