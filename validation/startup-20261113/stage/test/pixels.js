const assert = require('assert');
const mocks = require('./mock-screeps');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function fixture() {
    mocks.installGlobals(); mocks.clearLocalModules();
    let calls = 0, reads = 0, result = OK, used = 12;
    Game.cpu.bucket = 10000; Game.cpu.getUsed = () => used;
    Game.cpu.generatePixel = () => { calls++; return result; };
    const H = require('HiveMind.Memory'), settings = H.getConfig('pixels');
    settings.enabled = true; settings.tickModulo = 1;
    const getConfig = H.getConfig; H.getConfig = domain => { reads++; return getConfig(domain); };
    const room = { name: 'W39S47', controller: { my: true }, find: () => [] };
    Game.rooms[room.name] = room;
    Game.spawns.spawn = { name: 'spawn', room, my: true };
    const economy = { sampleTick: Game.time, state: 'STABLE', haul: { localCarry: 18, requiredCarry: 18 },
        harvest: { actualOrEstimatedIncome: 20, stationedWork: 10, workRequired: 10 } };
    require('HiveMind.Economy').get = () => economy;
    const bootstrap = require('Tick.Bootstrap');
    function step(n = 1) { Game.time += n; global.__sushiCpuRolling = { tick: Game.time - 1, total: 14, samples: 100 }; }
    step(20);
    return { bootstrap, settings, economy, step, calls: () => calls, reads: () => reads,
        used: n => used = n, result: n => result = n, H };
}
test('non-full bucket checks perform no config reads, CPU sampling or scans', () => {
    const f = fixture(); Game.cpu.bucket = 9999;
    Game.cpu.getUsed = () => { throw new Error('unnecessary CPU read'); };
    assert.strictEqual(f.bootstrap.maybeGeneratePixel(), null); assert.strictEqual(f.reads(), 0); assert.strictEqual(f.calls(), 0);
});
test('safe full bucket generates once and records bounded successful telemetry', () => {
    const f = fixture(); assert.strictEqual(f.bootstrap.maybeGeneratePixel(), OK);
    f.bootstrap.maybeGeneratePixel(); assert.strictEqual(f.calls(), 1);
    assert.strictEqual(Memory.hive.telemetry.pixels.generated, 1);
    assert.strictEqual(Memory.hive.telemetry.pixels.lastSuccess, Game.time);
});
test('disabled, simulation and unsupported runtimes never attempt pixels', () => {
    const f = fixture(); f.settings.enabled = false; f.bootstrap.maybeGeneratePixel();
    f.settings.enabled = true; Game.shard.name = 'sim'; f.bootstrap.maybeGeneratePixel();
    Game.shard.name = 'shard3'; delete Game.cpu.generatePixel; f.bootstrap.maybeGeneratePixel();
    assert.strictEqual(f.calls(), 0);
});
test('current and rolling CPU pressure preserve bucket capacity', () => {
    const f = fixture(); f.used(19); f.bootstrap.maybeGeneratePixel(); assert.strictEqual(f.calls(), 0);
    f.used(10); global.__sushiCpuRolling.total = 19; f.bootstrap.maybeGeneratePixel(); assert.strictEqual(f.calls(), 0);
});
test('reload warmup and stale CPU samples cannot consume the bucket', () => {
    const f = fixture(); Game.time -= 19; f.bootstrap.maybeGeneratePixel();
    assert.strictEqual(f.calls(), 0); f.step(19); global.__sushiCpuRolling.tick -= 2; f.bootstrap.maybeGeneratePixel(); assert.strictEqual(f.calls(), 0);
});
test('harvest, hauling, recovery and threat gaps defer optional generation', () => {
    for (const change of [f => f.economy.state = 'RECOVERY', f => f.economy.harvest.stationedWork = 7,
        f => f.economy.haul.localCarry = 17, f => f.H.ensure().threats.W39S47 = { harmfulHostileCount: 1 }]) {
        const f = fixture(); change(f); f.bootstrap.maybeGeneratePixel(); assert.strictEqual(f.calls(), 0);
        assert.strictEqual(f.bootstrap.getPixelStatus().state, 'DEFERRED_COLONY');
    }
});
test('failed pixel calls back off instead of retrying each full-bucket tick', () => {
    const f = fixture(); f.result(-6); f.bootstrap.maybeGeneratePixel();
    for (let i = 0; i < 99; i++) { f.step(); f.bootstrap.maybeGeneratePixel(); }
    assert.strictEqual(f.calls(), 1); f.step(); f.bootstrap.maybeGeneratePixel(); assert.strictEqual(f.calls(), 2);
});
test('cadence and explicit higher thresholds remain respected', () => {
    const f = fixture(); f.settings.tickModulo = 10; f.step(); f.bootstrap.maybeGeneratePixel(); assert.strictEqual(f.calls(), 0);
    f.settings.tickModulo = 1; f.settings.bucketThreshold = 10001; f.bootstrap.maybeGeneratePixel(); assert.strictEqual(f.calls(), 0);
});
console.log('Pixel scenarios passed: ' + passed);
