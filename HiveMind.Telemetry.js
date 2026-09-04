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
    sampleControllerProgress();

    const settings = HiveMemory.getConfig('cpu').telemetry;
    const interval = Math.max(10, settings.persistInterval || 100);
    if (Game.time % interval === 0) persistRolling(telemetry);
    if (settings.debug === true) {
        console.log('Sushi CPU', JSON.stringify(getView()));
    }
    return telemetry;
}

function sampleControllerProgress() {
    const telemetryMemory = HiveMemory.ensure().telemetry;
    if (!telemetryMemory.growth || typeof telemetryMemory.growth !== 'object') telemetryMemory.growth = {};
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room || !room.controller || !room.controller.my) continue;
        const controller = room.controller;
        const previous = telemetryMemory.growth[roomName];
        const current = {
            tick: Game.time,
            level: controller.level || 0,
            progress: controller.progress || 0,
            rollingRate: previous && previous.rollingRate || 0,
            samples: previous && previous.samples || 0
        };
        if (previous && previous.level === current.level && current.progress >= previous.progress) {
            const elapsed = Math.max(1, Game.time - previous.tick);
            const instantRate = (current.progress - previous.progress) / elapsed;
            const alpha = previous.samples < 10 ? 0.25 : 0.1;
            current.rollingRate = previous.samples > 0 ?
                previous.rollingRate + (instantRate - previous.rollingRate) * alpha : instantRate;
            current.samples = Math.min(1000, previous.samples + 1);
        }
        else if (previous && previous.level !== current.level) {
            /* A level-up resets progress; preserve the EMA instead of sampling a negative delta. */
            current.transitionAt = Game.time;
            current.samples = previous.samples;
        }
        current.rollingRate = Math.round(current.rollingRate * 100) / 100;
        telemetryMemory.growth[roomName] = current;
    }
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
        const growthMemory = HiveMemory.ensure().telemetry.growth || {};
        const progressTelemetry = growthMemory[roomName] || {};
        const actualRate = progressTelemetry.rollingRate || 0;
        const progressRemaining = Math.max(0,
            (room.controller.progressTotal || 0) - (room.controller.progress || 0));
        growth[roomName] = {
            rcl: room.controller.level || 0,
            controllerProgress: room.controller.progress || 0,
            controllerProgressTotal: room.controller.progressTotal || 0,
            estimatedUpgradePerTick: policy.controllerBudget,
            plannedUpgradePerTick: policy.controllerBudget,
            actualControllerProgressPerTick: actualRate,
            rollingUpgradeRate: actualRate,
            controllerUtilization: policy.controllerBudget > 0 ?
                Math.round(actualRate / policy.controllerBudget * 100) : 0,
            estimatedTicksToNextRcl: actualRate > 0 ? Math.ceil(progressRemaining / actualRate) : null,
            livingTechWork: roomMemory.techLivingWork || 0,
            queuedTechWork: roomMemory.techQueuedWork || 0,
            desiredTechWork: roomMemory.techDesiredWork === undefined ? policy.affordableWork : roomMemory.techDesiredWork,
            localGrossIncome: policy.localGrossIncome,
            remoteGrossIncome: policy.remoteGrossIncome,
            plannedRemoteIncome: policy.remote.plannedIncome,
            provenRemoteIncome: policy.remote.provenIncome,
            provenRemoteSources: policy.remote.provenSources,
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

module.exports = { startTick, measure, finish, getView, sampleControllerProgress };
