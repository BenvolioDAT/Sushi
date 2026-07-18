const travelUtility = require('utility.Travel.Creep');
const scoreSeason = require('Season.Score');
const cpuStatusUtility = require('CPU.Status');

const FULL_CPU_BUCKET = 10000;
const PIXEL_CHECK_INTERVAL = 10;
const PIXEL_FAILURE_LOG_INTERVAL = 1000;
let lastPixelFailureLogTick = -PIXEL_FAILURE_LOG_INTERVAL;

function maybeGeneratePixel() {
    if (!Game.cpu || typeof Game.cpu.generatePixel !== 'function') {
        return null;
    }
    if (Game.shard && Game.shard.name === 'sim') {
        return null;
    }
    if (Game.cpu.bucket !== FULL_CPU_BUCKET) {
        return null;
    }
    if (Game.time % PIXEL_CHECK_INTERVAL !== 0) {
        return null;
    }

    const result = Game.cpu.generatePixel();
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

function run() {
    travelUtility.cleanupRouteCaches();
    const cpuStatus = cpuStatusUtility.getCpuStatus();
    scoreSeason.maintain();
    maybeGeneratePixel();
    return cpuStatus;
}

module.exports = {
    run: run,
    maybeGeneratePixel: maybeGeneratePixel
};
