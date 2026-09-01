/* Stable capacity and live pressure for the current Screeps tick. */
const HiveMemory = require('HiveMind.Memory');
const FALLBACK_CPU_LIMIT = 1;
const FULL_BUCKET = 10000;
let cachedTick = -1;
let cachedCapacity = null;
let cachedStatus = null;
let lastDebugSaveTick = -1;
let overrideMigrationChecked = false;

function safeNumber(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

function getPreviousMode() {
    const status = typeof Memory !== 'undefined' && Memory.cpu && Memory.cpu.status;
    if (status && typeof status.mode === 'string') {
        return status.mode;
    }
    return 'normal';
}

function chooseMode(limit, bucket, usageRatio, previousMode) {
    const criticalNow = bucket < 1000 || usageRatio >= 0.95;
    const lowNow = bucket < 4000 || usageRatio >= 0.80;
    const highNow = limit >= 30 && bucket >= 7000 && usageRatio <= 0.65;

    if (previousMode === 'critical' && (bucket < 1800 || usageRatio >= 0.85)) return 'critical';
    if (criticalNow) return 'critical';
    if (previousMode === 'low' && (bucket < 5000 || usageRatio >= 0.70)) return 'low';
    if (lowNow) return 'low';
    if (previousMode === 'high' && limit >= 27 && bucket >= 6000 && usageRatio <= 0.75) return 'high';
    if (highNow) return 'high';
    return 'normal';
}

function removeStaleCpuOverride() {
    if (overrideMigrationChecked || typeof Memory === 'undefined') return;
    overrideMigrationChecked = true;
    const policy = HiveMemory.getConfig('cpu');
    if (policy.maxCpuOverride !== undefined) {
        delete policy.maxCpuOverride;
    }
}

function buildCapacity(tick) {
    const cpu = typeof Game !== 'undefined' && Game.cpu ? Game.cpu : {};
    const runtimeLimit = Math.max(0.1, safeNumber(cpu.limit, FALLBACK_CPU_LIMIT));
    const tickLimit = Math.max(runtimeLimit, safeNumber(cpu.tickLimit, runtimeLimit));
    const bucket = clamp(safeNumber(cpu.bucket, FULL_BUCKET), 0, FULL_BUCKET);
    return {
        tick,
        limit: runtimeLimit,
        runtimeLimit,
        tickLimit,
        bucket,
        bucketRatio: bucket / FULL_BUCKET
    };
}

function readUsed(fallback) {
    const cpu = typeof Game !== 'undefined' && Game.cpu ? Game.cpu : {};
    if (typeof cpu.getUsed !== 'function') return fallback;
    return Math.max(0, safeNumber(cpu.getUsed(), fallback));
}

function saveDebug(status, previousMode) {
    if (typeof Memory === 'undefined' || lastDebugSaveTick === status.tick) return;
    if (!Memory.cpu || typeof Memory.cpu !== 'object') Memory.cpu = {};
    const oldSince = Memory.cpu.status && Memory.cpu.status.modeSince;
    Memory.cpu.status = {
        tick: status.tick,
        mode: status.mode,
        modeSince: status.mode === previousMode && typeof oldSince === 'number' ? oldSince : status.tick,
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
    const tick = typeof Game !== 'undefined' && typeof Game.time === 'number' ? Game.time : 0;
    removeStaleCpuOverride();

    if (!cachedCapacity || cachedTick !== tick) {
        cachedTick = tick;
        cachedCapacity = buildCapacity(tick);
        const used = readUsed(0);
        const usageRatio = cachedCapacity.limit > 0 ? used / cachedCapacity.limit : 1;
        const previousMode = getPreviousMode();
        const mode = chooseMode(cachedCapacity.limit, cachedCapacity.bucket, usageRatio, previousMode);
        cachedStatus = {
            ...cachedCapacity,
            capacity: cachedCapacity,
            used,
            remaining: Math.max(0, cachedCapacity.limit - used),
            usageRatio,
            currentUsageRatio: usageRatio,
            strategicUsed: used,
            strategicUsageRatio: usageRatio,
            mode,
            pressure: { used, remaining: Math.max(0, cachedCapacity.limit - used), usageRatio, mode }
        };
        saveDebug(cachedStatus, previousMode);
        return cachedStatus;
    }

    const used = Math.max(cachedStatus.used, readUsed(cachedStatus.used));
    const usageRatio = cachedCapacity.limit > 0 ? used / cachedCapacity.limit : 1;
    const mode = chooseMode(cachedCapacity.limit, cachedCapacity.bucket, usageRatio, cachedStatus.mode);
    cachedStatus.used = used;
    cachedStatus.remaining = Math.max(0, cachedCapacity.limit - used);
    cachedStatus.usageRatio = usageRatio;
    cachedStatus.currentUsageRatio = usageRatio;
    cachedStatus.mode = mode;
    cachedStatus.pressure = { used, remaining: cachedStatus.remaining, usageRatio, mode };
    return cachedStatus;
}

module.exports = { getCpuStatus, chooseMode };
