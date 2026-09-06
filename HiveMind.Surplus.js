/* Rank useful work already discovered by the existing planners. */
function score(candidate) {
    if (!(candidate.demand > 0)) return -Infinity;
    return (candidate.urgency || 0) + (candidate.benefit || 0) + (candidate.income || 0) * 10 -
        (candidate.energyCost || 0) / 1000 - (candidate.cpuCost || 0) * 10 -
        (candidate.spawnLoad || 0) * 30 - (candidate.risk || 0);
}
function allocate(candidates, budget) {
    let remaining = Math.max(0, budget);
    return candidates.map(c => ({ ...c, score: score(c) })).filter(c => c.score > 0)
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map(c => {
            const allocated = Math.min(remaining, c.demand); remaining -= allocated;
            return { id: c.id, score: c.score, allocated };
        });
}
function plan(room, economy, capacity) {
    const growth = economy && economy.growth || {};
    const rich = capacity && ['SURPLUS', 'EXPAND'].includes(capacity.mode) && capacity.population.discretionarySlots > 0;
    const budget = rich ? Math.max(0, (growth.estimatedNetIncome || 0) * 0.85 +
        Math.min(30, (growth.energyAboveReserve || 0) / 10000)) : 0;
    const remote = growth.remote || {};
    const hive = Memory.hive || {}, memory = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
    const reactors = hive.season && hive.season.season11 && hive.season.season11.reactorPortfolio;
    const season = Object.values(reactors && reactors.reactors || {}).filter(r => r.homeRoom === room.name && r.active);
    const expansion = Object.values(hive.operations || {}).filter(o => o.originRoom === room.name &&
        /EXPANSION|CLAIM/.test(o.type || '') && !['COMPLETE', 'ABORTED'].includes(o.state));
    const candidates = [
        { id: 'remoteHauling', demand: Math.max(0, (remote.requiredCarry || 0) - (remote.availableCarry || 0)), benefit: 100, income: remote.provenIncome || 0 },
        { id: 'criticalInfrastructure', demand: growth.criticalConstructionBudget || 0, urgency: 80 },
        { id: 'reactorContinuity', demand: season.filter(r => r.owned).length * 2, benefit: 90 },
        { id: 'seasonExpansion', demand: season.filter(r => !r.owned).length * 2, benefit: 65 },
        { id: 'controller', demand: room.controller.level < 8 ? 60 : 15, benefit: room.controller.level < 8 ? 60 : 20 },
        { id: 'infrastructure', demand: Math.max(0, (memory.artificerDesiredWork || 0) - (memory.artificerLivingWork || 0)), benefit: 40 },
        { id: 'expansionSupport', demand: expansion.length * 2, benefit: 30 }
    ];
    const allocations = allocate(candidates, budget);
    const controller = allocations.find(a => a.id === 'controller');
    const result = { tick: Game.time, budget, allocations,
        techWork: controller ? Math.floor(controller.allocated) : 0,
        reason: budget > 0 ? 'invest sustainable income and bounded stored surplus in useful work' : 'NO_USEFUL_SURPLUS_WORK' };
    memory.surplus = result;
    return result;
}
function requestBias(roomName, request) {
    const memory = Memory.rooms[roomName] || {}, plan = memory.surplus;
    if (!plan || !plan.budget || Game.time - plan.tick > 10 || request.emergency) return 0;
    const category = require('HiveMind.Economy').categoryForRequest(request);
    const id = category === 'upgradeSurplus' ? 'controller' : category === 'criticalInfrastructure' ? 'criticalInfrastructure' :
        /^remote/.test(category) ? 'remoteHauling' : category === 'construction' ? 'infrastructure' :
        category === 'special' ? 'seasonExpansion' : category === 'expansion' ? 'expansionSupport' : null;
    const investment = plan.allocations.find(a => a.id === id && a.allocated > 0);
    return investment ? Math.min(5, Math.max(0, investment.score / 20)) : 0;
}
module.exports = { score, allocate, plan, requestBias };
