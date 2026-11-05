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

test('release public APIs include combat operations, quads, resources, and diagnostics', function() {
    reset();
    assertFunctions('Combat.Operations.js', ['evaluate', 'run', 'createManual', 'setManualTarget']);
    assertFunctions('Squad.Controller.js', ['createDuo', 'createQuad', 'abort', 'plan', 'execute']);
    assertFunctions('Squad.Quad.js', ['create', 'transition', 'buildFormationCostMatrix', 'runSquad']);
    assertFunctions('Squad.Tactics.js', ['evaluateDuo', 'evaluateQuad', 'chooseKitePositions']);
    assertFunctions('Resource.Manager.js', ['plan', 'runRoom', 'runEmpireStructures', 'getJobForCreep']);
});


test('Hive migrations are additive and emergency switches have safe defaults', function() {
    reset();
    Memory.hive = { schemaVersion: 1, customOperatorField: { keep: true }, settings: { independentCombat: false } };
    const hive = fresh('HiveMind.Memory.js').migrate();
    assert.strictEqual(Memory.meta.schemaVersion, 8);
    assert.deepStrictEqual(hive.customOperatorField, { keep: true });
    assert.strictEqual(Memory.config.combat.independentCombat, false, 'operator override was replaced');
    assert.strictEqual(Memory.config.combat.safeMode.manualConfirmation, true);
    assert.strictEqual(Memory.config.resources.market, false);
    assert.strictEqual(Memory.config.combat.squads.quadsEnabled, true);
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
    assert(source('spawn.request.manager.js').includes("getConfig('combat').independentCombat === false"));
});

test('production graph contains no retired seasonal modules', function() {
    assert.deepStrictEqual(productionSources().filter(item => /Season11|Thorium|Reactor/.test(item.file)), []);
});

test('the complete validation command includes every phase and structural audit', function() {
    const pkg = JSON.parse(source('package.json'));
    for (const command of [
        'test/run.js', 'test/phase2.js', 'test/phase3.js', 'test/phase4.js',
        'test/phase5.js', 'test/phase6.js', 'test/phase8.js',
        'test/phase9.js', 'test/module-graph.js', 'test/movement-audit.js', 'test/power-pipeline.js'
    ]) assert(pkg.scripts.validate.includes(command), `validate omits ${command}`);
});

test('operator runbook covers architecture, CPU review, deployment, and emergency controls', function() {
    const runbook = source('HIVEMIND.md');
    for (const heading of [
        'Tick order', 'HiveMind architecture', 'Operation schema', 'Utility scoring',
        'Spawn demand flow', 'Diplomacy and threat policy', 'Duo and quad squads',
        'Movement ownership', 'Minerals, labs, and boosts', 'Seasonal retirement',
        'CPU budget review', 'Debugging', 'Memory migrations', 'Deployment',
        'Emergency switches', 'Console cookbook'
    ]) assert(runbook.includes(`## ${heading}`), `runbook missing ${heading}`);
    for (const command of [
        'setClassification', 'createManual', "abort('", 'Sushi.debug.status()',
        'Sushi.debug.room(', 'getView()', 'independentCombat', 'pixels.enabled'
    ]) assert(runbook.includes(command), `runbook missing console example ${command}`);
});

console.log(`Phase 9 tests passed: ${passed}`);
