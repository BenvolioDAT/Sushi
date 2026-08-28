const TickIndex = require('HiveMind.Index');
const ThreatLedger = require('Combat.ThreatLedger');
const CombatMath = require('Combat.Math');

let demandTick = -1;
let demandByRoom = new Map();

function towersInRoom(roomName) {
    const byType = TickIndex.get().structuresByRoom.get(roomName);
    return byType && byType.get(typeof STRUCTURE_TOWER !== 'undefined' ? STRUCTURE_TOWER : 'tower') || [];
}

function towerEnergy(tower) {
    if (!tower || !tower.store) return tower && tower.energy || 0;
    if (typeof tower.store.getUsedCapacity === 'function') return tower.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    return tower.store[RESOURCE_ENERGY] || 0;
}

function getDemand(room) {
    if (!room) return null;
    if (demandTick !== Game.time) {
        demandTick = Game.time;
        demandByRoom = new Map();
    }
    if (demandByRoom.has(room.name)) return demandByRoom.get(room.name);
    const threat = ThreatLedger.getRoomThreat(room.name) || ThreatLedger.observeRoom(room);
    const liveHostiles = ThreatLedger.getLiveHostiles(room.name);
    const primaryRecord = threat && threat.hostiles.filter(record => record.harmful)
        .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))[0];
    const primaryTarget = primaryRecord && liveHostiles.find(hostile => (hostile.id || hostile.name) === primaryRecord.id);
    const towers = towersInRoom(room.name).filter(tower => towerEnergy(tower) >= 10);
    const towerDamage = primaryTarget ? towers.reduce((sum, tower) => sum + CombatMath.towerDamage(tower, primaryTarget), 0) : 0;
    const requiredDamage = threat && threat.harmfulHostileCount > 0 ?
        Math.max(0, threat.hostileHealing + threat.hostileEffectiveHits / 10 - towerDamage) : 0;
    const requiredHealing = threat ? Math.max(0, (threat.hostileMelee + threat.hostileRanged) * 0.6) : 0;
    const rangedBodyPower = Math.max(10, Math.floor((room.energyCapacityAvailable || 300) / 250) * 10);
    const healBodyPower = Math.max(12, Math.floor((room.energyCapacityAvailable || 300) / 300) * 12);
    let desiredMelee = 0;
    let desiredRanged = 0;
    let desiredHealers = 0;

    if (threat && threat.harmfulHostileCount > 0 && requiredDamage > 0) {
        desiredRanged = Math.min(3, Math.max(1, Math.ceil(requiredDamage / rangedBodyPower)));
        if (threat.hostileDismantle > 0 && threat.hostileMelee > threat.hostileRanged) desiredMelee = 1;
        if (requiredHealing > healBodyPower * 0.5) desiredHealers = Math.min(2, Math.ceil(requiredHealing / healBodyPower));
    }

    const demand = {
        tick: Game.time,
        roomName: room.name,
        operationId: threat && threat.harmfulHostileCount > 0 ? `defend:${room.name}` : null,
        harmfulHostileCount: threat ? threat.harmfulHostileCount : 0,
        totalThreat: threat ? threat.totalThreat : 0,
        requiredDamage: Math.round(requiredDamage),
        requiredHealing: Math.round(requiredHealing),
        towerCount: towers.length,
        towerDamageAvailable: Math.round(towerDamage),
        desiredMelee,
        desiredRanged,
        desiredHealers,
        emergency: !!(threat && threat.emergency),
        priority: threat && threat.emergency ? 95 : 82,
        primaryThreatId: primaryRecord ? primaryRecord.id : null
    };
    demandByRoom.set(room.name, demand);
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
    Memory.rooms[room.name].defenseSummary = { ...demand };
    return demand;
}

module.exports = { getDemand };
