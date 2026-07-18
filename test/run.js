const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mocks = require('./mock-screeps');

function rootJavaScriptFiles() {
    return fs.readdirSync(mocks.root).filter(file => file.endsWith('.js')).sort();
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

function loadCpu(cpu) {
    mocks.installGlobals(cpu);
    mocks.clearLocalModules();
    return require(path.join(mocks.root, 'CPU.Status.js'));
}

function testCpuStatus() {
    let used = 1;
    let api = loadCpu({ limit: 20, tickLimit: 500, bucket: 10000, getUsed: () => used });
    let status = api.getCpuStatus();
    assert.strictEqual(status.limit, 20);
    assert.strictEqual(status.tickLimit, 500);
    assert.strictEqual(status.remaining, 19);

    used = 19.5;
    const debugBefore = JSON.stringify(Memory.cpuStatus);
    status = api.getCpuStatus();
    assert.strictEqual(status.used, 19.5);
    assert.strictEqual(status.remaining, 0.5);
    assert.strictEqual(status.mode, 'critical');
    assert.strictEqual(JSON.stringify(Memory.cpuStatus), debugBefore, 'debug Memory rewrote within one tick');

    used = 10;
    api = loadCpu({ limit: 100, tickLimit: 550, bucket: 10000, getUsed: () => used });
    status = api.getCpuStatus();
    assert.strictEqual(status.limit, 100);
    assert.strictEqual(status.mode, 'high');
    const stableBucket = status.bucket;
    Game.cpu.bucket = 0;
    used = 99;
    status = api.getCpuStatus();
    assert.strictEqual(status.bucket, stableBucket, 'capacity changed during the tick');
    assert.strictEqual(status.mode, 'critical');
    assert.strictEqual(status.usageRatio, 0.99);

    api = loadCpu({ limit: 100, tickLimit: 500, bucket: 500, getUsed: () => 1 });
    assert.strictEqual(api.getCpuStatus().mode, 'critical', 'bucket pressure ignored');
    api = loadCpu({ limit: 100, tickLimit: 120, bucket: 10000, getUsed: () => 1 });
    status = api.getCpuStatus();
    assert.strictEqual(status.tickLimit, 120);
    assert.strictEqual(status.remaining, 99, 'tickLimit replaced sustainable limit');
}

function testScoreShapes() {
    mocks.installGlobals();
    mocks.clearLocalModules();
    const api = require(path.join(mocks.root, 'Season.Score.js'));
    const direct = { id: 'a', pos: new RoomPosition(1, 2, 'W0N0') };
    const nested = { score: { id: 'b', pos: new RoomPosition(2, 3, 'W0N0') } };
    const looked = { [LOOK_SCORE]: { id: 'c', pos: new RoomPosition(3, 4, 'W0N0') } };
    assert.strictEqual(api.unwrapScoreEntry(direct), direct);
    assert.strictEqual(api.unwrapScoreEntry(nested), nested.score);
    assert.strictEqual(api.unwrapScoreEntry(looked), looked[LOOK_SCORE]);
    assert.strictEqual(api.unwrapScoreEntry({}), null);
}

function testPixelGeneration() {
    let calls = 0;
    mocks.installGlobals({
        bucket: 9999,
        generatePixel: () => { calls++; return OK; }
    });
    mocks.clearLocalModules();
    let api = require(path.join(mocks.root, 'Tick.Bootstrap.js'));
    assert.strictEqual(api.maybeGeneratePixel(), null);
    assert.strictEqual(calls, 0);

    Game.cpu.bucket = 10000;
    assert.strictEqual(api.maybeGeneratePixel(), OK);
    assert.strictEqual(calls, 1);
}

function testRoleCompatibility() {
    mocks.installGlobals();
    mocks.clearLocalModules();
    const dispatched = require(path.join(mocks.root, 'Tick.Creeps.js')).roles;
    const bodyConfig = require(path.join(mocks.root, 'role.creepBodyConfig.js'));
    const activeRoles = [
        'Foreman', 'Extractor', 'Tech', 'Freighter', 'Annex', 'Artificer',
        'Pioneer', 'SupplyRunner', 'Scout', 'Ronin', 'Volley', 'Cleric',
        'ScoreRunner'
    ];
    for (const role of activeRoles) {
        assert(dispatched[role] && typeof dispatched[role].run === 'function', `undispatched role: ${role}`);
        assert.strictEqual(typeof bodyConfig[`get${role}Body`], 'function', `missing body configuration: ${role}`);
    }
}

function assertExports(file, expected) {
    const api = require(path.join(mocks.root, file));
    for (const name of expected) assert.strictEqual(typeof api[name], 'function', `${file}.${name}`);
}

function testExportCompatibility() {
    mocks.installGlobals();
    mocks.clearLocalModules();
    assertExports('CPU.Status.js', ['getCpuStatus', 'chooseMode']);
    assertExports('Planner.Brain.js', ['run', 'runRoom', 'planRoom', 'buildSites', 'resetRoom', 'packCoord', 'unpackCoord']);
    assertExports('Season.Score.js', ['ensureSettings', 'isRuntimeSupported', 'isEnabled', 'maintain', 'reportVisibleRoom', 'getVisibleScores', 'getBestTarget', 'getTarget', 'claimTarget', 'releaseTarget', 'getVisibleThreat', 'markHostileRoom', 'isRoomUnsafe', 'getReachableTargetSummaryForRoom', 'getStats']);
    assertExports('spawn.request.manager.js', ['run', 'runForRoom', 'runRoom', 'getOwnedSpawnRooms', 'requestRoleForRoom', 'requestTechWorkForRoom', 'getTechWorkDemand', 'getArtificerBuildDemand', 'saveArtificerDemandDebug', 'requestDynamicArtificersForRoom', 'countHealthyCreeps', 'countLivingRoleBodyParts', 'countQueuedRoleBodyParts', 'countLivingRoleWork', 'countQueuedRoleWork', 'countBodyParts', 'getSourceMiningDemand', 'getFreighterCarryDemand', 'getDesiredTechWork', 'getCpuStatus', 'getDesiredScoreRunnerCount', 'getScoreRunnerDemand', 'requestScoreRunnersForRoom', 'getReplacementLeadTicks', 'requestDynamicExtractorsForRoom', 'requestDynamicFreightersForRoom', 'requestRemoteExtractorsForRoom', 'requestAnnexForRoom']);
}

testSyntax();
testAllModulesLoad();
testCpuStatus();
testScoreShapes();
testPixelGeneration();
testRoleCompatibility();
testExportCompatibility();
console.log(`PASS: syntax (${rootJavaScriptFiles().length} files), module loads, CPU, pixels, scores, roles, exports`);
