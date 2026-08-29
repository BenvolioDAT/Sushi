const HiveMemory = require('HiveMind.Memory');
const Scheduler = require('HiveMind.Scheduler');
const Utility = require('HiveMind.Utility');
const Operations = require('HiveMind.Operations');
const Expansion = require('Logic.Expansion');
const Season11 = require('Logic.Season11');
const Season11Operations = require('Season11.Operations');

function scoreOperations() {
    const settings = HiveMemory.ensure().settings.strategy;
    const candidates = Object.values(HiveMemory.ensure().operations)
        .filter(operation => operation && operation.state !== 'COMPLETE' && operation.state !== 'ABORTED')
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
    const settings = HiveMemory.ensure().settings.strategy;
    if (settings.enabled === false) return { enabled: false };
    const expansion = Memory.expansion;
    const expansionActive = expansion && ['claiming', 'placeSpawn', 'buildSpawn', 'bootstrap'].includes(expansion.state);
    Scheduler.run('expansionStrategy', () => Expansion.run(), { interval: expansionActive ? 1 : 17 });
    Scheduler.run('season11Operations', () => {
        const diagnostics = Season11.run();
        return Season11Operations.run(diagnostics);
    }, { interval: 1 });
    Operations.run();
    Scheduler.run('utilityScoring', () => scoreOperations(), { interval: settings.scoreInterval || 17 });
    return { enabled: true, operations: Object.keys(HiveMemory.ensure().operations).length };
}

module.exports = { run, scoreOperations };
