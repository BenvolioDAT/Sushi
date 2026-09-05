/* Economic visibility has its own floor; never depend on existing remote income. */
function status(room) {
    const memory = Memory.rooms[room.name] || {};
    const creeps = Object.values(Game.creeps || {}).filter(c => c.memory &&
        c.memory.homeRoom === room.name);
    const working = creeps.filter(c => !c.spawning && c.room && c.room.name === room.name &&
        (c.ticksToLive === undefined || c.ticksToLive > 50));
    const parts = (c, type) => (c.body || []).some(p => (p.type || p) === type && p.hits !== 0);
    const local = c => !c.memory.remoteMining && !c.memory.remoteWorkTargetId &&
        (!c.memory.sourceRoom || c.memory.sourceRoom === room.name) &&
        (!c.memory.targetRoom || c.memory.targetRoom === room.name);
    const miners = working.filter(c => c.memory.role === 'Extractor' && local(c) && parts(c, WORK));
    const queue = memory.spawn && memory.spawn.queue || [];
    const scouts = creeps.filter(c => c.memory.role === 'Scout');
    const spawning = Object.values(Game.spawns || {}).filter(s => s.room.name === room.name && s.spawning &&
        !Game.creeps[s.spawning.name] && Memory.creeps && Memory.creeps[s.spawning.name] &&
        Memory.creeps[s.spawning.name].role === 'Scout').length;
    const planner = memory.remotePlanner || {};
    const infos = Object.values(planner.sourceInfos || {});
    const names = new Set([...Object.keys(planner.remotes || {}), ...infos.map(i => i.roomName),
        ...Object.keys(memory.scoutPlan && memory.scoutPlan.rooms || {})]);
    // Pending adjacent intel counts even before a portfolio or Scout plan exists.
    Object.values(Game.map.describeExits(room.name) || {}).forEach(n => names.add(n));
    const records = [...names].filter(n => n !== room.name).map(n => Memory.rooms[n] || {});
    const pending = records.filter(m => m.intelRefreshRequestedAt !== undefined);
    const ages = records.map(m => m.lastIntelRefreshAt === undefined ? m.lastScanTick : m.lastIntelRefreshAt)
        .filter(t => t !== undefined).map(t => Math.max(0, Game.time - t));
    const demandReason = pending.length ? 'REMOTE_INTEL_REFRESH_PENDING' :
        !infos.some(info => info.score > 0) ? 'NO_REMOTE_CANDIDATES' :
        !ages.length || Math.min(...ages) >= 3000 ? 'NO_RECENT_REMOTE_SCAN' : 'MAINTAIN_HOME_VISIBILITY';
    let blockedReason = null;
    if (Game.cpu && Game.cpu.bucket < 1000) blockedReason = 'CPU bucket too low';
    else if (!Object.values(Game.spawns || {}).some(s => s.room.name === room.name && s.my !== false)) blockedReason = 'owned spawn missing';
    else if (!miners.length) blockedReason = 'working local Extractor missing';
    else if (!working.some(c => c.memory.role === 'Foreman' && parts(c, CARRY))) blockedReason = 'Foreman floor missing';
    else if (miners.length < 2) blockedReason = 'local Extractor floor missing';
    else if (!working.some(c => c.memory.role === 'Freighter' && local(c) && parts(c, CARRY))) blockedReason = 'local Freighter floor missing';
    else if (room.controller && room.controller.level < 8 && !working.some(c => c.memory.role === 'Tech' && local(c) && parts(c, WORK))) blockedReason = 'baseline controller work missing';
    const living = scouts.length + spawning;
    return { desired: 1, living, queued: queue.filter(q => (q.role || q.memory && q.memory.role) === 'Scout').length,
        allowed: !blockedReason, blockedReason, category: 'remoteIntel', demandReason,
        priority: demandReason === 'MAINTAIN_HOME_VISIBILITY' ? 50 : 55,
        lastSeen: scouts.length ? Game.time : memory.scout && memory.scout.lastSeen || null,
        targetRoom: scouts[0] && scouts[0].memory.targetRoom || null,
        knownRemoteRooms: new Set(infos.map(i => i.roomName)).size, knownRemoteSources: infos.length,
        intelRefreshPending: pending.length, oldestRemoteIntelAge: ages.length ? Math.max(...ages) : null };
}
module.exports = { status };
