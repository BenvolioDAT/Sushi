/*
 * CPU.Profiler.js
 *
 * Opt-in major-system timing. Disabled calls only check one scalar setting.
 * Enabled samples stay in heap and are flushed as bounded ten-tick summaries,
 * avoiding a persistent Memory write for every measurement.
 */

var MAX_HISTORY = 60;
var FLUSH_INTERVAL = 10;
var samplesByCategory = {};
var lastFlushTick = null;

function ensureSettings() {
    if (!Memory.settings) {
        Memory.settings = {};
    }
    if (Memory.settings.enableCpuProfiling === undefined) {
        Memory.settings.enableCpuProfiling = false;
    }
    return Memory.settings;
}

function isEnabled() {
    return !!(
        typeof Memory !== 'undefined' &&
        Memory.settings &&
        Memory.settings.enableCpuProfiling === true
    );
}

function getCpuUsed() {
    if (
        typeof Game === 'undefined' ||
        !Game.cpu ||
        typeof Game.cpu.getUsed !== 'function'
    ) {
        return 0;
    }
    return Game.cpu.getUsed();
}

function start() {
    return isEnabled() ? getCpuUsed() : null;
}

function end(category, startValue) {
    if (startValue === null || startValue === undefined) {
        return 0;
    }
    var used = Math.max(0, getCpuUsed() - startValue);
    if (!samplesByCategory[category]) {
        samplesByCategory[category] = { total: 0, count: 0, maximum: 0 };
    }
    var sample = samplesByCategory[category];
    sample.total += used;
    sample.count++;
    sample.maximum = Math.max(sample.maximum, used);
    return used;
}

function ensureProfileMemory() {
    if (!Memory.cpuProfile || typeof Memory.cpuProfile !== 'object') {
        Memory.cpuProfile = { history: [] };
    }
    if (!Array.isArray(Memory.cpuProfile.history)) {
        Memory.cpuProfile.history = [];
    }
    return Memory.cpuProfile;
}

function flush() {
    if (!isEnabled() || typeof Game === 'undefined') {
        return false;
    }
    if (lastFlushTick !== null && Game.time - lastFlushTick < FLUSH_INTERVAL) {
        return false;
    }

    var categories = {};
    var hasSamples = false;
    for (var category in samplesByCategory) {
        if (!samplesByCategory.hasOwnProperty(category)) {
            continue;
        }
        var sample = samplesByCategory[category];
        if (!sample || sample.count <= 0) {
            continue;
        }
        hasSamples = true;
        categories[category] = {
            average: Math.round(sample.total / sample.count * 1000) / 1000,
            maximum: Math.round(sample.maximum * 1000) / 1000,
            count: sample.count
        };
    }

    lastFlushTick = Game.time;
    if (!hasSamples) {
        return false;
    }

    var profile = ensureProfileMemory();
    profile.history.push({ tick: Game.time, categories: categories });
    while (profile.history.length > MAX_HISTORY) {
        profile.history.shift();
    }
    samplesByCategory = {};
    return true;
}

function enable() {
    ensureSettings().enableCpuProfiling = true;
    return 'CPU profiling enabled';
}

function disable() {
    ensureSettings().enableCpuProfiling = false;
    return 'CPU profiling disabled';
}

function reset() {
    samplesByCategory = {};
    lastFlushTick = null;
    if (typeof Memory !== 'undefined') {
        delete Memory.cpuProfile;
    }
    return 'CPU profiling data reset';
}

function report() {
    var history = typeof Memory !== 'undefined' && Memory.cpuProfile &&
        Array.isArray(Memory.cpuProfile.history) ? Memory.cpuProfile.history : [];
    return {
        enabled: isEnabled(),
        buffered: samplesByCategory,
        history: history
    };
}

module.exports = {
    start: start,
    end: end,
    flush: flush,
    enable: enable,
    disable: disable,
    reset: reset,
    report: report,
    isEnabled: isEnabled
};
