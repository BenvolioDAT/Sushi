const ResourceManager = require('Resource.Manager');
const travel = require('utility.Travel.Creep');
const Economy = require('HiveMind.Economy');
const creepUtility = require('utility.Creep');
const Season11 = require('Logic.Season11');

function resourceKeys(store) {
    return Object.keys(store || {}).filter(type => typeof store[type] === 'number' && store[type] > 0);
}

function fallbackDeposit(creep, resourceType) {
    return [creep.room.terminal, creep.room.storage].find(structure => structure && structure.store &&
        structure.store.getFreeCapacity(resourceType) > 0) || null;
}

function ownedFallbackDeposit(creep, resourceType) {
    if (!creep.room.controller || !creep.room.controller.my) return null;
    return [creep.room.terminal, creep.room.storage].find(structure => structure && structure.my !== false &&
        structure.store && structure.store.getFreeCapacity(resourceType) > 0) || null;
}

function moveOrAct(creep, target, action) {
    const result = action();
    if (result === ERR_NOT_IN_RANGE) travel.move(creep, target, { range: 1, trafficPriority: 45 });
    return result;
}

function season11Staging(creep) {
    if (!Season11.isApiAvailable()) return null;
    const assignments = Season11.ensureMemory().assignments.mining || {};
    const local = assignments[creep.room.name] || Object.values(assignments)
        .find(item => item && item.roomName === (creep.memory.homeRoom || creep.room.name));
    return local && local.stagingId && Game.getObjectById(local.stagingId) || null;
}

function run(creep) {
    if (!creep || creep.spawning) return;
    const homeRoomName = creep.memory.homeRoom || creep.room.name;
    const thorium = Season11.getThoriumResourceType();
    if (Season11.isApiAvailable() && thorium) {
        const staleThoriumJob = creep.memory.mineralType === thorium ||
            creep.memory.resourceJobId && String(creep.memory.resourceJobId).endsWith(`:${thorium}`);
        if (staleThoriumJob) ResourceManager.clearJob(creep);
        if ((creep.store[thorium] || 0) > 0) {
            const target = season11Staging(creep) || ownedFallbackDeposit(creep, thorium);
            if (!target) {
                creep.memory.resourceCourierState = 'waitingToRetireThoriumCargo';
                return;
            }
            moveOrAct(creep, target, () => creep.transfer(target, thorium));
            creep.memory.resourceCourierState = 'returningThoriumToSeason11';
            return;
        }
        if (staleThoriumJob) {
            delete creep.memory.mineralId;
            delete creep.memory.mineralType;
            creep.memory.resourceCourierState = 'retiredThoriumAssignment';
        }
    }
    if (!Economy.canSpend(homeRoomName, 'resources')) {
        ResourceManager.clearJob(creep);
        if ((creep.store[RESOURCE_ENERGY] || 0) > 0 && creep.room.name === homeRoomName) {
            creepUtility.fillRoomEnergy(creep);
        }
        creep.memory.resourceCourierState = 'heldForHomeEconomy';
        return;
    }
    const carriedTypes = resourceKeys(creep.store);
    const job = ResourceManager.getJobForCreep(creep);
    if (carriedTypes.length) {
        const resourceType = carriedTypes[0];
        const target = job && job.resourceType === resourceType && Game.getObjectById(job.targetId) ||
            fallbackDeposit(creep, resourceType);
        if (!target) {
            creep.memory.resourceCourierState = 'waitingForDeposit';
            return;
        }
        const result = moveOrAct(creep, target, () => creep.transfer(target, resourceType));
        creep.memory.resourceCourierState = 'delivering';
        if (result === OK) ResourceManager.clearJob(creep);
        return;
    }
    if (!job) {
        creep.memory.resourceCourierState = 'idle';
        return;
    }
    const source = Game.getObjectById(job.sourceId);
    if (!source) {
        ResourceManager.clearJob(creep);
        return;
    }
    const result = moveOrAct(creep, source, () => creep.withdraw(source, job.resourceType,
        Math.min(job.amount, creep.store.getFreeCapacity(job.resourceType))));
    creep.memory.resourceCourierState = 'collecting';
    if (result !== OK && result !== ERR_NOT_IN_RANGE) ResourceManager.clearJob(creep);
}

module.exports = { run, resourceKeys, fallbackDeposit, ownedFallbackDeposit, season11Staging };
