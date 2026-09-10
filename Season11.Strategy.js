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
    return nomination && { ...nomination, provider: 'SEASON11',
        score: nomination.yieldScore, modifier: nomination.yieldScore };
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
function getSpecialSpawnPlans(room) { return logic().isOperatingMode() ? logic().getSpawnPlanForRoom(room) || [] : []; }
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
    getColonyObjectives, onExpansionOnline, getSpecialSpawnPlans, getSurplusInvestments,
    getSpecialResourcePolicy, getDiagnostics };
