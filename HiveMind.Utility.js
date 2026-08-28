const COMPONENTS = [
    'urgency', 'expectedValue', 'strategicValue',
    'energyCost', 'spawnCost', 'travelTime', 'risk', 'opportunityCost'
];

function normalize(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, value));
}

function score(input = {}) {
    const components = {};
    for (const name of COMPONENTS) components[name] = normalize(input[name]);
    const total = components.urgency + components.expectedValue + components.strategicValue -
        components.energyCost - components.spawnCost - components.travelTime -
        components.risk - components.opportunityCost;
    return { total: Math.round(total * 100) / 100, components };
}

function rank(candidates, getBreakdown = candidate => candidate.utility || {}) {
    return (candidates || []).map(candidate => ({ candidate, utility: score(getBreakdown(candidate)) }))
        .sort((a, b) => b.utility.total - a.utility.total || String(a.candidate.id).localeCompare(String(b.candidate.id)));
}

module.exports = { normalize, score, rank, COMPONENTS };
