/* Generic boundary between permanent Sushi systems and temporary strategy packages. */
const DEFAULT_CAPABILITIES = Object.freeze({ market: true, externalTerminalTransfers: true, portals: true });

function providers() {
    /* Keep package discovery here so permanent modules never import a season directly. */
    return [require('Season11.Strategy')];
}

function active() {
    const game = typeof Game !== 'undefined' ? Game : null;
    const tick = game ? game.time : -1;
    const signature = providers().map(p => p && p.id).join(',');
    const cached = global.__sushiStrategyActive;
    if (cached && cached.tick === tick && cached.signature === signature && cached.game === game) return cached.providers;
    const list = providers().filter(provider => {
        try { return provider && provider.isActive && provider.isActive(); }
        catch (error) { return false; }
    });
    global.__sushiStrategyActive = { tick, signature, game, providers: list };
    return list;
}

function callList(hook, ...args) {
    const result = [];
    for (const provider of active()) {
        if (typeof provider[hook] !== 'function') continue;
        const value = provider[hook](...args);
        if (Array.isArray(value)) result.push(...value.filter(Boolean));
        else if (value) result.push(value);
    }
    return result;
}

function capabilities() {
    const result = { ...DEFAULT_CAPABILITIES };
    for (const provider of active()) Object.assign(result,
        typeof provider.getCapabilities === 'function' ? provider.getCapabilities() || {} : {});
    return result;
}

function getExpansionNomination() {
    return callList('getExpansionNomination').sort((a, b) =>
        (b.score || b.yieldScore || 0) - (a.score || a.yieldScore || 0))[0] || null;
}

function getColonyObjectives(room) {
    return callList('getColonyObjectives', room).sort((a, b) => (b.priority || 0) - (a.priority || 0));
}

function getSpecialSpawnPlans(room) { return callList('getSpecialSpawnPlans', room); }
function validateDemand(demand) {
    if (!demand || !demand.strategyProvider) return true;
    const provider = active().find(item => item.id === demand.strategyProvider);
    return !!provider && (typeof provider.validateDemand !== 'function' || provider.validateDemand(demand));
}
function normalizeDemand(demand) {
    for (const provider of providers()) if (typeof provider.normalizeDemand === 'function') {
        demand = provider.normalizeDemand(demand) || demand;
    }
    return demand;
}
function getScoutModifier(context) {
    return callList('getScoutModifier', context).reduce((total, entry) => total +
        (typeof entry === 'number' ? entry : Number(entry.modifier) || 0), 0);
}
function observeRoom(room, homeRoom, viaScout) {
    for (const provider of active()) if (typeof provider.observeRoom === 'function') provider.observeRoom(room, homeRoom, viaScout);
}
function getScoutRadius(fallback) {
    return active().reduce((radius, provider) => typeof provider.getScoutRadius === 'function' ?
        Math.max(radius, provider.getScoutRadius(radius)) : radius, fallback);
}
function runScoutDirective(creep) {
    return active().some(provider => typeof provider.runScoutDirective === 'function' && provider.runScoutDirective(creep));
}
function getSurplusInvestments(room, economy, capacity) {
    return callList('getSurplusInvestments', room, economy, capacity);
}
function getSpecialResourcePolicy(resourceType) {
    return callList('getSpecialResourcePolicy', resourceType)[0] || null;
}
function onExpansionOnline(roomName, nomination) {
    for (const provider of active()) if (provider.id === nomination.provider && provider.onExpansionOnline) {
        provider.onExpansionOnline(roomName, nomination);
    }
}
function diagnostics() {
    const list = active();
    return { active: list.map(p => p.id), capabilities: capabilities(),
        providers: list.map(p => p.getDiagnostics ? p.getDiagnostics() : { id: p.id }) };
}

module.exports = { DEFAULT_CAPABILITIES, active, capabilities, getExpansionNomination,
    getColonyObjectives, getSpecialSpawnPlans, validateDemand, normalizeDemand, getScoutModifier,
    observeRoom, getScoutRadius, runScoutDirective, getSurplusInvestments,
    getSpecialResourcePolicy, onExpansionOnline, diagnostics };
