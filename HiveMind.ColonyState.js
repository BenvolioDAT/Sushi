const HiveMemory = require('HiveMind.Memory');
const TickIndex = require('HiveMind.Index');
const Economy = require('HiveMind.Economy');

const PHASES = Object.freeze({ OWNED_NO_SPAWN: 'OWNED_NO_SPAWN', BOOTSTRAP: 'BOOTSTRAP', GROWTH: 'GROWTH', DEVELOPMENT: 'DEVELOPMENT', MATURE: 'MATURE' });
const ALERTS = Object.freeze({ PEACE: 'PEACE', THREATENED: 'THREATENED', SIEGE: 'SIEGE' });
const PRIORITY_BANDS = Object.freeze({ EMERGENCY: 0, CORE: 1, BASELINE_GROWTH: 2, DEVELOPMENT: 3, STRATEGIC: 4 });
const TRANSITIONS = Object.freeze({
    OWNED_NO_SPAWN: new Set([PHASES.BOOTSTRAP]),
    BOOTSTRAP: new Set([PHASES.OWNED_NO_SPAWN, PHASES.GROWTH]),
    GROWTH: new Set([PHASES.OWNED_NO_SPAWN, PHASES.BOOTSTRAP, PHASES.DEVELOPMENT]),
    DEVELOPMENT: new Set([PHASES.OWNED_NO_SPAWN, PHASES.BOOTSTRAP, PHASES.GROWTH, PHASES.MATURE]),
    MATURE: new Set([PHASES.OWNED_NO_SPAWN, PHASES.BOOTSTRAP, PHASES.DEVELOPMENT])
});
const ORDERED_PHASES = Object.freeze([
    PHASES.OWNED_NO_SPAWN, PHASES.BOOTSTRAP, PHASES.GROWTH, PHASES.DEVELOPMENT, PHASES.MATURE
]);
const COMBAT_ROLES = new Set(['Ronin', 'Volley', 'Cleric']);

function roleOf(item) { return item && (item.role || item.memory && item.memory.role) || null; }
function activeParts(item, type) {
    if (!item || !Array.isArray(item.body)) return 0;
    return item.body.reduce((sum, part) => sum + (part && (part.type || part) === type && part.hits !== 0 ? 1 : 0), 0);
}
function isHealthy(creep) { return !!creep && (creep.ticksToLive === undefined || creep.ticksToLive > 50); }
function isLocalExtractor(item, roomName) {
    const memory = item && item.memory || {};
    return roleOf(item) === 'Extractor' && memory.remoteMining !== true &&
        (!memory.sourceRoom || memory.sourceRoom === roomName) && (!memory.targetRoom || memory.targetRoom === roomName);
}

function plannedSummary(roomName) {
    const byRole = {};
    let localExtractors = 0;
    let techWork = 0;
    let nonCombat = 0;
    const add = (item, countTechWork) => {
        const role = roleOf(item);
        if (!role) return;
        byRole[role] = (byRole[role] || 0) + 1;
        if (!COMBAT_ROLES.has(role)) nonCombat++;
        if (isLocalExtractor(item, roomName)) localExtractors++;
        if (role === 'Tech' && countTechWork !== false) techWork += activeParts(item, typeof WORK !== 'undefined' ? WORK : 'work');
    };
    for (const creep of TickIndex.get().creepsByHomeRoom.get(roomName) || []) if (isHealthy(creep)) add(creep, true);
    const seenSpawning = new Set();
    for (const spawn of TickIndex.get().ownedSpawnsByRoom.get(roomName) || []) {
        const name = spawn && spawn.spawning && spawn.spawning.name;
        if (!name || Game.creeps && Game.creeps[name]) continue;
        const memory = Memory.creeps && Memory.creeps[name];
        if (memory && !seenSpawning.has(name)) {
            seenSpawning.add(name);
            add({ memory, body: memory.body || [] }, true);
        }
    }
    for (const request of TickIndex.get().spawnRequestsByRoom.get(roomName) || []) {
        const memory = request && request.memory || {};
        const countsForFloor = roleOf(request) !== 'Tech' || memory.controllerGrowthFloor === true ||
            memory.controllerEmergency === true;
        add(request, countsForFloor);
    }
    return { byRole, localExtractors, techWork, nonCombat };
}

function alertFor(room) {
    const threat = HiveMemory.ensure().threats[room.name];
    if (!threat || !(threat.harmfulHostileCount > 0)) return ALERTS.PEACE;
    return threat.emergency || threat.siege || threat.totalThreat >= 1000 ? ALERTS.SIEGE : ALERTS.THREATENED;
}
function objectiveFor(lifecycle) {
    if (lifecycle === PHASES.OWNED_NO_SPAWN) return 'ESTABLISH_SPAWN';
    if (lifecycle === PHASES.BOOTSTRAP) return 'REACH_RCL2';
    if (lifecycle === PHASES.GROWTH) return 'BUILD_CORE_INFRASTRUCTURE';
    if (lifecycle === PHASES.DEVELOPMENT) return 'DEVELOP_SUSTAINABLE_ECONOMY';
    return 'MAINTAIN_AND_SUPPORT_STRATEGY';
}
function structureCount(roomName, type) {
    const byType = TickIndex.get().structuresByRoom.get(roomName);
    return byType && (byType.get(type) || []).length || 0;
}
function milestoneFor(room, lifecycle) {
    const rcl = room.controller && room.controller.level || 0;
    const requirements = [];
    const unmet = [];
    if (lifecycle === PHASES.OWNED_NO_SPAWN) { requirements.push('owned spawn'); unmet.push('waiting for owned spawn'); }
    else if (lifecycle === PHASES.BOOTSTRAP) requirements.push('Foreman', 'two local Extractors', 'local Freighter', 'baseline Tech');
    else if (rcl === 2) {
        requirements.push('5 extensions', 'essential source logistics');
        if (structureCount(room.name, typeof STRUCTURE_EXTENSION !== 'undefined' ? STRUCTURE_EXTENSION : 'extension') < 5) unmet.push('waiting for extensions');
    }
    else if (rcl === 3) {
        requirements.push('first tower', '10 extensions');
        if (structureCount(room.name, typeof STRUCTURE_TOWER !== 'undefined' ? STRUCTURE_TOWER : 'tower') < 1) unmet.push('waiting for first tower');
        if (structureCount(room.name, typeof STRUCTURE_EXTENSION !== 'undefined' ? STRUCTURE_EXTENSION : 'extension') < 10) unmet.push('waiting for extensions');
    }
    else if (rcl === 4) {
        requirements.push('storage', '20 extensions');
        if (structureCount(room.name, typeof STRUCTURE_STORAGE !== 'undefined' ? STRUCTURE_STORAGE : 'storage') < 1) unmet.push('waiting for storage');
    }
    else if (rcl <= 7) requirements.push('advanced infrastructure', 'healthy reserves');
    else requirements.push('controller safety', 'core infrastructure');
    return { milestone: requirements[0] || 'maintain colony', requirements, unmet };
}
function rawLifecycle(room, summary) {
    if (!(TickIndex.get().ownedSpawnsByRoom.get(room.name) || []).length) return PHASES.OWNED_NO_SPAWN;
    const rcl = room.controller && room.controller.level || 0;
    const floorsComplete = (summary.byRole.Foreman || 0) >= 1 && summary.localExtractors >= 2 && (summary.byRole.Freighter || 0) >= 1;
    if (rcl <= 1 || !floorsComplete) return PHASES.BOOTSTRAP;
    if (rcl <= 3) return PHASES.GROWTH;
    if (rcl <= 7) return PHASES.DEVELOPMENT;
    return PHASES.MATURE;
}

function transition(record, nextState, reason) {
    if (!record || !ORDERED_PHASES.includes(nextState)) return false;
    const current = record.lifecycle || record.state || record.phase;
    if (!current || current === nextState) return false;
    const allowed = TRANSITIONS[current];
    if (!allowed || !allowed.has(nextState)) return false;
    record.lifecycle = nextState;
    record.phase = nextState;
    record.state = nextState;
    record.lifecycleSince = Game.time;
    record.stateSince = Game.time;
    record.updatedTick = Game.time;
    record.debugReason = reason || `${current} -> ${nextState}`;
    return true;
}

function nextLifecycleStep(current, proposed) {
    if (current === proposed) return current;
    if (proposed === PHASES.OWNED_NO_SPAWN || proposed === PHASES.BOOTSTRAP) return proposed;
    const currentIndex = ORDERED_PHASES.indexOf(current);
    const proposedIndex = ORDERED_PHASES.indexOf(proposed);
    if (currentIndex < 0 || proposedIndex < 0) return proposed;
    return ORDERED_PHASES[currentIndex + Math.sign(proposedIndex - currentIndex)];
}

function transitionReason(room, from, to, summary) {
    const rcl = room.controller && room.controller.level || 0;
    if (to === PHASES.OWNED_NO_SPAWN) return 'Owned room has no spawn';
    if (to === PHASES.BOOTSTRAP) return `Core workforce floor missing at RCL${rcl}`;
    if (from === PHASES.BOOTSTRAP && to === PHASES.GROWTH) return 'Core workforce floor established';
    if (to === PHASES.DEVELOPMENT) return `RCL${rcl} core workforce established`;
    if (to === PHASES.MATURE) return 'RCL8 colony reached mature lifecycle';
    if (to === PHASES.GROWTH && summary) return `RCL${rcl} growth requirements active`;
    return `${from} -> ${to}`;
}

function decide(room, economy, summary, lifecycle, alert) {
    const rcl = room.controller && room.controller.level || 0;
    const floorReachable = !economy.bootstrap || economy.bootstrap.floorReachable !== false;
    const harvest = economy.harvest || {};
    const functionalMining = summary.localExtractors > 0 &&
        (harvest.workActive === undefined || harvest.workActive + (harvest.workIncoming || harvest.workQueued || 0) > 0);
    let nextMandatoryRole = null;
    let blockedReason = null;
    if (!functionalMining && !floorReachable) {
        nextMandatoryRole = 'Extractor';
        blockedReason = 'minimum Extractor energy floor is not recoverable';
    }
    else if ((summary.byRole.Foreman || 0) < 1) {
        nextMandatoryRole = 'Foreman';
        blockedReason = 'Foreman floor missing';
    }
    else if (summary.localExtractors < 2 || !functionalMining) {
        nextMandatoryRole = 'Extractor';
        blockedReason = 'minimum local miner floor missing';
    }
    else if ((summary.byRole.Freighter || 0) < 1) {
        nextMandatoryRole = 'Freighter';
        blockedReason = 'core logistics missing';
    }
    const coreBlockedReason = blockedReason;
    const controllerDanger = !!(room.controller && room.controller.ticksToDowngrade < 5000);
    const baselineTechWork = rcl >= 1 && rcl < 8 ? 1 : 0;
    /* RCL1-7 are all growth phases; DEVELOPMENT changes infrastructure, not the controller objective. */
    const baselinePhase = rcl >= 1 && rcl < 8;
    let growthAllowed = baselinePhase && !blockedReason && economy.state !== Economy.STATES.SURVIVAL;
    if (alert === ALERTS.SIEGE) { growthAllowed = false; blockedReason = 'owned-room defense emergency'; }
    if (Game.cpu && Game.cpu.bucket < 1000) { growthAllowed = false; blockedReason = 'CPU bucket too low'; }
    const baselineTechRequired = growthAllowed && baselineTechWork > 0 && summary.techWork < baselineTechWork;
    if (!nextMandatoryRole && baselineTechRequired) nextMandatoryRole = 'Tech';
    let reason;
    if (controllerDanger) reason = 'controller downgrade danger; safety policy active';
    else if (baselineTechRequired) reason = 'core income exists; begin minimum controller progress' +
        (economy.protectedStockpileEnergy > 0 ? '; spawn stockpile available' : '');
    else if (!growthAllowed && blockedReason) reason = blockedReason;
    else if (baselinePhase) reason = 'minimum controller growth is covered';
    else reason = lifecycle + ' lifecycle requirements active';
    return {
        objective: objectiveFor(lifecycle),
        priorityBand: alert === ALERTS.SIEGE ? PRIORITY_BANDS.EMERGENCY : blockedReason ? PRIORITY_BANDS.CORE :
            baselinePhase ? PRIORITY_BANDS.BASELINE_GROWTH : PRIORITY_BANDS.DEVELOPMENT,
        growthAllowed, baselineTechRequired, baselineTechWork,
        blockedReason: growthAllowed ? null : blockedReason, reason, nextMandatoryRole,
        coreFloor: { foreman: summary.byRole.Foreman || 0, localExtractors: summary.localExtractors,
            freighters: summary.byRole.Freighter || 0, complete: !coreBlockedReason },
        techPlannedWork: summary.techWork, governorNonCombat: summary.nonCombat,
        controllerDowngradeTicks: room.controller && room.controller.ticksToDowngrade || 0,
        protectedStockpileEnergy: economy.protectedStockpileEnergy || 0
    };
}

function setIfChanged(target, key, value) {
    if (JSON.stringify(target[key]) !== JSON.stringify(value)) target[key] = value;
}
function update(room) {
    if (!room || !room.controller || !room.controller.my) return null;
    const economy = Economy.get(room.name) || { state: Economy.STATES.RECOVERY };
    const summary = plannedSummary(room.name);
    const proposed = rawLifecycle(room, summary);
    const alert = alertFor(room);
    const memory = HiveMemory.getRoomMemory(room.name);
    if (!memory.colony || typeof memory.colony !== 'object') memory.colony = {};
    const record = memory.colony;
    const holdTicks = Math.max(1, HiveMemory.getConfig('lifecycle').hysteresisTicks || 5);
    let lifecycle = record.lifecycle || record.state || record.phase || proposed;
    if (!ORDERED_PHASES.includes(lifecycle)) lifecycle = proposed;
    if (!record.lifecycle && !record.state && !record.phase) {
        record.lifecycle = lifecycle;
        record.phase = lifecycle;
        record.state = lifecycle;
        record.lifecycleSince = Game.time;
        record.stateSince = Game.time;
        record.updatedTick = Game.time;
        record.debugReason = `Initialized ${lifecycle} lifecycle`;
    }
    if (proposed !== lifecycle) {
        if (record.pendingLifecycle !== proposed) { record.pendingLifecycle = proposed; record.pendingSince = Game.time; }
        const urgent = proposed === PHASES.OWNED_NO_SPAWN || proposed === PHASES.BOOTSTRAP;
        if (urgent || Game.time - record.pendingSince >= holdTicks) {
            const nextState = nextLifecycleStep(lifecycle, proposed);
            if (transition(record, nextState, transitionReason(room, lifecycle, nextState, summary))) {
                lifecycle = nextState;
                if (lifecycle === proposed) {
                    delete record.pendingLifecycle;
                    delete record.pendingSince;
                }
                else record.pendingSince = Game.time - holdTicks;
            }
        }
    }
    else { delete record.pendingLifecycle; delete record.pendingSince; }
    if (record.lifecycleSince === undefined) record.lifecycleSince = Game.time;
    if (record.stateSince === undefined) record.stateSince = record.lifecycleSince;
    if (record.updatedTick === undefined) record.updatedTick = record.stateSince;
    if (!record.debugReason) record.debugReason = `Initialized ${lifecycle} lifecycle`;
    record.lifecycle = lifecycle;
    record.phase = lifecycle;
    record.state = lifecycle;
    for (const obsolete of ['pendingPhase', 'stateStartTick', 'stateChangedAt']) delete record[obsolete];
    const decision = decide(room, economy, summary, lifecycle, alert);
    const milestone = milestoneFor(room, lifecycle);
    if (record.milestone !== milestone.milestone || record.milestoneSince === undefined) {
        record.milestoneSince = Game.time;
    }
    const milestoneTimeout = Math.max(1, HiveMemory.getConfig('lifecycle').milestoneTimeout || 1500);
    const milestoneTimedOut = milestone.unmet.length > 0 && Game.time - record.milestoneSince >= milestoneTimeout;
    const stable = {
        lifecycle, phase: lifecycle, lifecycleSince: record.lifecycleSince, rcl: room.controller.level || 0,
        objective: decision.objective, priorityBand: decision.priorityBand, growthAllowed: decision.growthAllowed,
        baselineTechRequired: decision.baselineTechRequired, baselineTechWork: decision.baselineTechWork,
        blockedReason: decision.blockedReason, reason: decision.reason, nextMandatoryRole: decision.nextMandatoryRole,
        coreFloor: decision.coreFloor, techPlannedWork: decision.techPlannedWork,
        governorNonCombat: decision.governorNonCombat, alert, economy: economy.state,
        controllerDowngradeTicks: decision.controllerDowngradeTicks,
        protectedStockpileEnergy: decision.protectedStockpileEnergy,
        milestone: milestone.milestone, milestoneSince: record.milestoneSince, milestoneTimedOut,
        requirements: milestone.requirements, unmet: milestone.unmet
    };
    for (const [key, value] of Object.entries(stable)) setIfChanged(record, key, value);
    return { ...record };
}
function run() {
    const result = {};
    for (const room of TickIndex.get().ownedRooms) result[room.name] = update(room);
    return result;
}
function get(roomName) { return Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].colony || null; }

module.exports = {
    PHASES, ALERTS, PRIORITY_BANDS, TRANSITIONS,
    run, update, get, transition, plannedSummary, rawLifecycle, decide, milestoneFor
};
