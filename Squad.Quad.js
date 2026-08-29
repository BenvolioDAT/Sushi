const HiveMemory = require('HiveMind.Memory');
const TickIndex = require('HiveMind.Index');
const DemandBoard = require('Spawn.DemandBoard');
const Operations = require('HiveMind.Operations');
const CombatMath = require('Combat.Math');
const WarRoom = require('Logic.WarRoom');
const Tactics = require('Squad.Tactics');
const ResourceLabs = require('Resource.Labs');
const travel = require('utility.Travel.Creep');

const TYPES = Object.freeze(['RANGED_QUAD', 'SIEGE_QUAD']);
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
    FORMING: 1800, RALLYING: 350, BOOSTING: 600, MARCHING: 1200,
    ENGAGING: 2000, RETREATING: 500, RECOVERING: 700
});
const TRANSFORMS = Object.freeze([
    Object.freeze([[0, 0], [1, 0], [0, 1], [1, 1]]),
    Object.freeze([[0, 0], [-1, 0], [0, 1], [-1, 1]]),
    Object.freeze([[0, 0], [-1, 0], [0, -1], [-1, -1]]),
    Object.freeze([[0, 0], [1, 0], [0, -1], [1, -1]])
]);

function packPosition(value) {
    const pos = value && value.pos || value;
    return pos && Number.isInteger(pos.x) && Number.isInteger(pos.y) && pos.roomName ?
        { x: pos.x, y: pos.y, roomName: pos.roomName } : null;
}

function unpackPosition(value) {
    return value && value.roomName ? new RoomPosition(value.x, value.y, value.roomName) : null;
}

function defaultRallyPosition(originRoom) {
    const spawns = TickIndex.get().ownedSpawnsByRoom.get(originRoom) || [];
    const spawn = spawns[0];
    if (spawn && spawn.pos) {
        const x = Math.max(2, Math.min(47, spawn.pos.x + (spawn.pos.x < 25 ? 2 : -2)));
        const y = Math.max(2, Math.min(47, spawn.pos.y + (spawn.pos.y < 25 ? 2 : -2)));
        return { x, y, roomName: spawn.pos.roomName };
    }
    return originRoom ? { x: 25, y: 25, roomName: originRoom } : null;
}

function definitions(type) {
    if (type === 'SIEGE_QUAD') {
        return [
            { slot: 'strikerA', role: 'Ronin', capability: 'melee' },
            { slot: 'strikerB', role: 'Ronin', capability: 'melee' },
            { slot: 'healerA', role: 'Cleric', capability: 'heal' },
            { slot: 'healerB', role: 'Cleric', capability: 'heal' }
        ];
    }
    return [
        { slot: 'rangedA', role: 'Volley', capability: 'ranged' },
        { slot: 'rangedB', role: 'Volley', capability: 'ranged' },
        { slot: 'healerA', role: 'Cleric', capability: 'heal' },
        { slot: 'healerB', role: 'Cleric', capability: 'heal' }
    ];
}

function create(options = {}) {
    const type = TYPES.includes(options.type) ? options.type : 'RANGED_QUAD';
    const hive = HiveMemory.ensure();
    const id = options.id || `quad:${options.operationId || 'manual'}`;
    if (hive.squads[id] && !TERMINAL.has(hive.squads[id].state)) return hive.squads[id];
    const memberDefinitions = definitions(type);
    const expectedTravelTime = Number.isFinite(options.expectedTravelTime) ? options.expectedTravelTime :
        options.originRoom && options.targetRoom && Game.map ?
            Game.map.getRoomLinearDistance(options.originRoom, options.targetRoom) * 50 : 100;
    const members = {};
    const desiredMemberCapabilities = {};
    const boostRequirements = {};
    for (const definition of memberDefinitions) {
        members[definition.slot] = null;
        desiredMemberCapabilities[definition.slot] = {
            role: definition.role,
            [definition.capability]: 1
        };
        boostRequirements[definition.slot] = options.boostRequirements &&
            options.boostRequirements[definition.slot] || [];
    }
    const squad = {
        id,
        operationId: options.operationId || null,
        type,
        state: options.state || 'FORMING',
        leader: null,
        leaderSlot: memberDefinitions[0].slot,
        members,
        memberSlots: memberDefinitions.map(definition => definition.slot),
        desiredMemberCapabilities,
        rallyPosition: packPosition(options.rallyPosition) || defaultRallyPosition(options.originRoom),
        originRoom: options.originRoom || null,
        targetRoom: options.targetRoom || null,
        sharedTargetId: options.targetId || null,
        formationMode: 'RALLY',
        formationTransform: 0,
        formationAnchor: null,
        stateStartTick: Game.time,
        createdTick: Game.time,
        updatedTick: Game.time,
        retreatDestination: packPosition(options.retreatDestination) || defaultRallyPosition(options.originRoom),
        readinessThreshold: Number.isFinite(options.readinessThreshold) ? options.readinessThreshold : 0.85,
        abortThreshold: Number.isFinite(options.abortThreshold) ? options.abortThreshold : 0.25,
        expectedTravelTime,
        minimumAcceptableTTL: Number.isFinite(options.minimumAcceptableTTL) ?
            options.minimumAcceptableTTL : expectedTravelTime + 300,
        replacementRequirements: {
            enabled: true,
            arrivalBuffer: expectedTravelTime + 150,
            slots: memberDefinitions.reduce((result, definition) => {
                result[definition.slot] = 1;
                return result;
            }, {})
        },
        boostRequirements,
        acceptPartialBoosts: options.acceptPartialBoosts === true,
        stateTimeouts: { ...DEFAULT_TIMEOUTS, ...(options.stateTimeouts || {}) },
        demandIds: [],
        minimumMembers: 3,
        completionQuietTicks: Number.isFinite(options.completionQuietTicks) ? options.completionQuietTicks : 25,
        debugReason: options.debugReason || `Waiting for ${type.toLowerCase().replace('_', ' ')} members`
    };
    hive.squads[id] = squad;
    const operation = squad.operationId && hive.operations[squad.operationId];
    if (operation) {
        if (!operation.assignedSquads) operation.assignedSquads = [];
        if (!operation.assignedSquads.includes(id)) operation.assignedSquads.push(id);
    }
    return squad;
}

function get(id) {
    return HiveMemory.ensure().squads[id] || null;
}

function transition(squadOrId, nextState, reason, guard = () => true) {
    const squad = typeof squadOrId === 'string' ? get(squadOrId) : squadOrId;
    if (!squad || TERMINAL.has(squad.state) || !STATES.includes(nextState) || !guard(squad)) return false;
    if (squad.state === nextState) return true;
    const allowed = TRANSITIONS[squad.state];
    if (!allowed || !allowed.has(nextState)) return false;
    squad.state = nextState;
    squad.stateStartTick = Game.time;
    squad.updatedTick = Game.time;
    squad.debugReason = reason || `Quad transitioned to ${nextState}`;
    if (nextState === 'COMPLETE') squad.completedTick = Game.time;
    if (nextState === 'ABORTED') squad.abortedTick = Game.time;
    return true;
}

function capabilityValue(creep, capability) {
    const analysis = CombatMath.analyzeBody(creep);
    if (capability === 'melee') return analysis.melee + analysis.dismantle;
    return analysis[capability] || 0;
}

function memberCandidates(squad) {
    return (TickIndex.get().creepsBySquadId.get(squad.id) || []).filter(creep => creep && !creep.spawning);
}

function refreshMembers(squad) {
    const candidates = memberCandidates(squad);
    const byName = new Map(candidates.map(creep => [creep.name, creep]));
    const selected = new Set();
    const members = {};
    /* Preserve every surviving remembered slot before filling any vacancy. */
    for (const slot of squad.memberSlots) {
        const requirement = squad.desiredMemberCapabilities[slot];
        const capability = Object.keys(requirement).find(key => key !== 'role');
        const remembered = squad.members[slot] && byName.get(squad.members[slot]);
        const creep = remembered && !selected.has(remembered.name) && remembered.memory && remembered.memory.role === requirement.role &&
            capabilityValue(remembered, capability) > 0 ? remembered : null;
        members[slot] = creep;
        if (creep) selected.add(creep.name);
    }
    for (const slot of squad.memberSlots) {
        const requirement = squad.desiredMemberCapabilities[slot];
        const capability = Object.keys(requirement).find(key => key !== 'role');
        let creep = members[slot];
        if (!creep) {
            creep = candidates.filter(candidate => !selected.has(candidate.name))
                .filter(candidate => candidate.memory && candidate.memory.role === requirement.role)
                .filter(candidate => capabilityValue(candidate, capability) > 0)
                .sort((a, b) => {
                    const preferredA = a.memory.squadSlot === slot ? 1 : 0;
                    const preferredB = b.memory.squadSlot === slot ? 1 : 0;
                    return preferredB - preferredA || String(a.name).localeCompare(String(b.name));
                })[0] || null;
        }
        members[slot] = creep;
        squad.members[slot] = creep && creep.name || null;
        if (creep) {
            selected.add(creep.name);
            creep.memory.squadId = squad.id;
            creep.memory.squadSlot = slot;
            creep.memory.formationRole = slot;
            creep.memory.operationId = squad.operationId;
        }
    }
    const priorLeader = squad.leader && byName.get(squad.leader);
    const leader = priorLeader && selected.has(priorLeader.name) ? priorLeader :
        squad.memberSlots.map(slot => members[slot]).find(Boolean) || null;
    if (squad.leader && (!leader || squad.leader !== leader.name)) squad.lastLeaderLostTick = Game.time;
    squad.leader = leader && leader.name || null;
    squad.leaderSlot = leader && leader.memory.squadSlot || squad.memberSlots[0];
    const operation = squad.operationId && HiveMemory.ensure().operations[squad.operationId];
    if (operation) {
        operation.assignedCreeps = Object.values(members).filter(Boolean).map(creep => creep.name).sort();
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

function allReady(members, squad) {
    return squad.memberSlots.every(slot => memberReady(members[slot], squad));
}

function replacementCanArrive(squad, operation) {
    if (!operation || !operation.timeoutTick) return true;
    return Game.time + (squad.replacementRequirements.arrivalBuffer || 250) < operation.timeoutTick;
}

function emitDemands(squad) {
    if (TERMINAL.has(squad.state) || squad.replacementRequirements.enabled === false) return [];
    const operation = squad.operationId && HiveMemory.ensure().operations[squad.operationId];
    if (!replacementCanArrive(squad, operation)) {
        squad.debugReason = 'Replacement cannot arrive before operation timeout';
        return [];
    }
    const offensive = operation && ['ATTACK_PLAYER', 'RAID_REMOTE', 'CONTEST_REACTOR'].includes(operation.type);
    const definitionsBySlot = new Map(definitions(squad.type).map(definition => [definition.slot, definition]));
    const demands = squad.memberSlots.map(slot => {
        const definition = definitionsBySlot.get(slot);
        return DemandBoard.emit({
            id: `squad:${squad.id}:${slot}`,
            operationId: squad.operationId,
            squadId: squad.id,
            role: definition.role,
            capabilities: { [definition.capability]: 1 },
            count: 1,
            priority: Math.max(88, operation && operation.priority || 0),
            originRoom: squad.originRoom,
            preferredSpawnRoom: squad.originRoom,
            targetRoom: squad.targetRoom,
            boostRequirements: squad.boostRequirements[slot],
            replacementBuffer: squad.expectedTravelTime + 100,
            validUntil: Game.time + 5,
            emergency: !!(operation && operation.priority >= 95),
            memory: {
                squadSlot: slot,
                formationRole: slot,
                allowOffensiveTargets: offensive && operation.policyApproved === true
            },
            reason: `${squad.type} ${squad.state}`
        });
    });
    squad.demandIds = demands.map(demand => demand.id);
    return demands;
}

function getCommittedRoleCount(operationId, role) {
    return Object.values(HiveMemory.ensure().squads).filter(squad =>
        squad && TYPES.includes(squad.type) && !TERMINAL.has(squad.state) && squad.operationId === operationId)
        .reduce((sum, squad) => sum + definitions(squad.type).filter(item => item.role === role).length, 0);
}

function clearLocks(members) {
    for (const member of Object.values(members)) {
        if (member && typeof member.setTrafficLock === 'function') member.setTrafficLock(false);
    }
}

function holdAll(members) {
    for (const member of Object.values(members)) {
        if (member && typeof member.setTrafficLock === 'function') member.setTrafficLock(true);
    }
}

function moveTo(member, target, range, squad, fallbacks = []) {
    if (!member || !target || member.memory._sushiMoveTick === Game.time) return ERR_BUSY;
    return travel.move(member, target, {
        range,
        reusePath: 3,
        trafficPriority: 96,
        squadId: squad.id,
        operationId: squad.operationId,
        fallbackPositions: fallbacks,
        disableSharedRouteCache: true
    });
}

function onExit(member) {
    return member && (member.pos.x === 0 || member.pos.x === 49 || member.pos.y === 0 || member.pos.y === 49);
}

function sameRoom(members) {
    const living = Object.values(members).filter(Boolean);
    return living.length > 0 && living.every(member => member.room.name === living[0].room.name);
}

function roomHostiles(roomName) {
    return (TickIndex.get().hostilesByRoom.get(roomName) || [])
        .filter(hostile => WarRoom.isHostileCreepThreat(hostile));
}

function roomTowers(roomName) {
    const byType = TickIndex.get().structuresByRoom.get(roomName);
    const towerType = typeof STRUCTURE_TOWER !== 'undefined' ? STRUCTURE_TOWER : 'tower';
    return Tactics.enemyTowers(byType && byType.get(towerType) || []);
}

function inside(x, y) {
    return x > 0 && x < 49 && y > 0 && y < 49;
}

function walkable(room, x, y) {
    if (!room || !inside(x, y)) return false;
    if (Game.map && typeof Game.map.getRoomTerrain === 'function' &&
        Game.map.getRoomTerrain(room.name).get(x, y) ===
            (typeof TERRAIN_MASK_WALL !== 'undefined' ? TERRAIN_MASK_WALL : 1)) return false;
    if (typeof room.lookForAt !== 'function') return true;
    const structures = room.lookForAt(
        typeof LOOK_STRUCTURES !== 'undefined' ? LOOK_STRUCTURES : 'structure', x, y
    ) || [];
    return !structures.some(structure => structure &&
        (typeof OBSTACLE_OBJECT_TYPES !== 'undefined' ? OBSTACLE_OBJECT_TYPES : []).includes(structure.structureType) &&
        !(structure.structureType === (typeof STRUCTURE_RAMPART !== 'undefined' ? STRUCTURE_RAMPART : 'rampart') &&
            (structure.my || structure.isPublic)));
}

function positionsFor(squad, anchor, transformIndex = squad.formationTransform || 0) {
    const transform = TRANSFORMS[transformIndex];
    const result = {};
    for (let index = 0; index < squad.memberSlots.length; index++) {
        const offset = transform[index];
        result[squad.memberSlots[index]] = new RoomPosition(
            anchor.x + offset[0], anchor.y + offset[1], anchor.roomName
        );
    }
    return result;
}

function candidateValid(squad, room, anchor, transformIndex, threats = []) {
    const positions = positionsFor(squad, anchor, transformIndex);
    const hostileTiles = new Set((threats || []).map(threat =>
        threat && threat.pos && `${threat.pos.x}:${threat.pos.y}`).filter(Boolean));
    return Object.values(positions).every(pos => walkable(room, pos.x, pos.y) &&
        !hostileTiles.has(`${pos.x}:${pos.y}`));
}

function blockingStructure(structure) {
    if (!structure) return false;
    const rampartType = typeof STRUCTURE_RAMPART !== 'undefined' ? STRUCTURE_RAMPART : 'rampart';
    if (structure.structureType === rampartType) return !structure.my && !structure.isPublic;
    return (typeof OBSTACLE_OBJECT_TYPES !== 'undefined' ? OBSTACLE_OBJECT_TYPES : [])
        .includes(structure.structureType);
}

function structureSignature(structures) {
    return structures.map(structure => [
        structure.id || '', structure.structureType || '',
        structure.pos && structure.pos.x, structure.pos && structure.pos.y,
        structure.my === true ? 1 : 0, structure.isPublic === true ? 1 : 0
    ].join(':')).sort().join('|');
}

function staticFormationMatrix(room) {
    if (!global.__sushiQuadMatrices) global.__sushiQuadMatrices = {};
    const index = TickIndex.get();
    const byType = index.structuresByRoom.get(room.name);
    const structures = byType ? Array.from(byType.values()).flat() : [];
    const sites = index.constructionSitesByRoom.get(room.name) || [];
    const blockers = structures.concat(sites);
    const signature = structureSignature(blockers);
    const cached = global.__sushiQuadMatrices[room.name];
    if (cached && cached.signature === signature && cached.staticMatrix) return cached;
    const blocked = new Set(blockers.filter(blockingStructure)
        .map(structure => `${structure.pos.x}:${structure.pos.y}`));
    const terrain = Game.map.getRoomTerrain(room.name);
    const tileOpen = (x, y) => inside(x, y) && !blocked.has(`${x}:${y}`) &&
        terrain.get(x, y) !== (typeof TERRAIN_MASK_WALL !== 'undefined' ? TERRAIN_MASK_WALL : 1);
    const staticMatrix = new PathFinder.CostMatrix();
    for (let x = 1; x < 49; x++) {
        for (let y = 1; y < 49; y++) {
            const possible = TRANSFORMS.some(transform => transform.every(offset => tileOpen(x + offset[0], y + offset[1])));
            if (!possible) staticMatrix.set(x, y, 255);
        }
    }
    const record = { signature, staticMatrix, dynamicKey: null, dynamicMatrix: null };
    global.__sushiQuadMatrices[room.name] = record;
    return record;
}

function buildFormationCostMatrix(room, threats = [], towers = [], focus = null) {
    const cached = staticFormationMatrix(room);
    const dynamicKey = [Game.time, focus && `${focus.x}:${focus.y}` || 'all']
        .concat(threats.map(threat => `${threat.id || threat.name}:${threat.pos.x}:${threat.pos.y}`))
        .concat(towers.map(tower => `${tower.id}:${tower.pos.x}:${tower.pos.y}`)).join('|');
    if (cached.dynamicKey === dynamicKey && cached.dynamicMatrix) return cached.dynamicMatrix.clone();
    const matrix = cached.staticMatrix.clone();
    const virtual = { pos: null };
    for (const threat of threats) {
        for (let x = Math.max(1, threat.pos.x - 3); x <= Math.min(48, threat.pos.x + 3); x++) {
            for (let y = Math.max(1, threat.pos.y - 3); y <= Math.min(48, threat.pos.y + 3); y++) {
                if (matrix.get(x, y) === 255) continue;
                const range = Math.max(Math.abs(x - threat.pos.x), Math.abs(y - threat.pos.y));
                const cost = range <= 1 ? 120 : 50;
                matrix.set(x, y, Math.min(254, Math.max(matrix.get(x, y), cost)));
            }
        }
    }
    for (const tower of towers) {
        const minimumX = focus ? Math.max(1, focus.x - 3) : 1;
        const maximumX = focus ? Math.min(48, focus.x + 3) : 48;
        const minimumY = focus ? Math.max(1, focus.y - 3) : 1;
        const maximumY = focus ? Math.min(48, focus.y + 3) : 48;
        for (let x = minimumX; x <= maximumX; x++) {
            for (let y = minimumY; y <= maximumY; y++) {
                if (matrix.get(x, y) === 255) continue;
                const anchor = new RoomPosition(x, y, room.name);
                virtual.pos = anchor;
                const towerCost = Math.min(120, Math.floor(CombatMath.towerDamage(tower, virtual) / 20));
                matrix.set(x, y, Math.min(254, matrix.get(x, y) + towerCost));
            }
        }
    }
    cached.dynamicKey = dynamicKey;
    cached.dynamicMatrix = matrix.clone();
    return matrix;
}

function anchorFromLeader(squad, leader) {
    if (!leader) return null;
    const index = squad.memberSlots.indexOf(leader.memory.squadSlot);
    const offset = TRANSFORMS[squad.formationTransform || 0][Math.max(0, index)];
    return new RoomPosition(leader.pos.x - offset[0], leader.pos.y - offset[1], leader.pos.roomName);
}

function chooseTransform(squad, anchor, room, members, threats = []) {
    let best = null;
    for (let index = 0; index < TRANSFORMS.length; index++) {
        if (!candidateValid(squad, room, anchor, index, threats)) continue;
        const positions = positionsFor(squad, anchor, index);
        let movement = 0;
        for (const slot of squad.memberSlots) {
            const member = members[slot];
            if (member) movement += CombatMath.rangeBetween(member, positions[slot]);
        }
        const score = movement + (index === squad.formationTransform ? -0.25 : 0);
        if (!best || score < best.score || score === best.score && index < best.index) best = { index, score, positions };
    }
    return best;
}

function formationComplete(squad, members) {
    const leader = squad.leader && Game.creeps[squad.leader];
    if (!leader || !sameRoom(members)) return false;
    const anchor = anchorFromLeader(squad, leader);
    const positions = positionsFor(squad, anchor);
    return squad.memberSlots.every(slot => members[slot] && members[slot].pos.isEqualTo(positions[slot]));
}

function nearbyAnchor(squad, members, center, room, threats) {
    const candidates = [];
    for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
            const anchor = new RoomPosition(center.x + dx, center.y + dy, center.roomName);
            if (!inside(anchor.x, anchor.y)) continue;
            const transform = chooseTransform(squad, anchor, room, members, threats);
            if (transform) candidates.push({ anchor, transform, score: Math.max(Math.abs(dx), Math.abs(dy)) + transform.score });
        }
    }
    candidates.sort((a, b) => a.score - b.score || a.anchor.x - b.anchor.x || a.anchor.y - b.anchor.y);
    return candidates[0] || null;
}

function formAt(squad, members, center) {
    const living = Object.values(members).filter(Boolean);
    if (!living.length || !center || !Game.rooms[center.roomName]) return false;
    const room = Game.rooms[center.roomName];
    const threats = roomHostiles(room.name);
    const choice = nearbyAnchor(squad, members, center, room, threats);
    if (!choice) {
        holdAll(members);
        squad.debugReason = 'No safe 2x2 formation anchor is currently available';
        return false;
    }
    squad.formationTransform = choice.transform.index;
    squad.formationAnchor = packPosition(choice.anchor);
    squad.formationMode = 'ATTACK';
    let complete = true;
    for (const slot of squad.memberSlots) {
        const member = members[slot];
        if (!member) {
            complete = false;
            continue;
        }
        const destination = choice.transform.positions[slot];
        if (!member.pos.isEqualTo(destination)) {
            complete = false;
            moveTo(member, destination, 0, squad);
        }
        else if (typeof member.setTrafficLock === 'function') member.setTrafficLock(true);
    }
    return complete;
}

function regroup(squad, members) {
    const leader = squad.leader && Game.creeps[squad.leader] || Object.values(members).find(Boolean);
    if (!leader) return;
    squad.formationMode = 'RALLY';
    if (onExit(leader)) travel.moveOffExit(leader);
    else if (typeof leader.setTrafficLock === 'function') leader.setTrafficLock(true);
    const ordered = squad.memberSlots.map(slot => members[slot]).filter(member => member && member !== leader);
    for (let index = 0; index < ordered.length; index++) moveTo(ordered[index], index ? ordered[index - 1] : leader, 1, squad);
    squad.debugReason = 'Regrouping quad after separation or border crossing';
}

function boostSatisfied(member, requirements) {
    if (!requirements || !requirements.length) return true;
    const boosts = CombatMath.analyzeBody(member).boosts;
    return requirements.every(requirement => boosts[typeof requirement === 'string' ? requirement : requirement.compound] >=
        (typeof requirement === 'object' && requirement.parts || 1));
}

function performActions(squad, members) {
    const living = Object.values(members).filter(Boolean);
    const leader = squad.leader && Game.creeps[squad.leader] || living[0];
    if (!leader) return Tactics.evaluateQuad([], [], []);
    const hostiles = roomHostiles(leader.room.name);
    const towers = roomTowers(leader.room.name);
    const operation = squad.operationId && HiveMemory.ensure().operations[squad.operationId];
    let locked = squad.sharedTargetId && Game.getObjectById(squad.sharedTargetId);
    if (!locked || !locked.hits || locked.pos.roomName !== leader.room.name) locked = null;
    let structureTarget = null;
    if (operation && operation.policyApproved === true) {
        for (const member of living) member.memory.allowOffensiveTargets = true;
        structureTarget = operation.targetId && Game.getObjectById(operation.targetId) ||
            WarRoom.findBestHostileStructure(leader);
    }
    const tactic = Tactics.evaluateQuad(living, hostiles, towers, {
        leader,
        lockedTarget: locked,
        structureTarget,
        abortThreshold: squad.abortThreshold
    });
    squad.sharedTargetId = tactic.target && (tactic.target.id || tactic.target.name) || null;
    for (const member of living) {
        const analysis = CombatMath.analyzeBody(member);
        const range = tactic.target ? CombatMath.rangeBetween(member, tactic.target) : Infinity;
        if (analysis.ranged > 0 && range <= 3) {
            const mode = tactic.attackModes[member.name || member.id];
            if (mode === 'mass' && typeof member.rangedMassAttack === 'function') member.rangedMassAttack();
            else if (typeof member.rangedAttack === 'function') member.rangedAttack(tactic.target);
        }
        else if (analysis.dismantle > 0 && range <= 1 && typeof member.dismantle === 'function' && tactic.target && tactic.target.body === undefined) {
            member.dismantle(tactic.target);
        }
        else if (analysis.melee > 0 && range <= 1 && typeof member.attack === 'function') member.attack(tactic.target);
    }
    for (const assignment of tactic.healAssignments) {
        const range = CombatMath.rangeBetween(assignment.healer, assignment.target);
        if (range <= 1 && typeof assignment.healer.heal === 'function') assignment.healer.heal(assignment.target);
        else if (range <= 3 && typeof assignment.healer.rangedHeal === 'function') assignment.healer.rangedHeal(assignment.target);
    }
    return tactic;
}

function tryPull(squad, members, target) {
    const leader = squad.leader && Game.creeps[squad.leader];
    if (!leader || leader.fatigue > 0 || typeof leader.pull !== 'function') return false;
    const fatigued = Object.values(members).filter(member => member && member !== leader && member.fatigue > 0);
    if (fatigued.length !== 1 || CombatMath.rangeBetween(leader, fatigued[0]) > 1) return false;
    leader.pull(fatigued[0]);
    moveTo(fatigued[0], leader, 0, squad);
    moveTo(leader, target, 22, squad);
    squad.debugReason = `Leader pulling fatigued ${fatigued[0].name}`;
    return true;
}

function transport(squad, members, target) {
    const leader = squad.leader && Game.creeps[squad.leader];
    if (!leader || !sameRoom(members) || Object.values(members).some(onExit)) {
        regroup(squad, members);
        return;
    }
    const ordered = [leader].concat(squad.memberSlots.map(slot => members[slot])
        .filter(member => member && member !== leader));
    const contiguous = ordered.every((member, index) => index === 0 ||
        CombatMath.rangeBetween(member, ordered[index - 1]) <= 1);
    if (!contiguous) {
        regroup(squad, members);
        return;
    }
    if (ordered.some(member => member.fatigue > 0)) {
        if (!tryPull(squad, members, target)) holdAll(members);
        squad.formationMode = 'TRANSPORT';
        return;
    }
    squad.formationMode = 'TRANSPORT';
    moveTo(leader, target, 22, squad);
    for (let index = 1; index < ordered.length; index++) moveTo(ordered[index], ordered[index - 1], 0, squad);
}

function chooseCombatAnchor(squad, members, tactic) {
    const leader = squad.leader && Game.creeps[squad.leader];
    if (!leader) return null;
    const room = leader.room;
    const hostiles = roomHostiles(room.name);
    const towers = roomTowers(room.name);
    const current = anchorFromLeader(squad, leader);
    const matrix = buildFormationCostMatrix(room, hostiles, towers, current);
    const candidates = [];
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            const anchor = new RoomPosition(current.x + dx, current.y + dy, current.roomName);
            if (!inside(anchor.x, anchor.y) || matrix.get(anchor.x, anchor.y) >= 200) continue;
            const transform = chooseTransform(squad, anchor, room, members, hostiles);
            if (!transform) continue;
            const targetRange = tactic.target ? CombatMath.rangeBetween(anchor, tactic.target) : 10;
            const threatRange = hostiles.length ? Math.min(...hostiles.map(hostile => CombatMath.rangeBetween(anchor, hostile))) : 10;
            let score = -matrix.get(anchor.x, anchor.y) - transform.score * 5;
            if (tactic.movement === 'advance') score -= targetRange * 40;
            else if (tactic.movement === 'kite') score += threatRange * 60 - targetRange * 5;
            else if (dx === 0 && dy === 0) score += 25;
            candidates.push({ anchor, transform, score });
        }
    }
    candidates.sort((a, b) => b.score - a.score || a.anchor.x - b.anchor.x || a.anchor.y - b.anchor.y || a.transform.index - b.transform.index);
    return candidates[0] || null;
}

function moveCombatFormation(squad, members, tactic) {
    if (!formationComplete(squad, members) || Object.values(members).some(member => member && member.fatigue > 0)) {
        const leader = squad.leader && Game.creeps[squad.leader];
        const anchor = leader && anchorFromLeader(squad, leader);
        if (anchor && chooseTransform(squad, anchor, leader.room, members, roomHostiles(leader.room.name))) {
            formAt(squad, members, anchor);
        }
        else regroup(squad, members);
        return;
    }
    const choice = chooseCombatAnchor(squad, members, tactic);
    if (!choice) {
        holdAll(members);
        squad.debugReason = 'Holding compact formation outside projected kill zones';
        return;
    }
    squad.formationTransform = choice.transform.index;
    squad.formationAnchor = packPosition(choice.anchor);
    squad.formationMode = tactic.movement === 'kite' ? 'RETREAT' : 'ATTACK';
    for (const slot of squad.memberSlots) {
        const member = members[slot];
        const destination = choice.transform.positions[slot];
        if (!member.pos.isEqualTo(destination)) moveTo(member, destination, 0, squad);
        else if (typeof member.setTrafficLock === 'function') member.setTrafficLock(true);
    }
}

function timedOut(squad) {
    const timeout = squad.stateTimeouts[squad.state];
    return Number.isFinite(timeout) && Game.time - squad.stateStartTick > timeout;
}

function handleTimeout(squad) {
    if (!timedOut(squad)) return false;
    if (['MARCHING', 'ENGAGING'].includes(squad.state)) return transition(squad, 'RETREATING', `${squad.state} timed out`);
    if (['RALLYING', 'BOOSTING'].includes(squad.state)) return transition(squad, 'RECOVERING', `${squad.state} timed out`);
    return transition(squad, 'ABORTED', `${squad.state} timed out`);
}

function runForming(squad, members) {
    performActions(squad, members);
    const rally = unpackPosition(squad.rallyPosition);
    for (const member of Object.values(members)) if (member && rally) moveTo(member, rally, 3, squad);
    if (allReady(members, squad)) transition(squad, 'RALLYING', 'All four members have sufficient health and travel TTL');
}

function runRallying(squad, members) {
    performActions(squad, members);
    if (!allReady(members, squad)) {
        transition(squad, 'RECOVERING', 'Quad readiness fell below rally threshold');
        return;
    }
    const rally = unpackPosition(squad.rallyPosition);
    if (!rally || !Game.rooms[rally.roomName]) {
        transition(squad, 'ABORTED', 'No visible valid rally room');
        return;
    }
    if (!formAt(squad, members, rally) || !formationComplete(squad, members) ||
        Object.values(members).some(member => member.fatigue > 0)) return;
    const needsBoosts = squad.memberSlots.some(slot => squad.boostRequirements[slot] && squad.boostRequirements[slot].length);
    transition(squad, needsBoosts ? 'BOOSTING' : 'MARCHING', needsBoosts ? 'Compact rally complete; awaiting boosts' : 'Compact 2x2 rally complete');
}

function runBoosting(squad, members) {
    performActions(squad, members);
    const complete = squad.memberSlots.every(slot => boostSatisfied(members[slot], squad.boostRequirements[slot]));
    if (complete) {
        transition(squad, 'MARCHING', 'All required quad boosts verified');
        return;
    }
    if (squad.acceptPartialBoosts && Game.time - squad.stateStartTick > 25) {
        transition(squad, 'MARCHING', 'Partial quad boosts explicitly accepted');
        return;
    }
    for (const slot of squad.memberSlots) {
        const member = members[slot];
        if (!member) continue;
        const positions = ResourceLabs.getBoostPositions(squad.id, slot);
        const next = positions.find(item => !member.body.some(part => part.hits > 0 && part.boost === item.compound));
        if (next && next.pos) moveTo(member, unpackPosition(next.pos), 1, squad);
        else if (typeof member.setTrafficLock === 'function') member.setTrafficLock(true);
    }
    squad.debugReason = 'Waiting for quad lab boost verification';
}

function viableMemberCount(members) {
    return Object.values(members).filter(member => member && member.hits > 0).length;
}

function runMarching(squad, members) {
    const tactic = performActions(squad, members);
    if (!squad.targetRoom) {
        transition(squad, 'ABORTED', 'Quad has no target room');
        return;
    }
    if (viableMemberCount(members) < 3 || tactic.retreat) {
        transition(squad, 'RETREATING', tactic.retreatReason || 'Quad casualties make march unsafe');
        return;
    }
    const leader = squad.leader && Game.creeps[squad.leader];
    const allAtTarget = Object.values(members).filter(Boolean).every(member => member.room.name === squad.targetRoom && !onExit(member));
    if (allAtTarget) {
        const center = anchorFromLeader(squad, leader) || leader.pos;
        if (formAt(squad, members, center) && formationComplete(squad, members)) {
            transition(squad, 'ENGAGING', 'Quad reached target room in compact 2x2 formation');
        }
        return;
    }
    transport(squad, members, new RoomPosition(25, 25, squad.targetRoom));
}

function runEngaging(squad, members) {
    const tactic = performActions(squad, members);
    if (tactic.retreat || viableMemberCount(members) < 3) {
        transition(squad, 'RETREATING', tactic.retreatReason || 'Quad combat losses require withdrawal');
        return;
    }
    if (tactic.recover) {
        transition(squad, 'RETREATING', 'A casualty requires safe replacement recovery');
        return;
    }
    if (!tactic.target) {
        squad.quietSince = squad.quietSince || Game.time;
        holdAll(members);
        if (Game.time - squad.quietSince >= squad.completionQuietTicks) {
            const operation = squad.operationId && HiveMemory.ensure().operations[squad.operationId];
            if (operation && operation.state === 'ACTIVE') Operations.transition(operation, 'COMPLETE', 'Target room remained clear');
            transition(squad, 'COMPLETE', 'Target room remained clear');
        }
        return;
    }
    delete squad.quietSince;
    moveCombatFormation(squad, members, tactic);
}

function runRetreating(squad, members) {
    performActions(squad, members);
    const destination = unpackPosition(squad.retreatDestination);
    const leader = squad.leader && Game.creeps[squad.leader] || Object.values(members).find(Boolean);
    if (!leader || !destination) {
        transition(squad, 'ABORTED', 'Quad retreat lacks a survivor or destination');
        return;
    }
    squad.formationMode = 'RETREAT';
    if (leader.room.name === destination.roomName && leader.pos.inRangeTo(destination, 3)) {
        transition(squad, 'RECOVERING', 'Surviving quad reached retreat destination');
        return;
    }
    transport(squad, members, destination);
}

function runRecovering(squad, members) {
    performActions(squad, members);
    const operation = squad.operationId && HiveMemory.ensure().operations[squad.operationId];
    if (operation && operation.state === 'ABORTED') {
        transition(squad, 'ABORTED', 'Assigned offensive operation was aborted');
        return;
    }
    const rally = unpackPosition(squad.rallyPosition);
    for (const member of Object.values(members)) if (member && rally) moveTo(member, rally, 3, squad);
    if (allReady(members, squad)) transition(squad, 'RALLYING', 'Quad replacements and readiness restored');
    else squad.debugReason = 'Recovering health, TTL, or missing formation members';
}

function release(squad, members) {
    for (const demandId of squad.demandIds || []) DemandBoard.cancel(demandId);
    for (const member of Object.values(members || {})) {
        if (!member || !member.memory || member.memory.squadId !== squad.id) continue;
        delete member.memory.squadId;
        delete member.memory.squadSlot;
        delete member.memory.formationRole;
        delete member.memory.allowOffensiveTargets;
        if ((squad.demandIds || []).includes(member.memory.demandId)) delete member.memory.demandId;
    }
}

function runSquad(squad) {
    const members = refreshMembers(squad);
    clearLocks(members);
    const operation = squad.operationId && HiveMemory.ensure().operations[squad.operationId];
    if (operation && operation.state === 'ABORTED' && !['RETREATING', 'RECOVERING'].includes(squad.state)) {
        if (['MARCHING', 'ENGAGING'].includes(squad.state)) transition(squad, 'RETREATING', 'Assigned operation aborted; withdraw as a group');
        else transition(squad, 'ABORTED', 'Assigned operation aborted before deployment');
    }
    else if (operation && operation.state === 'COMPLETE' && squad.state === 'ENGAGING') {
        transition(squad, 'COMPLETE', 'Assigned operation completed');
    }
    const timeoutChanged = handleTimeout(squad);
    if (TERMINAL.has(squad.state)) {
        release(squad, members);
        return members;
    }
    if (timeoutChanged) return members;
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

function syncOperations() {
    const settings = HiveMemory.ensure().settings.squads;
    if (settings.enabled === false || settings.quadsEnabled === false) return [];
    const created = [];
    for (const operation of Object.values(HiveMemory.ensure().operations)) {
        if (!operation || ['COMPLETE', 'ABORTED'].includes(operation.state) || !operation.originRoom || !operation.targetRoom) continue;
        const offensive = ['ATTACK_PLAYER', 'RAID_REMOTE', 'CONTEST_REACTOR'].includes(operation.type);
        const heavyDefense = settings.autoDefenseQuads !== false &&
            ['DEFEND_OWNED_ROOM', 'DEFEND_REMOTE', 'HOLD_REACTOR'].includes(operation.type) &&
            ((operation.desiredCapabilities && operation.desiredCapabilities.damage || 0) >= 300 ||
                (operation.desiredCapabilities && operation.desiredCapabilities.guardDamage || 0) >= 20);
        if (offensive && operation.policyApproved !== true || !offensive && !heavyDefense && !TYPES.includes(operation.preferredSquadType)) continue;
        const type = TYPES.includes(operation.preferredSquadType) ? operation.preferredSquadType : 'RANGED_QUAD';
        created.push(create({
            id: `quad:${operation.id}`,
            operationId: operation.id,
            type,
            originRoom: operation.originRoom,
            targetRoom: operation.targetRoom,
            targetId: operation.targetId,
            retreatDestination: operation.retreatRoom ? { x: 25, y: 25, roomName: operation.retreatRoom } : null,
            boostRequirements: operation.quadBoostRequirements || operation.boostRequirements,
            acceptPartialBoosts: operation.acceptPartialBoosts,
            debugReason: offensive ? `Policy-approved ${operation.objective || operation.type}` : 'High-threat quad defense'
        }));
    }
    return created;
}

function plan() {
    syncOperations();
    const active = Object.values(HiveMemory.ensure().squads)
        .filter(squad => squad && TYPES.includes(squad.type) && !TERMINAL.has(squad.state))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    for (const squad of active) emitDemands(squad);
    return active;
}

function resetForTests() {
    delete global.__sushiQuadMatrices;
}

function abort(id, reason = 'Manual quad abort') {
    const squad = get(id);
    if (!squad || !TYPES.includes(squad.type) || TERMINAL.has(squad.state)) return false;
    squad.state = 'ABORTED';
    squad.abortedTick = Game.time;
    squad.updatedTick = Game.time;
    squad.debugReason = reason;
    return true;
}

module.exports = {
    TYPES,
    STATES,
    TRANSFORMS,
    create,
    get,
    transition,
    refreshMembers,
    allReady,
    emitDemands,
    getCommittedRoleCount,
    buildFormationCostMatrix,
    positionsFor,
    chooseTransform,
    formationComplete,
    formAt,
    transport,
    runSquad,
    syncOperations,
    plan,
    abort,
    resetForTests,
    packPosition,
    unpackPosition
};
