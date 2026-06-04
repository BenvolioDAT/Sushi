var roleFreighter = {

    /** @param {Creep} creep **/
    run: function(creep) {
        /*
         * Freighters are haulers. They need to exist and be done spawning before
         * they can withdraw, pick up, transfer, or move.
         */
        if(!creep || creep.spawning) {
            return;
        }

        /*
         * truckerWorking is this role's memory flag even though the file is
         * named Freighter. false = collect energy, true = deliver energy.
         */
        updateWorkingState(creep);

        if(creep.memory.truckerWorking) {
            deliverEnergy(creep);
        } else {
            collectEnergy(creep);
        }
    }
};

function updateWorkingState(creep) {
    /*
     * If the hauler was delivering but has zero energy, it must go collect more.
     */
    if(creep.memory.truckerWorking && creep.store[RESOURCE_ENERGY] === 0) {
        creep.memory.truckerWorking = false;
    }
    /*
     * If the hauler was collecting and has no free energy capacity, it is full
     * and should switch to delivery mode.
     */
    if(!creep.memory.truckerWorking && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
        creep.memory.truckerWorking = true;
    }
}

function collectEnergy(creep) {
    /*
     * Prefer source containers, then dropped energy. Source containers represent
     * energy mined by Extractors and waiting for transport.
     */
    var target = findSourceContainer(creep) || findDroppedEnergy(creep);

    if(!target) {
        /*
         * No pickup target exists. Idling near a source keeps the Freighter near
         * future energy drops without doing more expensive searches.
         */
        idleNearSource(creep);
        return;
    }

    /*
     * Dropped Resource objects have resourceType and use pickup().
     * Structures have stores and use withdraw().
     */
    if(target.resourceType) {
        if(creep.pickup(target) === ERR_NOT_IN_RANGE) {
            creep.moveTo(target, {visualizePathStyle: {stroke: '#ffaa00'}});
        }
    } else if(creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, {visualizePathStyle: {stroke: '#ffaa00'}});
    }
}

function deliverEnergy(creep) {
    /*
     * Delivery priority starts with storage if it exists and has room. This makes
     * the Freighter act like a source-to-storage hauler in developed rooms.
     */
    var target = null;

    if(creep.room.storage && creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        target = creep.room.storage;
    }

    /*
     * If storage is not available, fill spawn and extensions so the room can
     * keep producing creeps.
     */
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

    /*
     * Towers are useful, but this role fills them after spawn/extensions.
     */
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
        /*
         * No valid destination has free capacity, so there is no transfer action
         * to take this tick.
         */
        return;
    }

    /*
     * transfer returns ERR_NOT_IN_RANGE when the target has room but is too far
     * away. moveTo starts pathing toward transfer range.
     */
    if(creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, {visualizePathStyle: {stroke: '#ffffff'}});
    }
}

function findSourceContainer(creep) {
    /*
     * This finds containers that both contain energy and are within range 2 of a
     * source, which marks them as mining containers rather than random storage.
     */
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
    /*
     * Ignore tiny piles under 50 energy so the Freighter does not spend lots of
     * travel time cleaning up very small scraps.
     */
    return creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: function(resource) {
            return resource.resourceType === RESOURCE_ENERGY && resource.amount >= 50;
        }
    });
}

function idleNearSource(creep) {
    /*
     * Standing near sources makes the hauler ready for new dropped energy or
     * container energy without blocking the source directly.
     */
    var source = creep.pos.findClosestByPath(FIND_SOURCES);
    if(source && creep.pos.getRangeTo(source) > 3) {
        creep.moveTo(source, {visualizePathStyle: {stroke: '#bbbbbb'}});
    }
}

module.exports = roleFreighter;
