const ResourceManager = require('Resource.Manager');
const travel = require('utility.Travel.Creep');
const Economy = require('HiveMind.Economy');
const creepUtility = require('utility.Creep');

function resourceKeys(store) {
    return Object.keys(store || {}).filter(type => typeof store[type] === 'number' && store[type] > 0);
}

function fallbackDeposit(creep, resourceType) {
    return ownedFallbackDeposit(creep, resourceType);
}

function ownedFallbackDeposit(creep, resourceType) {
    if (!creep.room.controller || !creep.room.controller.my) return null;
    return [creep.room.storage].find(structure => structure && structure.my !== false &&
        structure.store && structure.store.getFreeCapacity(resourceType) > 0) || null;
}

function moveOrAct(creep, target, action) {
    const result = action();
    if (result === ERR_NOT_IN_RANGE) travel.move(creep, target, { range: 1, trafficPriority: 45 });
    return result;
}


function run(creep) {
    if (!creep || creep.spawning) return;
    if (creep.memory.returnHomeAfterRetirement) {
        if (creep.memory.homeRoom && creep.room.name !== creep.memory.homeRoom) {
            travel.moveToRoom(creep, creep.memory.homeRoom, { range: 22, allowHostile: false });
            return;
        }
        delete creep.memory.returnHomeAfterRetirement;
    }
    if (creep.memory.powerBankOperationId) {
        runPowerBankHauler(creep);
        return;
    }
    const homeRoomName = creep.memory.homeRoom || creep.room.name;

    if (!Economy.canSpend(homeRoomName, 'resources')) {
        ResourceManager.clearJob(creep);
        if ((creep.store[RESOURCE_ENERGY] || 0) > 0 && creep.room.name === homeRoomName) {
            creepUtility.fillRoomEnergy(creep);
        }
        creep.memory.resourceCourierState = 'heldForHomeEconomy';
        return;
    }
    const carriedTypes = resourceKeys(creep.store);
    if (!carriedTypes.length) delete creep.memory.resourceDelivery;
    // The source may now be empty, so the heap board need not emit the pickup
    // job again. Keep the delivery leg independently until cargo is discharged.
    const delivery = creep.memory.resourceDelivery;
    const job = delivery ? null : ResourceManager.getJobForCreep(creep);
    if (carriedTypes.length) {
        const resourceType = carriedTypes[0];
        const assignedId = delivery && delivery.resourceType === resourceType ? delivery.targetId :
            job && job.resourceType === resourceType && job.targetId;
        const assigned = assignedId && Game.getObjectById(assignedId);
        const valid = assigned && assigned.my !== false && assigned.store && assigned.pos &&
            assigned.pos.roomName === creep.room.name && assigned.store.getFreeCapacity(resourceType) > 0;
        if (!valid) ResourceManager.clearJob(creep);
        const target = valid ? assigned : fallbackDeposit(creep, resourceType);
        if (!target) {
            creep.memory.resourceCourierState = 'waitingForDeposit';
            return;
        }
        const result = moveOrAct(creep, target, () => creep.transfer(target, resourceType));
        creep.memory.resourceCourierState = 'delivering';
        if (result !== ERR_NOT_IN_RANGE) ResourceManager.clearJob(creep);
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
    if (result === OK) creep.memory.resourceDelivery = { targetId: job.targetId, resourceType: job.resourceType };
    if (result !== OK && result !== ERR_NOT_IN_RANGE) ResourceManager.clearJob(creep);
}

function runPowerBankHauler(creep) {
    const powerType = typeof RESOURCE_POWER !== 'undefined' ? RESOURCE_POWER : 'power';
    const homeRoom = creep.memory.powerBankHomeRoom || creep.memory.homeRoom;
    const targetRoom = creep.memory.targetRoom;
    const operationKey = String(creep.memory.powerBankOperationId).replace(/^power-bank:/, '');
    const operation = require('HiveMind.Memory').ensure().power.operations[operationKey];
    if ((creep.store[powerType] || 0) > 0) {
        if (operation) operation.state = 'RETURNING';
        if (creep.room.name !== homeRoom) {
            travel.moveToRoom(creep, homeRoom, { range: 22, reusePath: 20 });
            creep.memory.powerBankState = 'returning';
            return;
        }
        const target = creep.room.controller && creep.room.controller.my && [creep.room.powerSpawn && (creep.room.powerSpawn.store[powerType] || 0) <
            (require('HiveMind.Memory').getConfig('power').processing.targetPower || 25) ? creep.room.powerSpawn : null, creep.room.storage]
            .find(item => item && item.store && item.my !== false &&
                (typeof item.store.getFreeCapacity !== 'function' || item.store.getFreeCapacity(powerType) > 0));
        const workingNeed = target && target === creep.room.powerSpawn ? Math.max(0,
            (require('HiveMind.Memory').getConfig('power').processing.targetPower || 25) - (target.store[powerType] || 0)) : creep.store[powerType];
        const deliveryAmount = target ? Math.min(creep.store[powerType], workingNeed,
            typeof target.store.getFreeCapacity === 'function' ? target.store.getFreeCapacity(powerType) : workingNeed) : 0;
        const result = target && moveOrAct(creep, target, () => creep.transfer(target, powerType, deliveryAmount));
        if (result === OK && operation) {
            operation.deliveredPower = (operation.deliveredPower || 0) + deliveryAmount;
            operation.state = operation.recoveryTarget > 0 && operation.deliveredPower >= operation.recoveryTarget ? 'COMPLETE' : 'RETURNING';
            if (operation.state === 'COMPLETE') operation.completedAt = Game.time;
            operation.reason = 'Recovered Power delivered to safe owned storage';
        }
        creep.memory.powerBankState = target ? 'depositing' : 'waitingForSafeStore';
        return;
    }
    if (!operation || operation.state === 'REJECTED' || operation.state === 'ABORTED' || operation.state === 'COMPLETE') {
        if (homeRoom && creep.room.name !== homeRoom) travel.moveToRoom(creep, homeRoom, { range: 22, reusePath: 20 });
        creep.memory.powerBankState = 'aborting';
        return;
    }
    if (creep.room.name !== targetRoom) {
        travel.moveToRoom(creep, targetRoom, { range: 22, reusePath: 20 });
        creep.memory.powerBankState = 'inbound';
        return;
    }
    let drops = [];
    if (typeof FIND_DROPPED_RESOURCES !== 'undefined') {
        try { drops = creep.room.find(FIND_DROPPED_RESOURCES, { filter: item => item.resourceType === powerType }); }
        catch (error) { drops = []; }
    }
    const drop = creep.pos.findClosestByRange ? creep.pos.findClosestByRange(drops) : drops[0];
    if (drop) moveOrAct(creep, drop, () => creep.pickup(drop));
    creep.memory.powerBankState = drop ? 'looting' : 'waitingForDrop';
}

module.exports = { run, resourceKeys, fallbackDeposit, ownedFallbackDeposit, runPowerBankHauler };
