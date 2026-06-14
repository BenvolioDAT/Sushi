/*
Body part = Build cost = Effect
MOVE = 50 = Moves the creep.
WORK = 100 = Harvests, builds, and repairs.
CARRY = 50 = Stores up to 50 resource units.
ATTACK = 80 = Deals short-range damage.
RANGED_ATTACK = 150 = Deals ranged damage.
HEAL = 250 = Heals creeps.
TOUGH = 10 = Adds inexpensive hit points.
CLAIM = 600 = Claims, reserves, and signs controllers.
*/

/*
 * Body plans are ordered from strongest to weakest. Keeping the plans in one
 * place lets request planning use room capacity while the spawn manager uses
 * the energy available on the current tick.
 */
var BODY_PLANS = {
    Foreman: [
        [[CARRY, 25], [MOVE, 25]],
        [[CARRY, 24], [MOVE, 24]],
        [[CARRY, 23], [MOVE, 23]],
        [[CARRY, 22], [MOVE, 22]],
        [[CARRY, 21], [MOVE, 21]],
        [[CARRY, 20], [MOVE, 20]],
        [[CARRY, 19], [MOVE, 19]],
        [[CARRY, 18], [MOVE, 18]],
        [[CARRY, 17], [MOVE, 17]],
        [[CARRY, 16], [MOVE, 16]],
        [[CARRY, 15], [MOVE, 15]],
        [[CARRY, 14], [MOVE, 14]],
        [[CARRY, 13], [MOVE, 13]],    
        [[CARRY, 12], [MOVE, 12]],
        [[CARRY, 11], [MOVE, 11]],
        [[CARRY, 10], [MOVE, 10]],
        [[CARRY, 9], [MOVE, 9]],
        [[CARRY, 8], [MOVE, 8]],
        [[CARRY, 7], [MOVE, 7]],
        [[CARRY, 6], [MOVE, 6]],
        [[CARRY, 5], [MOVE, 5]],
        [[CARRY, 4], [MOVE, 4]],
        [[CARRY, 3], [MOVE, 3]],
        [[CARRY, 2], [MOVE, 2]],
        [[CARRY, 1], [MOVE, 1]]
    ],

    Extractor: [
        [[WORK, 6], [MOVE, 3], [CARRY, 1]],
        [[WORK, 4], [MOVE, 2], [CARRY, 1]],
        [[WORK, 2], [MOVE, 1], [CARRY, 1]],
        [[WORK, 1], [MOVE, 1], [CARRY, 1]]
    ],

    Freighter: [
        [[CARRY, 25], [MOVE, 25]],
        [[CARRY, 24], [MOVE, 24]],
        [[CARRY, 23], [MOVE, 23]],
        [[CARRY, 22], [MOVE, 22]],
        [[CARRY, 21], [MOVE, 21]],
        [[CARRY, 20], [MOVE, 20]],
        [[CARRY, 19], [MOVE, 19]],
        [[CARRY, 18], [MOVE, 18]],
        [[CARRY, 17], [MOVE, 17]],
        [[CARRY, 16], [MOVE, 16]],
        [[CARRY, 15], [MOVE, 15]],
        [[CARRY, 14], [MOVE, 14]],
        [[CARRY, 13], [MOVE, 13]],    
        [[CARRY, 12], [MOVE, 12]],
        [[CARRY, 11], [MOVE, 11]],
        [[CARRY, 10], [MOVE, 10]],
        [[CARRY, 9], [MOVE, 9]],
        [[CARRY, 8], [MOVE, 8]],
        [[CARRY, 7], [MOVE, 7]],
        [[CARRY, 6], [MOVE, 6]],
        [[CARRY, 5], [MOVE, 5]],
        [[CARRY, 4], [MOVE, 4]],
        [[CARRY, 3], [MOVE, 3]],
        [[CARRY, 2], [MOVE, 2]],
        [[CARRY, 1], [MOVE, 1]]
    ],

    Annex: [
        [[CLAIM, 4], [MOVE, 4]],
        [[CLAIM, 3], [MOVE, 3]],
        [[CLAIM, 2], [MOVE, 2]],
        [[CLAIM, 1], [MOVE, 1]]
    ],

    Tech: [
        /* Controller-fed Techs favor WORK over carrying a large energy load. */
        [[WORK, 12], [CARRY, 6], [MOVE, 9]],
        [[WORK, 10], [CARRY, 5], [MOVE, 8]],
        [[WORK, 8], [CARRY, 4], [MOVE, 6]],
        [[WORK, 6], [CARRY, 4], [MOVE, 5]],
        [[WORK, 5], [CARRY, 3], [MOVE, 4]],
        [[WORK, 4], [CARRY, 3], [MOVE, 4]],
        [[WORK, 3], [CARRY, 2], [MOVE, 3]],
        [[WORK, 2], [CARRY, 1], [MOVE, 2]],
        [[WORK, 1], [CARRY, 1], [MOVE, 1]]
    ],

    Artificer: [
        //[[WORK, 12], [CARRY, 12], [MOVE, 24]],
        //[[WORK, 12], [CARRY, 11], [MOVE, 23]],
        //[[WORK, 11], [CARRY, 11], [MOVE, 22]],
        //[[WORK, 11], [CARRY, 10], [MOVE, 21]],
        //[[WORK, 10], [CARRY, 10], [MOVE, 20]],
        //[[WORK, 10], [CARRY, 9], [MOVE, 19]],
        //[[WORK, 9], [CARRY, 9], [MOVE, 18]],
        //[[WORK, 9], [CARRY, 8], [MOVE, 17]],
        //[[WORK, 8], [CARRY, 8], [MOVE, 16]],
        //[[WORK, 8], [CARRY, 7], [MOVE, 15]],
        //[[WORK, 7], [CARRY, 7], [MOVE, 14]],
        //[[WORK, 7], [CARRY, 6], [MOVE, 13]],
        [[WORK, 6], [CARRY, 6], [MOVE, 12]],
        [[WORK, 6], [CARRY, 5], [MOVE, 11]],
        [[WORK, 6], [CARRY, 4], [MOVE, 10]],
        [[WORK, 5], [CARRY, 4], [MOVE, 9]],
        [[WORK, 4], [CARRY, 4], [MOVE, 8]],
        [[WORK, 4], [CARRY, 4], [MOVE, 7]],
        [[WORK, 4], [CARRY, 3], [MOVE, 7]],
        [[WORK, 4], [CARRY, 3], [MOVE, 6]],
        [[WORK, 3], [CARRY, 3], [MOVE, 6]],
        [[WORK, 3], [CARRY, 3], [MOVE, 5]],
        [[WORK, 3], [CARRY, 2], [MOVE, 5]],
        [[WORK, 2], [CARRY, 2], [MOVE, 4]],
        [[WORK, 2], [CARRY, 1], [MOVE, 3]],
        [[WORK, 2], [CARRY, 1], [MOVE, 2]],
        [[WORK, 1], [CARRY, 1], [MOVE, 1]]
    ],

    Scout: [
        [[MOVE, 1]]
    ],

    Ronin: [
        /*
         * TOUGH parts absorb damage first and HEAL stays protected at the end.
         * Each tier has enough MOVE parts to avoid crawling on plain terrain.
         */
        [[TOUGH, 3], [MOVE, 5], [ATTACK, 6], [HEAL, 1]],
        [[TOUGH, 2], [MOVE, 4], [ATTACK, 4], [HEAL, 1]],
        [[TOUGH, 1], [MOVE, 2], [ATTACK, 2], [HEAL, 1]]
    ],

    Volley: [
        /*
         * Volley keeps one backup HEAL part at the protected end of the body.
         * MOVE stays near the non-MOVE count so ranged positioning remains fast.
         */
        [[MOVE, 4], [RANGED_ATTACK, 5], [HEAL, 1]],
        [[MOVE, 3], [RANGED_ATTACK, 3], [HEAL, 1]],
        [[MOVE, 2], [RANGED_ATTACK, 2], [HEAL, 1]]
    ],

    Cleric: [
        [[HEAL, 3], [MOVE, 3]],
        [[HEAL, 2], [MOVE, 2]],
        [[HEAL, 1], [MOVE, 1]]
    ],

    ScoreRunner: [
        [[MOVE, 1]]
    ]
};

function getRoomEnergyCapacity(room) {
    if (!room) {
        return 300;
    }

    return room.energyCapacityAvailable || 300;
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

function buildBody(bodyPlan) {
    var body = [];

    if (!bodyPlan) {
        return body;
    }

    for (var planIndex = 0; planIndex < bodyPlan.length; planIndex++) {
        var bodyPart = bodyPlan[planIndex][0];
        var count = bodyPlan[planIndex][1];

        for (var partIndex = 0; partIndex < count; partIndex++) {
            body.push(bodyPart);
        }
    }

    return body;
}

function getBestBodyForEnergy(role, energy) {
    var bodyPlans = BODY_PLANS[role];

    if (!bodyPlans || typeof energy !== 'number' || energy < 0) {
        return null;
    }

    for (var index = 0; index < bodyPlans.length; index++) {
        var body = buildBody(bodyPlans[index]);

        if (getBodyCost(body) <= energy) {
            return body;
        }
    }

    return null;
}

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

function getTechBodyForEnergyAndWork(energy, desiredWork) {
    var bodyPlans = BODY_PLANS.Tech;

    if (typeof energy !== 'number' || energy < 0 || desiredWork <= 0) {
        return null;
    }

    /*
     * Plans are strongest first. Requiring work <= desiredWork prevents a
     * small shortage from turning into a needlessly oversized upgrader.
     */
    for (var index = 0; index < bodyPlans.length; index++) {
        var body = buildBody(bodyPlans[index]);
        var workParts = countBodyParts(body, WORK);

        if (workParts <= desiredWork && getBodyCost(body) <= energy) {
            return body;
        }
    }

    return null;
}

function getArtificerBodyForEnergyAndWork(energy, desiredWork) {
    var bodyPlans = BODY_PLANS.Artificer;

    if (typeof energy !== 'number' || energy < 0 || desiredWork <= 0) {
        return null;
    }

    /* Keep the configured off-road movement safety without overshooting WORK. */
    for (var index = 0; index < bodyPlans.length; index++) {
        var body = buildBody(bodyPlans[index]);
        var workParts = countBodyParts(body, WORK);

        if (workParts <= desiredWork && getBodyCost(body) <= energy) {
            return body;
        }
    }

    return null;
}

function getFreighterBodyForEnergyAndCarry(energy, desiredCarryParts) {
    var bodyPlans = BODY_PLANS.Freighter;

    if (typeof energy !== 'number' || energy < 0 || desiredCarryParts <= 0) {
        return null;
    }

    /*
     * Keep the safe one CARRY to one MOVE plans, but do not build more hauling
     * capacity than the current demand shortage asked for.
     */
    for (var index = 0; index < bodyPlans.length; index++) {
        var body = buildBody(bodyPlans[index]);
        var carryParts = countBodyParts(body, CARRY);

        if (carryParts <= desiredCarryParts && getBodyCost(body) <= energy) {
            return body;
        }
    }

    return null;
}

/**
 * Pick the strongest configured body the room can support when full. This is
 * normal request-planning behavior; the spawn manager performs a second choice
 * from current energy when the request reaches the front of the queue.
 */
function getBody(role, room) {
    var body = getBestBodyForEnergy(role, getRoomEnergyCapacity(room));

    if (body) {
        return body;
    }

    /* Annex must never receive the generic worker fallback body. */
    if (role === 'Annex') {
        return null;
    }

    return [WORK, CARRY, MOVE];
}

/**
 * Pick the strongest configured body affordable on the current tick.
 * Unknown roles and rooms that cannot afford their smallest plan return null.
 */
function getBestBodyForAvailableEnergy(role, room) {
    if (!room || typeof room.energyAvailable !== 'number') {
        return null;
    }

    return getBestBodyForEnergy(role, room.energyAvailable);
}

function getForemanBody(room) {
    return getBody('Foreman', room);
}

function getExtractorBody(room) {
    return getBody('Extractor', room);
}

function getFreighterBody(room) {
    return getBody('Freighter', room);
}

function getFreighterBodyForCarry(room, desiredCarryParts) {
    return getFreighterBodyForEnergyAndCarry(
        getRoomEnergyCapacity(room),
        desiredCarryParts
    );
}

function getFreighterBodyForAvailableEnergy(room, desiredCarryParts) {
    if (!room || typeof room.energyAvailable !== 'number') {
        return null;
    }

    return getFreighterBodyForEnergyAndCarry(
        room.energyAvailable,
        desiredCarryParts
    );
}

function getAnnexBody(room) {
    return getBody('Annex', room);
}

function getTechBody(room) {
    return getBody('Tech', room);
}

function getTechBodyForWork(room, desiredWork) {
    return getTechBodyForEnergyAndWork(getRoomEnergyCapacity(room), desiredWork);
}

function getTechBodyForAvailableEnergy(room, desiredWork) {
    if (!room || typeof room.energyAvailable !== 'number') {
        return null;
    }

    return getTechBodyForEnergyAndWork(room.energyAvailable, desiredWork);
}

function getArtificerBody(room) {
    return getBody('Artificer', room);
}

function getArtificerBodyForWork(room, desiredWork) {
    return getArtificerBodyForEnergyAndWork(
        getRoomEnergyCapacity(room),
        desiredWork
    );
}

function getArtificerBodyForAvailableEnergy(room, desiredWork) {
    if (!room || typeof room.energyAvailable !== 'number') {
        return null;
    }

    return getArtificerBodyForEnergyAndWork(
        room.energyAvailable,
        desiredWork
    );
}

function getScoutBody(room) {
    return getBody('Scout', room);
}

function getRoninBody(room) {
    return getBody('Ronin', room);
}

function getVolleyBody(room) {
    return getBody('Volley', room);
}

function getClericBody(room) {
    return getBody('Cleric', room);
}

function getScoreRunnerBody(room) {
    return getBody('ScoreRunner', room);
}

module.exports = {
    getBody: getBody,
    getBestBodyForAvailableEnergy: getBestBodyForAvailableEnergy,
    getBodyCost: getBodyCost,
    getTechBodyForWork: getTechBodyForWork,
    getTechBodyForAvailableEnergy: getTechBodyForAvailableEnergy,
    getArtificerBodyForWork: getArtificerBodyForWork,
    getArtificerBodyForAvailableEnergy: getArtificerBodyForAvailableEnergy,
    getFreighterBodyForCarry: getFreighterBodyForCarry,
    getFreighterBodyForAvailableEnergy: getFreighterBodyForAvailableEnergy,

    getScoutBody: getScoutBody,
    getForemanBody: getForemanBody,
    getExtractorBody: getExtractorBody,
    getFreighterBody: getFreighterBody,
    getAnnexBody: getAnnexBody,
    getTechBody: getTechBody,
    getArtificerBody: getArtificerBody,
    getRoninBody: getRoninBody,
    getVolleyBody: getVolleyBody,
    getClericBody: getClericBody,
    getScoreRunnerBody: getScoreRunnerBody
};
