/*
Body part = Build cost = Effect
MOVE = 50 = Moves the creep. Reduces creep fatigue by 2/tick. See movement.
WORK = 100 = Harvests energy from target source. Gathers 2 energy/tick.Constructs a target structure. Builds the designated structure at a construction site, at 5 points/tick, consuming 1 energy/point. See building Costs. Repairs a target structure. Repairs a structure for 100 hits/tick. Consumes 0.01 energy/hit repaired, rounded up to the nearest whole number.
CARRY = 50 = Stores energy. Contains up to 50 energy units. Weighs nothing when empty.
ATTACK = 80 = Attacks a target creep/structure. Deals 30 damage/tick. Short-ranged attack (1 tile).
RANGED_ATTACK = 150 = Attacks a target creep/structure. Deals 10 damage/tick. Long-ranged attack (1 to 3 tiles).
HEAL = 250 = Heals a target creep. Restores 12 hit points/tick at short range (1 tile) or 4 hits/tick at a distance (up to 3 tiles).
TOUGH = 10 = No effect other than the 100 hit points all body parts add. This provides a cheap way to add hit points to a creep.
CLAIM = 600 = To sign the room controller, it's about change your room sign.
*/

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

function buildBody(bodyPlan) {
    var body = [];

    for(var i = 0; i < bodyPlan.length; i++) {
        var bodyPart = bodyPlan[i][0];
        var count = bodyPlan[i][1];

        for(var j = 0; j < count; j++) {
            body.push(bodyPart);
        }
    }

    return body;
}

function chooseBestAffordableBody(room, bodyPlans) {
    var energyCapacity = getRoomEnergyCapacity(room);

    for(var i = 0; i < bodyPlans.length; i++) {
        var body = buildBody(bodyPlans[i]);
        var bodyCost = getBodyCost(body);

        if(energyCapacity >= bodyCost) {
            return body;
        }
    }

    return [WORK, CARRY, MOVE];
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
    return chooseBestAffordableBody(room, [
        [
            [WORK, 6],
            [MOVE, 3],
            [CARRY, 1],
        ],
        [
            [WORK, 4],
            [MOVE, 2], 
            [CARRY, 1], 
        ],
        [
            [WORK, 2],
            [MOVE, 1],
            [CARRY, 1],
        ],
        [
            [WORK, 1],
            [MOVE, 1],
            [CARRY, 1],
        ],
    ]);
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
    return chooseBestAffordableBody(room, [
        [
            [CARRY, 12],
            [MOVE, 12]
        ],
        [
            [CARRY, 6],
            [MOVE, 6]
        ],
        [
            [CARRY, 6],
            [MOVE, 3]
        ],
        [
            [CARRY, 4],
            [MOVE, 2]
        ],
        [
            [CARRY, 2],
            [MOVE, 1]
        ]
    ]);
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

function getScoreRunnerBody(room) {
    var energyCapacity = getRoomEnergyCapacity(room);

    /*
     * ScoreRunners only need to step onto Score objects.
     * MOVE parts keep the body cheap and fast to replace.
     */
    if(energyCapacity >= 300) {
        return [TOUGH, MOVE, MOVE, MOVE, MOVE, MOVE];
    }

    if(energyCapacity >= 150) {
        return [MOVE, MOVE, MOVE];
    }

    return [MOVE];
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

    if (role === 'ScoreRunner') {
        return getScoreRunnerBody(room);
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
    getArtificerBody,
    getScoreRunnerBody: getScoreRunnerBody
};
