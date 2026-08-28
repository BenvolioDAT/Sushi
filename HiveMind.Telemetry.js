const cpuStatus = require('CPU.Status');

function getUsed() {
    return Game.cpu && typeof Game.cpu.getUsed === 'function' ? Game.cpu.getUsed() : 0;
}

function startTick() {
    if (global.__sushiTelemetry && global.__sushiTelemetry.tick === Game.time) {
        return global.__sushiTelemetry;
    }
    global.__sushiTelemetry = {
        tick: Game.time,
        start: getUsed(),
        phases: {},
        total: 0,
        bucket: Game.cpu && Game.cpu.bucket
    };
    return global.__sushiTelemetry;
}

function measure(name, fn) {
    const telemetry = startTick();
    const before = getUsed();
    const result = fn();
    const used = Math.max(0, getUsed() - before);
    telemetry.phases[name] = (telemetry.phases[name] || 0) + used;
    return result;
}

function finish() {
    const telemetry = startTick();
    telemetry.total = Math.max(0, getUsed() - telemetry.start);
    telemetry.bucket = Game.cpu && Game.cpu.bucket;
    telemetry.mode = cpuStatus.getCpuStatus().mode;

    if (!Memory.settings) Memory.settings = {};
    if (!Memory.settings.cpuTelemetry) {
        Memory.settings.cpuTelemetry = { persistInterval: 100, debug: false };
    }
    const interval = Math.max(10, Memory.settings.cpuTelemetry.persistInterval || 100);
    if (Game.time % interval === 0) persistRolling(telemetry);
    if (Memory.settings.cpuTelemetry.debug === true) {
        console.log('Sushi CPU', JSON.stringify(getView()));
    }
    return telemetry;
}

function persistRolling(telemetry) {
    if (!Memory.stats) Memory.stats = {};
    const previous = Memory.stats.cpu || { samples: 0, phases: {} };
    const samples = Math.min(1000, (previous.samples || 0) + 1);
    const alpha = Math.max(0.05, 1 / samples);
    const phases = { ...(previous.phases || {}) };
    for (const [name, value] of Object.entries(telemetry.phases)) {
        phases[name] = phases[name] === undefined ? value : phases[name] + ((value - phases[name]) * alpha);
    }
    Memory.stats.cpu = {
        tick: telemetry.tick,
        samples,
        total: previous.total === undefined ? telemetry.total : previous.total + ((telemetry.total - previous.total) * alpha),
        bucket: telemetry.bucket,
        mode: telemetry.mode,
        phases
    };
}

function getView() {
    const current = startTick();
    return {
        tick: current.tick,
        phases: { ...current.phases },
        total: current.total,
        bucket: current.bucket,
        mode: current.mode
    };
}

module.exports = { startTick, measure, finish, getView };
