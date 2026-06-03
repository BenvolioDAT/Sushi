/*
 * role.creepBodyConfig.js
 *
 * This file chooses creep bodies.
 *
 * The spawn request manager can ask:
 * "What body should Queen use in this room?"
 *
 * Later you can make this smarter.
 * For now, keep it simple and readable.
 */

/**
 * Get the energy level we want to use for body choices.
 *
 * We use room.energyCapacityAvailable, not room.energyAvailable.
 *
 * Why?
 * - energyAvailable = energy right now
 * - energyCapacityAvailable = what the room can hold when full
 *
 * If the room has 550 max energy but only 300 right now,
 * we still may want to queue the 550 body and wait until energy fills.
 *
 * @param {Room} room
 * @returns {number}
 */
function getRoomEnergyCapacity(room) {
    if (!room) {
        return 300;
    }

    return room.energyCapacityAvailable || 300;
}

/**
 * Calculate how much a body costs.
 *
 * Example:
 * [WORK, CARRY, MOVE]
 * 100 + 50 + 50 = 200
 *
 * @param {array} body
 * @returns {number}
 */
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

/**
 * Queen body.
 *
 * Queen moves energy into spawn/extensions/towers.
 * So Queen mostly needs CARRY and MOVE.
 *
 * @param {Room} room
 * @returns {array}
 */
function getQueenBody(room) {
    var energyCapacity = getRoomEnergyCapacity(room);

    if (energyCapacity >= 800) {
        return [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE];
    }

    if (energyCapacity >= 550) {
        return [CARRY, CARRY, CARRY, CARRY, MOVE, MOVE];
    }

    if (energyCapacity >= 300) {
        return [CARRY, CARRY, MOVE, MOVE];
    }

    return [CARRY, MOVE];
}

/**
 * Veinseeker body.
 *
 * Veinseeker is your source harvester.
 *
 * @param {Room} room
 * @returns {array}
 */
function getVeinseekerBody(room) {
    var energyCapacity = getRoomEnergyCapacity(room);
/*
    if (energyCapacity >= 800) {
        return [WORK, WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE, MOVE];
    }

    if (energyCapacity >= 550) {
        return [WORK, WORK, WORK, CARRY, MOVE, MOVE];
    }
*/
    if (energyCapacity >= 300) {
        return [WORK, WORK, CARRY, MOVE];
    }

    return [WORK, CARRY, MOVE];
}

/**
 * Trucker body.
 *
 * Trucker hauls energy.
 *
 * @param {Room} room
 * @returns {array}
 */
function getTruckerBody(room) {
    var energyCapacity = getRoomEnergyCapacity(room);

    if (energyCapacity >= 800) {
        return [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE];
    }

    if (energyCapacity >= 550) {
        return [CARRY, CARRY, CARRY, CARRY, MOVE, MOVE];
    }

    return [CARRY, CARRY, MOVE];
}

/**
 * Upgrader body.
 *
 * @param {Room} room
 * @returns {array}
 */
function getUpgraderBody(room) {
    var energyCapacity = getRoomEnergyCapacity(room);

    if (energyCapacity >= 800) {
        return [WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE];
    }

    if (energyCapacity >= 550) {
        return [WORK, WORK, CARRY, CARRY, MOVE, MOVE];
    }

    return [WORK, CARRY, MOVE];
}

function getBuilderBody(room) {
    var energyCapacity = getRoomEnergyCapacity(room);
    if (energyCapacity >= 800) {
        return [WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE];
    }

    if (energyCapacity >= 550) {
        return [WORK, WORK, CARRY, CARRY, MOVE, MOVE];
    }

    return [WORK, CARRY, MOVE];
}

/**
 * Main body picker.
 *
 * @param {string} role
 * @param {Room} room
 * @returns {array}
 */
function getBody(role, room) {
    if (role === 'Queen') {
        return getQueenBody(room);
    }

    if (role === 'Veinseeker') {
        return getVeinseekerBody(room);
    }

    if (role === 'Trucker') {
        return getTruckerBody(room);
    }

    if (role === 'Upgrader') {
        return getUpgraderBody(room);
    }
    if (role === 'Builder') {
        return getBuilderBody(room);
    }

    /*
     * Safe fallback body.
     */
    return [WORK, CARRY, MOVE];
}

module.exports = {
    getBody: getBody,
    getBodyCost: getBodyCost,

    getQueenBody: getQueenBody,
    getVeinseekerBody: getVeinseekerBody,
    getTruckerBody: getTruckerBody,
    getUpgraderBody: getUpgraderBody
};