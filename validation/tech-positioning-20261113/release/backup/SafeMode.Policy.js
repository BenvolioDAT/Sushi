const HiveMemory = require('HiveMind.Memory');
const TickIndex = require('HiveMind.Index');
const ThreatLedger = require('Combat.ThreatLedger');
const CombatMath = require('Combat.Math');

const lastLog = {};

function towers(roomName) {
    const byType = TickIndex.get().structuresByRoom.get(roomName);
    return byType && byType.get(typeof STRUCTURE_TOWER !== 'undefined' ? STRUCTURE_TOWER : 'tower') || [];
}

function defenders(roomName) {
    return (TickIndex.get().creepsByCurrentRoom.get(roomName) || []).filter(creep => {
        const role = creep.memory && creep.memory.role;
        return role === 'Ronin' || role === 'Volley' || role === 'Cleric';
    });
}

function evaluate(room) {
    const controller = room && room.controller;
    if (!controller || !controller.my) return { shouldActivate: false, reason: 'Room is not owned' };
    if (controller.safeMode) return { shouldActivate: false, reason: 'Safe mode is already active' };
    if (!controller.safeModeAvailable) return { shouldActivate: false, reason: 'No safe modes available' };
    if (controller.safeModeCooldown) return { shouldActivate: false, reason: 'Safe mode is on cooldown' };
    if (controller.upgradeBlocked) return { shouldActivate: false, reason: 'Controller upgradeBlocked is active' };

    const threat = ThreatLedger.getRoomThreat(room.name);
    if (!threat || threat.harmfulHostileCount <= 0) return { shouldActivate: false, reason: 'No actionable hostile' };
    const critical = threat.hostiles.filter(record => record.harmful && record.closestCriticalRange !== null && record.closestCriticalRange <= 1);
    if (!critical.length) return { shouldActivate: false, reason: 'No critical asset is in immediate range' };
    const live = ThreatLedger.getLiveHostiles(room.name);
    const towerDamage = towers(room.name).reduce((sum, tower) => {
        const target = live[0];
        return sum + (target ? CombatMath.towerDamage(tower, target) : 0);
    }, 0);
    const friendlyDefense = defenders(room.name).reduce((sum, creep) => {
        const body = CombatMath.analyzeBody(creep);
        return sum + body.melee + body.ranged + body.heal;
    }, 0);
    const predictedDamage = threat.hostileMelee + threat.hostileRanged + threat.hostileDismantle;
    const operation = HiveMemory.ensure().operations[`defend:${room.name}`];
    const reinforcementEta = operation && operation.reinforcementEta;
    const breach = critical.some(record => record.closestCriticalRange <= 1);
    const overwhelmed = predictedDamage > towerDamage + friendlyDefense;
    const shouldActivate = breach && overwhelmed && !(typeof reinforcementEta === 'number' && reinforcementEta <= 3);
    return {
        shouldActivate,
        reason: shouldActivate ?
            `critical breach: hostile power ${Math.round(predictedDamage)} exceeds local defense ${Math.round(towerDamage + friendlyDefense)}` :
            'Local towers/defenders or immediate reinforcements can contain the breach',
        breach,
        predictedDamage: Math.round(predictedDamage),
        towerDamage: Math.round(towerDamage),
        friendlyDefense: Math.round(friendlyDefense),
        reinforcementEta: reinforcementEta === undefined ? null : reinforcementEta
    };
}

function run(room) {
    const settings = HiveMemory.getConfig('combat').safeMode;
    if (settings.enabled === false) return { activated: false, reason: 'Safe-mode policy disabled' };
    const decision = evaluate(room);
    if (!decision.shouldActivate) return { ...decision, activated: false };
    if (settings.manualConfirmation !== false) {
        if (lastLog[room.name] !== decision.reason) {
            console.log(`SAFE MODE WARNING ${room.name}: ${decision.reason}; manual confirmation required`);
            lastLog[room.name] = decision.reason;
        }
        return { ...decision, activated: false, manualConfirmationRequired: true };
    }
    if (typeof room.controller.activateSafeMode !== 'function') {
        return { ...decision, activated: false, result: null, reason: `${decision.reason}; API unavailable` };
    }
    const result = room.controller.activateSafeMode();
    const activated = result === OK;
    if (activated) console.log(`SAFE MODE ACTIVATED ${room.name}: ${decision.reason}`);
    return { ...decision, activated, result };
}

module.exports = { evaluate, run };
