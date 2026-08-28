function constant(name, fallback) {
    return typeof global[name] === 'number' ? global[name] : fallback;
}

function partName(name, fallback) {
    return typeof global[name] !== 'undefined' ? global[name] : fallback;
}

function boostMultiplier(type, boost, action) {
    if (!boost || typeof BOOSTS === 'undefined') return 1;
    const data = BOOSTS[type] && BOOSTS[type][boost];
    return data && typeof data[action] === 'number' ? data[action] : 1;
}

function bodyOf(subject) {
    return Array.isArray(subject) ? subject : subject && Array.isArray(subject.body) ? subject.body : [];
}

function rangeBetween(a, b) {
    const aPos = a && a.pos ? a.pos : a;
    const bPos = b && b.pos ? b.pos : b;
    if (!aPos || !bPos) return Infinity;
    if (typeof aPos.getRangeTo === 'function') return aPos.getRangeTo(bPos);
    return Math.max(Math.abs(aPos.x - bPos.x), Math.abs(aPos.y - bPos.y));
}

function analyzeBody(subject) {
    const body = bodyOf(subject);
    const types = {
        move: partName('MOVE', 'move'), work: partName('WORK', 'work'),
        carry: partName('CARRY', 'carry'), attack: partName('ATTACK', 'attack'),
        ranged: partName('RANGED_ATTACK', 'ranged_attack'), heal: partName('HEAL', 'heal'),
        claim: partName('CLAIM', 'claim'), tough: partName('TOUGH', 'tough')
    };
    const result = {
        parts: {}, boosts: {}, melee: 0, ranged: 0,
        rangedMass: { range1: 0, range2: 0, range3: 0 },
        dismantle: 0, heal: 0, rangedHeal: 0, claim: 0,
        effectiveHits: 0, liveHits: 0, movePower: 0, fatigueWeight: 0,
        movementRatio: 0, fatigueRisk: 1, dangerous: false
    };
    for (const part of body) {
        if (!part || !part.type || part.hits === 0) continue;
        const hits = typeof part.hits === 'number' ? part.hits : 100;
        result.parts[part.type] = (result.parts[part.type] || 0) + 1;
        result.liveHits += hits;
        if (part.boost) result.boosts[part.boost] = (result.boosts[part.boost] || 0) + 1;

        if (part.type === types.attack) {
            result.melee += constant('ATTACK_POWER', 30) * boostMultiplier(types.attack, part.boost, 'attack');
        }
        else if (part.type === types.ranged) {
            const power = constant('RANGED_ATTACK_POWER', 10) * boostMultiplier(types.ranged, part.boost, 'rangedAttack');
            result.ranged += power;
            result.rangedMass.range1 += power;
            result.rangedMass.range2 += power * 0.4;
            result.rangedMass.range3 += power * 0.1;
        }
        else if (part.type === types.work) {
            result.dismantle += constant('DISMANTLE_POWER', 50) * boostMultiplier(types.work, part.boost, 'dismantle');
        }
        else if (part.type === types.heal) {
            const multiplier = boostMultiplier(types.heal, part.boost, 'heal');
            result.heal += constant('HEAL_POWER', 12) * multiplier;
            result.rangedHeal += constant('RANGED_HEAL_POWER', 4) * multiplier;
        }
        else if (part.type === types.claim) result.claim++;

        if (part.type === types.move) {
            result.movePower += 2 * boostMultiplier(types.move, part.boost, 'fatigue');
        }
        else result.fatigueWeight += 1;

        const damageMultiplier = part.type === types.tough ? boostMultiplier(types.tough, part.boost, 'damage') : 1;
        result.effectiveHits += damageMultiplier > 0 ? hits / damageMultiplier : hits;
    }
    result.movementRatio = result.fatigueWeight > 0 ? result.movePower / result.fatigueWeight : Infinity;
    result.fatigueRisk = result.movementRatio >= 2 ? 0 : Math.max(0, 1 - result.movementRatio / 2);
    result.dangerous = result.melee > 0 || result.ranged > 0 || result.dismantle > 0 || result.heal > 0 || result.claim > 0;
    return result;
}

function damageAfterTough(subject, rawDamage) {
    let remaining = Math.max(0, rawDamage || 0);
    let realDamage = 0;
    const toughType = partName('TOUGH', 'tough');
    for (const part of bodyOf(subject)) {
        if (!part || part.hits === 0 || remaining <= 0) continue;
        const multiplier = part.type === toughType ? boostMultiplier(toughType, part.boost, 'damage') : 1;
        const safeMultiplier = multiplier > 0 ? multiplier : 1;
        const hits = typeof part.hits === 'number' ? part.hits : 100;
        const rawForPart = hits / safeMultiplier;
        const applied = Math.min(remaining, rawForPart);
        realDamage += applied * safeMultiplier;
        remaining -= applied;
    }
    return realDamage;
}

function rangedMassDamage(attacker, targets) {
    const analysis = analyzeBody(attacker);
    let damage = 0;
    for (const target of targets || []) {
        const range = rangeBetween(attacker, target);
        if (range <= 1) damage += analysis.rangedMass.range1;
        else if (range === 2) damage += analysis.rangedMass.range2;
        else if (range === 3) damage += analysis.rangedMass.range3;
    }
    return damage;
}

function towerPowerAtRange(basePower, range) {
    if (range <= 5) return basePower;
    if (range >= 20) return basePower * 0.25;
    return basePower * (1 - (0.75 * (range - 5) / 15));
}

function towerEffectMultiplier(tower) {
    if (!tower || !Array.isArray(tower.effects) || typeof PWR_OPERATE_TOWER === 'undefined') return 1;
    const effect = tower.effects.find(item => item && item.effect === PWR_OPERATE_TOWER);
    return effect ? 1 + Math.max(0, effect.level || 0) * 0.1 : 1;
}

function towerDamage(tower, target) {
    return towerPowerAtRange(constant('TOWER_POWER_ATTACK', 600), rangeBetween(tower, target)) * towerEffectMultiplier(tower);
}

function towerHeal(tower, target) {
    return towerPowerAtRange(constant('TOWER_POWER_HEAL', 400), rangeBetween(tower, target)) * towerEffectMultiplier(tower);
}

function incomingDamage(target, attackers) {
    let damage = 0;
    for (const attacker of attackers || []) {
        const analysis = analyzeBody(attacker);
        const range = rangeBetween(attacker, target);
        if (range <= 1) damage += analysis.melee;
        if (range <= 3) damage += analysis.ranged;
    }
    return damage;
}

function timeToKill(target, rawDamagePerTick, healingPerTick = 0) {
    const realDamage = damageAfterTough(target, rawDamagePerTick);
    const net = realDamage - Math.max(0, healingPerTick);
    if (net <= 0) return Infinity;
    return Math.ceil((target.hits || analyzeBody(target).liveHits) / net);
}

function timeToDie(target, incomingPerTick, healingPerTick = 0) {
    return timeToKill(target, incomingPerTick, healingPerTick);
}

module.exports = {
    boostMultiplier,
    analyzeBody,
    damageAfterTough,
    rangedMassDamage,
    rangeBetween,
    towerPowerAtRange,
    towerDamage,
    towerHeal,
    incomingDamage,
    timeToKill,
    timeToDie
};
