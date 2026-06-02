var roleUpgrader = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if(!creep || creep.spawning) {
            return;
        }

        // Keep the role name simple and local. This does not depend on any
        // BeeHiveMind role wrapper or shared memory layout.
        if(creep.memory.role !== 'Upgrader') {
            creep.memory.role = 'Upgrader';
        }

        updateState(creep);

        if(creep.memory.upgrading) {
            upgradeController(creep);
        } else {
            refuel(creep);
        }
    }
};

function updateState(creep) {
    // When empty, switch back to refueling.
    if(creep.memory.upgrading && creep.store[RESOURCE_ENERGY] === 0) {
        creep.memory.upgrading = false;
    }

    // When full, switch to upgrading.
    if(!creep.memory.upgrading && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
        creep.memory.upgrading = true;
    }

    // Store a readable state for quick memory/debug inspection.
    creep.memory.state = creep.memory.upgrading ? 'UPGRADE' : 'REFUEL';
}

function upgradeController(creep) {
    var controller = creep.room.controller;
    if(!controller) {
        return;
    }

    // If this creep somehow has no energy, fail safely. The next tick will
    // switch it back to refuel mode.
    if(creep.store[RESOURCE_ENERGY] === 0) {
        creep.memory.upgrading = false;
        creep.memory.state = 'REFUEL';
        return;
    }

    var result = creep.upgradeController(controller);
    if(result === ERR_NOT_IN_RANGE) {
        creep.moveTo(controller, {
            range: 3,
            visualizePathStyle: {stroke: '#ffffff'}
        });
    }
}

function refuel(creep) {
    var target = findEnergyTarget(creep);

    if(!target) {
        harvestFromSource(creep);
        return;
    }

    if(target.resourceType) {
        pickupEnergy(creep, target);
    } else {
        withdrawEnergy(creep, target);
    }
}

function findEnergyTarget(creep) {
    // 1. Storage is the easiest reliable energy source when the room has one.
    if(creep.room.storage && creep.room.storage.store[RESOURCE_ENERGY] > 0) {
        return creep.room.storage;
    }

    // 2. Containers are a common early-room source for worker energy.
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

    // 3. Pick up dropped energy so it does not decay on the ground.
    var dropped = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: function(resource) {
            return resource.resourceType === RESOURCE_ENERGY && resource.amount > 0;
        }
    });
    if(dropped) {
        return dropped;
    }

    // 4. Tombstones and ruins are simple cleanup sources after creep deaths.
    var tombstone = creep.pos.findClosestByPath(FIND_TOMBSTONES, {
        filter: function(tomb) {
            return tomb.store && tomb.store[RESOURCE_ENERGY] > 0;
        }
    });
    if(tombstone) {
        return tombstone;
    }

    if(typeof FIND_RUINS !== 'undefined') {
        var ruin = creep.pos.findClosestByPath(FIND_RUINS, {
            filter: function(ruinTarget) {
                return ruinTarget.store && ruinTarget.store[RESOURCE_ENERGY] > 0;
            }
        });
        if(ruin) {
            return ruin;
        }
    }

    return null;
}

function withdrawEnergy(creep, target) {
    var result = creep.withdraw(target, RESOURCE_ENERGY);
    if(result === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, {visualizePathStyle: {stroke: '#ffffff'}});
    }
}

function pickupEnergy(creep, target) {
    var result = creep.pickup(target);
    if(result === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, {visualizePathStyle: {stroke: '#ffffff'}});
    }
}

function harvestFromSource(creep) {
    var source = creep.pos.findClosestByPath(FIND_SOURCES);
    if(!source) {
        return;
    }

    var result = creep.harvest(source);
    if(result === ERR_NOT_IN_RANGE) {
        creep.moveTo(source, {visualizePathStyle: {stroke: '#ffffff'}});
    }
}

module.exports = roleUpgrader;
