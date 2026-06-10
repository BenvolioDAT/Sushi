/*
 * role.Repair.js
 *
 * Dedicated repair role.
 *
 * This role is intentionally independent from Artificer repair claims. It uses
 * a simple two-state memory flag, collects energy, and repairs the lowest
 * percentage structure under that structure's configured repair goal.
 */
var utilityTravelCreep = require('utility.Travel.Creep');

var WALL_REPAIR_CAP = 10000;
var RAMPART_REPAIR_CAP = 10000;

var roleRepair = {

    /** @param {Creep} creep **/
    run: function(creep) {
        /*
         * Repairers need an active creep with a store and WORK parts. If the
         * creep is still spawning, it cannot repair or collect energy yet.
         */
        if(!creep || creep.spawning) {
            return;
        }

        /*
         * repairWorking is the mode flag in creep.memory. The role alternates
         * between collecting energy and spending energy on repairs.
         */
        updateWorkingState(creep);

        if(creep.memory.repairWorking) {
            repairTarget(creep);
        } else {
            collectEnergy(creep);
        }
    }
};

function updateWorkingState(creep) {
    /*
     * If the creep was repairing but is now empty, switch back to energy
     * collection mode.
     */
    if(creep.memory.repairWorking && creep.store[RESOURCE_ENERGY] === 0) {
        creep.memory.repairWorking = false;
    }
    /*
     * If the creep was collecting and is now full, it can start repairing.
     */
    if(!creep.memory.repairWorking && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
        creep.memory.repairWorking = true;
    }
}

function collectEnergy(creep) {
    /*
     * Look for reusable energy first. This prefers storage/container/dropped
     * energy before falling back to harvesting from a source.
     */
    var target = findStoredEnergy(creep);

    if(target) {
        /*
         * Dropped Resource objects use pickup. Structures with a store use
         * withdraw. The resourceType check separates those two shapes.
         */
        if(target.resourceType) {
            if(creep.pickup(target) === ERR_NOT_IN_RANGE) {
                utilityTravelCreep.move(creep, target, {visualizePathStyle: {stroke: '#ffaa00'}});
            }
        } else if(creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            utilityTravelCreep.move(creep, target, {visualizePathStyle: {stroke: '#ffaa00'}});
        }
        return;
    }

    /*
     * If no stored energy exists, harvest directly from the nearest reachable
     * source so the repairer can bootstrap itself.
     */
    var source = creep.pos.findClosestByPath(FIND_SOURCES);
    if(source && creep.harvest(source) === ERR_NOT_IN_RANGE) {
        utilityTravelCreep.move(creep, source, {visualizePathStyle: {stroke: '#ffaa00'}});
    }
}

function repairTarget(creep) {
    /*
     * Find one damaged structure according to the repair priority rules below.
     */
    var target = findRepairTarget(creep);

    if(!target) {
        /*
         * Nothing needs repairs right now. Returning avoids a repair call with a
         * null target, which would waste CPU and return an error.
         */
        return;
    }

    /*
     * creep.repair spends energy on the target. ERR_NOT_IN_RANGE means the creep
     * must move closer before repairing.
     */
    if(creep.repair(target) === ERR_NOT_IN_RANGE) {
        utilityTravelCreep.move(creep, target, {visualizePathStyle: {stroke: '#ffffff'}});
    }
}

function findRepairTarget(creep) {
    /*
     * room.find(FIND_STRUCTURES) returns visible structures. The filter keeps
     * only structures below their desired repair goal.
     */
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
    /*
     * Walls and ramparts can have enormous max hits. Capping their repair goal
     * prevents repairers from spending all energy on defenses forever.
     */
    if(structure.structureType === STRUCTURE_WALL) {
        return Math.min(structure.hitsMax, WALL_REPAIR_CAP);
    }
    if(structure.structureType === STRUCTURE_RAMPART) {
        return Math.min(structure.hitsMax, RAMPART_REPAIR_CAP);
    }
    return structure.hitsMax;
}

function findStoredEnergy(creep) {
    /*
     * Storage is the central energy bank. Check it before searching all room
     * structures because it is a simple direct property on the room.
     */
    if(creep.room.storage && creep.room.storage.store[RESOURCE_ENERGY] > 0) {
        return creep.room.storage;
    }

    /*
     * If there is no usable storage, find the closest container with energy.
     */
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

    /*
     * Dropped energy is the final reusable source. It is returned as a Resource
     * object and collected with pickup in collectEnergy().
     */
    return creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: function(resource) {
            return resource.resourceType === RESOURCE_ENERGY && resource.amount > 0;
        }
    });
}

module.exports = roleRepair;
