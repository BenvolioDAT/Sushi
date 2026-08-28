const ResourceManager = require('Resource.Manager');
const travel = require('utility.Travel.Creep');

function resourceKeys(store) {
    return Object.keys(store || {}).filter(type => typeof store[type] === 'number' && store[type] > 0);
}

function fallbackDeposit(creep, resourceType) {
    return [creep.room.terminal, creep.room.storage].find(structure => structure && structure.store &&
        structure.store.getFreeCapacity(resourceType) > 0) || null;
}

function moveOrAct(creep, target, action) {
    const result = action();
    if (result === ERR_NOT_IN_RANGE) travel.move(creep, target, { range: 1, trafficPriority: 45 });
    return result;
}

function run(creep) {
    if (!creep || creep.spawning) return;
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

module.exports = { run, resourceKeys, fallbackDeposit };
