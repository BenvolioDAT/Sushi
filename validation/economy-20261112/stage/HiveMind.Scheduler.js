const cpuStatus = require('CPU.Status');

function state() {
    const tick = typeof Game !== 'undefined' ? Game.time : -1;
    if (!global.__sushiScheduler || global.__sushiScheduler.tick !== tick) {
        const dirty = global.__sushiScheduler && global.__sushiScheduler.dirty;
        global.__sushiScheduler = { tick, dirty: dirty || new Set(), decisions: {} };
    }
    return global.__sushiScheduler;
}

function hash(value) {
    let result = 0;
    for (let i = 0; i < value.length; i++) result = ((result * 31) + value.charCodeAt(i)) >>> 0;
    return result;
}

function markDirty(taskName) {
    state().dirty.add(taskName);
}

function shouldRun(taskName, options = {}) {
    const current = state();
    const interval = Math.max(1, options.interval || 1);
    const emergency = options.emergency === true || options.activeCombat === true;
    const pressure = cpuStatus.getCpuStatus();
    const dirty = current.dirty.has(taskName);
    let reason = 'due';
    let run = true;

    if (pressure.mode === 'critical' && !emergency) {
        run = false;
        reason = 'critical CPU pressure';
    }
    else if (!emergency && global.__sushiCpuRolling && global.__sushiCpuRolling.total > pressure.limit * 0.83) {
        run = false;
        reason = 'rolling full-tick CPU pressure';
    }
    else if (!dirty && interval > 1 && (Game.time + hash(taskName)) % interval !== 0) {
        run = false;
        reason = 'staggered';
    }

    if (run) current.dirty.delete(taskName);
    current.decisions[taskName] = { run, reason, interval, tick: Game.time };
    return run;
}

function run(taskName, fn, options) {
    if (!shouldRun(taskName, options)) return { ran: false, value: undefined };
    return { ran: true, value: fn() };
}

function getState() {
    return state();
}

module.exports = { shouldRun, run, markDirty, getState };
