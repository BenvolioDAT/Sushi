/* Generic boundary between permanent Sushi systems and temporary strategy packages. */
const DEFAULT_CAPABILITIES = Object.freeze({ market: true, externalTerminalTransfers: true, portals: true });

function providers() {
    /* Keep package discovery here so permanent modules never import a season directly. */
    return [require('Season11.Strategy')];
}

function active() {
    return providers().filter(provider => {
        try { return provider && provider.isActive && provider.isActive(); }
        catch (error) { return false; }
    });
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
    getColonyObjectives, getSpecialSpawnPlans, getSurplusInvestments,
    getSpecialResourcePolicy, onExpansionOnline, diagnostics };
