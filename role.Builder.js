var roleBuilder = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if(!creep || creep.spawning) {
            return;
        }

        updateWorkingState(creep);

        if(creep.memory.builderWorking) {
            buildOrUpgrade(creep);
        } else {
            collectEnergy(creep);
        }
    }
};

function updateWorkingState(creep) {
    if(creep.memory.builderWorking && creep.store[RESOURCE_ENERGY] === 0) {
        creep.memory.builderWorking = false;
    }
    if(!creep.memory.builderWorking && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
        creep.memory.builderWorking = true;
    }
}

function collectEnergy(creep) {
    var target = findStoredEnergy(creep);

    if(target) {
        if(target.resourceType) {
            if(creep.pickup(target) === ERR_NOT_IN_RANGE) {
                creep.moveTo(target, {visualizePathStyle: {stroke: '#ffaa00'}});
            }
        } else if(creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            creep.moveTo(target, {visualizePathStyle: {stroke: '#ffaa00'}});
        }
        return;
    }

    // Last fallback: harvest directly if no stored energy is available.
    var source = creep.pos.findClosestByPath(FIND_SOURCES);
    if(source && creep.harvest(source) === ERR_NOT_IN_RANGE) {
        creep.moveTo(source, {visualizePathStyle: {stroke: '#ffaa00'}});
    }
}

function buildOrUpgrade(creep) {
    var target = creep.pos.findClosestByPath(FIND_CONSTRUCTION_SITES);

    if(target) {
        if(creep.build(target) === ERR_NOT_IN_RANGE) {
            creep.moveTo(target, {visualizePathStyle: {stroke: '#ffffff'}});
        }
        return;
    }

    // Builders can help the controller when there is nothing to build.
    if(creep.room.controller && creep.upgradeController(creep.room.controller) === ERR_NOT_IN_RANGE) {
        creep.moveTo(creep.room.controller, {visualizePathStyle: {stroke: '#ffffff'}});
    }
}

function findStoredEnergy(creep) {
    if(creep.room.storage && creep.room.storage.store[RESOURCE_ENERGY] > 0) {
        return creep.room.storage;
    }

    var container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
        filter: function(structure) {
            return (
                structure.structureType === STRUCTURE_CONTAINER &&
                structure.store &&
                structure.store[RESOURCE_ENERGY] > 0
            );
        }
    });

    if(container) {
        return container;
    }

    return creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: function(resource) {
            return resource.resourceType === RESOURCE_ENERGY && resource.amount > 0;
        }
    });
}

module.exports = roleBuilder;
