const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mocks = require('./mock-screeps');

let passed = 0;

function test(name, fn) {
    fn();
    passed++;
    console.log(`PASS ${name}`);
}

function source(file) {
    return fs.readFileSync(path.join(mocks.root, file), 'utf8');
}

function productionSources() {
    return fs.readdirSync(mocks.root)
        .filter(file => file.endsWith('.js') && !file.startsWith('test.'))
        .map(file => ({ file, text: source(file) }));
}

function fresh(file) {
    const target = path.join(mocks.root, file);
    delete require.cache[require.resolve(target)];
    return require(target);
}

function reset() {
    mocks.installGlobals({ limit: 100, tickLimit: 500, bucket: 10000, getUsed: () => 0 });
    mocks.clearLocalModules();
}

function assertFunctions(file, names) {
    const api = fresh(file);
    for (const name of names) assert.strictEqual(typeof api[name], 'function', `${file}.${name}`);
}

test('release public APIs include combat operations, quads, resources, and Season 11 adapters', function() {
    reset();
    assertFunctions('Combat.Operations.js', ['evaluate', 'run', 'createManual', 'setManualTarget']);
    assertFunctions('Squad.Controller.js', ['createDuo', 'createQuad', 'abort', 'plan', 'execute']);
    assertFunctions('Squad.Quad.js', ['create', 'transition', 'buildFormationCostMatrix', 'runSquad']);
    assertFunctions('Squad.Tactics.js', ['evaluateDuo', 'evaluateQuad', 'chooseKitePositions']);
    assertFunctions('Resource.Manager.js', ['plan', 'runRoom', 'runEmpireStructures', 'getJobForCreep']);
    assertFunctions('Season11.Adapter.js', ['isAvailable', 'findReactors', 'claim', 'harvestThorium', 'snapshot']);
    assertFunctions('Season11.Operations.js', ['transition', 'utilityFor', 'agingMetrics', 'noteDelivery', 'getDashboard']);
});

test('Season 11 orchestration consumes the shared tick index instead of rescanning globals', function() {
    const text = source('Logic.Season11.js');
    assert(/require\(['"]HiveMind\.Index['"]\)/.test(text));
    assert(!/for\s*\([^)]*\bin\s+Game\.(?:creeps|spawns|rooms)\s*\)/.test(text));
    for (const field of ['allCreeps', 'ownedRooms', 'ownedSpawnRooms', 'visibleRooms', 'spawnRequests']) {
        assert(text.includes(field), `missing indexed field ${field}`);
    }
});

test('Hive migrations are additive and emergency switches have safe defaults', function() {
    reset();
    Memory.hive = { schemaVersion: 1, customOperatorField: { keep: true }, settings: { independentCombat: false } };
    const hive = fresh('HiveMind.Memory.js').migrate();
    assert.strictEqual(hive.schemaVersion, 7);
    assert.deepStrictEqual(hive.customOperatorField, { keep: true });
    assert.strictEqual(hive.settings.independentCombat, false, 'operator override was replaced');
    assert.strictEqual(hive.settings.safeMode.manualConfirmation, true);
    assert.strictEqual(hive.settings.resources.market, false);
    assert.strictEqual(hive.settings.squads.quadsEnabled, true);
});

test('durable operation and demand state remains JSON-safe plain data', function() {
    reset();
    const Operations = fresh('HiveMind.Operations.js');
    const DemandBoard = fresh('Spawn.DemandBoard.js');
    const operation = Operations.create('DEFEND_REMOTE', {
        id: 'phase9:plain-data', originRoom: 'W1N1', targetRoom: 'W2N2',
        desiredCapabilities: { ranged: 20, healing: 12 }
    });
    DemandBoard.emit({
        id: 'phase9:demand', operationId: operation.id, role: 'Volley', count: 1,
        originRoom: 'W1N1', targetRoom: 'W2N2'
    });
    const roundTrip = JSON.parse(JSON.stringify(Memory.hive));
    assert.strictEqual(roundTrip.operations[operation.id].targetRoom, 'W2N2');
    assert.strictEqual(roundTrip.demands['phase9:demand'].role, 'Volley');
});

test('CPU policy distinguishes 20 and 100 CPU capacity and preserves hysteresis thresholds', function() {
    reset();
    const CPU = fresh('CPU.Status.js');
    assert.strictEqual(CPU.chooseMode(20, 10000, 0.2, 'normal'), 'normal');
    assert.strictEqual(CPU.chooseMode(100, 8000, 0.2, 'normal'), 'high');
    assert.strictEqual(CPU.chooseMode(100, 900, 0.2, 'normal'), 'critical');
    assert.strictEqual(CPU.chooseMode(100, 4500, 0.75, 'low'), 'low');
});

test('hot subsystems declare cadence, dirty scheduling, and heap caches', function() {
    const planning = source('Tick.Planning.js');
    const scheduler = source('HiveMind.Scheduler.js');
    const resource = source('Resource.Manager.js');
    assert(planning.includes("interval: 5") && planning.includes("interval: 3"));
    assert(scheduler.includes('markDirty') && scheduler.includes('critical CPU pressure'));
    assert(resource.includes('mineralPlanTick') && resource.includes('courierDemandTick'));
    assert(source('HiveMind.Index.js').includes('global.__sushiTickIndex'));
    assert(source('HiveMind.Telemetry.js').includes('persistInterval'));
    assert(source('Squad.Quad.js').includes('global.__sushiQuadMatrices'));
    assert(source('spawn.request.manager.js').includes('settings.independentCombat === false'));
});

test('Season 11 production path contains no market, portal, or legacy scorer behavior', function() {
    const season = productionSources().filter(item => /Season11|Thorium|Reactor/.test(item.file));
    const combined = season.map(item => item.text).join('\n');
    assert(!/Game\.market|STRUCTURE_PORTAL|find.*portal/i.test(combined));
    assert(!/ScoreRunner|Season\.Score|role\.scorerunner/i.test(combined));
});

test('the complete validation command includes every phase and structural audit', function() {
    const pkg = JSON.parse(source('package.json'));
    for (const command of [
        'test/run.js', 'test/phase2.js', 'test/phase3.js', 'test/phase4.js',
        'test/phase5.js', 'test/phase6.js', 'test/phase7.js', 'test/phase8.js',
        'test/phase9.js', 'test/module-graph.js', 'test/movement-audit.js', 'test.Season11.js'
    ]) assert(pkg.scripts.validate.includes(command), `validate omits ${command}`);
});

test('operator runbook covers architecture, CPU review, deployment, and emergency controls', function() {
    const runbook = source('HIVEMIND.md');
    for (const heading of [
        'Tick order', 'HiveMind architecture', 'Operation schema', 'Utility scoring',
        'Spawn demand flow', 'Diplomacy and threat policy', 'Duo and quad squads',
        'Movement ownership', 'Minerals, labs, and boosts', 'Season 11 adapter',
        'CPU budget review', 'Debugging', 'Memory migrations', 'Deployment',
        'Emergency switches', 'Console cookbook'
    ]) assert(runbook.includes(`## ${heading}`), `runbook missing ${heading}`);
    for (const command of [
        'setClassification', 'createManual', "abort('", 'getDiagnostics()',
        'getDashboard()', 'getView()', 'independentCombat', 'pixels.enabled'
    ]) assert(runbook.includes(command), `runbook missing console example ${command}`);
});

console.log(`Phase 9 tests passed: ${passed}`);
