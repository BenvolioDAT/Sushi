var roleFreighter = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if(!creep || creep.spawning) {
            return;
        }

        updateWorkingState(creep);

        if(creep.memory.truckerWorking) {
            deliverEnergy(creep);
        } else {
            collectEnergy(creep);
        }
    }
};

function updateWorkingState(creep) {
    if(creep.memory.truckerWorking && creep.store[RESOURCE_ENERGY] === 0) {
        creep.memory.truckerWorking = false;
    }
    if(!creep.memory.truckerWorking && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
        creep.memory.truckerWorking = true;
    }
}

function collectEnergy(creep) {
    var target = findSourceContainer(creep) || findDroppedEnergy(creep);

    if(!target) {
        idleNearSource(creep);
        return;
    }

    if(target.resourceType) {
        if(creep.pickup(target) === ERR_NOT_IN_RANGE) {
            creep.moveTo(target, {visualizePathStyle: {stroke: '#ffaa00'}});
        }
    } else if(creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, {visualizePathStyle: {stroke: '#ffaa00'}});
    }
}

function deliverEnergy(creep) {
    var target = null;

    if(creep.room.storage && creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        target = creep.room.storage;
    }

    if(!target) {
        target = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
            filter: function(structure) {
                return (
                    (structure.structureType === STRUCTURE_SPAWN ||
                     structure.structureType === STRUCTURE_EXTENSION) &&
                    structure.store &&
                    structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0
                );
            }
        });
    }

    if(!target) {
        target = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
            filter: function(structure) {
                return (
                    structure.structureType === STRUCTURE_TOWER &&
                    structure.store &&
                    structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0
                );
            }
        });
    }

    if(!target) {
        return;
    }

    if(creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, {visualizePathStyle: {stroke: '#ffffff'}});
    }
}

function findSourceContainer(creep) {
    return creep.pos.findClosestByPath(FIND_STRUCTURES, {
        filter: function(structure) {
            return (
                structure.structureType === STRUCTURE_CONTAINER &&
                structure.store &&
                structure.store[RESOURCE_ENERGY] > 0 &&
                structure.pos.findInRange(FIND_SOURCES, 2).length > 0
            );
        }
    });
}

function findDroppedEnergy(creep) {
    return creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: function(resource) {
            return resource.resourceType === RESOURCE_ENERGY && resource.amount >= 50;
        }
    });
}

function idleNearSource(creep) {
    var source = creep.pos.findClosestByPath(FIND_SOURCES);
    if(source && creep.pos.getRangeTo(source) > 3) {
        creep.moveTo(source, {visualizePathStyle: {stroke: '#bbbbbb'}});
    }
}

module.exports = roleFreighter;
