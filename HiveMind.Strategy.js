const HiveMemory = require('HiveMind.Memory');
const Scheduler = require('HiveMind.Scheduler');
const Utility = require('HiveMind.Utility');
const Operations = require('HiveMind.Operations');
const Expansion = require('Logic.Expansion');
const Season11 = require('Logic.Season11');
const Season11Operations = require('Season11.Operations');
const CombatOperations = require('Combat.Operations');

function scoreOperations() {
    const settings = HiveMemory.getConfig('combat').strategy;
    const candidates = Object.values(HiveMemory.ensure().operations)
        .filter(operation => operation && operation.state !== 'COMPLETE' && operation.state !== 'ABORTED')
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .slice(0, settings.maxCandidates || 12);
    for (const operation of candidates) {
        const current = operation.utility && operation.utility.components || {};
        Operations.rescore(operation, {
            ...current,
            urgency: Math.max(current.urgency || 0, operation.priority || 0),
            travelTime: operation.targetRoom && operation.originRoom && Game.map ?
                Math.min(100, Game.map.getRoomLinearDistance(operation.originRoom, operation.targetRoom) * 5) : current.travelTime || 0
        });
    }
    return Utility.rank(candidates, operation => operation.utility.components);
}

function run() {
    const settings = HiveMemory.getConfig('combat').strategy;
    // Seasonal ownership/fuel safety is independent of optional strategy scheduling.
    const seasonDiagnostics = Season11.run();
    if (settings.enabled === false) return { enabled: false };
    const expansion = HiveMemory.ensure().expansion;
    const expansionActive = expansion && ['claiming', 'placeSpawn', 'buildSpawn', 'bootstrap'].includes(expansion.state);
    Scheduler.run('expansionStrategy', () => Expansion.run(), { interval: expansionActive ? 1 : 17 });
    Scheduler.run('season11Operations', () => {
        return Season11Operations.run(seasonDiagnostics);
    }, { interval: 1, emergency: !!(seasonDiagnostics.portfolioDashboard &&
        seasonDiagnostics.portfolioDashboard.reactors.some(entry => entry.claimThreat > 0)) });
    CombatOperations.run();
    Operations.syncExpansion();
    Scheduler.run('utilityScoring', () => scoreOperations(), { interval: settings.scoreInterval || 17 });
    const ranked = Utility.rank(Object.values(HiveMemory.ensure().operations)
        .filter(operation => operation && !['COMPLETE', 'ABORTED'].includes(operation.state)),
    operation => operation.utility && operation.utility.components || {}).map(entry => entry.candidate);
    Operations.run(ranked);
    return { enabled: true, operations: Object.keys(HiveMemory.ensure().operations).length };
}

module.exports = { run, scoreOperations };
