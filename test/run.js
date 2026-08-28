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

function testCpuStatusShape() {
    for (const limit of [20, 100]) {
        const api = loadCpu({ limit, tickLimit: limit + 100, bucket: 10000, getUsed: () => 1 });
        const status = api.getCpuStatus();
        assert.strictEqual(status.limit, limit);
        assert.strictEqual(status.tickLimit, limit + 100);
        assert.strictEqual(status.remaining, limit - 1);
        assert.strictEqual(typeof status.mode, 'string');
    }
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
}

function testRoleBodySpawnConsistency() {
    mocks.installGlobals();
    mocks.clearLocalModules();
    const source = fs.readFileSync(path.join(mocks.root, 'main.js'), 'utf8');
    const bodyConfig = require(path.join(mocks.root, 'role.creepBodyConfig.js'));
    const roles = [
        'Foreman', 'Extractor', 'Tech', 'Freighter', 'Annex', 'Artificer',
        'Pioneer', 'SupplyRunner', 'Scout', 'Ronin', 'Volley', 'Cleric',
        'ThoriumMiner', 'ThoriumHauler', 'ReactorClaimer'
    ];
    for (const role of roles) {
        assert(source.includes(`role.${role}`), `main missing module for ${role}`);
        assert(source.includes(`'${role}'`), `main missing dispatch for ${role}`);
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
testCpuStatusShape();
testExportCompatibility();
testRoleBodySpawnConsistency();
testNoScoreRunner();
console.log(`PASS baseline: syntax (${rootJavaScriptFiles().length}), mocked loads, main smoke, exports, roles, CPU shapes, no ScoreRunner`);
