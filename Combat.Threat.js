/*
 * Combat.Threat.js
 *
 * Shared tick-local hostile analysis. Scores use current Screeps base powers:
 * ATTACK 30, RANGED_ATTACK 10, HEAL 12 (4 ranged), and WORK dismantle 50.
 * Boost multipliers are read from BOOSTS when the runtime exposes them.
 */

var tickCache = require('Tick.Cache');

var analysisTick = null;
var analysisById = {};
var analysisBuilds = 0;
var summaryTick = null;
var summaryByRoom = {};

function currentTick() {
    return typeof Game !== 'undefined' && typeof Game.time === 'number' ?
        Game.time : -1;
}

function resetForTick() {
    var tick = currentTick();
    if (analysisTick !== tick) {
        analysisTick = tick;
        analysisById = {};
    }
    if (summaryTick !== tick) {
        summaryTick = tick;
        summaryByRoom = {};
    }
}

function getBasePower(globalName, fallback) {
    if (
        typeof global !== 'undefined' &&
        typeof global[globalName] === 'number'
    ) {
        return global[globalName];
    }
    return fallback;
}

function getBoostMultiplier(partType, boost, action) {
    if (
        !boost ||
        typeof BOOSTS === 'undefined' ||
        !BOOSTS[partType] ||
        !BOOSTS[partType][boost] ||
        typeof BOOSTS[partType][boost][action] !== 'number'
    ) {
        return 1;
    }
    return BOOSTS[partType][boost][action];
}

function getRange(posA, posB) {
    if (!posA || !posB) {
        return 50;
    }
    if (typeof posA.getRangeTo === 'function') {
        return posA.getRangeTo(posB);
    }
    return Math.max(Math.abs(posA.x - posB.x), Math.abs(posA.y - posB.y));
}

function getCriticalPositions(room) {
    var positions = [];
    if (!room) {
        return positions;
    }
    var structures = tickCache.getRoomStructures(room);
    for (var i = 0; i < structures.length; i++) {
        var type = structures[i].structureType;
        if (
            type === 'spawn' ||
            type === 'tower' ||
            type === 'storage' ||
            type === 'terminal' ||
            type === 'rampart'
        ) {
            positions.push(structures[i].pos);
        }
    }
    if (room.controller && room.controller.pos) {
        positions.push(room.controller.pos);
    }
    return positions;
}

function getClosestCriticalRange(hostile, room) {
    var positions = getCriticalPositions(room);
    var closest = 50;
    for (var i = 0; i < positions.length; i++) {
        closest = Math.min(closest, getRange(hostile.pos, positions[i]));
    }
    return closest;
}

function makeCacheKey(hostile) {
    if (hostile && hostile.id) {
        return hostile.id;
    }
    return hostile && hostile.name ? hostile.name : 'unknown';
}

function analyze(hostile, room) {
    resetForTick();
    if (!hostile) {
        return null;
    }
    var key = makeCacheKey(hostile);
    if (analysisById[key]) {
        return analysisById[key];
    }

    analysisBuilds++;
    var body = hostile.body || [];
    var parts = {
        attack: 0,
        ranged_attack: 0,
        heal: 0,
        work: 0,
        claim: 0,
        tough: 0,
        move: 0,
        carry: 0
    };
    var attackPower = 0;
    var rangedPower = 0;
    var healingPower = 0;
    var rangedHealingPower = 0;
    var dismantlePower = 0;
    var maximumEffectiveHits = 0;
    var boostedToughParts = 0;

    for (var i = 0; i < body.length; i++) {
        var part = body[i];
        if (!part || !part.type || part.hits === 0) {
            continue;
        }
        parts[part.type] = (parts[part.type] || 0) + 1;
        if (part.type === 'attack') {
            attackPower += getBasePower('ATTACK_POWER', 30) *
                getBoostMultiplier('attack', part.boost, 'attack');
        }
        else if (part.type === 'ranged_attack') {
            rangedPower += getBasePower('RANGED_ATTACK_POWER', 10) *
                getBoostMultiplier('ranged_attack', part.boost, 'rangedAttack');
        }
        else if (part.type === 'heal') {
            var healMultiplier = getBoostMultiplier('heal', part.boost, 'heal');
            healingPower += getBasePower('HEAL_POWER', 12) * healMultiplier;
            rangedHealingPower += getBasePower('RANGED_HEAL_POWER', 4) * healMultiplier;
        }
        else if (part.type === 'work') {
            dismantlePower += getBasePower('DISMANTLE_POWER', 50) *
                getBoostMultiplier('work', part.boost, 'dismantle');
        }

        var damageMultiplier = part.type === 'tough' ?
            getBoostMultiplier('tough', part.boost, 'damage') : 1;
        if (damageMultiplier > 0 && damageMultiplier < 1) {
            boostedToughParts++;
            maximumEffectiveHits += 100 / damageMultiplier;
        }
        else {
            maximumEffectiveHits += 100;
        }
    }

    var hitsMax = hostile.hitsMax || Math.max(100, body.length * 100);
    var hits = typeof hostile.hits === 'number' ? hostile.hits : hitsMax;
    var hitRatio = Math.max(0, Math.min(1, hits / Math.max(1, hitsMax)));
    var effectiveHits = Math.round(maximumEffectiveHits * hitRatio);
    var closestCriticalRange = getClosestCriticalRange(hostile, room);
    var strategicThreat = 0;
    var category = 'scout';

    if (dismantlePower > 0) {
        category = 'dismantler';
        strategicThreat += closestCriticalRange <= 1 ? 700 :
            closestCriticalRange <= 3 ? 500 : closestCriticalRange <= 6 ? 150 : 0;
    }
    else if (rangedPower > 0) {
        category = 'ranged';
        strategicThreat += closestCriticalRange <= 3 ? 450 :
            closestCriticalRange <= 6 ? 120 : 0;
    }
    else if (attackPower > 0) {
        category = 'attacker';
        strategicThreat += closestCriticalRange <= 1 ? 500 :
            closestCriticalRange <= 4 ? 160 : 0;
    }
    else if (healingPower > 0) {
        category = 'healer';
        strategicThreat += 220;
    }
    else if (parts.claim > 0) {
        category = 'claimer';
        strategicThreat += closestCriticalRange <= 1 ? 500 :
            closestCriticalRange <= 4 ? 180 : 50;
    }

    var offensivePower = attackPower + rangedPower + dismantlePower;
    var dangerous = offensivePower > 0 || healingPower > 0 || parts.claim > 0;
    var totalThreat = dangerous ? Math.round(
        offensivePower * 6 +
        healingPower * 8 +
        effectiveHits * 0.05 +
        strategicThreat
    ) : Math.min(25, Math.round(effectiveHits * 0.02));

    var analysis = {
        id: hostile.id || hostile.name || null,
        hostile: hostile,
        owner: hostile.owner && hostile.owner.username || 'unknown',
        npcInvader: !!(hostile.owner && hostile.owner.username === 'Invader'),
        category: category,
        dangerous: dangerous,
        activeParts: parts,
        attackPower: attackPower,
        rangedPower: rangedPower,
        offensivePower: offensivePower,
        healingPower: healingPower,
        rangedHealingPower: rangedHealingPower,
        dismantlePower: dismantlePower,
        durability: effectiveHits,
        boostedToughParts: boostedToughParts,
        strategicThreat: strategicThreat,
        closestCriticalRange: closestCriticalRange,
        totalThreat: totalThreat
    };
    analysisById[key] = analysis;
    return analysis;
}

function estimateDamageAfterTough(hostile, rawDamage) {
    if (!hostile || rawDamage <= 0) {
        return 0;
    }
    var body = hostile.body || [];
    var remainingRaw = rawDamage;
    var realDamage = 0;

    for (var i = 0; i < body.length && remainingRaw > 0; i++) {
        var part = body[i];
        if (!part || part.hits === 0) {
            continue;
        }
        var multiplier = part.type === 'tough' ?
            getBoostMultiplier('tough', part.boost, 'damage') : 1;
        if (multiplier <= 0) {
            multiplier = 1;
        }
        var partHits = typeof part.hits === 'number' ? part.hits : 100;
        var rawToBreakPart = partHits / multiplier;
        var rawApplied = Math.min(remainingRaw, rawToBreakPart);
        realDamage += rawApplied * multiplier;
        remainingRaw -= rawApplied;
    }
    return Math.round(realDamage);
}

function getHealingSupport(target, hostiles) {
    if (!target) {
        return 0;
    }
    var healing = 0;
    hostiles = hostiles || [];
    for (var i = 0; i < hostiles.length; i++) {
        var healer = hostiles[i];
        var healerAnalysis = analyze(healer, healer.room || target.room);
        if (!healerAnalysis || healerAnalysis.healingPower <= 0) {
            continue;
        }
        var range = getRange(healer.pos, target.pos);
        if (range <= 1) {
            healing += healerAnalysis.healingPower;
        }
        else if (range <= 3) {
            healing += healerAnalysis.rangedHealingPower;
        }
    }
    return Math.round(healing);
}

function getRoomSummary(room, suppliedHostiles) {
    resetForTick();
    if (!room) {
        return null;
    }
    if (summaryByRoom[room.name]) {
        return summaryByRoom[room.name];
    }

    var hostiles = suppliedHostiles || tickCache.getHostileCreeps(room);
    var summary = {
        tick: currentTick(),
        roomName: room.name,
        hostileCount: hostiles.length,
        harmfulHostileCount: 0,
        hostileAttack: 0,
        hostileRanged: 0,
        hostileHealing: 0,
        hostileDismantle: 0,
        hostileEffectiveHits: 0,
        totalThreat: 0,
        highestThreat: 0,
        emergency: false,
        analyses: []
    };

    for (var i = 0; i < hostiles.length; i++) {
        var hostileAnalysis = analyze(hostiles[i], room);
        summary.analyses.push(hostileAnalysis);
        summary.hostileAttack += hostileAnalysis.attackPower;
        summary.hostileRanged += hostileAnalysis.rangedPower;
        summary.hostileHealing += hostileAnalysis.healingPower;
        summary.hostileDismantle += hostileAnalysis.dismantlePower;
        summary.hostileEffectiveHits += hostileAnalysis.durability;
        summary.totalThreat += hostileAnalysis.totalThreat;
        summary.highestThreat = Math.max(
            summary.highestThreat,
            hostileAnalysis.totalThreat
        );
        if (hostileAnalysis.dangerous) {
            summary.harmfulHostileCount++;
        }
    }
    summary.emergency = summary.harmfulHostileCount > 0 &&
        (summary.totalThreat >= 500 || summary.hostileDismantle > 0);
    summaryByRoom[room.name] = summary;
    return summary;
}

function getDebugStats() {
    resetForTick();
    return {
        tick: analysisTick,
        analysesBuiltThisGlobal: analysisBuilds,
        cachedHostiles: Object.keys(analysisById).length
    };
}

module.exports = {
    analyze: analyze,
    getRoomSummary: getRoomSummary,
    getHealingSupport: getHealingSupport,
    estimateDamageAfterTough: estimateDamageAfterTough,
    getDebugStats: getDebugStats,
    getRange: getRange
};
