const HiveMemory = require('HiveMind.Memory');
const TickIndex = require('HiveMind.Index');

const STATES = Object.freeze({
    SURVIVAL: 'SURVIVAL',
    RECOVERY: 'RECOVERY',
    STABLE: 'STABLE',
    SURPLUS: 'SURPLUS'
});

const STATE_RANK = Object.freeze({ SURVIVAL: 0, RECOVERY: 1, STABLE: 2, SURPLUS: 3 });
const EXIT_TICKS = Object.freeze({ SURVIVAL: 12, RECOVERY: 40, STABLE: 100 });
const CORE_ROLES = new Set(['Extractor', 'Freighter', 'Foreman']);
const COMBAT_ROLES = new Set(['Ronin', 'Volley', 'Cleric']);

function energyIn(target) {
    if (!target || !target.store) return 0;
    if (typeof target.store.getUsedCapacity === 'function') {
        return target.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    }
    return target.store[RESOURCE_ENERGY] || 0;
}

function activeParts(creep, type) {
    if (!creep) return 0;
    if (typeof creep.getActiveBodyparts === 'function') return creep.getActiveBodyparts(type) || 0;
    return (creep.body || []).filter(part => part && part.type === type && part.hits !== 0).length;
}

function bodyParts(body, type) {
    return (body || []).reduce((total, part) => total +
        ((part === type || part && part.type === type) ? 1 : 0), 0);
}

function isLocalExtractor(creep, roomName) {
    const memory = creep && creep.memory || {};
    if (memory.role !== 'Extractor' || memory.homeRoom && memory.homeRoom !== roomName) return false;
    if (memory.remoteMining === true) return false;
    if (memory.sourceRoom && memory.sourceRoom !== roomName) return false;
    return !memory.targetRoom || memory.targetRoom === roomName;
}

function sourceIdFor(memory) {
    return memory && (memory.sourceId || memory.targetSourceId || memory.assignedSource) || null;
}

function replacementLead(creep, distance) {
    return (creep && creep.body ? creep.body.length * 3 : 0) + Math.max(15, distance || 0) + 10;
}

function getDistance(room, source, dropoff) {
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
    const roomMemory = Memory.rooms[room.name];
    if (!roomMemory.economyDistanceCache) roomMemory.economyDistanceCache = {};
    const targetId = dropoff && dropoff.id || 'center';
    const key = source.id + ':' + targetId;
    const cached = roomMemory.economyDistanceCache[key];
    if (cached && cached.version === 1 && cached.distance > 0) return cached.distance;
    let distance = dropoff && source.pos && dropoff.pos && typeof source.pos.getRangeTo === 'function' ?
        Math.max(1, source.pos.getRangeTo(dropoff.pos)) : 25;
    if (dropoff && source.pos && dropoff.pos && typeof room.findPath === 'function') {
        try {
            const route = room.findPath(source.pos, dropoff.pos, {
                ignoreCreeps: true, range: 1, maxOps: 2000, serialize: false
            });
            if (route && route.length > 0) distance = route.length;
        }
        catch (error) {
            /* Range distance remains a safe low-CPU fallback for unusual mocks/shards. */
        }
    }
    roomMemory.economyDistanceCache[key] = { version: 1, distance, tick: Game.time };
    return distance;
}

function sourceBacklog(source) {
    if (!source || !source.pos || typeof source.pos.findInRange !== 'function') return 0;
    const structures = source.pos.findInRange(FIND_STRUCTURES, 2, {
        filter: structure => structure.structureType === STRUCTURE_CONTAINER && energyIn(structure) > 0
    }) || [];
    const drops = source.pos.findInRange(FIND_DROPPED_RESOURCES, 3, {
        filter: resource => resource.resourceType === RESOURCE_ENERGY && resource.amount > 0
    }) || [];
    return structures.reduce((sum, structure) => sum + energyIn(structure), 0) +
        drops.reduce((sum, resource) => sum + (resource.amount || 0), 0);
}

function pendingLocalParts(roomName, role, partType) {
    const roomMemory = Memory.rooms && Memory.rooms[roomName];
    const queue = roomMemory && roomMemory.spawnQueue || [];
    let total = 0;
    for (const request of queue) {
        const memory = request && request.memory || {};
        if (!request || (request.role || memory.role) !== role) continue;
        if (memory.homeRoom && memory.homeRoom !== roomName) continue;
        if (role === 'Extractor' && (memory.remoteMining ||
            memory.sourceRoom && memory.sourceRoom !== roomName ||
            memory.targetRoom && memory.targetRoom !== roomName)) continue;
        total += bodyParts(request.body, partType);
    }
    return total;
}

function buildSnapshot(room, previous) {
    const index = TickIndex.get();
    const creeps = index.creepsByHomeRoom.get(room.name) || [];
    const sources = typeof room.find === 'function' ? room.find(FIND_SOURCES) || [] : [];
    const spawns = index.ownedSpawnsByRoom.get(room.name) || [];
    const dropoff = room.storage || spawns[0] || null;
    const sourceRows = [];
    let workRequired = 0;
    let workActive = 0;
    let incomeExpected = 0;
    let incomeEstimated = 0;
    let backlog = 0;
    let replacementRisk = 0;

    for (const source of sources) {
        const capacity = source.energyCapacity || 3000;
        const regeneration = typeof ENERGY_REGEN_TIME !== 'undefined' ? ENERGY_REGEN_TIME : 300;
        const harvestPower = typeof HARVEST_POWER !== 'undefined' ? HARVEST_POWER : 2;
        const required = Math.max(1, Math.ceil((capacity / regeneration) / harvestPower));
        const assigned = creeps.filter(creep => isLocalExtractor(creep, room.name) &&
            sourceIdFor(creep.memory) === source.id);
        const activeWork = assigned.reduce((sum, creep) => sum + activeParts(creep, WORK), 0);
        const distance = getDistance(room, source, dropoff);
        const stationedWork = assigned.reduce((sum, creep) => {
            if (!creep.pos || creep.pos.roomName !== room.name ||
                typeof creep.pos.getRangeTo !== 'function' || creep.pos.getRangeTo(source.pos) > 1) return sum;
            return sum + activeParts(creep, WORK);
        }, 0);
        const sourceIncome = capacity / regeneration;
        const estimated = Math.min(sourceIncome, stationedWork * harvestPower);
        const sourceRisk = assigned.some(creep => creep.ticksToLive !== undefined &&
            creep.ticksToLive <= replacementLead(creep, distance));
        const rowBacklog = sourceBacklog(source);
        workRequired += required;
        workActive += activeWork;
        incomeExpected += sourceIncome;
        incomeEstimated += estimated;
        backlog += rowBacklog;
        if (sourceRisk || assigned.length === 0) replacementRisk++;
        sourceRows.push({
            id: source.id,
            energy: source.energy || 0,
            capacity,
            regeneration,
            distance,
            assigned: assigned.length,
            workRequired: required,
            workActive: activeWork,
            expectedIncome: Math.round(sourceIncome * 100) / 100,
            estimatedIncome: Math.round(estimated * 100) / 100,
            backlog: rowBacklog,
            replacementRisk: sourceRisk
        });
    }

    /* Unassigned local Extractors still matter during the few ticks before they claim a source. */
    const localExtractors = creeps.filter(creep => isLocalExtractor(creep, room.name));
    const unassignedWork = localExtractors.filter(creep => !sourceIdFor(creep.memory))
        .reduce((sum, creep) => sum + activeParts(creep, WORK), 0);
    workActive += unassignedWork;

    const freighters = creeps.filter(creep => creep && creep.memory && creep.memory.role === 'Freighter' &&
        (!creep.memory.homeRoom || creep.memory.homeRoom === room.name));
    const healthyFreighters = freighters.filter(creep => creep.ticksToLive === undefined ||
        creep.ticksToLive > replacementLead(creep, 25));
    const activeCarry = healthyFreighters.reduce((sum, creep) => sum + activeParts(creep, CARRY), 0);
    const remoteCarry = healthyFreighters.filter(creep => creep.memory.freighterJob === 'remote' ||
        creep.memory.freighterJob === 'remoteDelivery')
        .reduce((sum, creep) => sum + activeParts(creep, CARRY), 0);
    const localCarry = Math.max(0, activeCarry - remoteCarry);
    const requiredCarry = Math.max(sources.length ? 2 : 0, Math.ceil(sourceRows.reduce((sum, source) =>
        sum + source.expectedIncome * Math.max(2, source.distance * 2 + 4) / 50, 0) * 1.15));
    for (const creep of freighters) {
        if (creep.ticksToLive !== undefined && creep.ticksToLive <= replacementLead(creep, 25)) {
            replacementRisk++;
        }
    }

    const storageEnergy = energyIn(room.storage);
    const terminalEnergy = energyIn(room.terminal);
    const energyAvailable = room.energyAvailable || 0;
    const energyCapacity = Math.max(1, room.energyCapacityAvailable || 300);
    const liquidEnergy = energyAvailable + storageEnergy + terminalEnergy + backlog;
    const previousTick = previous && previous.sampleTick;
    const elapsed = previousTick === undefined ? 0 : Math.max(1, Game.time - previousTick);
    const immediateTrend = previous && typeof previous.liquidEnergy === 'number' ?
        (liquidEnergy - previous.liquidEnergy) / elapsed : 0;
    const oldTrend = previous && typeof previous.energyTrend === 'number' ? previous.energyTrend : immediateTrend;
    const energyTrend = Math.round((oldTrend * 0.8 + immediateTrend * 0.2) * 100) / 100;
    const remoteCommitments = creeps.filter(creep => creep && creep.memory &&
        (creep.memory.remoteMining === true || creep.memory.freighterJob === 'remote' ||
            creep.memory.freighterJob === 'remoteDelivery' ||
            creep.memory.remoteWorkTargetId)).length;
    const queue = Memory.rooms && Memory.rooms[room.name] && Memory.rooms[room.name].spawnQueue || [];
    const busySpawns = spawns.filter(spawn => spawn && spawn.spawning).length;

    return {
        roomName: room.name,
        sampleTick: Game.time,
        state: previous && previous.state || STATES.RECOVERY,
        stateSince: previous && previous.stateSince || Game.time,
        stateChangedAt: previous && previous.stateChangedAt || Game.time,
        healthyTicks: previous && previous.healthyTicks || 0,
        reason: previous && previous.reason || 'initial economy sample',
        spawnFill: Math.round(energyAvailable / energyCapacity * 1000) / 1000,
        energyAvailable,
        energyCapacity,
        storageEnergy,
        terminalEnergy,
        liquidEnergy,
        energyTrend,
        harvest: {
            expectedIncome: Math.round(incomeExpected * 100) / 100,
            actualOrEstimatedIncome: Math.round(incomeEstimated * 100) / 100,
            workRequired,
            workActive,
            workQueued: pendingLocalParts(room.name, 'Extractor', WORK),
            sources: sourceRows
        },
        haul: {
            requiredCarry,
            activeCarry,
            localCarry,
            queuedCarry: pendingLocalParts(room.name, 'Freighter', CARRY),
            remoteCarry,
            backlog
        },
        replacementRisk,
        remoteCommitments,
        spawnPressure: { queued: queue.length, busy: busySpawns }
    };
}

function rawState(snapshot) {
    const harvest = snapshot.harvest;
    const haul = snapshot.haul;
    const harvestRatio = harvest.workRequired > 0 ? harvest.workActive / harvest.workRequired : 1;
    const incomeRatio = harvest.expectedIncome > 0 ?
        harvest.actualOrEstimatedIncome / harvest.expectedIncome : 1;
    const haulRatio = haul.requiredCarry > 0 ? haul.localCarry / haul.requiredCarry : 1;
    const reserves = snapshot.storageEnergy + snapshot.terminalEnergy;
    const functionalMining = harvest.workActive > 0;

    if (!functionalMining) return { state: STATES.SURVIVAL, reason: 'zero functional local source miners' };
    if (snapshot.spawnFill < 0.15 && reserves < 500 && incomeRatio < 0.45) {
        return { state: STATES.SURVIVAL, reason: 'spawn energy critically low and harvest income below replacement level' };
    }
    if (harvestRatio < 0.9 || incomeRatio < 0.65) {
        return { state: STATES.RECOVERY, reason: 'harvesting below sustainable local demand' };
    }
    if (haulRatio < 0.85 || haul.backlog > Math.max(500, haul.activeCarry * 75)) {
        return { state: STATES.RECOVERY, reason: 'harvest restored, logistics below demand' };
    }
    if (snapshot.spawnFill < 0.45 && reserves < 2000 &&
        !(snapshot.spawnPressure.busy > 0 && incomeRatio >= 0.9 && haulRatio >= 0.85)) {
        return { state: STATES.RECOVERY, reason: 'spawn fill recovering' };
    }
    if (snapshot.replacementRisk > 0 && reserves < 5000) {
        return { state: STATES.RECOVERY, reason: 'critical economy replacement at risk' };
    }
    if (reserves >= 100000 && snapshot.spawnFill >= 0.9 && snapshot.energyTrend >= -1) {
        return { state: STATES.SURPLUS, reason: 'storage reserves high and core economy satisfied' };
    }
    return { state: STATES.STABLE, reason: 'local income and logistics sustainable' };
}

function applyHysteresis(snapshot, previous) {
    const raw = rawState(snapshot);
    if (!previous || !STATE_RANK.hasOwnProperty(previous.state)) {
        snapshot.state = raw.state;
        snapshot.rawState = raw.state;
        snapshot.reason = raw.reason;
        snapshot.healthyTicks = 0;
        snapshot.stateSince = Game.time;
        snapshot.stateChangedAt = Game.time;
        return snapshot;
    }
    const oldState = previous && STATE_RANK.hasOwnProperty(previous.state) ? previous.state : STATES.RECOVERY;
    const oldRank = STATE_RANK[oldState];
    const rawRank = STATE_RANK[raw.state];
    let state = oldState;
    let healthyTicks = previous && previous.healthyTicks || 0;
    let reason = raw.reason;

    if (rawRank < oldRank) {
        state = raw.state;
        healthyTicks = 0;
    }
    else if (rawRank > oldRank) {
        healthyTicks++;
        if (healthyTicks >= (EXIT_TICKS[oldState] || 1)) {
            state = Object.keys(STATE_RANK).find(name => STATE_RANK[name] === oldRank + 1) || raw.state;
            healthyTicks = 0;
            reason = 'sustained improvement: ' + raw.reason;
        }
        else {
            reason = 'holding ' + oldState + ' for recovery confirmation: ' + raw.reason;
        }
    }
    else {
        healthyTicks = 0;
    }

    snapshot.state = state;
    snapshot.healthyTicks = healthyTicks;
    snapshot.reason = reason;
    snapshot.stateSince = previous && previous.state === state ? previous.stateSince : Game.time;
    snapshot.stateChangedAt = previous && previous.state === state ? previous.stateChangedAt : Game.time;
    snapshot.rawState = raw.state;
    return snapshot;
}

function ensureEconomyMemory() {
    const hive = HiveMemory.ensure();
    if (!hive.economy || typeof hive.economy !== 'object') hive.economy = {};
    if (!hive.economy.rooms || typeof hive.economy.rooms !== 'object') hive.economy.rooms = {};
    return hive.economy;
}

function updateRoom(room) {
    if (!room || !room.controller || !room.controller.my) return null;
    const economy = ensureEconomyMemory();
    const previous = economy.rooms[room.name] || null;
    const snapshot = applyHysteresis(buildSnapshot(room, previous), previous);
    economy.rooms[room.name] = snapshot;
    return snapshot;
}

function run() {
    const result = {};
    for (const room of TickIndex.get().ownedSpawnRooms) result[room.name] = updateRoom(room);
    return result;
}

function get(roomOrName) {
    const roomName = typeof roomOrName === 'string' ? roomOrName : roomOrName && roomOrName.name;
    return roomName && ensureEconomyMemory().rooms[roomName] || null;
}

function categoryForRequest(request) {
    const memory = request && request.memory || {};
    const role = request && (request.role || memory.role);
    if (request && request.economyCategory) return request.economyCategory;
    if (memory.economyCategory) return memory.economyCategory;
    if (memory.remoteMining === true || memory.remoteWorkTargetId ||
        memory.sourceRoom && memory.homeRoom && memory.sourceRoom !== memory.homeRoom) return 'remote';
    if (CORE_ROLES.has(role)) return role === 'Extractor' ? 'harvest' : 'logistics';
    if (COMBAT_ROLES.has(role)) {
        const targetRoom = memory.defendedRoom || memory.targetRoom || request && request.targetRoom;
        const target = targetRoom && Game.rooms[targetRoom];
        if (memory.defenseRequest === true && target && target.controller && target.controller.my) {
            return 'emergencyDefense';
        }
        return 'combat';
    }
    if (role === 'Tech') return memory.controllerEmergency ? 'criticalController' : 'upgrade';
    if (role === 'Artificer') return memory.criticalMaintenance ? 'criticalMaintenance' : 'construction';
    if (role === 'Annex' || role === 'Scout' || role === 'Pioneer') return 'expansion';
    if (role === 'MineralMiner' || role === 'ResourceCourier') return 'resources';
    if (role === 'ThoriumMiner' || role === 'ThoriumHauler' || role === 'ReactorClaimer') return 'special';
    return 'discretionary';
}

function checkSpend(roomOrName, category) {
    const snapshot = get(roomOrName);
    if (!snapshot) return { allowed: true, reason: 'no economy snapshot' };
    if (category === 'emergencyDefense') return { allowed: true, reason: 'owned-room emergency defense' };
    if (['harvest', 'logistics', 'spawnFill'].includes(category)) {
        return { allowed: true, reason: 'core economy' };
    }
    if (snapshot.state === STATES.SURVIVAL) {
        const allowed = category === 'criticalController' || category === 'criticalMaintenance';
        return { allowed, reason: allowed ? 'critical survival exception' : 'blocked during SURVIVAL' };
    }
    if (snapshot.state === STATES.RECOVERY) {
        const allowed = ['defense', 'criticalController', 'criticalMaintenance'].includes(category);
        return { allowed, reason: allowed ? 'recovery exception' : 'blocked during RECOVERY' };
    }
    return { allowed: true, reason: snapshot.state + ' permits spending' };
}

function canSpend(roomOrName, category) {
    return checkSpend(roomOrName, category).allowed;
}

function canSpawnRequest(room, request) {
    return checkSpend(room, categoryForRequest(request));
}

function shouldBootstrapSelfDeliver(roomOrName) {
    const snapshot = get(roomOrName);
    return !!snapshot && snapshot.state === STATES.SURVIVAL &&
        snapshot.haul.localCarry + snapshot.haul.queuedCarry < 1;
}

module.exports = {
    STATES,
    run,
    updateRoom,
    get,
    rawState,
    applyHysteresis,
    canSpend,
    checkSpend,
    canSpawnRequest,
    categoryForRequest,
    shouldBootstrapSelfDeliver
};
