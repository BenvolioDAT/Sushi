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
    // Heap EMA uses every completed tick; occasional Memory persistence survives resets.
    const previous = global.__sushiCpuRolling || HiveMemory.ensure().telemetry.cpu || { samples: 0, phases: {} };
    const phases = {};
    for (const name of new Set([...Object.keys(previous.phases || {}), ...Object.keys(telemetry.phases)])) {
        phases[name] = (previous.phases[name] || 0) * 0.9 + (telemetry.phases[name] || 0) * 0.1;
    }
    global.__sushiCpuRolling = { tick: Game.time, samples: Math.min(1000, previous.samples + 1),
        total: previous.samples ? previous.total * 0.9 + telemetry.total * 0.1 : telemetry.total,
        phases, bucket: telemetry.bucket, mode: telemetry.mode };
    sampleControllerProgress();

    const settings = HiveMemory.getConfig('cpu').telemetry;
    const interval = Math.max(10, settings.persistInterval || 100);
    if (Game.time % interval === 0) HiveMemory.ensure().telemetry.cpu = global.__sushiCpuRolling;
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

function samplePopulation(samples) {
    const memory = HiveMemory.ensure().telemetry;
    const roles = memory.populationRoles || (memory.populationRoles = {});
    const rooms = memory.populationRooms || (memory.populationRooms = {});
    const update = (previous, value) => ({ cpu: previous ? previous.cpu * 0.8 + value.cpu * 0.2 : value.cpu,
        utilization: previous ? previous.utilization * 0.8 + value.utilization * 0.2 : value.utilization,
        samples: Math.min(1000, (previous && previous.samples || 0) + 1), tick: Game.time });
    const totals = {};
    for (const [roomName, byRole] of Object.entries(samples)) {
        if (!rooms[roomName]) rooms[roomName] = {};
        for (const [role, value] of Object.entries(byRole)) {
            rooms[roomName][role] = update(rooms[roomName][role], { cpu: value.cpu / value.count,
                utilization: value.active / value.count });
            const total = totals[role] || (totals[role] = { cpu: 0, active: 0, count: 0 });
            total.cpu += value.cpu; total.active += value.active; total.count += value.count;
        }
    }
    for (const [role, value] of Object.entries(totals)) roles[role] = update(roles[role], {
        cpu: value.cpu / value.count, utilization: value.active / value.count });
    for (const roomName of Object.keys(rooms)) {
        if (!Game.rooms[roomName] || !Game.rooms[roomName].controller || !Game.rooms[roomName].controller.my) delete rooms[roomName];
        else for (const role of Object.keys(rooms[roomName])) if (Game.time - rooms[roomName][role].tick > 1500) delete rooms[roomName][role];
    }
    for (const role of Object.keys(roles)) if (Game.time - roles[role].tick > 1500) delete roles[role];
}
module.exports = { startTick, measure, finish, getView, sampleControllerProgress, samplePopulation };
