var WALL_REPAIR_CAP = 10000;
var RAMPART_REPAIR_CAP = 10000;

var roleRepair = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if(!creep || creep.spawning) {
            return;
        }

        updateWorkingState(creep);

        if(creep.memory.repairWorking) {
            repairTarget(creep);
        } else {
            collectEnergy(creep);
        }
    }
};

function updateWorkingState(creep) {
    if(creep.memory.repairWorking && creep.store[RESOURCE_ENERGY] === 0) {
        creep.memory.repairWorking = false;
    }
    if(!creep.memory.repairWorking && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
        creep.memory.repairWorking = true;
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

    var source = creep.pos.findClosestByPath(FIND_SOURCES);
    if(source && creep.harvest(source) === ERR_NOT_IN_RANGE) {
        creep.moveTo(source, {visualizePathStyle: {stroke: '#ffaa00'}});
    }
}

function repairTarget(creep) {
    var target = findRepairTarget(creep);

    if(!target) {
        return;
    }

    if(creep.repair(target) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, {visualizePathStyle: {stroke: '#ffffff'}});
    }
}

function findRepairTarget(creep) {
    var targets = creep.room.find(FIND_STRUCTURES, {
        filter: function(structure) {
            return getRepairGoal(structure) > structure.hits;
        }
    });

    if(!targets || targets.length === 0) {
        return null;
    }

    // Lowest hit percentage is usually the most urgent simple repair target.
    targets.sort(function(a, b) {
        return (a.hits / getRepairGoal(a)) - (b.hits / getRepairGoal(b));
    });

    return targets[0];
}

function getRepairGoal(structure) {
    if(structure.structureType === STRUCTURE_WALL) {
        return Math.min(structure.hitsMax, WALL_REPAIR_CAP);
    }
    if(structure.structureType === STRUCTURE_RAMPART) {
        return Math.min(structure.hitsMax, RAMPART_REPAIR_CAP);
    }
    return structure.hitsMax;
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

module.exports = roleRepair;
