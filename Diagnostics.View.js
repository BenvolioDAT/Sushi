const Economy = require('HiveMind.Economy');
const TickIndex = require('HiveMind.Index');
const Colony = require('HiveMind.ColonyState');

// Read on demand, using the same commitment ledger as spawn planning. Flow
// totals describe surviving workers; compare snapshots over complete haul trips.
function logistics(name, economy, freighters) {
    const totals = { observedCreepTicks: 0, workCreepTicks: 0, parkingCreepTicks: 0, picked: 0, delivered: 0 };
    for (const creep of freighters) {
        const flow = creep.flow || {};
        totals.observedCreepTicks += flow.observedTicks || 0;
        totals.workCreepTicks += flow.workTicks || 0;
        totals.parkingCreepTicks += flow.parkingTicks || 0;
        totals.picked += flow.picked || 0;
        totals.delivered += flow.delivered || 0;
    }
    const sample = Memory.hive?.telemetry?.populationRooms?.[name]?.Freighter;
    const view = { revision: require('Logistics.Index').REVISION, flow: totals,
        cpu: sample ? { tick: sample.tick, total: sample.totalCpu, perCreep: sample.cpu, utilization: sample.utilization } : null };
    for (const assignment of ['local', 'remote']) {
        const coverage = Economy.freighterCoverage(name, assignment);
        const required = economy.sampleTick === Game.time && economy.haul ?
            assignment === 'local' ? economy.haul.requiredCarry : economy.haul.remoteCarryRequired : null;
        const workers = freighters.filter(c => c.assignmentClass === assignment);
        const idle = workers.filter(c => c.job === 'idle' && !c.working && c.cargo === 0).length;
        const noProgress = workers.filter(c => c.job !== 'idle' && (c.flow?.idleTicks || 0) >= 10).length;
        const missing = Number.isFinite(required) ? Math.max(0, required - coverage.living - coverage.queued - coverage.spawning) : null;
        view[assignment] = { required, ...coverage, missing, workers: workers.length, idleWorkers: idle,
            noProgressWorkers: noProgress, fatiguedWorkers: workers.filter(c => c.fatigue > 0).length,
            assessment: missing === null ? 'CURRENT_ECONOMY_UNAVAILABLE' : missing > 0 ?
                idle || noProgress ? 'DEFICIT_WITH_UNDERUSED_WORKERS' : 'CARRY_DEFICIT' :
                assignment === 'local' && economy.haul && (economy.haul.backlog > Math.max(500, economy.haul.activeCarry * 75) ||
                    economy.haul.linkBackpressure > 500) ? 'CAPACITY_COVERED_BACKLOG' :
                noProgress ? 'CAPACITY_COVERED_CHECK_FLOW' : idle ? 'CAPACITY_COVERED_IDLE_WORKERS' : 'CAPACITY_COVERED' };
    }
    return view;
}
function room(name) {
    const visible = Game.rooms && Game.rooms[name], memory = Memory.rooms && Memory.rooms[name] || {};
    if (!visible && !Memory.rooms?.[name]) return null;
    const economy = Economy.get(name) || {}, harvest = economy.harvest || {}, spawn = memory.spawn || {};
    const index = TickIndex.get(), counts = {}, spawning = {}, freighters = [];
    for (const creep of index.creepsByHomeRoom.get(name) || []) {
        const m = creep.memory || {}, role = m.role || 'Unknown';
        const target = creep.spawning ? spawning : counts; target[role] = (target[role] || 0) + 1;
        if (role === 'Freighter' && !creep.spawning) freighters.push({ name: creep.name,
            room: creep.pos && creep.pos.roomName, x: creep.pos && creep.pos.x, y: creep.pos && creep.pos.y,
            assignment: m.assignmentFunction, job: m.freighterJob || 'idle', working: !!m.FreighterWorking,
            assignmentClass: Economy.isLocalFreighter(creep) ? 'local' : Economy.isRemoteFreighter(creep) ? 'remote' : 'other',
            predecessors: Array.isArray(m.freighterPredecessors) ? m.freighterPredecessors.slice(0, 50) : [],
            pickup: m.pickupTargetId || null, delivery: m.freighterDeliveryTargetId || null,
            cargo: creep.store && creep.store[RESOURCE_ENERGY] || 0,
            carryParts: (creep.body || []).filter(p => (p.type || p) === CARRY && p.hits !== 0).length,
            moveParts: (creep.body || []).filter(p => (p.type || p) === MOVE && p.hits !== 0).length,
            ttl: creep.ticksToLive, fatigue: creep.fatigue || 0, flow: m.freighterFlow || null });
    }
    const queued = {};
    for (const q of spawn.queue || []) queued[q.role || 'Unknown'] = (queued[q.role || 'Unknown'] || 0) + 1;
    const sources = (harvest.sources || []).map(s => ({ id: s.id, activeWork: s.workActive,
        stationedWork: s.stationedWork, requiredWork: s.workRequired, spawningWork: s.workSpawning || 0,
        queuedWork: s.workQueued || 0, stagingWork: s.workStaging || 0, income: s.estimatedIncome, expectedIncome: s.expectedIncome,
        assigned: s.assigned, backlog: s.backlog, seats: s.seatCount, availableSeats: s.availableSeats,
        distance: s.distance, haulIncome: s.haulIncome, haulCarry: s.haulCarry, haulRoundTrip: s.haulRoundTrip,
        maximumWork: s.maxAchievableWork, plannedWork: s.plannedWork,
        miners: s.miners || [], replacement: s.replacementStatus,
        constraint: s.constraint, planningReason: s.planningReason, recommendedAction: s.recommendedAction,
        preferredBody: s.preferredBody, preferredCost: s.preferredCost }));
    const decision = spawn.lastDecision || null, current = decision && decision.tick === Game.time;
    const colony = Colony.get(name) || {}, growth = economy.growth || {};
    const alerts = [];
    if (harvest.constraint && harvest.constraint !== 'NONE') alerts.push('Harvest constraint: ' + harvest.constraint);
    if (harvest.infrastructureRecovery) alerts.push('Build extensions: sustainable minimum growth permitted during recovery');
    for (const source of sources) if (source.constraint === 'SPAWN_CAPACITY' || source.constraint === 'NO_HARVEST_SEAT') {
        alerts.push(source.recommendedAction + ' | ' + source.planningReason);
    }
    const economyTick = economy.sampleTick ?? economy.lastSampleTick ?? null;
    if (economyTick !== Game.time) alerts.push('Economy sample unavailable this tick' +
        (economyTick !== null ? ' (last tick ' + economyTick + ')' : ''));
    if (colony.growthAllowed === false) alerts.push('Growth paused: ' +
        (/local.*(?:miner|harvest)/i.test(colony.blockedReason || '') ? 'waiting for local harvesting capacity' : colony.blockedReason || colony.reason || 'core recovery'));
    if (harvest.workRequired > 0 && Economy.localHarvestCoverage(economy).status !== 'HEALTHY') {
        alerts.push('Harvest WORK: ' + (harvest.workActive || 0) + '/' + harvest.workRequired +
            ' active; ' + (harvest.workSpawning || 0) + ' spawning; ' + (harvest.workQueued || 0) + ' queued' +
            (harvest.workStaging ? '; ' + harvest.workStaging + ' staging' : ''));
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
        spawningWork: harvest.workSpawning || 0, queuedWork: harvest.workQueued || 0, stagingWork: harvest.workStaging || 0,
        income: harvest.actualOrEstimatedIncome || 0, expectedIncome: harvest.expectedIncome || 0,
        energy: visible?.energyAvailable || 0, energyCapacity: visible?.energyCapacityAvailable || 0,
        stored: (economy.storageEnergy || 0) + (economy.terminalEnergy || 0), reserveTarget: growth.reserveTarget || 0,
        healthyTicks: economy.healthyTicks || 0, counts, spawning, queued, sources, remotes, resources, alerts,
        hauling: economy.haul || null, freighters, logistics: { ...logistics(name, economy, freighters),
            renewals: (spawn.queue || []).filter(q => q.freighterRenewal).map(q => ({
                assignment: q.freighterRenewal.assignment, carry: q.requestedCarryParts,
                needBy: q.freighterRenewal.needBy, predecessors: q.freighterRenewal.predecessors })) },
        spawn: decision ? { tick: decision.tick, current, status: decision.status, role: decision.selectedRole,
            reason: decision.blocked?.reason || decision.reason, available: decision.energyAvailable,
            required: decision.requiredEnergy || decision.bodyCost, capacity: decision.energyCapacity || visible?.energyCapacityAvailable,
            preferredCost: decision.preferredCost, selectedBody: decision.selectedBody,
            sizingReason: decision.sizingReason, admission: decision.arbiterReason,
            stage: decision.stage, queue: (spawn.queue || []).length } : null };
}
module.exports = { room };
