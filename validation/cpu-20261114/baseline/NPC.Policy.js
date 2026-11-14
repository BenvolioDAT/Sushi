// Shared read-only admission rules; operation managers own transitions/spawning.
const Intel = require('Keeper.Intel');
const Index = require('HiveMind.Index');
const MathCombat = require('Combat.Math');
const MemoryHive = require('HiveMind.Memory');
const MILITARY = new Set(['ASSEMBLE', 'CLEAR', 'GUARD', 'MINE', 'HAUL']);

function keeper(roomName) { return Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].keeperOperation; }
function enabled() { return MemoryHive.getConfig('combat').keepers.enabled !== false; }
function guardCapable(creep) {
    const body = MathCombat.analyzeBody(creep);
    return !!(!creep.spawning && body.ranged >= 100 && body.heal >= 120 &&
        body.movePower >= 2 * body.fatigueWeight && creep.hits >= creep.hitsMax * 0.95 &&
        creep.ticksToLive > 250 && !creep.memory.squadId);
}
function fresh(roomName) {
    const intel = Intel.get(roomName);
    return !!(intel && Game.rooms[roomName] && intel.observedAt === Game.time && !intel.core && !intel.otherHostiles);
}
function coverage(roomName, homeRoom) {
    const op = keeper(roomName), intel = Intel.get(roomName);
    if (!op || !intel || op.originRoom !== homeRoom) return false;
    return (op.lairIds || []).length > 0 && op.lairIds.every(id => {
        const lair = intel.lairs[id];
        return lair && Index.get().allCreeps.some(c => c.memory && c.memory.keeperOperationId === op.id &&
            c.memory.homeRoom === homeRoom && c.memory.keeperLairId === id && c.memory.keeperPatrolState !== 'RETREAT' &&
            c.pos.roomName === roomName && guardCapable(c) && lair.resourceIds.some(resourceId =>
                intel.resources[resourceId] && MathCombat.rangeBetween(c, intel.resources[resourceId].pos) <= 5));
    });
}
function miningAllowed(roomName, homeRoom) {
    const op = keeper(roomName);
    return !!(enabled() && op && ['MINE', 'HAUL'].includes(op.phase) && op.updatedAt === Game.time &&
        (!homeRoom || op.originRoom === homeRoom) && fresh(roomName) && coverage(roomName, op.originRoom));
}
function haulingAllowed(roomName, homeRoom) {
    const op = keeper(roomName);
    return !!(op && op.phase === 'HAUL' && miningAllowed(roomName, homeRoom));
}
// Economy samples before operation transitions. A one-tick-old stage can fund
// a forecast only with fresh room vision and the current physical guard roster.
// Movement/spawning still require the strict current-tick admission above.
function haulingForecastAllowed(roomName, homeRoom) {
    const op = keeper(roomName);
    return !!(enabled() && op && op.phase === 'HAUL' && op.updatedAt <= Game.time && op.updatedAt >= Game.time - 1 &&
        op.originRoom === homeRoom && fresh(roomName) && coverage(roomName, homeRoom));
}
function guardMayDeploy(roomName, homeRoom) {
    const op = keeper(roomName), intel = Intel.get(roomName);
    return !!(enabled() && op && ['CLEAR', 'GUARD', 'MINE', 'HAUL'].includes(op.phase) &&
        op.originRoom === homeRoom && op.updatedAt === Game.time && intel &&
        intel.observedAt <= Game.time && Game.time - intel.observedAt <= 50 && !intel.core && !intel.otherHostiles);
}
function needsObserver(roomName) {
    const room = Memory.rooms && Memory.rooms[roomName];
    if (!room) return false;
    for (const op of [room.keeperOperation, room.npcCoreOperation]) {
        if (!op || !op.funded || op.updatedAt !== Game.time || !['ASSEMBLE', 'CLEAR', 'GUARD'].includes(op.phase)) continue;
        const visibleForce = (Index.get().creepsByCurrentRoom.get(roomName) || []).some(c => !c.spawning && c.memory &&
            (c.memory.keeperOperationId === op.id || c.memory.npcCoreOperationId === op.id));
        if (!visibleForce) return true;
    }
    return false;
}
function spawnAllowed(room, request) {
    const m = request.memory || {}, role = request.role || m.role;
    if (m.keeperOperationId) {
        const op = keeper(m.keeperPatrolRoom);
        if (!enabled() || !op || op.id !== m.keeperOperationId || op.originRoom !== room.name ||
            !MILITARY.has(op.phase) || op.updatedAt !== Game.time || !op.funded ||
            !(op.lairIds || []).includes(m.keeperLairId)) return { allowed: false, obsolete: true, reason: 'KEEPER_FORCE_NOT_AUTHORIZED' };
        const body = MathCombat.analyzeBody((request.body || []).map(p => typeof p === 'string' ? { type: p, hits: 100 } : p));
        if (!request.bodyRequirements || request.bodyRequirements.fixed !== true || body.ranged < 100 || body.heal < 120 || body.movePower < 2 * body.fatigueWeight)
            return { allowed: false, obsolete: true, reason: 'KEEPER_FORCE_BODY_INSUFFICIENT' };
    }
    const target = m.sourceRoom || m.pickupRoom || m.targetRoom;
    if (target && Intel.known(target) && ['Extractor', 'Freighter'].includes(role)) {
        if (!(role === 'Extractor' ? miningAllowed(target, room.name) : haulingAllowed(target, room.name)))
            return { allowed: false, obsolete: true, reason: 'KEEPER_CIVILIANS_NOT_AUTHORIZED' };
    }
    if (m.npcCoreOperationId) {
        const body = MathCombat.analyzeBody((request.body || []).map(p => typeof p === 'string' ? { type: p, hits: 100 } : p));
        if (!request.bodyRequirements || request.bodyRequirements.fixed !== true || body.melee < 180 || body.movePower < 2 * body.fatigueWeight)
            return { allowed: false, obsolete: true, reason: 'NPC_CORE_FORCE_BODY_INSUFFICIENT' };
        const op = Memory.rooms[m.targetRoom] && Memory.rooms[m.targetRoom].npcCoreOperation;
        if (!op || op.id !== m.npcCoreOperationId || op.originRoom !== room.name ||
            !['ASSEMBLE', 'CLEAR'].includes(op.phase) || op.updatedAt !== Game.time || !op.funded)
            return { allowed: false, obsolete: true, reason: 'NPC_CORE_FORCE_NOT_AUTHORIZED' };
    }
    return { allowed: true };
}

module.exports = { keeper, enabled, fresh, guardCapable, coverage, miningAllowed, haulingAllowed, haulingForecastAllowed, guardMayDeploy, needsObserver, spawnAllowed };
