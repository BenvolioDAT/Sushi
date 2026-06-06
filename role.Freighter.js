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

        updateWorkingState(creep);

        if(creep.memory.FreighterWorking) {
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
    if(creep.memory.FreighterWorking && creep.store[RESOURCE_ENERGY] === 0) {
        creep.memory.FreighterWorking = false;
    }

    /*
     * If the hauler was collecting and has no free energy capacity, it is full
     * and should switch to delivery mode.
     */
    if(!creep.memory.FreighterWorking && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
        creep.memory.FreighterWorking = true;
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
    var target = null;

    /*
     * Priority 1:
     * Fill spawn and extensions first so the room can keep making creeps.
     * If these are empty, the whole bee hive starts coughing dust.
     */
    target = findSpawnOrExtensionToFill(creep);

    /*
     * Priority 2:
     * Fill towers after spawn/extensions. Towers keep the room defended and
     * can repair when they have energy.
     */
    if(!target) {
        target = findTowerToFill(creep);
    }

    /*
     * Priority 3:
     * Fill the controller container. This gives Upgraders a local energy buffer
     * so they do not have to waddle back and forth like tired penguins.
     */
    if(!target) {
        target = findControllerContainerToFill(creep);
    }

    /*
     * Priority 4:
     * Put leftover energy into storage. Storage is last because it has huge
     * capacity and would otherwise steal all Freighter deliveries forever.
     */
    if(!target) {
        target = findStorageToFill(creep);
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

function findSpawnOrExtensionToFill(creep) {
    /*
     * Spawns and extensions are the highest-priority delivery target because
     * they directly control whether the room can spawn new creeps.
     */
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

function findTowerToFill(creep) {
    /*
     * Towers are useful for defense and repairs. This fills any tower that has
     * room for more energy.
     */
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

function findControllerContainerToFill(creep) {
    /*
     * This looks for a container near the room controller.
     *
     * Range 3 is used because Upgraders can usually stand around the controller
     * and withdraw from a nearby container without the container needing to be
     * directly touching the controller.
     *
     * This ignores source containers because source containers are near sources,
     * while this function only cares about containers near the controller.
     */
    if(!creep.room.controller) {
        return null;
    }

    return creep.pos.findClosestByPath(FIND_STRUCTURES, {
        filter: function(structure) {
            return (
                structure.structureType === STRUCTURE_CONTAINER &&
                structure.store &&
                structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0 &&
                structure.pos.getRangeTo(creep.room.controller) <= 3
            );
        }
    });
}

function findStorageToFill(creep) {
    /*
     * Storage is the fallback delivery target. It should not be first because
     * storage has so much capacity that it can prevent smaller important targets,
     * like the controller container, from being filled.
     */
    if(
        creep.room.storage &&
        creep.room.storage.store &&
        creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0
    ) {
        return creep.room.storage;
    }

    return null;
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