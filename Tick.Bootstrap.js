const travelUtility = require('utility.Travel.Creep');
const cpuStatusUtility = require('CPU.Status');
const Season11 = require('Logic.Season11');
const TickIndex = require('HiveMind.Index');

const FULL_CPU_BUCKET = 10000;
const PIXEL_FAILURE_LOG_INTERVAL = 1000;
let lastPixelFailureLogTick = -PIXEL_FAILURE_LOG_INTERVAL;
let pixelStatus = null;

function ensureSettings() {
    if (!Memory.settings) Memory.settings = {};
    if (!Memory.settings.pixels) {
        Memory.settings.pixels = {
            enabled: false,
            bucketThreshold: FULL_CPU_BUCKET,
            tickModulo: 10
        };
    }
    const pixels = Memory.settings.pixels;
    if (pixels.enabled === undefined) pixels.enabled = false;
    if (typeof pixels.bucketThreshold !== 'number') pixels.bucketThreshold = FULL_CPU_BUCKET;
    if (typeof pixels.tickModulo !== 'number' || pixels.tickModulo < 1) pixels.tickModulo = 10;
    pixels.bucketThreshold = Math.max(FULL_CPU_BUCKET, pixels.bucketThreshold);
    return Memory.settings;
}

function maybeGeneratePixel() {
    const settings = ensureSettings().pixels;
    if (!settings.enabled) return null;
    if (Season11.shouldSuppressPixelGeneration()) return null;
    if (!Game.cpu || typeof Game.cpu.generatePixel !== 'function') return null;
    if (Game.shard && Game.shard.name === 'sim') return null;
    if (Game.cpu.bucket !== FULL_CPU_BUCKET) return null;
    if (settings.tickModulo > 1 && Game.time % settings.tickModulo !== 0) return null;

    const result = Game.cpu.generatePixel();
    pixelStatus = { tick: Game.time, result };
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
    ensureSettings();
    travelUtility.cleanupRouteCaches();
    const cpuStatus = cpuStatusUtility.getCpuStatus();
    TickIndex.build();
    maybeGeneratePixel();
    return cpuStatus;
}

module.exports = { run, ensureSettings, maybeGeneratePixel, getPixelStatus };
