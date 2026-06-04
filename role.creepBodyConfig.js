/*
 * role.creepBodyConfig.js
 *
 * This file chooses creep bodies.
 *
 * The spawn request manager can ask:
 * "What body should Foreman use in this room?"
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

    /*
     * If a caller passes no body, return 0 instead of crashing on body.length.
     * This makes the helper safe for quick console tests.
     */
    if (!body) {
        return cost;
    }

    /*
     * Loop over every body part in the array. BODYPART_COST is a Screeps
     * constant that maps WORK, CARRY, MOVE, etc. to their energy cost.
     */
    for (var index = 0; index < body.length; index++) {
        cost += BODYPART_COST[body[index]] || 0;
    }

    return cost;
}

/**
 * Foreman body.
 *
 * Foreman moves energy into spawn/extensions/towers.
 * So Foreman mostly needs CARRY and MOVE.
 *
 * @param {Room} room
 * @returns {array}
 */
function getForemanBody(room) {
    var energyCapacity = getRoomEnergyCapacity(room);

    /*
     * Bigger rooms can build bigger hauler bodies. Foreman focuses on CARRY
     * capacity with enough MOVE parts to travel while carrying energy.
     */
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
 * Extractor body.
 *
 * Extractor is your source harvester.
 *
 * @param {Room} room
 * @returns {array}
 */
function getExtractorBody(room) {
    var energyCapacity = getRoomEnergyCapacity(room);
/*
    if (energyCapacity >= 800) {
        return [WORK, WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE, MOVE];
    }

    if (energyCapacity >= 550) {
        return [WORK, WORK, WORK, CARRY, MOVE, MOVE];
    }
*/
    /*
     * Extractors need WORK parts to harvest and enough CARRY/MOVE to handle
     * early-room offloading. Larger commented-out versions above are preserved
     * for later tuning but are not active code.
     */
    if (energyCapacity >= 300) {
        return [WORK, WORK, CARRY, MOVE];
    }

    return [WORK, CARRY, MOVE];
}

/**
 * Freighter body.
 *
 * Freighter hauls energy.
 *
 * @param {Room} room
 * @returns {array}
 */
function getFreighterBody(room) {
    var energyCapacity = getRoomEnergyCapacity(room);

    /*
     * Freighters haul energy, so the body scales mostly by adding more CARRY
     * parts and matching MOVE parts to keep travel reasonable.
     */
    if (energyCapacity >= 800) {
        return [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE];
    }

    if (energyCapacity >= 550) {
        return [CARRY, CARRY, CARRY, CARRY, MOVE, MOVE];
    }

    return [CARRY, CARRY, MOVE];
}

/**
 * Tech body.
 *
 * @param {Room} room
 * @returns {array}
 */
function getTechBody(room) {
    var energyCapacity = getRoomEnergyCapacity(room);

    /*
     * Tech creeps upgrade controllers. WORK controls upgrade speed, CARRY holds
     * energy, and MOVE lets the creep reach the controller and energy sources.
     */
    if (energyCapacity >= 800) {
        return [WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE];
    }

    if (energyCapacity >= 550) {
        return [WORK, WORK, CARRY, CARRY, MOVE, MOVE];
    }

    return [WORK, CARRY, MOVE];
}

function getArtificerBody(room) {
    var energyCapacity = getRoomEnergyCapacity(room);
    /*
     * Artificers build construction sites and then upgrade. This uses the same
     * balanced WORK/CARRY/MOVE pattern as Tech for now.
     */
    if (energyCapacity >= 800) {
        return [WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE];
    }

    if (energyCapacity >= 550) {
        return [WORK, WORK, CARRY, CARRY, MOVE, MOVE];
    }

    return [WORK, CARRY, MOVE];
}

function getScoutBody(room) {
    var energyCapacity = getRoomEnergyCapacity(room);
    /*
     * A Scout only needs MOVE to reveal rooms. The 50 energy check matches the
     * cost of one MOVE part.
     */
    if (energyCapacity >= 50) {
        return [MOVE];
    }
}

/**
 * Main body picker.
 *
 * @param {string} role
 * @param {Room} room
 * @returns {array}
 */
function getBody(role, room) {
    /*
     * This is a simple role-to-body router. The spawn request manager calls one
     * function and gets the correct body array for the role it wants to spawn.
     */
    if (role === 'Foreman') {
        return getForemanBody(room);
    }

    if (role === 'Extractor') {
        return getExtractorBody(room);
    }

    if (role === 'Freighter') {
        return getFreighterBody(room);
    }

    if (role === 'Tech') {
        return getTechBody(room);
    }

    if (role === 'Artificer') {
        return getArtificerBody(room);
    }

    if (role === 'Scout') {
        return getScoutBody(room);
    }

    /*
     * Safe fallback body.
     */
    return [WORK, CARRY, MOVE];
}

module.exports = {
    getBody,
    getBodyCost,

    getScoutBody,
    getForemanBody,
    getExtractorBody,
    getFreighterBody,
    getTechBody,
    getArtificerBody
};
