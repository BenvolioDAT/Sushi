const travelUtility = require('utility.Travel.Creep');
const cpuStatusUtility = require('CPU.Status');
const TickIndex = require('HiveMind.Index');
const HiveMemory = require('HiveMind.Memory');
const DemandBoard = require('Spawn.DemandBoard');

const FULL_CPU_BUCKET = 10000;
const PIXEL_FAILURE_LOG_INTERVAL = 1000;
let lastPixelFailureLogTick = -PIXEL_FAILURE_LOG_INTERVAL;
let pixelStatus = null;
let lastPixelAttemptTick = -1;
const loadedAt = typeof Game !== 'undefined' ? Game.time : 0;

function ensureSettings() {
    const pixels = HiveMemory.getConfig('pixels');
    if (pixels.enabled === undefined) pixels.enabled = false;
    if (typeof pixels.bucketThreshold !== 'number') pixels.bucketThreshold = FULL_CPU_BUCKET;
    if (typeof pixels.tickModulo !== 'number' || pixels.tickModulo < 1) pixels.tickModulo = 10;
    pixels.bucketThreshold = Math.max(FULL_CPU_BUCKET, pixels.bucketThreshold);
    return { pixels };
}

function maybeGeneratePixel() {
    // The overwhelmingly common path is one cheap numeric check. No config,
    // Memory, index, CPU measurement or scans until the bucket is full.
    if (!Game.cpu || Game.cpu.bucket !== FULL_CPU_BUCKET) return null;
    if (typeof Game.cpu.generatePixel !== 'function' || Game.shard?.name === 'sim') return null;
    if (lastPixelAttemptTick === Game.time) return null;
    if (pixelStatus?.state === 'FAILED' && lastPixelAttemptTick <= Game.time && Game.time - lastPixelAttemptTick < 100) return null;
    const settings = ensureSettings().pixels;
    if (!settings.enabled) return null;
    if (settings.tickModulo > 1 && Game.time % settings.tickModulo !== 0) return null;
    if (settings.bucketThreshold > FULL_CPU_BUCKET) return null;

    const rolling = global.__sushiCpuRolling;
    const used = typeof Game.cpu.getUsed === 'function' ? Game.cpu.getUsed() : Infinity;
    if (Game.time - loadedAt < 20 || !rolling || rolling.tick !== Game.time - 1 ||
        rolling.total > Game.cpu.limit * 0.83 || used > Game.cpu.limit * 0.9) {
        pixelStatus = { tick: Game.time, state: 'DEFERRED_CPU', used, rolling: rolling?.total };
        return null;
    }
    for (const room of TickIndex.get().ownedSpawnRooms) {
        const economy = require('HiveMind.Economy').get(room.name);
        const threat = Memory.hive?.threats?.[room.name];
        if (!economy || !['STABLE', 'SURPLUS'].includes(economy.state) ||
            !(economy.haul && economy.haul.localCarry >= economy.haul.requiredCarry) ||
            !(economy.harvest?.actualOrEstimatedIncome > 0) ||
            !(economy.harvest?.stationedWork >= economy.harvest?.workRequired) ||
            threat?.harmfulHostileCount > 0) {
            pixelStatus = { tick: Game.time, state: 'DEFERRED_COLONY', room: room.name };
            return null;
        }
    }

    lastPixelAttemptTick = Game.time;
    const result = Game.cpu.generatePixel();
    pixelStatus = { tick: Game.time, result, state: result === OK ? 'GENERATED' : 'FAILED', used, rolling: rolling.total };
    const telemetry = HiveMemory.ensure().telemetry;
    const previous = telemetry.pixels || {};
    telemetry.pixels = { ...pixelStatus, generated: (previous.generated || 0) + (result === OK ? 1 : 0),
        lastSuccess: result === OK ? Game.time : previous.lastSuccess || null };
    if (
        typeof OK !== 'undefined' &&
        result !== OK &&
        Game.time - lastPixelFailureLogTick >= PIXEL_FAILURE_LOG_INTERVAL
    ) {
        console.log('Pixel generation failed with code:', result);
        lastPixelFailureLogTick = Game.time;
    }
    return result;
}

function getPixelStatus() {
    return pixelStatus;
}

function run() {
    HiveMemory.migrate();
    HiveMemory.installConsoleHelpers();
    DemandBoard.beginTick();
    travelUtility.cleanupRouteCaches();
    const cpuStatus = cpuStatusUtility.getCpuStatus();
    const index = TickIndex.build();
    HiveMemory.syncHomeRooms(index);
    return cpuStatus;
}

module.exports = { run, ensureSettings, maybeGeneratePixel, getPixelStatus };
