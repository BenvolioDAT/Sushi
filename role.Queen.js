var roleQueen = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if(!creep || creep.spawning) {
            return;
        }

        updateWorkingState(creep, 'queenWorking');

        if(creep.memory.queenWorking) {
            fillRoomEnergy(creep);
        } else {
            collectEnergy(creep);
        }
    }
};

function updateWorkingState(creep, memoryKey) {
    if(creep.memory[memoryKey] && creep.store[RESOURCE_ENERGY] === 0) {
        creep.memory[memoryKey] = false;
    }
    if(!creep.memory[memoryKey] && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
        creep.memory[memoryKey] = true;
    }
}

function collectEnergy(creep) {
    var target = null;

    // Queen fills the base, so storage is her first and simplest fuel source.
    if(creep.room.storage && creep.room.storage.store[RESOURCE_ENERGY] > 0) {
        target = creep.room.storage;
    }

    if(!target) {
        target = creep.pos.findClosestByPath(FIND_STRUCTURES, {
            filter: function(structure) {
                return (
                    structure.structureType === STRUCTURE_CONTAINER &&
                    structure.store &&
                    structure.store[RESOURCE_ENERGY] > 0
                );
            }
        });
    }

    if(target) {
        if(creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            creep.moveTo(target, {visualizePathStyle: {stroke: '#ffaa00'}});
        }
        return;
    }

    var dropped = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: function(resource) {
            return resource.resourceType === RESOURCE_ENERGY && resource.amount > 0;
        }
    });

    if(dropped && creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
        creep.moveTo(dropped, {visualizePathStyle: {stroke: '#ffaa00'}});
    }
}

function fillRoomEnergy(creep) {
    var target = findSpawnOrExtension(creep);

    // Spawn and extensions come first because they unlock more creeps.
    if(!target) {
        target = findTower(creep);
    }

    if(!target) {
        idleNearBase(creep);
        return;
    }

    if(creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, {visualizePathStyle: {stroke: '#ffffff'}});
    }
}

function findSpawnOrExtension(creep) {
    return creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
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

function findTower(creep) {
    return creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
        filter: function(structure) {
            return (
                structure.structureType === STRUCTURE_TOWER &&
                structure.store &&
                structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0
            );
        }
    });
}

function idleNearBase(creep) {
    var anchor = creep.room.storage || creep.pos.findClosestByPath(FIND_MY_SPAWNS);
    if(anchor && creep.pos.getRangeTo(anchor) > 2) {
        creep.moveTo(anchor, {visualizePathStyle: {stroke: '#bbbbbb'}});
    }
}

module.exports = roleQueen;
