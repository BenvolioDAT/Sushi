const HiveMemory = require('HiveMind.Memory');
const TickIndex = require('HiveMind.Index');
const DemandBoard = require('Spawn.DemandBoard');
const CombatMath = require('Combat.Math');
const WarRoom = require('Logic.WarRoom');
const Tactics = require('Squad.Tactics');
const travel = require('utility.Travel.Creep');
const ResourceLabs = require('Resource.Labs');
const QuadController = require('Squad.Quad');

const STATES = Object.freeze([
    'FORMING', 'RALLYING', 'BOOSTING', 'MARCHING', 'ENGAGING',
    'RETREATING', 'RECOVERING', 'COMPLETE', 'ABORTED'
]);
const TERMINAL = new Set(['COMPLETE', 'ABORTED']);
const TRANSITIONS = {
    FORMING: new Set(['RALLYING', 'ABORTED']),
    RALLYING: new Set(['BOOSTING', 'MARCHING', 'RECOVERING', 'ABORTED']),
    BOOSTING: new Set(['MARCHING', 'RECOVERING', 'ABORTED']),
    MARCHING: new Set(['ENGAGING', 'RETREATING', 'RECOVERING', 'ABORTED']),
    ENGAGING: new Set(['RETREATING', 'RECOVERING', 'COMPLETE', 'ABORTED']),
    RETREATING: new Set(['RECOVERING', 'ABORTED']),
    RECOVERING: new Set(['FORMING', 'RALLYING', 'RETREATING', 'COMPLETE', 'ABORTED'])
};
const DEFAULT_TIMEOUTS = Object.freeze({
    FORMING: 1500, RALLYING: 250, BOOSTING: 500, MARCHING: 1000,
    ENGAGING: 1500, RETREATING: 350, RECOVERING: 500
});

function packPosition(value) {
    const pos = value && value.pos || value;
    return pos && Number.isInteger(pos.x) && Number.isInteger(pos.y) && pos.roomName ?
        { x: pos.x, y: pos.y, roomName: pos.roomName } : null;
}

function unpackPosition(value) {
    return value && value.roomName ? new RoomPosition(value.x, value.y, value.roomName) : null;
}

function nextSquadId(operationId) {
    const hive = HiveMemory.ensure();
    hive.counters.squad = (hive.counters.squad || 0) + 1;
    return `duo:${operationId || 'manual'}:${hive.counters.squad}`;
}

function defaultRallyPosition(originRoom) {
    const spawns = TickIndex.get().ownedSpawnsByRoom.get(originRoom) || [];
    if (spawns[0] && spawns[0].pos) return packPosition(spawns[0].pos);
    return originRoom ? { x: 25, y: 25, roomName: originRoom } : null;
}

function createDuo(options = {}) {
    const hive = HiveMemory.ensure();
    const id = options.id || nextSquadId(options.operationId);
    if (hive.squads[id] && !TERMINAL.has(hive.squads[id].state)) return hive.squads[id];
    const expectedTravelTime = Number.isFinite(options.expectedTravelTime) ? options.expectedTravelTime :
        options.originRoom && options.targetRoom && Game.map ?
            Game.map.getRoomLinearDistance(options.originRoom, options.targetRoom) * 50 : 50;
    const squad = {
        id,
        operationId: options.operationId || null,
        type: 'RANGED_DUO',
        state: options.state || 'FORMING',
        leader: null,
        members: { attacker: null, healer: null },
        desiredMemberCapabilities: {
            attacker: { role: 'Volley', ranged: 1 },
            healer: { role: 'Cleric', heal: 1 }
        },
        rallyPosition: packPosition(options.rallyPosition) || defaultRallyPosition(options.originRoom),
        originRoom: options.originRoom || null,
        targetRoom: options.targetRoom || null,
        sharedTargetId: null,
        formationMode: 'RALLY',
        stateStartTick: Game.time,
        createdTick: Game.time,
        updatedTick: Game.time,
        retreatDestination: packPosition(options.retreatDestination) ||
            defaultRallyPosition(options.originRoom),
        readinessThreshold: Number.isFinite(options.readinessThreshold) ? options.readinessThreshold : 0.8,
        abortThreshold: Number.isFinite(options.abortThreshold) ? options.abortThreshold : 0.2,
        expectedTravelTime,
        minimumAcceptableTTL: Number.isFinite(options.minimumAcceptableTTL) ?
            options.minimumAcceptableTTL : expectedTravelTime + 200,
        replacementRequirements: {
            enabled: true,
            travelBuffer: expectedTravelTime,
            attacker: 1,
            healer: 1
        },
        boostRequirements: options.boostRequirements || { attacker: [], healer: [] },
        acceptPartialBoosts: options.acceptPartialBoosts === true,
        stateTimeouts: { ...DEFAULT_TIMEOUTS, ...(options.stateTimeouts || {}) },
        demandIds: [],
        debugReason: options.debugReason || 'Waiting for ranged attacker and healer'
    };
    hive.squads[id] = squad;
    const operation = squad.operationId && hive.operations[squad.operationId];
    if (operation) {
        if (!operation.assignedSquads) operation.assignedSquads = [];
        if (!operation.assignedSquads.includes(id)) operation.assignedSquads.push(id);
    }
    return squad;
}

function transition(squadOrId, nextState, reason, guard = () => true) {
    const squad = typeof squadOrId === 'string' ? get(squadOrId) : squadOrId;
    if (squad && QuadController.TYPES.includes(squad.type)) {
        return QuadController.transition(squad, nextState, reason, guard);
    }
    if (!squad || TERMINAL.has(squad.state) || !STATES.includes(nextState) || !guard(squad)) return false;
    const allowed = TRANSITIONS[squad.state];
    if (!allowed || !allowed.has(nextState)) return false;
    squad.state = nextState;
    squad.stateStartTick = Game.time;
    squad.updatedTick = Game.time;
    squad.debugReason = reason || `Transitioned to ${nextState}`;
    if (nextState === 'COMPLETE') squad.completedTick = Game.time;
    if (nextState === 'ABORTED') squad.abortedTick = Game.time;
    return true;
}

function get(id) {
    return HiveMemory.ensure().squads[id] || null;
}

function memberCandidates(squad) {
    return (TickIndex.get().creepsBySquadId.get(squad.id) || []).filter(creep => creep && !creep.spawning);
}

function hasCapability(creep, capability) {
    const analysis = CombatMath.analyzeBody(creep);
    return capability === 'attacker' ? analysis.ranged > 0 : analysis.heal > 0;
}

function refreshMembers(squad) {
    const candidates = memberCandidates(squad);
    const byName = new Map(candidates.map(creep => [creep.name, creep]));
    const members = {};
    for (const slot of ['attacker', 'healer']) {
        const remembered = squad.members && squad.members[slot];
        let creep = remembered && byName.get(remembered);
        if (!creep || !hasCapability(creep, slot)) {
            creep = candidates.filter(candidate => !Object.values(members).includes(candidate))
                .filter(candidate => hasCapability(candidate, slot))
                .sort((a, b) => {
                    const aPreferred = a.memory && a.memory.squadSlot === slot ? 1 : 0;
                    const bPreferred = b.memory && b.memory.squadSlot === slot ? 1 : 0;
                    return bPreferred - aPreferred || String(a.name).localeCompare(String(b.name));
                })[0] || null;
        }
        members[slot] = creep;
        if (creep) {
            creep.memory.squadSlot = slot;
            creep.memory.squadId = squad.id;
            creep.memory.operationId = squad.operationId;
        }
    }
    squad.members = {
        attacker: members.attacker && members.attacker.name || null,
        healer: members.healer && members.healer.name || null
    };
    squad.leader = squad.members.attacker || squad.members.healer || null;
    const operation = squad.operationId && HiveMemory.ensure().operations[squad.operationId];
    if (operation) {
        const active = TickIndex.get().creepsByOperationId.get(operation.id) || [];
        operation.assignedCreeps = active.map(creep => creep.name).sort();
        if (!operation.assignedSquads) operation.assignedSquads = [];
        if (!operation.assignedSquads.includes(squad.id)) operation.assignedSquads.push(squad.id);
    }
    return members;
}

function memberReady(creep, squad) {
    if (!creep || creep.spawning || creep.hits <= 0) return false;
    if (creep.hitsMax && creep.hits / creep.hitsMax < squad.readinessThreshold) return false;
    return creep.ticksToLive === undefined || creep.ticksToLive >= squad.minimumAcceptableTTL;
}

function bothReady(members, squad) {
    return memberReady(members.attacker, squad) && memberReady(members.healer, squad);
}

function emitDemands(squad) {
    if (TERMINAL.has(squad.state) || squad.replacementRequirements && squad.replacementRequirements.enabled === false) return [];
    const operation = squad.operationId && HiveMemory.ensure().operations[squad.operationId];
    const emergency = !!(operation && operation.priority >= 95);
    const demands = [
        { slot: 'attacker', role: 'Volley', capabilities: { ranged: 1 } },
        { slot: 'healer', role: 'Cleric', capabilities: { heal: 1 } }
    ].map(specification => DemandBoard.emit({
        id: `squad:${squad.id}:${specification.slot}`,
        operationId: squad.operationId,
        squadId: squad.id,
        role: specification.role,
        capabilities: specification.capabilities,
        count: 1,
        priority: Math.max(85, operation && operation.priority || 0),
        originRoom: squad.originRoom,
        preferredSpawnRoom: squad.originRoom,
        targetRoom: squad.targetRoom,
        boostRequirements: squad.boostRequirements && squad.boostRequirements[specification.slot],
        replacementBuffer: squad.expectedTravelTime + 75,
        validUntil: Game.time + 5,
        emergency,
        memory: { squadSlot: specification.slot, formationRole: specification.slot },
        reason: `${squad.type} ${squad.state}`
    }));
    squad.demandIds = demands.map(demand => demand.id);
    return demands;
}

function getCommittedRoleCount(operationId, role) {
    if (HiveMemory.getConfig('combat').squads.enabled === false) return 0;
    const duoCount = Object.values(HiveMemory.ensure().squads).filter(squad => {
        if (!squad || TERMINAL.has(squad.state) || squad.operationId !== operationId) return false;
        return squad.type === 'RANGED_DUO' && (role === 'Volley' || role === 'Cleric');
    }).length;
    return duoCount + QuadController.getCommittedRoleCount(operationId, role);
}

function syncDefenseDuos() {
    const hive = HiveMemory.ensure();
    const settings = HiveMemory.getConfig('combat').squads;
    if (settings.enabled === false || settings.autoDefenseDuos === false) return;
    for (const operation of Object.values(hive.operations)) {
        if (!operation || operation.state === 'COMPLETE' || operation.state === 'ABORTED') continue;
        if (!['DEFEND_OWNED_ROOM', 'DEFEND_REMOTE'].includes(operation.type)) continue;
        const capabilities = operation.desiredCapabilities || {};
        if ((capabilities.damage || 0) <= 0 || (capabilities.healing || 0) <= 0) continue;
        createDuo({
            id: `duo:${operation.id}`,
            operationId: operation.id,
            originRoom: operation.originRoom,
            targetRoom: operation.targetRoom,
            expectedTravelTime: operation.originRoom && operation.targetRoom ?
                Game.map.getRoomLinearDistance(operation.originRoom, operation.targetRoom) * 50 : 50,
            debugReason: 'Dynamic defense duo requested'
        });
    }
}

function clearMemberLocks(members) {
    for (const creep of Object.values(members)) {
        if (creep && typeof creep.setTrafficLock === 'function') creep.setTrafficLock(false);
    }
}

function setHold(creep) {
    if (creep && typeof creep.setTrafficLock === 'function') creep.setTrafficLock(true);
}

function moveTo(creep, target, range, squad, fallbackPositions) {
    if (!creep || !target || creep.memory._sushiMoveTick === Game.time) return ERR_BUSY;
    return travel.move(creep, target, {
        range,
        reusePath: 5,
        trafficPriority: 90,
        squadId: squad.id,
        operationId: squad.operationId,
        fallbackPositions: fallbackPositions || [],
        disableSharedRouteCache: true
    });
}

function onExit(creep) {
    return creep && (creep.pos.x === 0 || creep.pos.x === 49 || creep.pos.y === 0 || creep.pos.y === 49);
}

function regroup(members, squad) {
    const leader = members.attacker || members.healer;
    const follower = leader === members.attacker ? members.healer : members.attacker;
    if (!leader) return;
    if (onExit(leader)) travel.moveOffExit(leader);
    else setHold(leader);
    if (follower) {
        if (onExit(follower) && follower.room.name === leader.room.name) travel.moveOffExit(follower);
        else moveTo(follower, leader, 1, squad);
    }
    squad.formationMode = 'RALLY';
    squad.debugReason = 'Regrouping separated or border-crossing members';
}

function roomHostiles(roomName) {
    return (TickIndex.get().hostilesByRoom.get(roomName) || []).filter(hostile => WarRoom.isHostileCreepThreat(hostile));
}

function roomTowers(roomName) {
    const byType = TickIndex.get().structuresByRoom.get(roomName);
    return Tactics.enemyTowers(byType && byType.get(STRUCTURE_TOWER) || []);
}

function currentLockedTarget(squad, attacker) {
    const target = squad.sharedTargetId && Game.getObjectById(squad.sharedTargetId);
    return target && target.hits > 0 && target.pos && attacker && target.pos.roomName === attacker.room.name ? target : null;
}

function performAttack(attacker, tactic) {
    if (!attacker || !tactic.target || CombatMath.rangeBetween(attacker, tactic.target) > 3) return;
    if (tactic.attackMode === 'mass' && typeof attacker.rangedMassAttack === 'function') attacker.rangedMassAttack();
    else if (tactic.attackMode === 'single' && typeof attacker.rangedAttack === 'function') attacker.rangedAttack(tactic.target);
}

function healOne(healer, target) {
    if (!healer || !target || CombatMath.analyzeBody(healer).heal <= 0) return;
    const range = CombatMath.rangeBetween(healer, target);
    if (range <= 1 && typeof healer.heal === 'function') healer.heal(target);
    else if (range <= 3 && typeof healer.rangedHeal === 'function') healer.rangedHeal(target);
}

function performActions(squad, members) {
    const attacker = members.attacker;
    const healer = members.healer;
    if (!attacker) return Tactics.evaluateDuo(attacker, healer, [], []);
    const hostiles = roomHostiles(attacker.room.name);
    const towers = roomTowers(attacker.room.name);
    const tactic = Tactics.evaluateDuo(attacker, healer, hostiles, towers, {
        lockedTarget: currentLockedTarget(squad, attacker)
    });
    squad.sharedTargetId = tactic.target && (tactic.target.id || tactic.target.name) || null;
    performAttack(attacker, tactic);
    const healTarget = tactic.heal && tactic.heal.member;
    if (healTarget) {
        healOne(healer, healTarget);
        if (attacker !== healTarget || attacker.hits < attacker.hitsMax) healOne(attacker, healTarget);
    }
    return tactic;
}

function boostSatisfied(creep, requirements) {
    if (!requirements || !requirements.length) return true;
    const boosts = CombatMath.analyzeBody(creep).boosts;
    return requirements.every(requirement => boosts[typeof requirement === 'string' ? requirement : requirement.compound] >=
        (typeof requirement === 'object' && requirement.parts || 1));
}

function timedOut(squad) {
    const timeout = squad.stateTimeouts && squad.stateTimeouts[squad.state];
    return Number.isFinite(timeout) && Game.time - squad.stateStartTick > timeout;
}

function handleTimeout(squad) {
    if (!timedOut(squad)) return false;
    if (['MARCHING', 'ENGAGING'].includes(squad.state)) return transition(squad, 'RETREATING', `${squad.state} timed out`);
    if (['RALLYING', 'BOOSTING'].includes(squad.state)) return transition(squad, 'RECOVERING', `${squad.state} timed out`);
    return transition(squad, 'ABORTED', `${squad.state} timed out`);
}

function membersAdjacent(members) {
    return !!(members.attacker && members.healer && members.attacker.room.name === members.healer.room.name &&
        CombatMath.rangeBetween(members.attacker, members.healer) <= 1);
}

function runForming(squad, members) {
    performActions(squad, members);
    const rally = unpackPosition(squad.rallyPosition);
    for (const creep of Object.values(members)) if (creep && rally) moveTo(creep, rally, 2, squad);
    if (bothReady(members, squad)) transition(squad, 'RALLYING', 'Required members are alive with sufficient TTL');
}

function runRallying(squad, members) {
    performActions(squad, members);
    if (!bothReady(members, squad)) {
        transition(squad, 'RECOVERING', 'Member readiness fell below rally threshold');
        return;
    }
    const rally = unpackPosition(squad.rallyPosition);
    if (!rally) {
        transition(squad, 'ABORTED', 'No valid rally position');
        return;
    }
    for (const creep of Object.values(members)) {
        if (creep.pos.roomName !== rally.roomName || !creep.pos.inRangeTo(rally, 2)) moveTo(creep, rally, 2, squad);
    }
    const rallied = Object.values(members).every(creep => creep.pos.roomName === rally.roomName && creep.pos.inRangeTo(rally, 2));
    if (!rallied || !membersAdjacent(members) || members.attacker.fatigue > 0 || members.healer.fatigue > 0) return;
    const needsBoosts = Object.values(squad.boostRequirements || {}).some(requirements => requirements && requirements.length);
    transition(squad, needsBoosts ? 'BOOSTING' : 'MARCHING', needsBoosts ? 'Rally complete; awaiting boosts' : 'Rally complete');
}

function runBoosting(squad, members) {
    performActions(squad, members);
    const attackerReady = boostSatisfied(members.attacker, squad.boostRequirements.attacker);
    const healerReady = boostSatisfied(members.healer, squad.boostRequirements.healer);
    if (attackerReady && healerReady) transition(squad, 'MARCHING', 'Required boosts verified');
    else if (squad.acceptPartialBoosts && Game.time - squad.stateStartTick > 25) transition(squad, 'MARCHING', 'Partial boosts explicitly accepted');
    else {
        for (const [slot, member] of Object.entries(members)) {
            if (!member) continue;
            const positions = ResourceLabs.getBoostPositions(squad.id, slot);
            const next = positions.find(item => !member.body.some(part => part.hits > 0 && part.boost === item.compound));
            if (next && next.pos) moveTo(member, unpackPosition(next.pos), 1, squad);
            else setHold(member);
        }
        squad.debugReason = 'Waiting for lab boost verification';
    }
}

function marchFormation(squad, members) {
    const attacker = members.attacker;
    const healer = members.healer;
    if (!attacker || !healer) return;
    if (attacker.room.name !== healer.room.name || onExit(attacker) || onExit(healer)) {
        regroup(members, squad);
        return;
    }
    if (!membersAdjacent(members) || attacker.fatigue > 0 || healer.fatigue > 0) {
        setHold(attacker);
        moveTo(healer, attacker, 1, squad);
        squad.debugReason = 'Holding leader for follower or fatigue';
        return;
    }
    squad.formationMode = 'TRANSPORT';
    moveTo(attacker, new RoomPosition(25, 25, squad.targetRoom), 22, squad);
    moveTo(healer, attacker, 0, squad);
}

function runMarching(squad, members) {
    const tactic = performActions(squad, members);
    if (!squad.targetRoom) {
        transition(squad, 'ABORTED', 'Marching squad has no target room');
        return;
    }
    if (!bothReady(members, squad)) {
        if (!members.healer || CombatMath.analyzeBody(members.healer).heal <= 0) transition(squad, 'RETREATING', 'Healer lost during march');
        else transition(squad, 'RECOVERING', 'Member readiness failed during march');
        return;
    }
    if (tactic.retreat) {
        transition(squad, 'RETREATING', tactic.retreatReason);
        return;
    }
    if (members.attacker.room.name === squad.targetRoom && members.healer.room.name === squad.targetRoom &&
        !onExit(members.attacker) && !onExit(members.healer)) {
        transition(squad, 'ENGAGING', 'Duo reached target room in formation');
        return;
    }
    marchFormation(squad, members);
}

function moveEngaging(squad, members, tactic) {
    const attacker = members.attacker;
    const healer = members.healer;
    if (!membersAdjacent(members) || attacker.fatigue > 0 || healer.fatigue > 0) {
        regroup(members, squad);
        return;
    }
    squad.formationMode = 'ATTACK';
    if (tactic.movement === 'kite') {
        const meleeThreats = roomHostiles(attacker.room.name).filter(hostile => CombatMath.analyzeBody(hostile).melee > 0);
        const realIncoming = tactic.memberRisk.find(risk => risk.member === attacker);
        const kite = Tactics.chooseKitePositions(attacker, healer, meleeThreats, {
            forceLeaveRampart: realIncoming && realIncoming.realIncoming > attacker.hits + realIncoming.healing
        });
        if (kite.primary) moveTo(attacker, kite.primary, 0, squad, kite.fallbacks);
        else setHold(attacker);
        moveTo(healer, attacker, 1, squad);
    }
    else if (tactic.movement === 'advance' && tactic.target) {
        moveTo(attacker, tactic.target, 3, squad);
        moveTo(healer, attacker, 1, squad);
    }
    else {
        setHold(attacker);
        setHold(healer);
    }
}

function runEngaging(squad, members) {
    if (!members.attacker || !members.healer || CombatMath.analyzeBody(members.healer).heal <= 0) {
        transition(squad, 'RETREATING', 'Healer lost or disabled while engaging');
        return;
    }
    const tactic = performActions(squad, members);
    if (tactic.retreat) {
        transition(squad, 'RETREATING', tactic.retreatReason);
        return;
    }
    if (!tactic.target) {
        squad.quietSince = squad.quietSince || Game.time;
        setHold(members.attacker);
        setHold(members.healer);
        return;
    }
    delete squad.quietSince;
    moveEngaging(squad, members, tactic);
}

function runRetreating(squad, members) {
    performActions(squad, members);
    const destination = unpackPosition(squad.retreatDestination);
    const leader = members.attacker || members.healer;
    const follower = leader === members.attacker ? members.healer : members.attacker;
    if (!leader || !destination) {
        transition(squad, 'ABORTED', 'Retreat has no surviving member or destination');
        return;
    }
    squad.formationMode = 'RETREAT';
    if (follower && leader.room.name === follower.room.name && CombatMath.rangeBetween(leader, follower) > 1) {
        setHold(leader);
        moveTo(follower, leader, 1, squad);
    }
    else {
        moveTo(leader, destination, 3, squad);
        if (follower) moveTo(follower, leader, 0, squad);
    }
    if (leader.pos.roomName === destination.roomName && leader.pos.inRangeTo(destination, 3)) {
        transition(squad, 'RECOVERING', 'Duo reached retreat destination');
    }
}

function runRecovering(squad, members) {
    performActions(squad, members);
    const rally = unpackPosition(squad.rallyPosition);
    for (const creep of Object.values(members)) if (creep && rally) moveTo(creep, rally, 2, squad);
    if (bothReady(members, squad)) transition(squad, 'RALLYING', 'Replacement and health thresholds restored');
    else squad.debugReason = 'Waiting for recovery or replacement';
}

function release(squad, members) {
    for (const demandId of squad.demandIds || []) DemandBoard.cancel(demandId);
    for (const creep of Object.values(members || {})) {
        if (!creep || !creep.memory || creep.memory.squadId !== squad.id) continue;
        delete creep.memory.squadId;
        delete creep.memory.squadSlot;
        delete creep.memory.formationRole;
        if ((squad.demandIds || []).includes(creep.memory.demandId)) delete creep.memory.demandId;
    }
}

function runSquad(squad) {
    if (squad && QuadController.TYPES.includes(squad.type)) return QuadController.runSquad(squad);
    const members = refreshMembers(squad);
    clearMemberLocks(members);
    const operation = squad.operationId && HiveMemory.ensure().operations[squad.operationId];
    if (operation && operation.state === 'COMPLETE') {
        if (squad.state === 'ENGAGING') transition(squad, 'COMPLETE', 'Assigned operation completed');
        else if (!['RETREATING', 'RECOVERING'].includes(squad.state)) {
            transition(squad, 'ABORTED', 'Assigned operation completed before deployment');
        }
    }
    else if (operation && operation.state === 'ABORTED' && !['RETREATING', 'RECOVERING'].includes(squad.state)) {
        if (['MARCHING', 'ENGAGING'].includes(squad.state)) transition(squad, 'RETREATING', 'Assigned operation aborted');
        else transition(squad, 'ABORTED', 'Assigned operation aborted before deployment');
    }
    const timeoutTransitioned = handleTimeout(squad);
    if (TERMINAL.has(squad.state)) {
        release(squad, members);
        return members;
    }
    if (timeoutTransitioned) return members;
    switch (squad.state) {
        case 'FORMING': runForming(squad, members); break;
        case 'RALLYING': runRallying(squad, members); break;
        case 'BOOSTING': runBoosting(squad, members); break;
        case 'MARCHING': runMarching(squad, members); break;
        case 'ENGAGING': runEngaging(squad, members); break;
        case 'RETREATING': runRetreating(squad, members); break;
        case 'RECOVERING': runRecovering(squad, members); break;
    }
    squad.updatedTick = Game.time;
    return members;
}

function plan() {
    if (HiveMemory.getConfig('combat').squads.enabled === false) return [];
    syncDefenseDuos();
    const active = Object.values(HiveMemory.ensure().squads)
        .filter(squad => squad && !QuadController.TYPES.includes(squad.type) && !TERMINAL.has(squad.state))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    for (const squad of active) emitDemands(squad);
    return active.concat(QuadController.plan());
}

function execute() {
    const controlled = new Set();
    if (HiveMemory.getConfig('combat').squads.enabled === false) return controlled;
    const squads = Object.values(HiveMemory.ensure().squads)
        .filter(Boolean).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    for (const squad of squads) {
        const members = QuadController.TYPES.includes(squad.type) ?
            QuadController.runSquad(squad) : runSquad(squad);
        for (const creep of Object.values(members)) if (creep) controlled.add(creep.name);
    }
    return controlled;
}

function abort(id, reason = 'Manual abort') {
    const squad = get(id);
    if (squad && QuadController.TYPES.includes(squad.type)) return QuadController.abort(id, reason);
    if (!squad || TERMINAL.has(squad.state)) return false;
    squad.state = 'ABORTED';
    squad.abortedTick = Game.time;
    squad.updatedTick = Game.time;
    squad.debugReason = reason;
    return true;
}

module.exports = {
    STATES,
    createDuo,
    createQuad: QuadController.create,
    get,
    transition,
    abort,
    plan,
    execute,
    runSquad,
    emitDemands,
    refreshMembers,
    bothReady,
    syncDefenseDuos,
    getCommittedRoleCount,
    packPosition,
    unpackPosition
};
