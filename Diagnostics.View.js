const Economy = require('HiveMind.Economy');
const TickIndex = require('HiveMind.Index');
const Colony = require('HiveMind.ColonyState');
function room(name) {
    const visible = Game.rooms && Game.rooms[name], memory = Memory.rooms && Memory.rooms[name] || {};
    if (!visible && !Memory.rooms?.[name]) return null;
    const economy = Economy.get(name) || {}, harvest = economy.harvest || {}, spawn = memory.spawn || {};
    const index = TickIndex.get(), counts = {}, spawning = {};
    for (const creep of index.creepsByHomeRoom.get(name) || []) {
        const m = creep.memory || {}, role = m.role || 'Unknown';
        const target = creep.spawning ? spawning : counts; target[role] = (target[role] || 0) + 1;
    }
    const queued = {};
    for (const q of spawn.queue || []) queued[q.role || 'Unknown'] = (queued[q.role || 'Unknown'] || 0) + 1;
    const sources = (harvest.sources || []).map(s => ({ id: s.id, activeWork: s.workActive,
        stationedWork: s.stationedWork, requiredWork: s.workRequired, spawningWork: s.workSpawning || 0,
        queuedWork: s.workQueued || 0, income: s.estimatedIncome, expectedIncome: s.expectedIncome,
        assigned: s.assigned, backlog: s.backlog }));
    const decision = spawn.lastDecision || null, current = decision && decision.tick === Game.time;
    const colony = Colony.get(name) || {}, growth = economy.growth || {};
    const alerts = [];
    const economyTick = economy.sampleTick ?? economy.lastSampleTick ?? null;
    if (economyTick !== Game.time) alerts.push('Economy sample unavailable this tick' +
        (economyTick !== null ? ' (last tick ' + economyTick + ')' : ''));
    if (colony.growthAllowed === false) alerts.push('Growth paused: ' +
        (/local.*(?:miner|harvest)/i.test(colony.blockedReason || '') ? 'waiting for local harvesting capacity' : colony.blockedReason || colony.reason || 'core recovery'));
    if (harvest.workRequired > 0 && Economy.localHarvestCoverage(economy).status !== 'HEALTHY') {
        alerts.push('Harvest WORK: ' + (harvest.workActive || 0) + '/' + harvest.workRequired +
            ' active; ' + (harvest.workSpawning || 0) + ' spawning; ' + (harvest.workQueued || 0) + ' queued');
    }
    if (decision && current && decision.waitingForEnergy) alerts.push('Spawn waiting for energy: ' +
        decision.energyAvailable + '/' + (decision.requiredEnergy || '?'));
    else if (decision && current && decision.status === 'BLOCK') alerts.push('Spawn blocked: ' + (decision.blocked?.reason || decision.reason));
    if (economy.state === 'SURVIVAL' || economy.state === 'RECOVERY') alerts.push('Recovery: ' + (economy.reason || 'core economy incomplete'));
    if (!current) alerts.push('Spawn decision unavailable this tick' + (decision ? ' (last tick ' + decision.tick + ')' : ''));
    const remotes = Object.entries(memory.remotePlanner?.remotes || {}).filter(([,r]) => r && r.status === 'active')
        .map(([roomName, r]) => ({ room: roomName, status: r.status, sources: (r.sourceIds || []).length }));
    const resources = {};
    for (const store of [visible?.storage?.store, visible?.terminal?.store]) for (const [type, n] of Object.entries(store || {})) {
        if (typeof n === 'number' && n > 0) resources[type] = (resources[type] || 0) + n;
    }
    return { room: name, visible: !!visible, tick: Game.time, economyTick,
        rcl: visible?.controller?.level || 0, progress: visible?.controller?.progress || 0,
        progressTotal: visible?.controller?.progressTotal || 0, state: economy.state || 'UNKNOWN',
        reason: economy.reason, priority: colony.nextMandatoryRole ? 'Restore ' + colony.nextMandatoryRole : colony.objective || growth.mode || 'Observe',
        growthAllowed: colony.growthAllowed, blockedReason: colony.blockedReason || growth.blockedReason,
        activeWork: harvest.workActive || 0, requiredWork: harvest.workRequired || 0,
        spawningWork: harvest.workSpawning || 0, queuedWork: harvest.workQueued || 0,
        income: harvest.actualOrEstimatedIncome || 0, expectedIncome: harvest.expectedIncome || 0,
        energy: visible?.energyAvailable || 0, energyCapacity: visible?.energyCapacityAvailable || 0,
        stored: (economy.storageEnergy || 0) + (economy.terminalEnergy || 0), reserveTarget: growth.reserveTarget || 0,
        healthyTicks: economy.healthyTicks || 0, counts, spawning, queued, sources, remotes, resources, alerts,
        spawn: decision ? { tick: decision.tick, current, status: decision.status, role: decision.selectedRole,
            reason: decision.blocked?.reason || decision.reason, available: decision.energyAvailable,
            required: decision.requiredEnergy || decision.bodyCost, stage: decision.stage, queue: (spawn.queue || []).length } : null };
}
module.exports = { room };
