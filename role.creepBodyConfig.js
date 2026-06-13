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
        [[CARRY, 12], [MOVE, 12]],
        [[CARRY, 6], [MOVE, 6]],
        [[CARRY, 6], [MOVE, 3]],
        [[CARRY, 4], [MOVE, 2]],
        [[CARRY, 2], [MOVE, 1]]
    ],

    Extractor: [
        [[WORK, 6], [MOVE, 3], [CARRY, 1]],
        [[WORK, 4], [MOVE, 2], [CARRY, 1]],
        [[WORK, 2], [MOVE, 1], [CARRY, 1]],
        [[WORK, 1], [MOVE, 1], [CARRY, 1]]
    ],

    Freighter: [
        [[CARRY, 12], [MOVE, 12]],
        [[CARRY, 6], [MOVE, 6]],
        [[CARRY, 6], [MOVE, 3]],
        [[CARRY, 4], [MOVE, 2]],
        [[CARRY, 2], [MOVE, 1]]
    ],

    Annex: [
        [[CLAIM, 2], [MOVE, 2]],
        [[CLAIM, 1], [MOVE, 1]]
    ],

    Tech: [
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

    Artificer: [
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
        [[ATTACK, 3], [MOVE, 3]],
        [[ATTACK, 2], [MOVE, 2]],
        [[ATTACK, 1], [MOVE, 1]]
    ],

    Volley: [
        [[RANGED_ATTACK, 3], [MOVE, 3]],
        [[RANGED_ATTACK, 2], [MOVE, 2]],
        [[RANGED_ATTACK, 1], [MOVE, 1]]
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

function getAnnexBody(room) {
    return getBody('Annex', room);
}

function getTechBody(room) {
    return getBody('Tech', room);
}

function getArtificerBody(room) {
    return getBody('Artificer', room);
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
