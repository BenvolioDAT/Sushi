/*
 * Defense.Demand.js
 *
 * Room-local defensive spawn demand built from live vision. Detailed hostile
 * work is dormant in peace because Combat.Threat returns an empty summary from
 * the tick-cached hostile list. No unseen room creates cross-colony demand.
 */

var tickCache = require('Tick.Cache');
var combatThreat = require('Combat.Threat');
var TowerLogic = require('Logic.Tower');

var demandTick = null;
var demandByRoom = {};
var lastWarningByRoom = {};

function resetForTick() {
    var tick = typeof Game !== 'undefined' ? Game.time : -1;
    if (demandTick !== tick) {
        demandTick = tick;
        demandByRoom = {};
    }
}

function getTowers(room) {
    var structures = tickCache.getMyStructures(room);
    var towers = [];
    for (var i = 0; i < structures.length; i++) {
        if (structures[i].structureType === 'tower') {
            towers.push(structures[i]);
        }
    }
    return towers;
}

function getHighestThreatAnalysis(summary) {
    var best = null;
    for (var i = 0; i < summary.analyses.length; i++) {
        if (
            summary.analyses[i].dangerous &&
            (!best || summary.analyses[i].totalThreat > best.totalThreat)
        ) {
            best = summary.analyses[i];
        }
    }
    return best;
}

function getDemand(room) {
    resetForTick();
    if (!room) {
        return null;
    }
    if (demandByRoom[room.name]) {
        return demandByRoom[room.name];
    }

    var hostileSummary = combatThreat.getRoomSummary(room);
    var towers = getTowers(room);
    var primaryThreat = getHighestThreatAnalysis(hostileSummary);
    var towerDamageAvailable = primaryThreat ?
        TowerLogic.getTowerAttackDamage(towers, primaryThreat.hostile) : 0;
    var desiredMelee = 0;
    var desiredRanged = 0;
    var desiredHealers = 0;
    var pressure = hostileSummary.totalThreat +
        hostileSummary.hostileHealing * 8 - towerDamageAvailable * 2;

    if (hostileSummary.harmfulHostileCount > 0) {
        var towerLikelySufficient = towers.length > 0 && primaryThreat &&
            towerDamageAvailable > hostileSummary.hostileHealing &&
            towerDamageAvailable >= Math.min(
                primaryThreat.durability,
                1200
            );

        if (!towerLikelySufficient || pressure > 500) {
            if (
                hostileSummary.hostileDismantle > 0 ||
                hostileSummary.hostileAttack > hostileSummary.hostileRanged
            ) {
                desiredMelee = 1;
            }
            if (
                hostileSummary.hostileRanged > 0 ||
                hostileSummary.hostileHealing > 0 ||
                desiredMelee === 0
            ) {
                desiredRanged = 1;
            }
        }

        if (
            hostileSummary.totalThreat >= 1800 &&
            (desiredMelee + desiredRanged) > 0
        ) {
            desiredHealers = 1;
        }
    }

    var emergency = hostileSummary.harmfulHostileCount > 0 && !!(
        towers.length === 0 ||
        hostileSummary.hostileDismantle > 0 ||
        primaryThreat && primaryThreat.closestCriticalRange <= 3 ||
        pressure > 1200
    );
    var safeModeWarning = emergency && room.controller &&
        !room.controller.safeMode &&
        primaryThreat && primaryThreat.closestCriticalRange <= 1 &&
        towerDamageAvailable <= hostileSummary.hostileHealing;

    var demand = {
        tick: Game.time,
        roomName: room.name,
        hostileCount: hostileSummary.hostileCount,
        harmfulHostileCount: hostileSummary.harmfulHostileCount,
        hostileAttack: hostileSummary.hostileAttack,
        hostileRanged: hostileSummary.hostileRanged,
        hostileHealing: hostileSummary.hostileHealing,
        hostileDismantle: hostileSummary.hostileDismantle,
        hostileEffectiveHits: hostileSummary.hostileEffectiveHits,
        totalThreat: hostileSummary.totalThreat,
        towerCount: towers.length,
        towerDamageAvailable: towerDamageAvailable,
        desiredMelee: desiredMelee,
        desiredRanged: desiredRanged,
        desiredHealers: desiredHealers,
        emergency: emergency,
        safeModeWarning: safeModeWarning,
        primaryThreatId: primaryThreat ? primaryThreat.id : null,
        primaryThreatCategory: primaryThreat ? primaryThreat.category : null
    };

    demandByRoom[room.name] = demand;
    saveDemand(room, demand);
    return demand;
}

function getDemandSignature(demand) {
    return [
        demand.harmfulHostileCount,
        demand.hostileAttack,
        demand.hostileRanged,
        demand.hostileHealing,
        demand.hostileDismantle,
        demand.desiredMelee,
        demand.desiredRanged,
        demand.desiredHealers,
        demand.emergency ? 1 : 0,
        demand.safeModeWarning ? 1 : 0,
        demand.primaryThreatId || '-'
    ].join('|');
}

function saveDemand(room, demand) {
    if (!Memory.rooms) {
        Memory.rooms = {};
    }
    if (!Memory.rooms[room.name]) {
        Memory.rooms[room.name] = {};
    }
    var roomMemory = Memory.rooms[room.name];
    var signature = getDemandSignature(demand);
    var saved = roomMemory.defenseSummary;

    if (
        !saved ||
        saved.signature !== signature ||
        Game.time - (saved.tick || 0) >= 10
    ) {
        roomMemory.defenseSummary = {
            tick: Game.time,
            signature: signature,
            hostileCount: demand.hostileCount,
            harmfulHostileCount: demand.harmfulHostileCount,
            totalThreat: demand.totalThreat,
            towerDamageAvailable: demand.towerDamageAvailable,
            desiredMelee: demand.desiredMelee,
            desiredRanged: demand.desiredRanged,
            desiredHealers: demand.desiredHealers,
            emergency: demand.emergency,
            safeModeWarning: demand.safeModeWarning,
            primaryThreatId: demand.primaryThreatId,
            primaryThreatCategory: demand.primaryThreatCategory
        };
    }

    if (demand.safeModeWarning && lastWarningByRoom[room.name] !== signature) {
        lastWarningByRoom[room.name] = signature;
        console.log(
            'DEFENSE WARNING ' + room.name +
            ': critical structure threatened; safe mode was not auto-activated'
        );
    }
}

function getCurrent(roomName) {
    resetForTick();
    if (demandByRoom[roomName]) {
        return demandByRoom[roomName];
    }
    var room = Game.rooms && Game.rooms[roomName];
    return room ? getDemand(room) :
        Memory.rooms && Memory.rooms[roomName] ?
            Memory.rooms[roomName].defenseSummary || null : null;
}

module.exports = {
    getDemand: getDemand,
    getCurrent: getCurrent
};
