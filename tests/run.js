/* Lightweight Node tests for pure or narrowly mocked Sushi logic. */

var path = require('path');

var passed = 0;
var failed = 0;

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(
            message + ': expected ' + expected + ', received ' + actual
        );
    }
}

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('PASS ' + name);
    }
    catch (error) {
        failed++;
        console.log('FAIL ' + name + ': ' + error.message);
    }
}

function loadFreshCpuStatus() {
    var modulePath = path.resolve(__dirname, '..', 'CPU.Status.js');
    delete require.cache[modulePath];
    return require(modulePath);
}

test('CPU mode thresholds and hysteresis', function() {
    var cpuStatus = loadFreshCpuStatus();

    assertEqual(cpuStatus.chooseMode(20, 900, 0.10, 'normal'), 'critical', 'low bucket');
    assertEqual(cpuStatus.chooseMode(20, 6000, 0.96, 'normal'), 'critical', 'high usage');
    assertEqual(cpuStatus.chooseMode(20, 4500, 0.50, 'low'), 'low', 'low hysteresis');
    assertEqual(cpuStatus.chooseMode(40, 8000, 0.40, 'normal'), 'high', 'healthy high CPU');
});

test('CPU strategy uses the previous finalized tick', function() {
    var used = 0.2;
    global.Memory = {
        cpuStatus: {
            tick: 100,
            mode: 'normal',
            modeSince: 90,
            limit: 20,
            used: 19.5,
            finalized: true
        }
    };
    global.Game = {
        time: 101,
        cpu: {
            limit: 20,
            tickLimit: 500,
            bucket: 6000,
            getUsed: function() {
                return used;
            }
        }
    };

    var cpuStatus = loadFreshCpuStatus();
    var status = cpuStatus.getCpuStatus();

    assertEqual(status.mode, 'critical', 'prior overuse enters critical');
    assertEqual(status.strategicUsed, 19.5, 'completed usage is strategic sample');
    assertEqual(status.used, 0.2, 'current usage remains current');
    assertEqual(Memory.cpuStatus.finalized, false, 'new tick begins unfinalized');

    used = 12;
    status = cpuStatus.getCpuStatus();
    assertEqual(status.mode, 'critical', 'mode remains stable during tick');
    assertEqual(status.used, 12, 'current usage refreshes during tick');

    cpuStatus.finalizeCpuStatus();
    assertEqual(Memory.cpuStatus.used, 12, 'final usage is persisted');
    assertEqual(Memory.cpuStatus.usageRatio, 0.6, 'final ratio is persisted');
    assertEqual(Memory.cpuStatus.finalized, true, 'completed tick is marked finalized');
});

test('unfinalized prior ticks are not trusted as completed usage', function() {
    global.Memory = {
        cpuStatus: {
            tick: 200,
            mode: 'normal',
            limit: 20,
            used: 19.9,
            finalized: false
        }
    };
    global.Game = {
        time: 201,
        cpu: {
            limit: 20,
            tickLimit: 500,
            bucket: 6000,
            getUsed: function() {
                return 0.1;
            }
        }
    };

    var status = loadFreshCpuStatus().getCpuStatus();
    assertEqual(status.mode, 'normal', 'partial prior tick is ignored');
    assertEqual(status.strategicUsed, 0.1, 'fallback uses current sample');
});

console.log('RESULT ' + passed + ' passed, ' + failed + ' failed');

if (failed > 0) {
    process.exitCode = 1;
}

