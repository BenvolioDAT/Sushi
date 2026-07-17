/*
 * CPU.Status.js
 *
 * Small shared view of the CPU that is sustainably available on this shard.
 * Game.cpu.tickLimit is deliberately reported but never used as the normal
 * allowance: it is only the emergency ceiling Screeps may permit this tick.
 */

var FALLBACK_CPU_LIMIT = 20;
var FULL_BUCKET = 10000;
var cachedTick = -1;
var cachedStatus = null;
var lastDebugSaveTick = -1;
var overrideMigrationChecked = false;

function safeNumber(value, fallback) {
    return typeof value === 'number' && isFinite(value) ? value : fallback;
}

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

function getPreviousMode() {
    if (
        typeof Memory !== 'undefined' &&
        Memory.cpuStatus &&
        typeof Memory.cpuStatus.mode === 'string'
    ) {
        return Memory.cpuStatus.mode;
    }

    return 'normal';
}

/*
 * main.js samples CPU near the start of a tick so every subsystem sees one
 * stable strategic mode. The current tick has barely used any CPU at that
 * point, so use the last completed tick as the usage signal. A finalized flag
 * prevents a tick that crashed before the end-of-tick sample from looking like
 * a healthy completed tick.
 */
function getPreviousCpuSample(tick, fallbackLimit, fallbackUsed) {
    var previous = typeof Memory !== 'undefined' ? Memory.cpuStatus : null;

    if (
        previous &&
        previous.finalized === true &&
        previous.tick === tick - 1 &&
        typeof previous.used === 'number' &&
        typeof previous.limit === 'number' &&
        previous.limit > 0
    ) {
        return {
            used: Math.max(0, previous.used),
            limit: previous.limit,
            usageRatio: Math.max(0, previous.used / previous.limit),
            tick: previous.tick
        };
    }

    return {
        used: fallbackUsed,
        limit: fallbackLimit,
        usageRatio: fallbackLimit > 0 ? fallbackUsed / fallbackLimit : 1,
        tick: tick
    };
}

/*
 * Mild hysteresis keeps mode changes meaningful. Each pressured mode needs a
 * healthier bucket/usage value to leave than it needed to enter, and high mode
 * similarly gets a small buffer before falling back to normal.
 */
function chooseMode(limit, bucket, usageRatio, previousMode) {
    var criticalNow = bucket < 1000 || usageRatio >= 0.95;
    var lowNow = bucket < 4000 || usageRatio >= 0.80;
    var highNow = limit >= 30 && bucket >= 7000 && usageRatio <= 0.65;

    if (previousMode === 'critical') {
        if (bucket < 1800 || usageRatio >= 0.85) {
            return 'critical';
        }
    }

    if (criticalNow) {
        return 'critical';
    }

    if (previousMode === 'low') {
        if (bucket < 5000 || usageRatio >= 0.70) {
            return 'low';
        }
    }

    if (lowNow) {
        return 'low';
    }

    if (previousMode === 'high') {
        if (limit >= 27 && bucket >= 6000 && usageRatio <= 0.75) {
            return 'high';
        }
    }

    if (highNow) {
        return 'high';
    }

    return 'normal';
}

function removeStaleCpuOverride() {
    if (overrideMigrationChecked || typeof Memory === 'undefined') {
        return;
    }

    overrideMigrationChecked = true;

    if (
        Memory.cpuPolicy &&
        Memory.cpuPolicy.maxCpuOverride !== undefined
    ) {
        delete Memory.cpuPolicy.maxCpuOverride;
    }
}

function saveDebug(status, previousMode) {
    if (
        typeof Memory === 'undefined' ||
        lastDebugSaveTick === status.tick
    ) {
        return;
    }

    var oldSince = Memory.cpuStatus && Memory.cpuStatus.modeSince;

    Memory.cpuStatus = {
        tick: typeof Game !== 'undefined' ? Game.time : 0,
        mode: status.mode,
        modeSince: status.mode === previousMode && typeof oldSince === 'number' ?
            oldSince : (typeof Game !== 'undefined' ? Game.time : 0),
        limit: status.limit,
        runtimeLimit: status.runtimeLimit,
        tickLimit: status.tickLimit,
        bucket: status.bucket,
        strategicUsed: Math.round(status.strategicUsed * 100) / 100,
        strategicUsageRatio: Math.round(status.strategicUsageRatio * 1000) / 1000,
        strategicSampleTick: status.strategicSampleTick,
        used: Math.round(status.used * 100) / 100,
        remaining: Math.round(status.remaining * 100) / 100,
        usageRatio: Math.round(status.currentUsageRatio * 1000) / 1000,
        finalized: false
    };
    lastDebugSaveTick = status.tick;
}

function getCpuStatus() {
    var tick = typeof Game !== 'undefined' && typeof Game.time === 'number' ?
        Game.time : 0;

    removeStaleCpuOverride();

    if (cachedStatus && cachedTick === tick) {
        var currentUsed = cachedStatus.used;
        if (
            typeof Game !== 'undefined' &&
            Game.cpu &&
            typeof Game.cpu.getUsed === 'function'
        ) {
            currentUsed = Math.max(0, safeNumber(Game.cpu.getUsed(), currentUsed));
        }
        cachedStatus.used = currentUsed;
        cachedStatus.remaining = Math.max(0, cachedStatus.limit - currentUsed);
        cachedStatus.usageRatio = cachedStatus.limit > 0 ?
            currentUsed / cachedStatus.limit : 1;
        cachedStatus.currentUsageRatio = cachedStatus.usageRatio;

        /*
         * Strategic mode is intentionally frozen at the first sample of the
         * tick. Later callers see fresh used/remaining values without making
         * strategy look progressively worse merely because more code ran.
         */
        return cachedStatus;
    }

    var cpu = typeof Game !== 'undefined' && Game.cpu ? Game.cpu : {};
    var runtimeLimit = Math.max(0.1, safeNumber(cpu.limit, FALLBACK_CPU_LIMIT));
    var sustainableLimit = runtimeLimit;
    var tickLimit = Math.max(
        sustainableLimit,
        safeNumber(cpu.tickLimit, sustainableLimit)
    );
    var bucket = clamp(safeNumber(cpu.bucket, FULL_BUCKET), 0, FULL_BUCKET);
    var used = 0;

    if (typeof cpu.getUsed === 'function') {
        used = Math.max(0, safeNumber(cpu.getUsed(), 0));
    }

    var previousSample = getPreviousCpuSample(
        tick,
        sustainableLimit,
        used
    );
    var usageRatio = previousSample.usageRatio;
    var previousMode = getPreviousMode();
    var mode = chooseMode(sustainableLimit, bucket, usageRatio, previousMode);

    cachedStatus = {
        limit: sustainableLimit,
        runtimeLimit: runtimeLimit,
        tickLimit: tickLimit,
        bucket: bucket,
        used: used,
        remaining: Math.max(0, sustainableLimit - used),
        usageRatio: sustainableLimit > 0 ? used / sustainableLimit : 1,
        currentUsageRatio: sustainableLimit > 0 ? used / sustainableLimit : 1,
        strategicUsed: previousSample.used,
        strategicUsageRatio: usageRatio,
        strategicSampleTick: previousSample.tick,
        bucketRatio: bucket / FULL_BUCKET,
        mode: mode,
        tick: tick
    };
    cachedTick = tick;
    saveDebug(cachedStatus, previousMode);

    return cachedStatus;
}

/*
 * Capture completed usage once, after normal tick work. This does not change
 * the already-frozen mode; it only provides the next tick with a trustworthy
 * sustainable-usage sample and keeps Memory.cpuStatus useful in the console.
 */
function finalizeCpuStatus() {
    var status = getCpuStatus();

    if (typeof Memory === 'undefined') {
        return status;
    }

    if (!Memory.cpuStatus || Memory.cpuStatus.tick !== status.tick) {
        saveDebug(status, getPreviousMode());
    }

    Memory.cpuStatus.used = Math.round(status.used * 100) / 100;
    Memory.cpuStatus.remaining = Math.round(status.remaining * 100) / 100;
    Memory.cpuStatus.usageRatio =
        Math.round(status.currentUsageRatio * 1000) / 1000;
    Memory.cpuStatus.finalized = true;

    return status;
}

module.exports = {
    getCpuStatus: getCpuStatus,
    finalizeCpuStatus: finalizeCpuStatus,
    chooseMode: chooseMode
};
