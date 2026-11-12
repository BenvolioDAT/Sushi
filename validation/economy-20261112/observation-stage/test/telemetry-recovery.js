const assert = require('assert');
const mocks = require('./mock-screeps');
let passed = 0;
function fixture(history) {
    mocks.installGlobals({ getUsed: () => 20 }); mocks.clearLocalModules();
    Game.rooms.home = { name: 'home', controller: { my: true, level: 2, progress: 100 } };
    const hive = require('HiveMind.Memory').ensure(); hive.telemetry.cpu = history;
    const telemetry = require('HiveMind.Telemetry');
    telemetry.measure('diagnostics', () => {});
    return { hive, telemetry };
}
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
test('legacy persisted CPU state cannot break finish, persistence or progress sampling', () => {
    const f = fixture({ used: 12.43, bucket: 10000, limit: 100 });
    f.telemetry.finish();
    assert.equal(global.__sushiCpuRolling.samples, 1);
    assert.equal(global.__sushiCpuRolling.total, 20);
    assert.equal(f.hive.telemetry.cpu.tick, Game.time);
    assert.equal(f.hive.telemetry.growth.home.progress, 100);
    Game.time++; Game.rooms.home.controller.progress += 5;
    f.telemetry.finish();
    assert.equal(f.hive.telemetry.growth.home.rollingRate, 5);
    assert.equal(global.__sushiCpuRolling.samples, 2);
});
test('valid completed-tick history retains smoothing and missing phases recover', () => {
    for (const phases of [undefined, { diagnostics: 10 }]) {
        const f = fixture({ tick: 99, samples: 10, total: 10, phases });
        f.telemetry.finish();
        assert.equal(global.__sushiCpuRolling.total, 11);
        assert.equal(global.__sushiCpuRolling.samples, 11);
        assert.equal(global.__sushiCpuRolling.phases.diagnostics, phases ? 9 : 0);
    }
});
test('malformed or future CPU history cannot poison the new rolling sample', () => {
    for (const history of [{}, { samples: 5 }, { tick: 101, samples: 5, total: 90 },
        { tick: 99, samples: NaN, total: 90, phases: { diagnostics: NaN } }]) {
        const f = fixture(history); f.telemetry.finish();
        assert.equal(global.__sushiCpuRolling.total, 20);
        assert.equal(global.__sushiCpuRolling.samples, 1);
        assert.ok(Object.values(global.__sushiCpuRolling.phases).every(Number.isFinite));
    }
});
console.log('Telemetry recovery scenarios passed: ' + passed);
