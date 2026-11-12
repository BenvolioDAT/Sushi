const CombatMath = require('Combat.Math');

function compareIds(a, b) {
    return String(a && (a.id || a.name) || '').localeCompare(String(b && (b.id || b.name) || ''));
}

function tacticalTargetScore(target, attacker) {
    const analysis = CombatMath.analyzeBody(target);
    const range = CombatMath.rangeBetween(attacker, target);
    const wounded = Math.max(0, (target.hitsMax || analysis.liveHits) - (target.hits || analysis.liveHits));
    const boostCount = Object.values(analysis.boosts).reduce((sum, count) => sum + count, 0);
    return analysis.heal * 45 + analysis.ranged * 32 + analysis.melee * 28 +
        analysis.dismantle * 12 + boostCount * 100 + wounded * 0.25 - Math.min(10, range) * 5;
}

function selectTarget(attacker, hostiles, lockedTarget) {
    if (lockedTarget && lockedTarget.hits > 0 && CombatMath.rangeBetween(attacker, lockedTarget) < Infinity) {
        return lockedTarget;
    }
    return (hostiles || []).filter(target => target && target.hits > 0).slice().sort((a, b) => {
        return tacticalTargetScore(b, attacker) - tacticalTargetScore(a, attacker) || compareIds(a, b);
    })[0] || null;
}

function enemyTowers(roomStructures) {
    return (roomStructures || []).filter(structure => {
        if (!structure || structure.structureType !== STRUCTURE_TOWER || structure.my === true) return false;
        if (!structure.store) return true;
        return (structure.store[RESOURCE_ENERGY] || 0) > 0;
    });
}

function incomingDamage(member, hostiles, towers) {
    let raw = CombatMath.incomingDamage(member, hostiles || []);
    for (const tower of towers || []) raw += CombatMath.towerDamage(tower, member);
    return raw;
}

function healingAtTarget(target, healers) {
    let total = 0;
    for (const healer of healers || []) {
        if (!healer || healer.spawning) continue;
        const analysis = CombatMath.analyzeBody(healer);
        const range = CombatMath.rangeBetween(healer, target);
        if (range <= 1) total += analysis.heal;
        else if (range <= 3) total += analysis.rangedHeal;
    }
    return total;
}

function chooseHealTarget(members, hostiles, towers) {
    const living = (members || []).filter(member => member && member.hits > 0);
    const healers = living.filter(member => CombatMath.analyzeBody(member).heal > 0);
    return living.map(member => {
        const rawIncoming = incomingDamage(member, hostiles, towers);
        const realIncoming = CombatMath.damageAfterTough(member, rawIncoming);
        const healing = healingAtTarget(member, healers);
        const missing = Math.max(0, (member.hitsMax || member.hits) - member.hits);
        const projectedHits = member.hits + Math.min(missing, healing) - realIncoming;
        const projectedRatio = projectedHits / Math.max(1, member.hitsMax || member.hits);
        const timeToDie = CombatMath.timeToDie(member, rawIncoming, healing);
        return { member, rawIncoming, realIncoming, healing, missing, projectedHits, projectedRatio, timeToDie };
    }).filter(item => item.missing > 0 || item.realIncoming > 0)
        .sort((a, b) => a.projectedRatio - b.projectedRatio || a.timeToDie - b.timeToDie ||
            b.realIncoming - a.realIncoming || compareIds(a.member, b.member))[0] || null;
}

function chooseAttackMode(attacker, target, hostiles) {
    if (!attacker || !target || CombatMath.rangeBetween(attacker, target) > 3) return 'none';
    const single = CombatMath.analyzeBody(attacker).ranged;
    if (single <= 0) return 'none';
    const inRange = (hostiles || []).filter(hostile => CombatMath.rangeBetween(attacker, hostile) <= 3);
    const mass = CombatMath.rangedMassDamage(attacker, inRange);
    return mass > single ? 'mass' : 'single';
}

function evaluateDuo(attacker, healer, hostiles, towers, options = {}) {
    const livingHostiles = (hostiles || []).filter(hostile => hostile && hostile.hits > 0);
    const result = {
        retreat: false,
        retreatReason: null,
        movement: 'hold',
        target: selectTarget(attacker, livingHostiles, options.lockedTarget),
        heal: null,
        attackMode: 'none',
        memberRisk: []
    };
    if (!attacker || attacker.hits <= 0) {
        result.retreat = true;
        result.retreatReason = 'Attacker missing or dead';
        return result;
    }
    if (!healer || healer.hits <= 0 || CombatMath.analyzeBody(healer).heal <= 0) {
        result.retreat = true;
        result.retreatReason = 'Healer missing or incapable';
        return result;
    }

    const members = [attacker, healer];
    result.heal = chooseHealTarget(members, livingHostiles, towers);
    for (const member of members) {
        const rawIncoming = incomingDamage(member, livingHostiles, towers);
        const realIncoming = CombatMath.damageAfterTough(member, rawIncoming);
        const healing = healingAtTarget(member, [healer, attacker]);
        const risk = { member, rawIncoming, realIncoming, healing, projectedHits: member.hits + healing - realIncoming };
        result.memberRisk.push(risk);
        if (realIncoming > member.hits + healing) {
            result.retreat = true;
            result.retreatReason = `${member.name || member.id} cannot survive predicted damage`;
        }
    }

    if (!result.target) return result;
    result.attackMode = chooseAttackMode(attacker, result.target, livingHostiles);
    const targetAnalysis = CombatMath.analyzeBody(result.target);
    const attackerAnalysis = CombatMath.analyzeBody(attacker);
    const targetRange = CombatMath.rangeBetween(attacker, result.target);
    const closeMelee = livingHostiles.some(hostile => {
        const analysis = CombatMath.analyzeBody(hostile);
        return analysis.melee > 0 && CombatMath.rangeBetween(attacker, hostile) <= 3;
    });
    if (closeMelee) result.movement = 'kite';
    else if (targetRange > 3 && attackerAnalysis.ranged + CombatMath.analyzeBody(healer).heal >
        targetAnalysis.ranged + targetAnalysis.heal) result.movement = 'advance';
    return result;
}

function evaluateQuad(members, hostiles, towers, options = {}) {
    const livingMembers = (members || []).filter(member => member && member.hits > 0);
    const livingHostiles = (hostiles || []).filter(hostile => hostile && hostile.hits > 0);
    const attackers = livingMembers.filter(member => {
        const analysis = CombatMath.analyzeBody(member);
        return analysis.ranged > 0 || analysis.melee > 0 || analysis.dismantle > 0;
    });
    const healers = livingMembers.filter(member => CombatMath.analyzeBody(member).heal > 0);
    const leader = options.leader || attackers[0] || livingMembers[0] || null;
    const result = {
        retreat: false,
        retreatReason: null,
        recover: false,
        movement: 'hold',
        target: selectTarget(leader, livingHostiles, options.lockedTarget),
        attackModes: {},
        healAssignments: [],
        memberRisk: [],
        projectedRatio: 0
    };
    if (livingMembers.length < 3 || healers.length === 0) {
        result.retreat = true;
        result.retreatReason = livingMembers.length < 3 ? 'Quad lost half its formation' : 'Quad has no capable healer';
        return result;
    }
    if (livingMembers.length < 4) result.recover = true;

    let projectedHits = 0;
    let maximumHits = 0;
    for (const member of livingMembers) {
        const rawIncoming = incomingDamage(member, livingHostiles, towers);
        const realIncoming = CombatMath.damageAfterTough(member, rawIncoming);
        const healing = healingAtTarget(member, healers);
        const projected = member.hits + healing - realIncoming;
        const risk = {
            member,
            rawIncoming,
            realIncoming,
            healing,
            projectedHits: projected,
            projectedRatio: projected / Math.max(1, member.hitsMax || member.hits)
        };
        result.memberRisk.push(risk);
        projectedHits += Math.max(0, projected);
        maximumHits += Math.max(1, member.hitsMax || member.hits);
        if (projected <= 0) {
            result.retreat = true;
            result.retreatReason = `${member.name || member.id} cannot survive predicted focus`;
        }
    }
    result.projectedRatio = projectedHits / Math.max(1, maximumHits);
    if (result.projectedRatio < (options.abortThreshold || 0.2)) {
        result.retreat = true;
        result.retreatReason = 'Projected quad health is below abort threshold';
    }

    const risks = result.memberRisk.slice().sort((a, b) =>
        a.projectedRatio - b.projectedRatio || b.realIncoming - a.realIncoming || compareIds(a.member, b.member));
    for (let index = 0; index < healers.length; index++) {
        const risk = risks[Math.min(index, risks.length - 1)];
        if (risk) result.healAssignments.push({ healer: healers[index], target: risk.member, risk });
    }
    if (!result.target && options.structureTarget) result.target = options.structureTarget;
    for (const attacker of attackers) {
        result.attackModes[attacker.name || attacker.id] = chooseAttackMode(attacker, result.target, livingHostiles);
    }
    if (!result.target) return result;
    const targetRange = leader ? CombatMath.rangeBetween(leader, result.target) : Infinity;
    const closeMelee = livingHostiles.some(hostile =>
        CombatMath.analyzeBody(hostile).melee > 0 && CombatMath.rangeBetween(leader, hostile) <= 3);
    if (closeMelee && attackers.some(attacker => CombatMath.analyzeBody(attacker).ranged > 0)) result.movement = 'kite';
    else if (targetRange > (attackers.some(attacker => CombatMath.analyzeBody(attacker).ranged > 0) ? 3 : 1)) {
        result.movement = 'advance';
    }
    return result;
}

function insideRoom(x, y) {
    return x > 0 && x < 49 && y > 0 && y < 49;
}

function isWalkable(room, x, y) {
    if (!insideRoom(x, y)) return false;
    if (Game.map.getRoomTerrain(room.name).get(x, y) === TERRAIN_MASK_WALL) return false;
    if (typeof room.lookForAt !== 'function') return true;
    const structures = room.lookForAt(LOOK_STRUCTURES, x, y) || [];
    return !structures.some(structure => structure && OBSTACLE_OBJECT_TYPES.includes(structure.structureType));
}

function hasFriendlyRampart(creep) {
    if (!creep || !creep.room || typeof creep.room.lookForAt !== 'function') return false;
    return (creep.room.lookForAt(LOOK_STRUCTURES, creep.pos.x, creep.pos.y) || [])
        .some(structure => structure && structure.structureType === STRUCTURE_RAMPART && structure.my === true);
}

function chooseKitePositions(attacker, healer, hostiles, options = {}) {
    if (!attacker || !attacker.room || !hostiles || !hostiles.length) return { primary: null, fallbacks: [] };
    if (hasFriendlyRampart(attacker) && options.forceLeaveRampart !== true) {
        return { primary: null, fallbacks: [] };
    }
    const candidates = [];
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const x = attacker.pos.x + dx;
            const y = attacker.pos.y + dy;
            if (!isWalkable(attacker.room, x, y)) continue;
            const pos = new RoomPosition(x, y, attacker.room.name);
            const minimumRange = Math.min(...hostiles.map(hostile => CombatMath.rangeBetween(pos, hostile)));
            const healerRange = healer ? CombatMath.rangeBetween(pos, healer) : 99;
            if (healer && healerRange > 2) continue;
            const rampart = typeof attacker.room.lookForAt === 'function' &&
                (attacker.room.lookForAt(LOOK_STRUCTURES, x, y) || []).some(structure =>
                    structure.structureType === STRUCTURE_RAMPART && structure.my === true);
            const edgeDistance = Math.min(x, y, 49 - x, 49 - y);
            const score = minimumRange * 100 - healerRange * 15 + (rampart ? 1000 : 0) + Math.min(5, edgeDistance);
            candidates.push({ pos, score });
        }
    }
    candidates.sort((a, b) => b.score - a.score || a.pos.x - b.pos.x || a.pos.y - b.pos.y);
    return {
        primary: candidates[0] && candidates[0].pos || null,
        fallbacks: candidates.slice(1, 4).map(candidate => candidate.pos)
    };
}

module.exports = {
    tacticalTargetScore,
    selectTarget,
    enemyTowers,
    incomingDamage,
    healingAtTarget,
    chooseHealTarget,
    chooseAttackMode,
    evaluateDuo,
    evaluateQuad,
    chooseKitePositions,
    hasFriendlyRampart
};
