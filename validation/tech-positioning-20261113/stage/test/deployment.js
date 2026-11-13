const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Build = require('../tools/runtime-build');
const Deploy = require('../tools/deploy-runtime');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function fixture() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sushi-deploy-'));
    const source = path.join(base, 'source'), target = path.join(base, 'target'), output = path.join(base, 'release');
    fs.mkdirSync(source); fs.mkdirSync(target);
    fs.writeFileSync(path.join(source, 'main.js'), 'module.exports.loop = () => 2;\n');
    fs.writeFileSync(path.join(source, 'Added.js'), 'module.exports = 1;\n');
    fs.mkdirSync(path.join(source, 'test'));
    fs.writeFileSync(path.join(source, 'test', 'fixture.js'), 'not deployed');
    fs.writeFileSync(path.join(source, 'package.json'), '{}');
    fs.writeFileSync(path.join(target, 'main.js'), 'module.exports.loop = () => 1;\n');
    fs.writeFileSync(path.join(target, 'local-settings.json'), 'preserve me');
    Build.prepare(source);
    return { source, target, plan: Deploy.makePlan(source, target, output) };
}
test('runtime identity matches current source and is exposed on demand', () => {
    const build = Build.verify(Build.root);
    assert.deepStrictEqual(require('../Runtime.Build'), build);
    const mocks = require('./mock-screeps'); mocks.installGlobals(); mocks.clearLocalModules();
    require('Diagnostics').install(); assert.deepStrictEqual(Sushi.debug.build(), build);
});
test('deployment verifies every runtime byte and preserves settings and development files', () => {
    const f = fixture(), result = Deploy.apply(f.plan);
    assert.strictEqual(result.modules, 3);
    assert.deepStrictEqual(Build.inventory(f.target), Build.inventory(f.source));
    assert.strictEqual(fs.readFileSync(path.join(f.target, 'local-settings.json'), 'utf8'), 'preserve me');
    assert.ok(!fs.existsSync(path.join(f.target, 'test')));
    assert.ok(!fs.existsSync(path.join(f.target, 'package.json')));
    assert.strictEqual(fs.readFileSync(path.join(f.plan.backup, 'main.js'), 'utf8'), 'module.exports.loop = () => 1;\n');
});
test('source edits after validation refuse deployment before writes', () => {
    const f = fixture(), before = Build.inventory(f.target);
    fs.appendFileSync(path.join(f.source, 'main.js'), '// newer work\n');
    assert.throws(() => Deploy.apply(f.plan), /stale|Source changed/);
    assert.deepStrictEqual(Build.inventory(f.target), before);
});
test('newer target edits and unrelated runtime modules refuse deployment', () => {
    for (const file of ['main.js', 'Unrelated.js']) {
        const f = fixture(); fs.writeFileSync(path.join(f.target, file), 'newer unrelated work');
        const before = Build.inventory(f.target);
        assert.throws(() => Deploy.apply(f.plan), /Target changed/);
        assert.deepStrictEqual(Build.inventory(f.target), before);
    }
});
test('planning refuses a target-only module before making a backup or writing runtime', () => {
    const f = fixture(); fs.writeFileSync(path.join(f.target, 'Unrelated.js'), 'preserve this module');
    const before = Build.inventory(f.target);
    assert.throws(() => Deploy.makePlan(f.source, f.target, path.join(f.source, 'another-release')), /Unrelated runtime module/);
    assert.deepStrictEqual(Build.inventory(f.target), before);
});
test('a verified prior deployment can be recognized without relying on Git file history', () => {
    const f = fixture(), result = Deploy.apply(f.plan);
    const release = path.join(f.source, 'validation', 'deployments', 'previous');
    fs.mkdirSync(release, { recursive: true });
    fs.writeFileSync(path.join(release, 'plan.json'), JSON.stringify(f.plan));
    fs.writeFileSync(path.join(release, 'result.json'), JSON.stringify(result));
    assert.doesNotThrow(() => Deploy.checkKnownTarget(f.source, f.target));
});
test('damaged backups refuse deployment and restoration', () => {
    const f = fixture(), before = Build.inventory(f.target);
    fs.writeFileSync(path.join(f.plan.backup, 'main.js'), 'damaged');
    assert.throws(() => Deploy.apply(f.plan), /Backup changed/);
    assert.throws(() => Deploy.restore(f.plan), /Backup verification/);
    assert.deepStrictEqual(Build.inventory(f.target), before);
});
test('rollback restores prior runtime without deleting files or settings', () => {
    const f = fixture(); Deploy.apply(f.plan); Deploy.restore(f.plan);
    assert.strictEqual(fs.readFileSync(path.join(f.target, 'main.js'), 'utf8'), 'module.exports.loop = () => 1;\n');
    assert.ok(fs.existsSync(path.join(f.target, 'Added.js')));
    assert.strictEqual(fs.readFileSync(path.join(f.target, 'local-settings.json'), 'utf8'), 'preserve me');
});
test('a partial write failure restores the backed-up runtime automatically', () => {
    const f = fixture(); let writes = 0;
    assert.throws(() => Deploy.apply(f.plan, (file, bytes) => {
        if (++writes === 2) throw new Error('simulated disk failure');
        fs.writeFileSync(file, bytes);
    }), /prior runtime restored/);
    assert.strictEqual(fs.readFileSync(path.join(f.target, 'main.js'), 'utf8'), 'module.exports.loop = () => 1;\n');
    assert.strictEqual(fs.readFileSync(path.join(f.target, 'local-settings.json'), 'utf8'), 'preserve me');
});
test('line endings preserve build identity while byte verification detects drift', () => {
    const f = fixture(), before = Build.identity(f.source), file = path.join(f.source, 'main.js');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
    assert.deepStrictEqual(Build.identity(f.source), before);
    assert.throws(() => Deploy.apply(f.plan), /Source changed/);
});
console.log('Deployment scenarios passed: ' + passed);
