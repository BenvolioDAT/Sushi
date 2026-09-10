const finite = (v, fallback = 0) => Number.isFinite(v) ? Math.max(0, v) : fallback;
function config() {
    const raw = require('HiveMind.Memory').getConfig('surplus') || {};
    return { drawdownHorizon: Math.max(1500, finite(raw.drawdownHorizon, 20000)),
        enterAboveReserve: Math.max(1, finite(raw.enterAboveReserve, 200000)),
        exitAboveReserve: Math.min(finite(raw.exitAboveReserve, 50000), finite(raw.enterAboveReserve, 200000)),
        maxSpendPerTick: finite(raw.maxSpendPerTick, 100), techMaxWork: finite(raw.techMaxWork, 60),
        artificerMaxWork: finite(raw.artificerMaxWork, 80), constructionHorizon: Math.max(100, finite(raw.constructionHorizon, 5000)),
        workDutyCycle: Math.max(0.1, Math.min(1, finite(raw.workDutyCycle, 0.65))) };
}
function drawdown(growth, previous, allowed, settings = config()) {
    const above = finite(growth.storedEnergy - growth.reserveTarget);
    const active = allowed && above > settings.exitAboveReserve &&
        (above >= settings.enterAboveReserve || previous && previous.mode === 'DRAWDOWN');
    return { mode: active ? 'DRAWDOWN' : 'INCOME', energyAboveReserve: above,
        extraSpendPerTick: active ? Math.min(settings.maxSpendPerTick,
            (above - settings.exitAboveReserve) / settings.drawdownHorizon) : 0 };
}
function score(c) {
    if (!(c.demand > 0)) return -Infinity;
    return (c.urgency || 0) + (c.benefit || 0) + (c.income || 0) * 10 -
        (c.energyCost || 0) / 1000 - (c.cpuCost || 0) * 10 - (c.spawnLoad || 0) * 30 - (c.risk || 0);
}
function allocate(candidates, budget) {
    let remaining = Math.max(0, budget);
    return candidates.map(c => ({ ...c, score: score(c) })).filter(c => c.score > 0)
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map(c => {
            const allocated = Math.min(remaining, c.demand); remaining -= allocated;
            return { ...c, allocated };
        });
}
function plan(room, economy, capacity) {
    const growth = economy && economy.growth || {}, settings = config();
    const memory = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
    const haul = economy && economy.haul || {};
    const localHaulFunded = (haul.localCarryMissing || 0) <= 0;
    const repairableRecovery = economy && economy.state === 'RECOVERY' &&
        economy.recoveryReason === 'LOCAL_HAUL_SHORTAGE' && localHaulFunded;
    const healthy = !!capacity && capacity.energy.healthy && capacity.energy.known !== false &&
        economy && economy.state !== 'SURVIVAL' &&
        (economy.state !== 'RECOVERY' || repairableRecovery) && growth.mode !== 'RECOVERY';
    const reason = !healthy || !(growth.storedEnergy > growth.reserveTarget) ? 'ENERGY_RESERVE' : capacity.cpu.headroom <= 0 || capacity.cpu.bucket < 4000 ||
        capacity.cpu.mode === 'critical' ? 'CPU_LIMIT' : capacity.spawn.headroom <= 0 ? 'SPAWN_LIMIT' :
        capacity.reason === 'DEFENSE_EMERGENCY' ? 'DEFENSE_EMERGENCY' : null;
    const stock = drawdown(growth, memory.surplus, !reason, settings);
    const budget = reason ? 0 : Math.min(settings.maxSpendPerTick,
        finite(growth.estimatedNetIncome) * 0.85 + stock.extraSpendPerTick);
    const hive = Memory.hive || {}, remote = growth.remote || {};
    const sites = typeof room.find === 'function' ? room.find(FIND_MY_CONSTRUCTION_SITES) || [] : [];
    const progress = sites.reduce((sum, s) => sum + finite(s.progressTotal - s.progress), 0);
    const backlog = memory.surplusBacklog;
    const work = backlog && Game.time - backlog.tick <= 25 ? backlog.work :
        progress / (5 * settings.constructionHorizon * settings.workDutyCycle);
    const infrastructure = Math.min(settings.artificerMaxWork, Math.ceil(work));
    const expansion = Object.values(hive.operations || {}).filter(o => o.originRoom === room.name &&
        /^(EXPAND|EXPANSION|CLAIM)$/.test(o.type || '') && !['COMPLETE', 'ABORTED'].includes(o.state));
    const candidates = [
        { id: 'remoteHauling', demand: Math.max(0, finite(remote.requiredCarry) - finite(remote.availableCarry)) * 0.1,
            benefit: 100, income: finite(remote.provenIncome), capabilityPerEnergy: 10 },
        { id: 'infrastructure', demand: infrastructure, benefit: 85, capabilityPerEnergy: 1 },
        { id: 'expansionSupport', demand: expansion.length * 2, benefit: 70, capabilityPerEnergy: 1 },
        { id: 'controller', demand: room.controller.level < 8 ? settings.techMaxWork : 15,
            benefit: room.controller.level < 8 ? 60 : 20, capabilityPerEnergy: 1 }
    ];
    const sources = memory.remotePlanner && memory.remotePlanner.sourceInfos || {};
    for (const info of Object.values(sources)) {
        if (info.active || !(info.netIncome > 0) || !(info.score > 0) || !info.route || info.route.valid !== true || info.risk > 0) continue;
        candidates.push({ id: 'remoteBootstrap:' + info.sourceId, demand: Math.max(1,
            (finite(info.estimatedMinerBodyCost) + finite(info.requiredCarry) * 100) / 1500),
            benefit: 70, income: info.netIncome, risk: finite(info.risk), capabilityPerEnergy: 1,
            sourceId: info.sourceId, requiredWork: info.requiredWork, requiredCarry: info.requiredCarry });
    }
    candidates.push(...require('Strategy.Provider').getSurplusInvestments(room, economy, capacity));
    for (const c of candidates) {
        // Replacement estimates, not lifetime operating expenditure (demand is energy/tick).
        c.energyCost = c.demand * 150;
        c.cpuCost = Math.ceil(c.demand / 18) * 0.2;
        c.spawnLoad = c.demand * 8 / 1500;
    }
    // Existing controller income demand remains alive even when other investments win.
    // Reserve it once so infrastructure cannot spend the same operating allowance.
    const controllerFloor = Math.min(budget, room.controller.level === 8 ? 15 : settings.techMaxWork,
        finite(growth.affordableWork));
    candidates.find(c => c.id === 'controller').demand = Math.max(0,
        candidates.find(c => c.id === 'controller').demand - controllerFloor);
    const allocations = allocate(candidates, budget - controllerFloor);
    let controller = allocations.find(a => a.id === 'controller');
    if (!controller && controllerFloor) {
        controller = { id: 'controller', demand: 0, allocated: 0, score: 0 };
        allocations.push(controller);
    }
    if (controller) { controller.allocated += controllerFloor; controller.demand += controllerFloor; }
    const amount = id => { const a = allocations.find(a => a.id === id); return a ? Math.floor(a.allocated * (a.capabilityPerEnergy || 1)) : 0; };
    const result = { tick: Game.time, ...stock, budget, settings, allocations,
        techWork: amount('controller'), artificerWork: amount('infrastructure'),
        remoteCarry: amount('remoteHauling'), expansionWork: amount('expansionSupport'),
        recoveryFunded: repairableRecovery,
        reason: reason || (repairableRecovery ? 'FUNDED_LOCAL_HAUL_PRESSURE_RELIEF' :
            stock.mode === 'DRAWDOWN' ? 'STOCKPILE_DRAWDOWN' : budget ? 'SUSTAINABLE_INCOME' : 'ENERGY_RESERVE') };
    memory.surplus = result;
    return result;
}
function requestBias(roomName, request) {
    const plan = (Memory.rooms[roomName] || {}).surplus;
    if (!plan || !plan.budget || Game.time - plan.tick > 10 || request.emergency) return 0;
    const category = require('HiveMind.Economy').categoryForRequest(request);
    const id = category === 'upgradeSurplus' ? 'controller' : /^remote/.test(category) ? 'remoteHauling' :
        ['construction', 'criticalInfrastructure'].includes(category) ? 'infrastructure' :
        category === 'special' ? 'seasonExpansion' : category === 'expansion' ? 'expansionSupport' : null;
    const investment = category === 'special' ? plan.allocations.find(a =>
        a.category === 'SPECIAL_STRATEGY' && a.allocated > 0) :
        plan.allocations.find(a => a.id === id && a.allocated > 0);
    return investment ? Math.min(5, Math.max(0, investment.score / 20)) : 0;
}
module.exports = { config, drawdown, score, allocate, plan, requestBias };
