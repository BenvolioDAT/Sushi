const HiveMemory = require('HiveMind.Memory');
const Utility = require('HiveMind.Utility');
const DemandBoard = require('Spawn.DemandBoard');

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
    if (allowed && !allowed.has(nextState)) return false;
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
    const expansion = Memory.expansion;
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

function runOperation(operation) {
    if (operation.timeoutTick && Game.time > operation.timeoutTick) {
        abort(operation.id, 'Operation timed out');
        return;
    }
    if (operation.state === 'PENDING') transition(operation, 'ACTIVE', 'Operation prerequisites accepted');
}

function emitDemands() {
    for (const operation of Object.values(HiveMemory.ensure().operations)) {
        if (!operation || TERMINAL_STATES.has(operation.state)) continue;
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

function run() {
    syncExpansion();
    const active = Object.values(HiveMemory.ensure().operations)
        .filter(operation => operation && !TERMINAL_STATES.has(operation.state))
        .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    for (const operation of active.slice(0, 25)) runOperation(operation);
    emitDemands();
    if (Game.time % 100 === 0) cleanup();
    return active;
}

module.exports = {
    TYPES, create, get, transition, abort, rescore,
    syncExpansion, emitDemands, cleanup, run
};
