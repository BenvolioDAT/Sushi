/* Compact policy math. No seasonal globals or live objects are retained here. */
const Utility = require('HiveMind.Utility');

function continuity(work, horizon = 1000) {
    work = Math.max(0, Math.floor(Number(work) || 0));
    const scoreRate = work > 0 ? 1 + Math.floor(Math.log10(work)) : 0;
    const nextScoreThreshold = Math.pow(10, Math.max(0, scoreRate));
    const ticksUntilNextScoreTier = nextScoreThreshold - work;
    const tierUrgency = work >= 10 ? Math.max(0, 1 - ticksUntilNextScoreTier /
        Math.max(1, nextScoreThreshold * 0.15)) * 30 : 0;
    const continuityValue = Utility.normalize(scoreRate * 12 + Math.log10(work + 1) * 6 + tierUrgency);
    // Integrate the logarithmic tiers over a bounded interruption horizon.
    function projected(start) {
        let left = Math.max(0, horizon), total = 0, at = Math.max(1, start);
        while (left > 0) {
            const rate = 1 + Math.floor(Math.log10(at));
            const ticks = Math.min(left, Math.max(1, Math.pow(10, rate) - at));
            total += rate * ticks; at += ticks; left -= ticks;
        }
        return total;
    }
    return { scoreRate, nextScoreThreshold, ticksUntilNextScoreTier, tierUrgency,
        continuityValue, potentialScoreLost: Math.max(0, projected(work) - projected(1)) };
}

function classifyThreat(creeps, reactor, isAlly = () => false) {
    let claimThreat = 0, combatThreat = 0, supportThreat = 0, claimTargetId = null;
    for (const creep of creeps || []) {
        if (!creep || isAlly(creep)) continue;
        const parts = type => typeof creep.getActiveBodyparts === 'function' ?
            creep.getActiveBodyparts(type) : (creep.body || []).filter(p => p.type === type && p.hits !== 0).length;
        const distance = creep.pos && reactor && reactor.pos ?
            Math.max(Math.abs(creep.pos.x - reactor.pos.x), Math.abs(creep.pos.y - reactor.pos.y)) : 25;
        const claims = parts('claim');
        claimThreat += claims * (distance <= 5 ? 60 : 35);
        if (claims && !claimTargetId) claimTargetId = creep.id || null;
        // Boosted parts are conservatively charged at their maximum multiplier.
        const boosted = (creep.body || []).some(p => p.boost && p.hits !== 0) ? 4 : 1;
        combatThreat += (parts('attack') * 3 + parts('ranged_attack') * 3 + parts('work')) * boosted;
        supportThreat += parts('heal') * 4 * boosted;
    }
    return { claimThreat, combatThreat, supportThreat,
        ownershipThreat: claimThreat + combatThreat + (claimThreat ? supportThreat * 2 : supportThreat), claimTargetId };
}

function startupReserve(pipeline, config) {
    const minimum = Math.max(config.reactorSafetyStock || 0,
        config.minimumStartupReserve == null ? config.startupReserve || 500 : config.minimumStartupReserve);
    const maximum = Math.max(minimum, config.maximumStartupReserve || 1000);
    const eta = Math.max(0, pipeline.deliveryEta || 0);
    const replacement = Math.max(0, pipeline.replacementDelay || 0);
    const jitter = Math.ceil((pipeline.roundTrip || eta * 2) *
        (0.1 + (1 - (pipeline.reliability == null ? 1 : pipeline.reliability))));
    const required = Math.ceil(eta + replacement + jitter + (config.reactorSafetyStock || 0) +
        (pipeline.defenseRisk || 0));
    return { reserve: Math.min(maximum, Math.max(minimum, required)), required,
        feasible: required <= maximum, minimum, maximum, eta, replacement, jitter };
}

function defense(context) {
    if (!context.owned) return 'NONE';
    const value = context.continuityValue || 0;
    if (context.claimThreat > 0 || context.combatThreat > 0 ||
        value >= 80 && (context.tierUrgency > 0 || context.previousLosses > 0 || context.routeThreat > 0)) {
        return context.healthy && context.combatReady ? 'HOLD' : 'WATCH';
    }
    if (value >= 65) return context.healthy && context.combatReady ? 'READY' : 'WATCH';
    if (value >= 45 || context.responseTicks > 150 || context.routeThreat > 0) return 'WATCH';
    return 'NONE';
}

function recapture(context) {
    const c = context;
    const utility = Utility.score({ urgency: c.tierUrgency || 0,
        expectedValue: Math.min(100, Math.log10(1 + Math.max(0, c.remaining || 0)) * 20),
        strategicValue: c.continuityValue || 0,
        energyCost: c.healthy ? 10 : 100, spawnCost: 15 + (c.spawnPressure || 0) * 60,
        travelTime: Math.min(100, (c.responseTicks || 0) / 10),
        risk: (c.enemyDefense || 0) * 3, opportunityCost: (c.failures || 0) * 20 });
    let reason = 'approved: score value exceeds cost';
    if (c.mode === 'disabled') reason = 'recapture disabled';
    else if (c.ally) reason = 'ally owns Reactor';
    else if (c.mode === 'manual' && !c.manual) reason = 'manual directive required';
    else if (!c.everMine && c.mode !== 'manual') reason = 'never previously ours';
    else if (!c.policyAllowed) reason = 'Combat.Policy refuses offense';
    else if (!c.fresh) reason = 'fresh target vision required';
    else if (c.cooldownUntil > c.tick) reason = 'claim failure cooldown';
    else if (c.failures >= 3) reason = 'repeated failures: hold off until failure window expires';
    else if (!c.healthy || c.spawnPressure >= 0.75) reason = 'home economy or spawn pressure';
    else if (!c.combatReady) reason = 'claimant and defense capability unavailable';
    else if (!c.viable || c.throughput < 1 || c.reserve < c.startupReserve) reason = 'pipeline or startup reserve insufficient';
    else if (c.remaining < Math.max(1500, c.startupReserve * 2)) reason = 'remaining finite supply too low';
    else if (c.enemyDefense > (c.maximumDefense || 12)) reason = 'enemy defense exceeds Season combat budget';
    else if (c.continuityValue < 45 || utility.total < 35) reason = 'recapture cost exceeds current score value';
    return { approved: reason.startsWith('approved:'), reason,
        recaptureValue: utility.components.expectedValue + utility.components.strategicValue,
        recaptureCost: utility.components.energyCost + utility.components.spawnCost + utility.components.travelTime +
            utility.components.risk + utility.components.opportunityCost,
        recaptureScore: utility.total, utility };
}

function sustainableCount(c) {
    return Math.max(0, Math.min(Math.floor(c.throughput || 0), c.opportunities || 0,
        c.healthyColonies || 0, c.spawnCapacity || 0, c.defenseCapacity || 0,
        c.cpuSafe ? c.maximum || 1 : 0, Math.floor((c.remaining || 0) / (c.horizon || 1500))));
}

function fuelOrder(a, b) {
    return (b.tierUrgency || 0) - (a.tierUrgency || 0) ||
        (b.scoreRate || 0) - (a.scoreRate || 0) ||
        (b.continuityValue || 0) - (a.continuityValue || 0) ||
        (a.deliveryEta || 0) - (b.deliveryEta || 0) || String(a.reactorId).localeCompare(String(b.reactorId));
}

function reserveFuel(ledger, stagingId, reactorId, available, requested) {
    const store = ledger[stagingId] || (ledger[stagingId] = { total: Math.max(0, available), reactors: {} });
    const used = Object.values(store.reactors).reduce((sum, n) => sum + n, 0);
    const granted = Math.max(0, Math.min(requested, store.total - used));
    store.reactors[reactorId] = (store.reactors[reactorId] || 0) + granted;
    return granted;
}

module.exports = { continuity, classifyThreat, startupReserve, defense, recapture,
    sustainableCount, fuelOrder, reserveFuel };
