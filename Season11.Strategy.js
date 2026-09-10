const Adapter = require('Season11.Adapter');

/* Provider packages resolve their internal implementation lazily. This keeps the
   generic registry out of the permanent economy/spawn dependency graph. */
function logic() { return require(['Logic', 'Season11'].join('.')); }
function isActive() { return Adapter.isAvailable(); }
function getCapabilities() {
    return { market: false, externalTerminalTransfers: false, portals: false,
        season: 'SEASON11', constantCpu: 100 };
}
function getExpansionNomination() {
    if (!logic().isOperatingMode()) return null;
    const nomination = logic().getExpansionNomination();
    return nomination && { ...nomination, provider: 'SEASON11', rawValue: nomination.yieldScore,
        nominationStrength: nomination.density || 0, strategicPriority: 'FINITE_RESOURCE' };
}
function getColonyObjectives(room) {
    const memory = Memory.rooms && Memory.rooms[room.name] || {};
    const objectives = memory.strategyObjectives || {};
    let objective = objectives.SEASON11_THORIUM;
    /* One-time compatibility migration; the permanent ColonyState never sees this key. */
    if (!objective && memory.season11MiningColony) {
        const legacy = memory.season11MiningColony;
        memory.strategyObjectives = objectives;
        objective = objectives.SEASON11_THORIUM = { active: legacy.active !== false,
            provider: 'SEASON11', type: 'TARGET_RCL', targetRcl: legacy.targetRcl || 6,
            controllerWorkMinimum: Math.max(1,
                Number(require('HiveMind.Memory').getConfig('season11').expansionUpgradeWork) || 8),
            mineralId: legacy.mineralId || null, nominatedAt: legacy.nominatedAt || Game.time,
            priority: 80, reason: legacy.reason || 'Reach RCL6 for finite strategic resource extraction' };
        delete memory.season11MiningColony;
    }
    if (!objective || objective.active === false || room.controller.level >= objective.targetRcl) return [];
    return [{ ...objective, provider: 'SEASON11' }];
}
function onExpansionOnline(roomName, nomination) {
    const memory = Memory.rooms[roomName] || (Memory.rooms[roomName] = {});
    const objectives = memory.strategyObjectives || (memory.strategyObjectives = {});
    objectives.SEASON11_THORIUM = { active: true, provider: 'SEASON11', type: 'TARGET_RCL',
        targetRcl: 6, controllerWorkMinimum: Math.max(1,
            Number(require('HiveMind.Memory').getConfig('season11').expansionUpgradeWork) || 8),
        mineralId: nomination.mineralId || null, nominatedAt: nomination.nominatedAt || Game.time,
        onlineAt: Game.time, priority: 80, reason: 'Reach RCL6 for finite strategic resource extraction' };
}
function getSpecialSpawnPlans(room) {
    if (!logic().isOperatingMode()) return [];
    const Bodies = require('role.creepBodyConfig');
    return (logic().getSpawnPlanForRoom(room) || []).map(plan => {
        const memory = { ...(plan.memory || {}) };
        const body = plan.role === 'ThoriumHauler' ?
            Bodies.getThoriumHaulerBodyForCarry(room, plan.requestedCarryParts || 1) :
            Bodies.getBody(plan.role, room);
        const route = Math.max(0, Number(memory.season11RouteDistance) || 0);
        const travelLeadTicks = plan.role === 'ThoriumMiner' ? Math.min(1000, route * 50) : Math.min(1000, route);
        const replacementBuffer = (plan.role === 'ThoriumMiner' ? 120 : 180) + travelLeadTicks;
        return { role: plan.role, count: plan.desired, desired: plan.desired,
            priority: Number.isFinite(plan.priority) ? plan.priority : 40,
            body, bodyRequirements: { body, fixed: true }, preferredSpawnRoom: room.name, originRoom: room.name,
            targetRoom: memory.season11ThoriumRoom || memory.season11SourceRoom || memory.season11ReactorRoom,
            assignmentKey: plan.assignmentKey, replacementBuffer, travelLeadTicks,
            validUntil: Game.time + 10, reason: 'Season 11 assignment ' + plan.assignmentKey,
            memory: { ...memory, strategyProvider: 'SEASON11', strategyCategory: 'SPECIAL_STRATEGY',
                strategyAssignmentKey: plan.assignmentKey, strategyEmergency: plan.emergency === true },
            economyCategory: 'special', strategyProvider: 'SEASON11',
            strategyCategory: 'SPECIAL_STRATEGY', strategyEmergency: plan.emergency === true,
            strategyMandatory: plan.mandatory === true, emergency: plan.emergency === true };
    }).filter(plan => plan.body && plan.body.length);
}
function validateDemand(demand) {
    if (!logic().isOperatingMode()) return false;
    const cm = demand.memory || {}, memory = require('HiveMind.Memory').getSeasonState();
    const portfolio = memory.reactorPortfolio;
    if (!portfolio || !portfolio.plannedAt) return true;
    const id = cm.season11ReactorId || cm.season11ReactorGuard;
    if (id) {
        const entry = portfolio.reactors[id];
        if (!entry || !entry.active || !entry.healthy) return false;
        if (demand.role === 'ReactorClaimer') return entry.claimReady === true;
        if (demand.role === 'ThoriumHauler') return (entry.owned || !entry.owner ||
            entry.recapture && (entry.recapture.approved || entry.recapture.preparing)) &&
            entry.assignedMiningRooms.includes(cm.season11SourceRoom);
        if (cm.season11ReactorGuard) return entry.owned && ['READY', 'HOLD'].includes(entry.defenseTier) ||
            entry.recapture && entry.recapture.approved;
    }
    const assignment = memory.assignments && memory.assignments.mining[cm.season11SourceRoom];
    return demand.role !== 'ThoriumMiner' || !!(assignment && assignment.ready && assignment.remaining > 0);
}
function normalizeDemand(demand) {
    const cm = demand && demand.memory || {};
    if (!demand.strategyProvider && (cm.season11AssignmentKey || cm.season11ReactorGuard)) {
        demand.strategyProvider = 'SEASON11';
        demand.strategyCategory = 'SPECIAL_STRATEGY';
        demand.assignmentKey = cm.season11AssignmentKey || 'guard:' + cm.season11ReactorGuard;
    }
    return demand;
}
function getScoutModifier(context) {
    if (!context || !context.unknown || context.urgent || context.defense) return 0;
    const match = /^[WE]\d+([NS])(\d+)$/.exec(context.roomName || '');
    if (!match) return 0;
    const modifier = match[1] === 'N' ? Math.min(5, Number(match[2]) / 20) : 0;
    if (modifier > 0) global.__sushiSeason11ScoutBias = { tick: Game.time,
        roomName: context.roomName, modifier, reason: 'SEASON11_UPPER_WORLD_BIAS' };
    return modifier;
}
function observeRoom(room, homeRoom, viaScout) { return logic().observeRoom(room, homeRoom, viaScout); }
function getScoutRadius(fallback) { return logic().getScoutRadius(fallback); }
function runScoutDirective(creep) {
    if (!creep.memory.season11WatchRoom) return false;
    const watchRoom = creep.memory.season11WatchRoom;
    const portfolio = logic().ensureMemory().reactorPortfolio;
    const needed = logic().isObserving() && Object.values(portfolio.reactors).some(entry =>
        entry.roomName === watchRoom && entry.active && entry.defenseTier !== 'NONE');
    if (!needed) { delete creep.memory.season11WatchRoom; return false; }
    if (creep.room.name !== watchRoom) require('utility.Travel.Creep').moveToRoom(creep, watchRoom,
        { range: 22, reusePath: 20, allowHostile: false });
    else require('utility.Travel.Creep').moveOffExit(creep);
    return true;
}
function getSurplusInvestments(room) {
    if (!logic().isOperatingMode()) return [];
    const memory = require('HiveMind.Memory').getSeasonState();
    const reactors = memory && memory.reactorPortfolio && memory.reactorPortfolio.reactors || {};
    const owned = Object.values(reactors).filter(r => r.homeRoom === room.name && r.active && r.owned).length;
    const expansion = Object.values(reactors).filter(r => r.homeRoom === room.name && r.active && !r.owned).length;
    return [{ id: 'strategy:SEASON11:reactorContinuity', category: 'SPECIAL_STRATEGY',
        demand: owned * 2, benefit: 90, provider: 'SEASON11' },
    { id: 'strategy:SEASON11:expansion', category: 'SPECIAL_STRATEGY',
        demand: expansion * 2, benefit: 65, provider: 'SEASON11' }];
}
function getSpecialResourcePolicy(type) {
    if (type !== Adapter.resourceType()) return null;
    const memory = require('HiveMind.Memory').getSeasonState();
    return { provider: 'SEASON11', finite: true, renewable: false, stockBands: false,
        reason: 'FINITE_RESOURCE', reservedAmount: Object.values(memory.thoriumReservations &&
            memory.thoriumReservations.stores || {}).reduce((sum, store) => sum +
            Object.values(store.reactors || {}).reduce((n, value) => n + value, 0), 0) };
}
function getDiagnostics() { return { id: 'SEASON11', ...logic().getDiagnostics(),
    operationSummary: require(['Season11', 'Operations'].join('.')).getDashboard() }; }

module.exports = { id: 'SEASON11', isActive, getCapabilities, getExpansionNomination,
    getColonyObjectives, onExpansionOnline, getSpecialSpawnPlans, validateDemand, normalizeDemand, getScoutModifier,
    observeRoom, getScoutRadius, runScoutDirective, getSurplusInvestments,
    getSpecialResourcePolicy, getDiagnostics };
