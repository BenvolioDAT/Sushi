const HiveMemory = require('HiveMind.Memory');
const Operations = require('HiveMind.Operations');
const CombatOperations = require('Combat.Operations');

const CORE_TYPE = typeof STRUCTURE_INVADER_CORE !== 'undefined' ? STRUCTURE_INVADER_CORE : 'invaderCore';

function visibleCore(room) {
    if (!room || typeof room.find !== 'function') return null;
    const structures = room.find(typeof FIND_STRUCTURES !== 'undefined' ? FIND_STRUCTURES : 0) || [];
    return structures.find(item => item && item.structureType === CORE_TYPE &&
        item.owner && item.owner.username === 'Invader') || null;
}

function relevantRoom(roomName) {
    const hive = HiveMemory.ensure();
    for (const operation of Object.values(hive.operations || {})) {
        if (operation && !['COMPLETE', 'ABORTED'].includes(operation.state) &&
            (operation.targetRoom === roomName || operation.strongholdTargetRoom === roomName)) return true;
    }
    for (const roomMemory of Object.values(Memory.rooms || {})) {
        const planner = roomMemory && roomMemory.remotePlanner;
        if (!planner) continue;
        if (planner.remotes && planner.remotes[roomName]) return true;
        if (Object.values(planner.sourceInfos || {}).some(info => info && info.roomName === roomName)) return true;
        if (Object.values(planner.sourceInfos || {}).some(info => info && info.route &&
            (info.route.roomSequence || []).includes(roomName))) return true;
    }
    return false;
}

function discover(room, options = {}) {
    const core = visibleCore(room);
    if (!core) return { ok: false, reason: 'No visible NPC Invader Core' };
    const relevant = options.manual === true || options.strongholdRelevant === true || relevantRoom(room.name);
    if (!relevant) return { ok: false, reason: 'Core is not relevant to a route, remote, safety, or selected objective', core };
    const existing = Object.values(HiveMemory.ensure().operations || {}).find(operation =>
        operation && operation.type === 'CLEAR_NPC_STRONGHOLD' && operation.targetRoom === room.name &&
        !['COMPLETE', 'ABORTED'].includes(operation.state));
    if (existing) return { ok: true, operation: existing, core, created: false };
    const result = CombatOperations.createStronghold({
        targetRoom: room.name, targetId: core.id, originRoom: options.originRoom,
        retreatRoom: options.retreatRoom || options.originRoom,
        strongholdRelevant: true, manualDirective: options.manual === true,
        priority: options.priority || (options.manual === true ? 80 : 65)
    });
    return { ...result, core, created: result.ok };
}

function manual(options = {}) {
    return discover(Game.rooms && Game.rooms[options.targetRoom], { ...options, manual: true });
}

function run() {
    const discovered = [];
    for (const room of Object.values(Game.rooms || {})) {
        const core = visibleCore(room);
        if (!core) continue;
        const result = discover(room);
        if (result.ok) discovered.push(result);
    }
    return discovered;
}

module.exports = { CORE_TYPE, visibleCore, relevantRoom, discover, manual, run };
