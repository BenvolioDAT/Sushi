const HiveMemory = require('HiveMind.Memory');
const Utility = require('HiveMind.Utility');
const DemandBoard = require('Spawn.DemandBoard');
const Economy = require('HiveMind.Economy');
const TickIndex = require('HiveMind.Index');

const TYPES = Object.freeze([
    'DEFEND_OWNED_ROOM', 'DEFEND_REMOTE', 'RECOVER_ROOM', 'EXPAND',
    'MINE_REMOTE', 'SCOUT_INTEL', 'FORTIFY', 'PRODUCE_BOOSTS',
    'ATTACK_PLAYER', 'RAID_REMOTE', 'HARVEST_THORIUM', 'SUPPLY_REACTOR',
    'HOLD_REACTOR', 'CAPTURE_REACTOR', 'CONTEST_REACTOR'
]);
const TERMINAL_STATES = new Set(['COMPLETE', 'ABORTED']);
const TRANSITIONS = {
    PENDING: new Set(['ACTIVE', 'ABORTED']),
    DISCOVERING: new Set(['SELECTING', 'ACTIVE', 'ABORTED']),
    SELECTING: new Set(['ACTIVE', 'ABORTED']),
    ACTIVE: new Set(['RECOVERING', 'COMPLETE', 'ABORTED']),
    RECOVERING: new Set(['ACTIVE', 'COMPLETE', 'ABORTED'])
};
const ROOM_TARGET_TYPES = new Set([
    'DEFEND_OWNED_ROOM', 'DEFEND_REMOTE', 'RECOVER_ROOM', 'EXPAND',
    'MINE_REMOTE', 'SCOUT_INTEL', 'FORTIFY', 'ATTACK_PLAYER', 'RAID_REMOTE',
    'HARVEST_THORIUM', 'SUPPLY_REACTOR', 'HOLD_REACTOR', 'CAPTURE_REACTOR', 'CONTEST_REACTOR'
]);
const OWNED_ORIGIN_TYPES = new Set([
    'DEFEND_REMOTE', 'RECOVER_ROOM', 'EXPAND', 'MINE_REMOTE', 'FORTIFY',
    'PRODUCE_BOOSTS', 'ATTACK_PLAYER', 'RAID_REMOTE', 'HARVEST_THORIUM',
    'SUPPLY_REACTOR', 'HOLD_REACTOR', 'CAPTURE_REACTOR', 'CONTEST_REACTOR'
]);
const VISIBLE_TARGET_TYPES = new Set(['DEFEND_OWNED_ROOM', 'DEFEND_REMOTE', 'RECOVER_ROOM', 'FORTIFY']);
const OFFENSIVE_TYPES = new Set(['ATTACK_PLAYER', 'RAID_REMOTE', 'CONTEST_REACTOR']);

function makeId(type, options) {
    if (options.id) return options.id;
    const target = options.targetRoom || options.targetId || 'empire';
    return `${type.toLowerCase()}:${target}`;
}

function create(type, options = {}) {
    if (!TYPES.includes(type)) throw new Error(`Unsupported operation type: ${type}`);
    const hive = HiveMemory.ensure();
    const id = makeId(type, options);
    if (hive.operations[id] && !TERMINAL_STATES.has(hive.operations[id].state)) return hive.operations[id];
    const operation = {
        id,
        type,
        state: options.state || 'PENDING',
        priority: Number.isFinite(options.priority) ? options.priority : 50,
        originRoom: options.originRoom || null,
        respondingColony: options.respondingColony || options.originRoom || null,
        targetRoom: options.targetRoom || null,
        targetPosition: options.targetPosition || null,
        targetId: options.targetId || null,
        createdTick: Game.time,
        updatedTick: Game.time,
        stateStartTick: Game.time,
        utility: Utility.score(options.utility || {}),
        desiredCapabilities: options.desiredCapabilities || {},
        spawnDemands: options.spawnDemands || [],
        assignedCreeps: [],
        assignedSquads: [],
        timeoutTick: options.timeoutTick || null,
        abortConditions: options.abortConditions || [],
        completionConditions: options.completionConditions || [],
        debugReason: options.debugReason || 'Created'
    };
    hive.operations[id] = operation;
    return operation;
}

function transition(operationOrId, nextState, reason, guard = () => true) {
    const operation = typeof operationOrId === 'string' ? get(operationOrId) : operationOrId;
    if (!operation || TERMINAL_STATES.has(operation.state) || !guard(operation)) return false;
    const allowed = TRANSITIONS[operation.state];
    if (!allowed || !allowed.has(nextState)) return false;
    operation.state = nextState;
    operation.stateStartTick = Game.time;
    operation.updatedTick = Game.time;
    operation.debugReason = reason || `Transitioned to ${nextState}`;
    if (nextState === 'COMPLETE') operation.completedTick = Game.time;
    if (nextState === 'ABORTED') operation.abortedTick = Game.time;
    return true;
}

function get(id) {
    return HiveMemory.ensure().operations[id] || null;
}

function abort(id, reason = 'Manual abort') {
    const operation = get(id);
    if (!operation) return false;
    if (TRANSITIONS[operation.state]) return transition(operation, 'ABORTED', reason);
    operation.state = 'ABORTED';
    operation.abortedTick = Game.time;
    operation.updatedTick = Game.time;
    operation.debugReason = reason;
    return true;
}

function rescore(operation, breakdown) {
    operation.utility = Utility.score(breakdown || operation.utility && operation.utility.components || {});
    operation.updatedTick = Game.time;
    return operation.utility;
}

function syncExpansion() {
    const expansion = HiveMemory.ensure().expansion;
    if (!expansion || !expansion.targetRoom) return null;
    const stateMap = {
        selectTarget: 'DISCOVERING', claiming: 'ACTIVE', placeSpawn: 'ACTIVE',
        buildSpawn: 'ACTIVE', bootstrap: 'RECOVERING', online: 'COMPLETE',
        complete: 'COMPLETE', blocked: 'ABORTED', idle: 'PENDING'
    };
    const operation = create('EXPAND', {
        id: `expand:${expansion.targetRoom}`,
        state: stateMap[expansion.state] || 'PENDING',
        originRoom: expansion.originRoom,
        targetRoom: expansion.targetRoom,
        priority: 60,
        debugReason: `Expansion adapter: ${expansion.state}`
    });
    operation.state = stateMap[expansion.state] || operation.state;
    operation.updatedTick = Game.time;
    operation.debugReason = expansion.blockReason || `Expansion adapter: ${expansion.state}`;
    return operation;
}

function hasOwnedSpawn(roomName) {
    return !!roomName && (TickIndex.get().ownedSpawnsByRoom.get(roomName) || []).length > 0;
}

function hasExecutionAssignment(operation) {
    return (operation.assignedCreeps || []).length > 0 || (operation.assignedSquads || []).length > 0;
}

function hasScoutPlan(operation) {
    if (operation.type === 'SCOUT_INTEL') return true;
    if ((operation.desiredCapabilities || {}).vision > 0) return true;
    return (operation.spawnDemands || []).some(demand => demand &&
        (demand.role === 'Scout' || demand.memory && demand.memory.role === 'Scout'));
}

function typePrerequisiteDecision(operation) {
    if (ROOM_TARGET_TYPES.has(operation.type) && !operation.targetRoom) {
        return { decision: 'wait', reason: `${operation.type} requires a target room` };
    }
    const target = operation.targetRoom && Game.rooms && Game.rooms[operation.targetRoom];
    if (VISIBLE_TARGET_TYPES.has(operation.type) && !target) {
        return { decision: 'wait', reason: `${operation.type} requires current target-room visibility` };
    }
    if (operation.type === 'DEFEND_OWNED_ROOM' &&
        (!target || !target.controller || !target.controller.my)) {
        return { decision: 'abort', reason: 'Owned-room defense target is not an owned visible room' };
    }
    const originName = operation.originRoom || operation.respondingColony;
    if (OWNED_ORIGIN_TYPES.has(operation.type)) {
        const origin = originName && Game.rooms && Game.rooms[originName];
        if (!origin || !origin.controller || !origin.controller.my) {
            return { decision: 'wait', reason: `${operation.type} requires a visible owned origin room` };
        }
    }
    const needsSpawn = (operation.spawnDemands || []).length > 0 ||
        OFFENSIVE_TYPES.has(operation.type) ||
        ['DEFEND_REMOTE', 'RECOVER_ROOM', 'EXPAND', 'SCOUT_INTEL'].includes(operation.type);
    if (needsSpawn && !hasExecutionAssignment(operation) && !hasOwnedSpawn(originName)) {
        return { decision: 'wait', reason: `${operation.type} requires spawn capability or an existing assignment` };
    }
    if (operation.requiresVisibility === true && !target && !hasScoutPlan(operation)) {
        return { decision: 'wait', reason: `${operation.type} requires visibility or a scout demand` };
    }
    if (OFFENSIVE_TYPES.has(operation.type)) {
        if (operation.manualDirective !== true) {
            return { decision: 'wait', reason: `${operation.type} requires an explicit offensive directive` };
        }
        const assessment = operation.offensiveAssessment;
        if (!assessment || assessment.tick !== Game.time || assessment.code !== 'APPROVED' ||
            assessment.allowed !== true || assessment.viable !== true) {
            return { decision: 'wait', reason: `${operation.type} requires a current approved diplomacy and viability assessment` };
        }
        if (!assessment.metrics || assessment.metrics.retreatRouteAvailable !== true) {
            return { decision: 'wait', reason: `${operation.type} requires a viable retreat route` };
        }
    }
    if (operation.type === 'PRODUCE_BOOSTS' && !originName) {
        return { decision: 'wait', reason: 'PRODUCE_BOOSTS requires an owned production room' };
    }
    return { decision: 'allow', reason: `${operation.type} type prerequisites accepted` };
}

function prerequisiteDecision(operation, budgets) {
    const emergency = operation.type === 'DEFEND_OWNED_ROOM';
    if (operation.timeoutTick && Game.time > operation.timeoutTick) return { decision: 'abort', reason: 'Operation timed out' };
    const typeDecision = typePrerequisiteDecision(operation);
    if (typeDecision.decision !== 'allow') return typeDecision;
    const origin = operation.originRoom && Game.rooms[operation.originRoom];
    if (!emergency && operation.spawnDemands && operation.spawnDemands.length &&
        (!origin || !origin.controller || !origin.controller.my)) {
        return { decision: 'wait', reason: 'No viable owned origin colony' };
    }
    if (!emergency && origin) {
        const economy = Economy.get(origin.name);
        if (economy && ['SURVIVAL', 'RECOVERY'].includes(economy.state)) {
            return { decision: 'wait', reason: `${origin.name} economy is ${economy.state}` };
        }
    }
    const total = operation.utility && operation.utility.total || 0;
    if (!emergency && total < budgets.minimumUtility) return { decision: 'deny', reason: 'Utility below strategy threshold' };
    if (!emergency && budgets.empireUsed >= budgets.empireLimit) return { decision: 'wait', reason: 'Empire operation budget exhausted' };
    const colony = operation.respondingColony || operation.originRoom || 'empire';
    if (!emergency && (budgets.byColony[colony] || 0) >= budgets.colonyLimit) {
        return { decision: 'wait', reason: `Colony operation budget exhausted for ${colony}` };
    }
    if (!emergency) {
        budgets.empireUsed++;
        budgets.byColony[colony] = (budgets.byColony[colony] || 0) + 1;
    }
    return { decision: 'allow', reason: emergency ? 'Emergency owned-room defense prerequisites accepted' :
        `${typeDecision.reason}; strategy budget accepted` };
}

function runOperation(operation, budgets) {
    if (operation.timeoutTick && Game.time > operation.timeoutTick) {
        abort(operation.id, 'Operation timed out');
        return;
    }
    const result = prerequisiteDecision(operation, budgets);
    operation.strategyDecision = result.decision;
    operation.strategyReason = result.reason;
    operation.strategyTick = Game.time;
    if (result.decision === 'abort') abort(operation.id, result.reason);
    else if (result.decision === 'allow' && ['PENDING', 'RECOVERING'].includes(operation.state)) {
        transition(operation, 'ACTIVE', result.reason);
    }
    else if (result.decision !== 'allow' && operation.state === 'ACTIVE' && operation.type !== 'DEFEND_OWNED_ROOM') {
        transition(operation, 'RECOVERING', result.reason);
    }
}

function emitDemands() {
    for (const operation of Object.values(HiveMemory.ensure().operations)) {
        if (!operation || TERMINAL_STATES.has(operation.state) || operation.strategyDecision !== 'allow') continue;
        for (const specification of operation.spawnDemands || []) {
            const demand = DemandBoard.emit({
                ...specification,
                id: specification.id || `${operation.id}:${specification.role || 'capability'}`,
                operationId: operation.id,
                originRoom: specification.originRoom || operation.originRoom,
                targetRoom: specification.targetRoom || operation.targetRoom,
                priority: Math.max(operation.priority || 0, specification.priority || 0),
                validUntil: specification.validUntil || Game.time + 25
            });
            if (!operation.spawnDemandIds) operation.spawnDemandIds = [];
            if (!operation.spawnDemandIds.includes(demand.id)) operation.spawnDemandIds.push(demand.id);
        }
    }
}

function cleanup() {
    const operations = HiveMemory.ensure().operations;
    for (const [id, operation] of Object.entries(operations)) {
        const ended = operation.completedTick || operation.abortedTick;
        if (TERMINAL_STATES.has(operation.state) && ended && Game.time - ended > 1000) delete operations[id];
    }
}

function run(ranked) {
    syncExpansion();
    const settings = HiveMemory.getConfig('combat').strategy;
    const active = (ranked || Object.values(HiveMemory.ensure().operations))
        .filter(operation => operation && !TERMINAL_STATES.has(operation.state))
        .sort((a, b) => (b.utility && b.utility.total || 0) - (a.utility && a.utility.total || 0) ||
            b.priority - a.priority || a.id.localeCompare(b.id));
    const budgets = {
        empireLimit: Math.max(0, settings.maxActiveNonEmergency || 3),
        colonyLimit: Math.max(0, settings.maxActivePerColony || 2),
        minimumUtility: Number.isFinite(settings.minimumUtility) ? settings.minimumUtility : -100,
        empireUsed: 0, byColony: {}
    };
    for (const operation of active.slice(0, 25)) runOperation(operation, budgets);
    emitDemands();
    if (Game.time % 100 === 0) cleanup();
    return active;
}

module.exports = {
    TYPES, create, get, transition, abort, rescore,
    syncExpansion, emitDemands, cleanup, typePrerequisiteDecision, prerequisiteDecision, run
};
