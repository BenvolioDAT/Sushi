const RemoteIntel = require('Remote.Intel');
const HiveMemory = require('HiveMind.Memory');
const TickIndex = require('HiveMind.Index');
const CombatMath = require('Combat.Math');
const Policy = require('Combat.Policy');

const THREAT_FORGET_TICKS = 1500;

function getStructures(roomName) {
    const byType = TickIndex.get().structuresByRoom.get(roomName);
    return byType ? Array.from(byType.values()).flat() : [];
}

function criticalPositions(room) {
    const important = new Set(['spawn', 'tower', 'storage', 'terminal', 'powerSpawn', 'reactor']);
    const positions = getStructures(room.name)
        .filter(structure => important.has(structure.structureType))
        .map(structure => structure.pos);
    if (room.controller && room.controller.pos) positions.push(room.controller.pos);
    return positions;
}

function closestRange(pos, positions) {
    let range = Infinity;
    for (const target of positions) range = Math.min(range, CombatMath.rangeBetween(pos, target));
    return range;
}

function attackEvents(room) {
    const attackedBy = new Map();
    const previous = HiveMemory.ensure().threats[room && room.name];
    if (previous && previous.tick === Game.time) {
        for (const record of previous.hostiles || []) if (record.attackedUs) attackedBy.set(record.id, { severity: record.incidentSeverity });
        return attackedBy;
    }
    if (!room || typeof room.getEventLog !== 'function') return attackedBy;
    const attackTypes = new Set();
    if (typeof EVENT_ATTACK !== 'undefined') attackTypes.add(EVENT_ATTACK);
    if (typeof EVENT_ATTACK_CONTROLLER !== 'undefined') attackTypes.add(EVENT_ATTACK_CONTROLLER);
    if (!attackTypes.size) return attackedBy;

    let events = [];
    try { events = room.getEventLog() || []; }
    catch (error) { return attackedBy; }
    for (const event of events) {
        if (!event || !attackTypes.has(event.event)) continue;
        const attacker = Game.getObjectById && Game.getObjectById(event.objectId);
        const targetId = event.data && event.data.targetId;
        const target = targetId && Game.getObjectById && Game.getObjectById(targetId);
        if (!attacker || !attacker.owner || !target) continue;
        // Tower fire is territorial defense, not diplomatic aggression.
        if (attacker.structureType === (typeof STRUCTURE_TOWER !== 'undefined' ? STRUCTURE_TOWER : 'tower')) continue;
        const ours = target.my === true || Object.values(Game.creeps || {}).some(creep => creep.id === targetId) ||
            target.structureType === 'controller' && target.reservation &&
            Object.values(Game.spawns || {}).some(spawn => spawn.owner && spawn.owner.username === target.reservation.username);
        const sources = Memory.rooms && Memory.rooms[room.name] && Memory.rooms[room.name].sources || {};
        const managedInfrastructure = Policy.isDefenseRoom(room.name) && Object.values(sources).some(source =>
            source && source.containerId === targetId);
        if (!ours && !managedInfrastructure) continue;
        const severity = target.structureType === 'spawn' || target.structureType === 'tower' ? 100 :
            target.structureType === 'controller' ? 120 : 40;
        attackedBy.set(attacker.id || attacker.name, { severity, targetId, type: 'attack' });
        Policy.recordIncident(attacker.owner.username, severity, {
            roomName: room.name, targetId, type: 'attack'
        });
    }
    return attackedBy;
}

function nearestOwnedRoom(roomName) {
    let best = null;
    let distance = Infinity;
    let bestAffordable = false;
    for (const room of TickIndex.get().ownedRooms) {
        if (!Object.values(Game.spawns || {}).some(spawn => spawn.my !== false && spawn.room && spawn.room.name === room.name)) continue;
        const current = room.name === roomName ? 0 : Game.map.getRoomLinearDistance(room.name, roomName);
        const affordable = room.name === roomName || require('HiveMind.Economy').checkSpend(room.name, 'combat').allowed;
        if (best === null || affordable && !bestAffordable || affordable === bestAffordable && current < distance) {
            bestAffordable = affordable;
            best = room.name;
            distance = current;
        }
    }
    return best;
}

function hostileTowerSupport(roomName) {
    return getStructures(roomName).filter(structure => structure.structureType === 'tower' && structure.my === false).length;
}

function summarizeHostile(hostile, room, attacked, positions, towerSupport, supportingArmed) {
    const body = CombatMath.analyzeBody(hostile);
    const owner = Policy.usernameOf(hostile) || 'unknown';
    const incident = attacked.get(hostile.id || hostile.name);
    const capabilities = {
        melee: body.melee,
        ranged: body.ranged,
        rangedMass: body.rangedMass,
        dismantle: body.dismantle,
        heal: body.heal,
        rangedHeal: body.rangedHeal,
        claim: body.claim,
        movePower: body.movePower,
        fatigueRisk: body.fatigueRisk
    };
    const context = { roomName: room.name, attackedUs: !!incident, supportingArmed };
    const harmful = Policy.isDangerous(owner, capabilities, context);
    const autoEngage = harmful && Policy.mayAutoDefendAgainst(owner, context);
    const proximity = closestRange(hostile.pos, positions);
    return {
        id: hostile.id || hostile.name || null,
        owner,
        classification: Policy.getClassification(owner),
        lastSeen: Game.time,
        capabilities,
        boosts: body.boosts,
        effectiveHits: Math.round(body.effectiveHits),
        liveHits: Math.round(body.liveHits),
        towerSupport,
        closestCriticalRange: Number.isFinite(proximity) ? proximity : null,
        attackedUs: !!incident,
        incidentSeverity: incident ? incident.severity : 0,
        harmful, // Legacy safety signal. Combat consumers must use autoEngage.
        dangerous: harmful,
        autoEngage,
        reason: harmful ? Policy.autoEngageReason(owner, context) : 'HARMLESS',
        score: Math.round(
            (capabilities.melee + capabilities.ranged + capabilities.dismantle) * 4 +
            capabilities.heal * 6 + body.effectiveHits * 0.05 +
            (proximity <= 3 ? 500 : 0) + (incident ? incident.severity * 5 : 0)
        ),
        timeLastConfirmed: Game.time
    };
}

function ensureDefenseOperation(snapshot) {
    const hive = HiveMemory.ensure();
    const id = `defend:${snapshot.roomName}`;
    if (!(snapshot.actionableHostileCount > 0) || !Policy.isDefenseRoom(snapshot.roomName) || !snapshot.respondingColony) {
        const existing = hive.operations[id];
        if (existing && existing.state !== 'COMPLETE') {
            existing.state = 'COMPLETE';
            existing.completedTick = Game.time;
            existing.updatedTick = Game.time;
            existing.debugReason = snapshot.dangerousHostileCount > 0 ? 'No permitted automatic defense targets' : 'Live vision is safe';
            existing.desiredCapabilities = { damage: 0, healing: 0 };
            existing.spawnDemands = [];
        }
        return null;
    }
    const existing = hive.operations[id] || {
        id,
        type: snapshot.owned ? 'DEFEND_OWNED_ROOM' : 'DEFEND_REMOTE',
        state: 'ACTIVE',
        createdTick: Game.time,
        targetRoom: snapshot.roomName,
        assignedCreeps: [],
        assignedSquads: []
    };
    existing.state = 'ACTIVE';
    existing.priority = snapshot.owned && snapshot.emergency ? 100 : 80;
    existing.originRoom = snapshot.respondingColony;
    existing.updatedTick = Game.time;
    existing.lastConfirmedTick = snapshot.timeLastConfirmed;
    existing.desiredCapabilities = {
        damage: Math.round(snapshot.actionableHealing + snapshot.actionableEffectiveHits / 10),
        healing: Math.round((snapshot.actionableMelee + snapshot.actionableRanged) * 0.5)
    };
    // Non-damaging NPC support still needs a defender; damaging forces use the existing duo/quad path.
    existing.spawnDemands = !snapshot.owned && existing.desiredCapabilities.healing <= 0 ? [{
        role: 'Volley', count: 1, capabilities: { ranged: 1 }, economyCategory: 'combat',
        targetRoom: snapshot.roomName, reason: 'Remote NPC support clearance'
    }] : [];
    existing.debugReason = `${snapshot.actionableHostileCount} actionable hostile(s), threat ${snapshot.totalThreat}`;
    hive.operations[id] = existing;
    return existing;
}

function observeRoom(room, suppliedHostiles) {
    if (!room) return null;
    RemoteIntel.refresh(room);
    const index = TickIndex.get();
    const hostiles = suppliedHostiles || index.hostilesByRoom.get(room.name) || [];
    const attacked = attackEvents(room);
    const positions = criticalPositions(room);
    const towerSupport = hostileTowerSupport(room.name);
    const armedOwners = new Set(hostiles.filter(hostile => {
        const body = CombatMath.analyzeBody(hostile);
        return body.melee > 0 || body.ranged > 0;
    }).map(Policy.usernameOf));
    const records = hostiles.map(hostile => summarizeHostile(hostile, room, attacked, positions, towerSupport, armedOwners.has(Policy.usernameOf(hostile))));
    const harmful = records.filter(record => record.harmful);
    const actionable = records.filter(record => record.autoEngage);
    const snapshot = {
        tick: Game.time,
        roomName: room.name,
        owned: !!(room.controller && room.controller.my),
        lastSeen: Game.time,
        hostileCount: records.length,
        harmfulHostileCount: harmful.length,
        dangerousHostileCount: harmful.length,
        actionableHostileCount: actionable.length,
        npcHostileCount: harmful.filter(record => record.classification === 'npc').length,
        humanThreatCount: harmful.filter(record => record.classification !== 'npc').length,
        actionableMelee: actionable.reduce((sum, record) => sum + record.capabilities.melee, 0),
        actionableRanged: actionable.reduce((sum, record) => sum + record.capabilities.ranged, 0),
        actionableDismantle: actionable.reduce((sum, record) => sum + record.capabilities.dismantle, 0),
        actionableHealing: actionable.reduce((sum, record) => sum + record.capabilities.heal, 0),
        actionableEffectiveHits: actionable.reduce((sum, record) => sum + record.effectiveHits, 0),
        hostileMelee: harmful.reduce((sum, record) => sum + record.capabilities.melee, 0),
        hostileRanged: harmful.reduce((sum, record) => sum + record.capabilities.ranged, 0),
        hostileDismantle: harmful.reduce((sum, record) => sum + record.capabilities.dismantle, 0),
        hostileHealing: harmful.reduce((sum, record) => sum + record.capabilities.heal, 0),
        hostileEffectiveHits: harmful.reduce((sum, record) => sum + record.effectiveHits, 0),
        totalThreat: harmful.reduce((sum, record) => sum + record.score, 0),
        emergency: harmful.some(record => record.attackedUs || record.closestCriticalRange <= 3),
        respondingColony: nearestOwnedRoom(room.name),
        hostiles: records,
        timeLastConfirmed: Game.time
    };
    HiveMemory.ensure().threats[room.name] = snapshot;
    ensureDefenseOperation(snapshot);
    if (!global.__sushiLiveThreats || global.__sushiLiveThreats.tick !== Game.time) {
        global.__sushiLiveThreats = { tick: Game.time, rooms: {} };
    }
    global.__sushiLiveThreats.rooms[room.name] = { room, hostiles };
    return snapshot;
}

function refreshPermissions(snapshot) {
    const targets = (snapshot.hostiles || []).filter(record => {
        record.autoEngage = !!record.harmful && Policy.mayAutoDefendAgainst(record.owner, {
            roomName: snapshot.roomName, attackedUs: record.attackedUs
        });
        record.classification = Policy.getClassification(record.owner);
        record.reason = record.harmful ? Policy.autoEngageReason(record.owner, {
            roomName: snapshot.roomName, attackedUs: record.attackedUs
        }) : 'HARMLESS';
        return record.autoEngage;
    });
    snapshot.actionableHostileCount = targets.length;
    for (const [field, capability] of [['Melee', 'melee'], ['Ranged', 'ranged'], ['Dismantle', 'dismantle'], ['Healing', 'heal']]) {
        snapshot[`actionable${field}`] = targets.reduce((sum, record) => sum + (record.capabilities[capability] || 0), 0);
    }
    snapshot.actionableEffectiveHits = targets.reduce((sum, record) => sum + record.effectiveHits, 0);
}

function cleanup() {
    const hive = HiveMemory.ensure();
    for (const [roomName, threat] of Object.entries(hive.threats)) {
        if (Game.time - (threat.timeLastConfirmed || threat.lastSeen || 0) > THREAT_FORGET_TICKS) {
            const operation = hive.operations[`defend:${roomName}`];
            if (operation && operation.state !== 'COMPLETE') {
                operation.state = 'COMPLETE';
                operation.completedTick = Game.time;
                operation.debugReason = 'Threat intel expired; await new observation';
            }
            delete hive.threats[roomName];
        }
    }
    for (const [id, operation] of Object.entries(hive.operations)) {
        if (operation.type && operation.type.startsWith('DEFEND_') && operation.state === 'COMPLETE' &&
            Game.time - (operation.completedTick || 0) > 500) delete hive.operations[id];
    }
}

function run() {
    HiveMemory.migrate();
    const index = TickIndex.get();
    const relevant = new Set(Object.keys(HiveMemory.ensure().threats));
    for (const memory of Object.values(Memory.rooms || {})) {
        const planner = memory && memory.remotePlanner;
        if (!planner) continue;
        for (const name of Object.keys(planner.remotes || {})) relevant.add(name);
        for (const info of Object.values(planner.sourceInfos || {})) {
            relevant.add(info.roomName);
            for (const name of info.route && info.route.roomSequence || []) relevant.add(name);
        }
    }
    for (const room of index.visibleRooms) {
        if (relevant.has(room.name) || (room.controller && room.controller.my) || (index.hostilesByRoom.get(room.name) || []).length > 0) {
            observeRoom(room);
        }
    }
    for (const snapshot of Object.values(HiveMemory.ensure().threats)) {
        if (Game.rooms[snapshot.roomName]) continue;
        refreshPermissions(snapshot);
        ensureDefenseOperation(snapshot);
        if (snapshot.dangerousHostileCount > 0) RemoteIntel.request(snapshot.roomName, 'DEFENSE_NEEDS_INTEL', 90);
    }
    cleanup();
}

function getRoomThreat(roomName) {
    return HiveMemory.ensure().threats[roomName] || null;
}

function getLiveHostiles(roomName) {
    const live = global.__sushiLiveThreats;
    return live && live.tick === Game.time && live.rooms[roomName] ? live.rooms[roomName].hostiles : [];
}

module.exports = { run, observeRoom, getRoomThreat, getLiveHostiles, cleanup, ensureDefenseOperation };
