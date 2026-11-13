const HiveMemory = require('HiveMind.Memory');
const TickIndex = require('HiveMind.Index');
const Economy = require('HiveMind.Economy');
const ResourceManager = require('Resource.Manager');
const Intel = require('Power.Intel');
const travel = require('utility.Travel.Creep');

function amount(target, type) {
    const store = target && target.store;
    if (!store) return 0;
    return typeof store.getUsedCapacity === 'function' ? store.getUsedCapacity(type) || 0 : store[type] || 0;
}

function powerSpawns(room) {
    if (typeof STRUCTURE_POWER_SPAWN === 'undefined') return [];
    const byType = TickIndex.get().structuresByRoom.get(room.name);
    return byType && byType.get(STRUCTURE_POWER_SPAWN) || [];
}

function sourceFor(room, resourceType) {
    return [room.storage, room.terminal].filter(Boolean)
        .sort((a, b) => amount(b, resourceType) - amount(a, resourceType))[0] || null;
}

function planLogistics(room, spawn) {
    if (!room || !spawn || typeof RESOURCE_POWER === 'undefined' || typeof RESOURCE_ENERGY === 'undefined') return [];
    const settings = HiveMemory.getConfig('power').processing;
    const jobs = [];
    for (const spec of [
        { type: RESOURCE_POWER, target: settings.targetPower || 25, priority: 72 },
        { type: RESOURCE_ENERGY, target: settings.targetEnergy || 2500, priority: 68 }
    ]) {
        const source = sourceFor(room, spec.type);
        const missing = Math.max(0, spec.target - amount(spawn, spec.type));
        const available = source && amount(source, spec.type) || 0;
        if (source && missing > 0 && available > 0) jobs.push({
            id: `power-spawn:${spawn.id}:${spec.type}`, roomName: room.name,
            sourceId: source.id, targetId: spawn.id, resourceType: spec.type,
            amount: Math.min(missing, available), priority: spec.priority
        });
    }
    ResourceManager.addJobs(jobs);
    return jobs;
}

function plan() {
    const settings = HiveMemory.getConfig('power');
    if (settings.enabled === false) return { enabled: false };
    const jobs = [];
    for (const room of TickIndex.get().ownedRooms) for (const spawn of powerSpawns(room)) {
        jobs.push(...planLogistics(room, spawn));
    }
    return { enabled: true, jobs };
}

function processRoom(room) {
    const settings = HiveMemory.getConfig('power');
    const processing = settings.processing;
    const power = Intel.state();
    if (settings.enabled === false || processing.enabled === false || typeof RESOURCE_POWER === 'undefined' ||
        typeof RESOURCE_ENERGY === 'undefined') return null;
    const spawn = powerSpawns(room).find(item => typeof item.isActive !== 'function' || item.isActive());
    const energyCost = Math.max(1, processing.energyPerPower || 50);
    if (!spawn || amount(spawn, RESOURCE_POWER) < 1 || amount(spawn, RESOURCE_ENERGY) < energyCost) return null;
    if (!Economy.canSpend(room.name, 'resources')) {
        power.stats.processingBlocker = { tick: Game.time, roomName: room.name, reason: 'ECONOMY_POLICY' };
        return null;
    }
    const result = spawn.processPower();
    if (result === OK) {
        if (!power.stats.recentWindowStart || Game.time - power.stats.recentWindowStart >= 100) {
            power.stats.recentWindowStart = Game.time;
            power.stats.processedRecently = 0;
        }
        power.stats.processedTotal = (power.stats.processedTotal || 0) + 1;
        power.stats.energySpent = (power.stats.energySpent || 0) + energyCost;
        power.stats.lastProcessed = Game.time;
        power.stats.processedRecently = (power.stats.processedRecently || 0) + 1;
    }
    power.stats.gpl = typeof Game.gpl === 'object' ? {
        level: Game.gpl.level || 0, progress: Game.gpl.progress || 0,
        progressTotal: Game.gpl.progressTotal || 0,
        remaining: Math.max(0, (Game.gpl.progressTotal || 0) - (Game.gpl.progress || 0))
    } : null;
    return result;
}

function safePowerSpawn() {
    for (const room of TickIndex.get().ownedRooms) {
        const spawn = powerSpawns(room).find(item => typeof item.isActive !== 'function' || item.isActive());
        if (spawn) return spawn;
    }
    return null;
}

function managePowerCreep() {
    const settings = HiveMemory.getConfig('power').powerCreeps;
    const lifecycle = Intel.state().lifecycle;
    if (settings.autoCreate !== true || typeof Game.powerCreeps !== 'object' || typeof Game.gpl !== 'object') {
        lifecycle.state = 'AUTO_CREATE_DISABLED';
        return lifecycle;
    }
    const name = settings.firstName || 'SushiOperator';
    let creep = Game.powerCreeps[name];
    const used = Object.values(Game.powerCreeps).reduce((sum, item) => sum + Math.max(1,
        (Number(item && item.level) || 0) + 1), 0);
    if (!creep && Game.gpl.level > used && Game.time >= (lifecycle.retryAt || 0) &&
        typeof PowerCreep !== 'undefined' && typeof PowerCreep.create === 'function' &&
        typeof POWER_CLASS !== 'undefined' && POWER_CLASS.OPERATOR !== undefined) {
        lifecycle.lastCreateResult = PowerCreep.create(name, POWER_CLASS.OPERATOR);
        lifecycle.lastCreateAttempt = Game.time;
        lifecycle.retryAt = Game.time + (lifecycle.lastCreateResult === OK ? 1 : 100);
        creep = Game.powerCreeps[name];
    }
    if (!creep) { lifecycle.state = 'WAITING_FOR_FREE_GPL'; return lifecycle; }
    const spawn = safePowerSpawn();
    if (!creep.ticksToLive) {
        lifecycle.state = 'UNSPAWNED';
        if (spawn && Game.time >= (lifecycle.retryAt || 0) && typeof creep.spawn === 'function') {
            lifecycle.lastSpawnResult = creep.spawn(spawn);
            lifecycle.retryAt = Game.time + (lifecycle.lastSpawnResult === OK ? 1 : 50);
        }
        return lifecycle;
    }
    lifecycle.state = 'ACTIVE';
    lifecycle.name = name;
    lifecycle.ticksToLive = creep.ticksToLive;
    if (spawn && creep.ticksToLive < (settings.renewBelow || 1000) && creep.pos && creep.pos.isNearTo(spawn)) creep.renew(spawn);
    else if (spawn && creep.ticksToLive < (settings.renewBelow || 1000)) travel.move(creep, spawn, { range: 1 });
    else if (creep.room && creep.room.controller && !creep.room.controller.isPowerEnabled &&
        typeof creep.enableRoom === 'function') creep.enableRoom(creep.room.controller);
    else if (typeof PWR_GENERATE_OPS !== 'undefined' && creep.powers && creep.powers[PWR_GENERATE_OPS] &&
        !creep.powers[PWR_GENERATE_OPS].cooldown && typeof creep.usePower === 'function') creep.usePower(PWR_GENERATE_OPS);
    return lifecycle;
}

module.exports = { plan, planLogistics, processRoom, managePowerCreep, safePowerSpawn, amount };
