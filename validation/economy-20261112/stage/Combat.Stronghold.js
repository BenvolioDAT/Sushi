const HiveMemory = require('HiveMind.Memory');

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
    // Detection/remote exclusion is supported. Neither a WORK breacher (which
    // cannot dismantle a core) nor requested squad DPS proves a clearing force.
    return { ok: false, core, reason: core.level === 0 ?
        'Lesser core detected; no validated core-clearing force implementation' :
        'Stronghold detected; automatic siege is unsupported' };
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
