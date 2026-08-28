const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mocks = require('./mock-screeps');

function rootJavaScriptFiles() {
    return fs.readdirSync(mocks.root)
        .filter(file => file.endsWith('.js') && !file.startsWith('test.'))
        .sort();
}

function testSyntax() {
    for (const file of rootJavaScriptFiles()) {
        const source = fs.readFileSync(path.join(mocks.root, file), 'utf8');
        assert.doesNotThrow(() => new vm.Script(source, { filename: file }), file);
    }
}

function testAllModulesLoad() {
    mocks.installGlobals();
    mocks.clearLocalModules();
    for (const file of rootJavaScriptFiles()) {
        assert.doesNotThrow(() => require(path.join(mocks.root, file)), file);
    }
}

function testMainSmoke() {
    mocks.installGlobals();
    mocks.clearLocalModules();
    const main = require(path.join(mocks.root, 'main.js'));
    assert.strictEqual(typeof main.loop, 'function');
    assert.doesNotThrow(() => main.loop());
}

function loadCpu(cpu) {
    mocks.installGlobals(cpu);
    mocks.clearLocalModules();
    return require(path.join(mocks.root, 'CPU.Status.js'));
}

function testCpuStatus() {
    for (const limit of [20, 100]) {
        let used = 1;
        const api = loadCpu({ limit, tickLimit: limit + 100, bucket: 10000, getUsed: () => used });
        let status = api.getCpuStatus();
        assert.strictEqual(status.limit, limit);
        assert.strictEqual(status.tickLimit, limit + 100);
        assert.strictEqual(status.remaining, limit - 1);
        assert.strictEqual(status.capacity.limit, limit);
        const firstBucket = status.bucket;
        const debugBefore = JSON.stringify(Memory.cpuStatus);
        Game.cpu.bucket = 0;
        used = limit * 0.97;
        status = api.getCpuStatus();
        assert.strictEqual(status.bucket, firstBucket, 'capacity changed during the tick');
        assert.strictEqual(status.mode, 'critical', 'pressure did not worsen later in the tick');
        assert.strictEqual(status.pressure.used, used);
        assert.strictEqual(JSON.stringify(Memory.cpuStatus), debugBefore, 'CPU debug Memory rewrote within a tick');
    }
}

function testBootstrapAndPixels() {
    let calls = 0;
    mocks.installGlobals({
        bucket: 9999,
        generatePixel: () => { calls++; return OK; }
    });
    Memory.settings.keepMe = true;
    mocks.clearLocalModules();
    const bootstrap = require(path.join(mocks.root, 'Tick.Bootstrap.js'));
    const settings = bootstrap.ensureSettings();
    assert.strictEqual(settings.keepMe, true, 'settings migration replaced existing Memory');
    assert.strictEqual(settings.pixels.enabled, false, 'pixels must default off');
    settings.pixels.enabled = true;
    settings.pixels.tickModulo = 1;
    assert.strictEqual(bootstrap.maybeGeneratePixel(), null);
    assert.strictEqual(calls, 0, 'pixel generated below a full bucket');
    Game.cpu.bucket = 10000;
    assert.strictEqual(bootstrap.maybeGeneratePixel(), OK);
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(bootstrap.getPixelStatus(), { tick: Game.time, result: OK });
}

function assertExports(file, expected) {
    const api = require(path.join(mocks.root, file));
    for (const name of expected) {
        assert.strictEqual(typeof api[name], 'function', `${file}.${name}`);
    }
}

function testExportCompatibility() {
    mocks.installGlobals();
    mocks.clearLocalModules();
    assertExports('CPU.Status.js', ['getCpuStatus', 'chooseMode']);
    assertExports('Planner.Brain.js', ['run', 'runRoom', 'planRoom', 'buildSites', 'resetRoom', 'packCoord', 'unpackCoord']);
    assertExports('Logic.Expansion.js', ['run', 'ensureExpansionMemory', 'chooseExpansionTarget', 'chooseSpawnSitePosition']);
    assertExports('Logic.Season11.js', ['run', 'plan', 'observeRoom', 'ensureMemory', 'isApiAvailable', 'rankMiningTargets', 'rankReactors', 'getDiagnostics']);
    assertExports('spawn.manager.js', ['getBodyCost', 'getSpawnQueue', 'countAliveRole', 'countQueuedRole', 'requestRoleCount', 'findIdleSpawn', 'runRoom']);
    assertExports('spawn.request.manager.js', ['run', 'runForRoom', 'runRoom', 'getOwnedSpawnRooms', 'requestRoleForRoom', 'requestTechWorkForRoom', 'getTechWorkDemand', 'getSourceMiningDemand', 'getFreighterCarryDemand', 'getDesiredTechWork', 'getCpuStatus', 'getReplacementLeadTicks', 'requestDynamicExtractorsForRoom', 'requestDynamicFreightersForRoom', 'requestRemoteExtractorsForRoom', 'requestAnnexForRoom', 'requestSeason11RolesForRoom']);
    assertExports('utility.Travel.Creep.js', ['move', 'moveToRoom', 'moveDirection', 'requestMove', 'cleanupRouteCaches']);
    assertExports('Tick.Bootstrap.js', ['run', 'ensureSettings', 'maybeGeneratePixel', 'getPixelStatus']);
    assertExports('Tick.Planning.js', ['refreshIntelAndThreats', 'runStrategy', 'generateSpawnRequests', 'runSpawning']);
    assertExports('Tick.Rooms.js', ['runStructures', 'drawSourceFlags', 'updateRepairStructureMemory']);
    assertExports('Tick.Finalize.js', ['resolveTraffic', 'runOptionalWork', 'cleanDeadCreepMemory', 'buildTrafficCostMatrix']);
    assertExports('HiveMind.Index.js', ['build', 'get', 'resetForTests', 'isCombatCapable']);
    assertExports('HiveMind.Scheduler.js', ['shouldRun', 'run', 'markDirty', 'getState']);
    assertExports('HiveMind.Telemetry.js', ['startTick', 'measure', 'finish', 'getView']);
    assertExports('traffic_manager.js', ['init', 'run', 'hasMovementIntents', 'getMovementIntents']);
    assertExports('HiveMind.Memory.js', ['ensure', 'migrate']);
    assertExports('Combat.Policy.js', ['getClassification', 'setClassification', 'recordIncident', 'shouldDefendAgainst', 'mayLaunchOffense']);
    assertExports('Combat.Math.js', ['analyzeBody', 'damageAfterTough', 'rangedMassDamage', 'towerDamage', 'incomingDamage', 'timeToKill']);
    assertExports('Combat.ThreatLedger.js', ['run', 'observeRoom', 'getRoomThreat', 'cleanup']);
    assertExports('Defense.Demand.js', ['getDemand']);
    assertExports('SafeMode.Policy.js', ['evaluate', 'run']);
    assertExports('Logic.Tower.js', ['run', 'chooseTowerTarget', 'evaluateTowerTarget', 'chooseDecision', 'getFortificationTarget']);
    assertExports('HiveMind.Utility.js', ['normalize', 'score', 'rank']);
    assertExports('HiveMind.Operations.js', ['create', 'get', 'transition', 'abort', 'rescore', 'syncExpansion', 'emitDemands', 'run']);
    assertExports('HiveMind.Strategy.js', ['run', 'scoreOperations']);
    assertExports('Spawn.DemandBoard.js', ['beginTick', 'emit', 'cancel', 'flush', 'getDemands', 'assignmentCount', 'chooseSpawnRoom']);
    assertExports('Squad.Tactics.js', ['selectTarget', 'chooseHealTarget', 'chooseAttackMode', 'evaluateDuo', 'chooseKitePositions']);
    assertExports('Squad.Controller.js', ['createDuo', 'get', 'transition', 'abort', 'plan', 'execute', 'runSquad', 'emitDemands']);
    assertExports('Resource.Minerals.js', ['observe', 'emitDemands', 'jobs', 'plan']);
    assertExports('Resource.Links.js', ['run', 'classify']);
    assertExports('Resource.Terminals.js', ['requestTransfer', 'planBalance', 'validate', 'run']);
    assertExports('Resource.Labs.js', ['configureReaction', 'clearReaction', 'requestBoost', 'identifyCluster', 'ingredientsFor', 'run']);
    assertExports('Resource.Observer.js', ['buildQueue', 'chooseTarget', 'run']);
    assertExports('Resource.Manager.js', ['plan', 'runRoom', 'runEmpireStructures', 'addJobs', 'getJobForCreep']);
}

function testRoleBodySpawnConsistency() {
    mocks.installGlobals();
    mocks.clearLocalModules();
    const dispatched = require(path.join(mocks.root, 'Tick.Creeps.js')).roles;
    const bodyConfig = require(path.join(mocks.root, 'role.creepBodyConfig.js'));
    const roles = [
        'Foreman', 'Extractor', 'Tech', 'Freighter', 'Annex', 'Artificer',
        'Pioneer', 'SupplyRunner', 'Scout', 'Ronin', 'Volley', 'Cleric',
        'ThoriumMiner', 'ThoriumHauler', 'ReactorClaimer',
        'MineralMiner', 'ResourceCourier'
    ];
    for (const role of roles) {
        assert(dispatched[role] && typeof dispatched[role].run === 'function', `missing dispatch for ${role}`);
        if (role === 'ThoriumHauler') {
            assert.strictEqual(typeof bodyConfig.getThoriumHaulerBodyForAvailableEnergy, 'function');
        }
        else if (role !== 'ThoriumMiner' && role !== 'ReactorClaimer') {
            assert.strictEqual(typeof bodyConfig[`get${role}Body`], 'function', `missing body configuration: ${role}`);
        }
    }
}

function testNoScoreRunner() {
    const source = rootJavaScriptFiles()
        .map(file => fs.readFileSync(path.join(mocks.root, file), 'utf8'))
        .join('\n');
    assert(!/ScoreRunner|Season\.Score|role\.scorerunner/i.test(source));
}

testSyntax();
testAllModulesLoad();
testMainSmoke();
testCpuStatus();
testBootstrapAndPixels();
testExportCompatibility();
testRoleBodySpawnConsistency();
testNoScoreRunner();
console.log(`PASS baseline: syntax (${rootJavaScriptFiles().length}), mocked loads, main smoke, exports, roles, CPU shapes, no ScoreRunner`);
