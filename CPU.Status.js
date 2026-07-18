/*
 * CPU.Status.js
 *
 * Capacity is shard information that stays stable for a tick (limit, tick
 * limit, and bucket). Pressure is the work consumed so far and is sampled on
 * every getCpuStatus() call. Game.cpu.tickLimit is reported as an emergency
 * ceiling; Game.cpu.limit remains the sustainable allowance.
 */

var FALLBACK_CPU_LIMIT = 0.1;
var FULL_BUCKET = 10000;
var cachedTick = -1;
var cachedStatus = null;
var lastDebugSaveTick = -1;

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
        used: Math.round(status.used * 100) / 100,
        remaining: Math.round(status.remaining * 100) / 100
    };
    lastDebugSaveTick = status.tick;
}

function getCpuStatus() {
    var tick = typeof Game !== 'undefined' && typeof Game.time === 'number' ?
        Game.time : 0;

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
        cachedStatus.mode = chooseMode(
            cachedStatus.limit,
            cachedStatus.bucket,
            cachedStatus.usageRatio,
            cachedStatus.mode
        );

        /* Capacity fields remain unchanged; pressure may worsen during a tick. */
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

    var usageRatio = sustainableLimit > 0 ? used / sustainableLimit : 1;
    var previousMode = getPreviousMode();
    var mode = chooseMode(sustainableLimit, bucket, usageRatio, previousMode);

    cachedStatus = {
        limit: sustainableLimit,
        runtimeLimit: runtimeLimit,
        tickLimit: tickLimit,
        bucket: bucket,
        used: used,
        remaining: Math.max(0, sustainableLimit - used),
        usageRatio: usageRatio,
        currentUsageRatio: usageRatio,
        strategicUsed: used,
        strategicUsageRatio: usageRatio,
        bucketRatio: bucket / FULL_BUCKET,
        mode: mode,
        tick: tick
    };
    cachedTick = tick;
    saveDebug(cachedStatus, previousMode);

    return cachedStatus;
}

module.exports = {
    getCpuStatus: getCpuStatus,
    chooseMode: chooseMode
};
