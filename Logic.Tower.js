const TickIndex = require('HiveMind.Index');
const HiveMemory = require('HiveMind.Memory');
const CombatMath = require('Combat.Math');
const ThreatLedger = require('Combat.ThreatLedger');
const Economy = require('HiveMind.Economy');

const FORTIFICATION_BY_RCL = {
    1: 0, 2: 20000, 3: 50000, 4: 100000,
    5: 250000, 6: 1000000, 7: 3000000, 8: 10000000
};
let lastDecisionByRoom = {};

function energy(tower) {
    if (!tower) return 0;
    if (tower.store && typeof tower.store.getUsedCapacity === 'function') {
        return tower.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    }
    return tower.store ? tower.store[RESOURCE_ENERGY] || 0 : tower.energy || 0;
}

function structuresOfType(roomName, type) {
    const byType = TickIndex.get().structuresByRoom.get(roomName);
    return byType && byType.get(type) || [];
}

function findMyTowers(room) {
    const type = typeof STRUCTURE_TOWER !== 'undefined' ? STRUCTURE_TOWER : 'tower';
    const indexed = structuresOfType(room.name, type).filter(tower => tower.my !== false);
    if (indexed.length || typeof room.find !== 'function') return indexed;
    return room.find(FIND_MY_STRUCTURES, { filter: structure => structure.structureType === type }) || [];
}

function liveHostiles(room) {
    const threat = ThreatLedger.getRoomThreat(room.name) || ThreatLedger.observeRoom(room);
    const allowed = new Set((threat && threat.hostiles || []).filter(record => record.harmful).map(record => record.id));
    return ThreatLedger.getLiveHostiles(room.name).filter(hostile => allowed.has(hostile.id || hostile.name));
}

function healingSupport(target, hostiles) {
    let healing = 0;
    for (const hostile of hostiles) {
        const body = CombatMath.analyzeBody(hostile);
        const range = CombatMath.rangeBetween(hostile, target);
        if (range <= 1) healing += body.heal;
        else if (range <= 3) healing += body.rangedHeal;
    }
    return healing;
}

function getRecord(roomName, target) {
    const threat = ThreatLedger.getRoomThreat(roomName);
    return threat && threat.hostiles.find(record => record.id === (target.id || target.name)) || null;
}

function attackTowersForTarget(roomName, towers, target) {
    const settings = HiveMemory.ensure().settings.towers;
    const record = getRecord(roomName, target);
    const urgent = record && (record.closestCriticalRange <= 3 || record.attackedUs);
    return towers.filter(tower => energy(tower) >= 10 && (urgent || energy(tower) > (settings.energyReserve || 200)));
}

function evaluateTowerTarget(room, towers, target, enemies) {
    const firingTowers = attackTowersForTarget(room.name, towers, target);
    const rawDamage = firingTowers.reduce((sum, tower) => sum + CombatMath.towerDamage(tower, target), 0);
    const actualDamage = CombatMath.damageAfterTough(target, rawDamage);
    const hostileHealing = healingSupport(target, enemies);
    const netDamage = actualDamage - hostileHealing;
    const record = getRecord(room.name, target);
    const hits = typeof target.hits === 'number' ? target.hits : CombatMath.analyzeBody(target).liveHits;
    const killable = actualDamage >= hits + hostileHealing;
    const important = !!(record && (record.attackedUs || record.closestCriticalRange <= 3));
    const score = (killable ? 100000 : 0) + (important ? 20000 : 0) +
        (record ? record.score : 0) + Math.max(0, netDamage) * 5 +
        (record && record.capabilities.heal > 0 ? 5000 : 0) +
        (hits < actualDamage * 2 ? 2000 : 0) - (netDamage <= 0 ? 10000 : 0);
    return {
        target, record, firingTowers, rawDamage: Math.round(rawDamage),
        actualDamage: Math.round(actualDamage), hostileHealing: Math.round(hostileHealing),
        netDamage: Math.round(netDamage), killable, important, score: Math.round(score),
        timeToKill: CombatMath.timeToKill(target, rawDamage, hostileHealing)
    };
}

function chooseTowerTarget(room, towers, enemies) {
    const evaluations = enemies.map(target => evaluateTowerTarget(room, towers, target, enemies));
    evaluations.sort((a, b) => b.score - a.score || String(a.target.id).localeCompare(String(b.target.id)));
    return evaluations[0] || null;
}

function friendlyCreeps(room) {
    const indexed = TickIndex.get().creepsByCurrentRoom.get(room.name) || [];
    if (indexed.length || typeof room.find !== 'function') return indexed;
    return room.find(FIND_MY_CREEPS) || [];
}

function chooseFriendlyHealTarget(room, hostiles, towers) {
    let best = null;
    for (const creep of friendlyCreeps(room)) {
        if (!creep || creep.hits >= creep.hitsMax) continue;
        const incoming = CombatMath.incomingDamage(creep, hostiles);
        const healing = towers.reduce((sum, tower) => sum + (energy(tower) >= 10 ? CombatMath.towerHeal(tower, creep) : 0), 0);
        const projectedHits = creep.hits - incoming + healing;
        const ratio = creep.hits / Math.max(1, creep.hitsMax);
        const score = (projectedHits <= 0 ? 100000 : 0) + incoming * 10 + (1 - ratio) * 1000;
        if (!best || score > best.score) best = { target: creep, incoming, healing, projectedHits, score };
    }
    return best;
}

function chooseDecision(room, towers, hostiles) {
    const target = chooseTowerTarget(room, towers, hostiles);
    const friendly = chooseFriendlyHealTarget(room, hostiles, towers);
    if (target && target.killable && target.important) return { action: 'attack', evaluation: target, target: target.target };
    if (friendly && friendly.projectedHits <= 0) return { action: 'heal', friendly, target: friendly.target };
    if (target && target.killable) return { action: 'attack', evaluation: target, target: target.target };
    if (target && (target.netDamage > 0 || target.important)) return { action: 'attack', evaluation: target, target: target.target };
    if (friendly && friendly.target.hits < friendly.target.hitsMax) return { action: 'heal', friendly, target: friendly.target };
    return { action: 'preserve', evaluation: target, target: null };
}

function executeDecision(towers, decision) {
    if (decision.action === 'attack') {
        for (const tower of decision.evaluation.firingTowers) tower.attack(decision.target);
    }
    else if (decision.action === 'heal') {
        for (const tower of towers) if (energy(tower) >= 10) tower.heal(decision.target);
    }
}

function getFortificationTarget(room, structure) {
    const rcl = room.controller && room.controller.level || 1;
    let target = FORTIFICATION_BY_RCL[rcl] || 0;
    const stored = room.storage && room.storage.store ? room.storage.store[RESOURCE_ENERGY] || 0 : 0;
    const economyMultiplier = stored >= 250000 ? 1.5 : stored < 20000 ? 0.5 : 1;
    const threat = ThreatLedger.getRoomThreat(room.name);
    const threatMultiplier = threat && threat.harmfulHostileCount > 0 ? 2 : 1;
    if (structure.structureType === (typeof STRUCTURE_WALL !== 'undefined' ? STRUCTURE_WALL : 'constructedWall')) target *= 0.75;
    return Math.min(structure.hitsMax || target, Math.round(target * economyMultiplier * threatMultiplier));
}

function repairTarget(room) {
    const byType = TickIndex.get().structuresByRoom.get(room.name);
    const structures = byType ? Array.from(byType.values()).flat() : [];
    const wall = typeof STRUCTURE_WALL !== 'undefined' ? STRUCTURE_WALL : 'constructedWall';
    const rampart = typeof STRUCTURE_RAMPART !== 'undefined' ? STRUCTURE_RAMPART : 'rampart';
    const road = typeof STRUCTURE_ROAD !== 'undefined' ? STRUCTURE_ROAD : 'road';
    const threat = ThreatLedger.getRoomThreat(room.name);
    return structures.filter(structure => {
        if (!structure || structure.my === false || structure.hits >= structure.hitsMax || structure.structureType === road) return false;
        if (structure.structureType === wall || structure.structureType === rampart) {
            return !!(threat && threat.harmfulHostileCount > 0 && structure.hits < Math.min(5000, getFortificationTarget(room, structure)));
        }
        return structure.hits < structure.hitsMax * 0.6;
    }).sort((a, b) => {
        const aRatio = a.hits / Math.max(1, a.hitsMax);
        const bRatio = b.hits / Math.max(1, b.hitsMax);
        return aRatio - bRatio || String(a.id).localeCompare(String(b.id));
    })[0] || null;
}

function peacefulWork(room, towers) {
    const wounded = chooseFriendlyHealTarget(room, [], towers);
    if (wounded && wounded.target.hits < wounded.target.hitsMax) {
        for (const tower of towers) if (energy(tower) >= 10) tower.heal(wounded.target);
        return { action: 'heal', target: wounded.target };
    }
    if (!Economy.canSpend(room, 'criticalMaintenance')) return { action: 'preserve', target: null };
    const target = repairTarget(room);
    if (!target) return { action: 'idle', target: null };
    const reserve = HiveMemory.ensure().settings.towers.repairEnergyReserve || 700;
    for (const tower of towers) if (energy(tower) >= reserve) tower.repair(target);
    return { action: 'repair', target };
}

function run(room) {
    if (!room || !room.controller || !room.controller.my) return null;
    const towers = findMyTowers(room);
    if (!towers.length) return null;
    const hostiles = liveHostiles(room);
    const decision = hostiles.length ? chooseDecision(room, towers, hostiles) : peacefulWork(room, towers);
    if (hostiles.length) executeDecision(towers, decision);
    lastDecisionByRoom[room.name] = { tick: Game.time, action: decision.action, targetId: decision.target && decision.target.id || null };
    return decision;
}

module.exports = {
    run,
    findMyTowers,
    chooseTowerTarget,
    evaluateTowerTarget,
    chooseFriendlyHealTarget,
    chooseDecision,
    getTowerAttackDamage: (towers, target) => Math.round(towers.reduce((sum, tower) => sum + CombatMath.towerDamage(tower, target), 0)),
    getTowerPowerAtRange: CombatMath.towerPowerAtRange,
    getFortificationTarget,
    getLastDecision: roomName => lastDecisionByRoom[roomName] || null
};
