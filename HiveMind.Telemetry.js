const cpuStatus = require('CPU.Status');
const HiveMemory = require('HiveMind.Memory');
const Economy = require('HiveMind.Economy');

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
    telemetry.mode = cpuStatus.persistCurrent().mode;

    const settings = HiveMemory.getConfig('cpu').telemetry;
    const interval = Math.max(10, settings.persistInterval || 100);
    if (Game.time % interval === 0) persistRolling(telemetry);
    if (settings.debug === true) {
        console.log('Sushi CPU', JSON.stringify(getView()));
    }
    return telemetry;
}

function persistRolling(telemetry) {
    const telemetryMemory = HiveMemory.ensure().telemetry;
    const previous = telemetryMemory.cpu || { samples: 0, phases: {} };
    const samples = Math.min(1000, (previous.samples || 0) + 1);
    const alpha = Math.max(0.05, 1 / samples);
    const phases = { ...(previous.phases || {}) };
    for (const [name, value] of Object.entries(telemetry.phases)) {
        phases[name] = phases[name] === undefined ? value : phases[name] + ((value - phases[name]) * alpha);
    }
    telemetryMemory.cpu = {
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
    const growth = {};
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room || !room.controller || !room.controller.my) continue;
        const economy = Economy.get(roomName);
        const policy = economy && economy.growth;
        const roomMemory = Memory.rooms && Memory.rooms[roomName] || {};
        if (!policy) continue;
        growth[roomName] = {
            rcl: room.controller.level || 0,
            controllerProgress: room.controller.progress || 0,
            controllerProgressTotal: room.controller.progressTotal || 0,
            estimatedUpgradePerTick: policy.controllerBudget,
            livingTechWork: roomMemory.techLivingWork || 0,
            queuedTechWork: roomMemory.techQueuedWork || 0,
            desiredTechWork: roomMemory.techDesiredWork === undefined ? policy.affordableWork : roomMemory.techDesiredWork,
            localGrossIncome: policy.localGrossIncome,
            remoteGrossIncome: policy.remoteGrossIncome,
            estimatedNetIncome: policy.estimatedNetIncome,
            safeReserveTarget: policy.reserveTarget,
            storedEnergy: policy.storedEnergy,
            energyAboveReserve: policy.energyAboveReserve,
            activeRemoteSources: policy.remote.activeSources,
            candidateRemoteSources: policy.remote.candidateSources,
            reservedRemoteSources: policy.remote.reservedSources,
            unreservedActiveRemoteSources: policy.remote.unreservedSources,
            remoteBacklog: policy.remote.backlog,
            remoteReservedCarry: policy.remote.reservedCarry,
            remoteRequiredCarry: policy.remote.requiredCarry,
            remoteAvailableCarry: policy.remote.availableCarry,
            oldestRemoteHaulAge: policy.remote.oldestHaulAge,
            mode: policy.mode,
            blockedReason: policy.blockedReason
        };
    }
    return {
        tick: current.tick,
        phases: { ...current.phases },
        total: current.total,
        bucket: current.bucket,
        mode: current.mode,
        growth
    };
}

module.exports = { startTick, measure, finish, getView };
