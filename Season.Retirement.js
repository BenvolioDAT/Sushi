/* One-shot retirement. No game resources or unrelated room records are deleted. */
const ROLES = new Set(['ThoriumMiner', 'ThoriumHauler', 'ReactorClaimer']);
const TYPES = new Set(['HARVEST_THORIUM', 'SUPPLY_REACTOR', 'HOLD_REACTOR', 'CAPTURE_REACTOR', 'CONTEST_REACTOR']);
const FIELDS = new Set(["season11AgingEstimateSource","season11AgingMultiplier","season11AgingThorium","season11AssignmentKey","season11ClaimFailed","season11DeliveryEta","season11EtaTick","season11Infrastructure","season11Maintenance","season11MaintenanceLease","season11MaintenanceTarget","season11MineralId","season11MiningColony","season11Nomination","season11NominationCooldownUntil","season11ObservedTileThorium","season11Operations","season11ReactorGuard","season11ReactorId","season11ReactorRoom","season11RecaptureApproved","season11RepairTargetId","season11ReserveStorageId","season11RouteDistance","season11Scout","season11SourceRoom","season11Staging","season11StagingId","season11SupportRoom","season11ThoriumRoom","season11WatchRoom"]);
function owned(record, id) {
    const m = record && record.memory || record || {};
    return !!record && (record.season11 === true || record.strategyProvider === 'SEASON11' ||
        m.strategyProvider === 'SEASON11' || m.season11Maintenance === true || !!m.season11AssignmentKey ||
        !!m.season11ReactorGuard || ROLES.has(record.role || m.role) || TYPES.has(record.type) ||
        typeof id === 'string' && /^(?:duo:|quad:)?season11:/.test(id));
}
function run() {
    if (Memory.meta && Memory.meta.season11Retired === 1) return false;
    const hive = Memory.hive || {}, removed = { operations: 0, demands: 0, squads: 0, queued: 0, creeps: 0 };
    const operationIds = new Set(), demandIds = new Set(), squadIds = new Set();
    for (const domain of ['operations', 'demands', 'squads']) {
        for (const [id, record] of Object.entries(hive[domain] || {})) {
            if (!owned(record, id) && !operationIds.has(record && record.operationId)) continue;
            ({ operations: operationIds, demands: demandIds, squads: squadIds })[domain].add(id);
            delete hive[domain][id]; removed[domain]++;
        }
    }
    const clearCreep = m => {
        if (!m || typeof m !== 'object') return;
        const seasonal = ROLES.has(m.role) || m.strategyProvider === 'SEASON11' ||
            m.season11Maintenance || m.season11ReactorGuard || operationIds.has(m.operationId) ||
            demandIds.has(m.demandId) || squadIds.has(m.squadId);
        if (seasonal) {
            if (ROLES.has(m.role)) {
                // Carry/WORK actors can unload via normal courier logic; claim-only actors scout.
                m.role = m.role === 'ReactorClaimer' ? 'Scout' : 'ResourceCourier';
                if (m.role === 'ResourceCourier') m.returnHomeAfterRetirement = true;
            }
            for (const key of ['operationId', 'demandId', 'squadId', 'assignmentKey', 'targetRoom',
                'remoteWorkTargetId', 'remoteWorkRoomName', 'remoteWorkType', 'resourceJobId', 'resourceDelivery',
                'strategyProvider', 'strategyCategory', 'economyCategory']) delete m[key];
            removed.creeps++;
        }
        for (const key of Object.keys(m)) if (FIELDS.has(key)) delete m[key];
    };
    for (const m of Object.values(Memory.creeps || {})) clearCreep(m);
    for (const room of Object.values(Memory.rooms || {})) {
        if (!room || typeof room !== 'object') continue;
        const queue = room.spawn && room.spawn.queue;
        if (Array.isArray(queue)) for (let i = queue.length - 1; i >= 0; i--) {
            const q = queue[i];
            const discard = owned(q, q && q.requestId) || operationIds.has(q && q.operationId) ||
                demandIds.has(q && q.demandId) || operationIds.has(q && q.memory && q.memory.operationId);
            if (discard) { queue.splice(i, 1); removed.queued++; }
        }
        for (const key of Object.keys(room)) if (FIELDS.has(key)) delete room[key];
        if (room.strategyObjectives) delete room.strategyObjectives.SEASON11_THORIUM;
        if (room.objectives) delete room.objectives.SEASON11_THORIUM;
        if (room.colonyObjectives) delete room.colonyObjectives.SEASON11_THORIUM;
    }
    const expansion = hive.expansion || {};
    for (const key of Object.keys(expansion)) if (FIELDS.has(key)) delete expansion[key];
    if (expansion.strategyNomination && expansion.strategyNomination.provider === 'SEASON11') delete expansion.strategyNomination;
    // Active expansion is a standard colony task and remains committed to its target.
    delete Memory.season11;
    if (Memory.config) delete Memory.config.season11;
    if (hive.season) {
        delete hive.season.season11;
        // These shared fields were written only by the retired season modules.
        for (const key of ['activeOperationIds', 'deliveryEvents']) delete hive.season[key];
        if (hive.season.stats && !Object.keys(hive.season.stats).length) delete hive.season.stats;
        if (!Object.keys(hive.season).length) delete hive.season;
    }
    if (!Memory.meta) Memory.meta = {};
    Memory.meta.season11Retired = 1;
    Memory.meta.season11Retirement = { tick: Game.time, removed };
    return true;
}
module.exports = { run };
