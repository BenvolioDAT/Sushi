var roleArtificer = {

    /** @param {Creep} creep **/
    run: function(creep) {
        /*
         * Safety check:
         * - !creep protects against accidentally calling run with no creep.
         * - creep.spawning means the creep is still inside the spawn and cannot act.
         * Returning early saves CPU and prevents errors from using an invalid creep.
         */
        if(!creep || creep.spawning) {
            return;
        }

        /*
         * builderWorking is this role's "mode" flag in creep.memory.
         * false = collect energy.
         * true = spend energy on construction or controller upgrading.
         */
        updateWorkingState(creep);

        if(creep.memory.builderWorking) {
            buildOrUpgrade(creep);
        } else {
            collectEnergy(creep);
        }
    }
};

function updateWorkingState(creep) {
    /*
     * If the Artificer was working but ran out of energy, switch back to
     * collection mode. creep.store[RESOURCE_ENERGY] reads how much energy
     * this creep is carrying right now.
     */
    if(creep.memory.builderWorking && creep.store[RESOURCE_ENERGY] === 0) {
        creep.memory.builderWorking = false;
    }
    /*
     * If the Artificer was collecting and its energy storage is full, switch
     * to working mode. getFreeCapacity(RESOURCE_ENERGY) returns empty carry
     * space for energy; zero means no more energy fits.
     */
    if(!creep.memory.builderWorking && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
        creep.memory.builderWorking = true;
    }
}

function collectEnergy(creep) {
    /*
     * Find stored or dropped energy before harvesting. Using existing energy is
     * usually faster than spending WORK time on a source.
     */
    var target = findStoredEnergy(creep);

    if(target) {
        /*
         * Dropped Resource objects have resourceType. Structures like storage
         * and containers do not use resourceType, so this distinguishes pickup
         * from withdraw.
         */
        if(target.resourceType) {
            /*
             * creep.pickup returns ERR_NOT_IN_RANGE when the target is valid but
             * too far away. In that case, moveTo starts walking toward it.
             */
            if(creep.pickup(target) === ERR_NOT_IN_RANGE) {
                creep.moveTo(target, {visualizePathStyle: {stroke: '#ffaa00'}});
            }
        } else if(creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            /*
             * creep.withdraw takes energy out of a structure's store. It also
             * returns ERR_NOT_IN_RANGE when the creep needs to move closer.
             */
            creep.moveTo(target, {visualizePathStyle: {stroke: '#ffaa00'}});
        }
        return;
    }

    // Last fallback: harvest directly if no stored energy is available.
    /*
     * findClosestByPath asks Screeps to choose a reachable source using pathing,
     * not just straight-line range. harvest uses WORK parts to gather energy.
     */
    var source = creep.pos.findClosestByPath(FIND_SOURCES);
    if(source && creep.harvest(source) === ERR_NOT_IN_RANGE) {
        creep.moveTo(source, {visualizePathStyle: {stroke: '#ffaa00'}});
    }
}

function buildOrUpgrade(creep) {
    /*
     * Construction sites are unfinished buildings. Artificers build first
     * because construction turns planned sites into useful structures.
     */
    var target = creep.pos.findClosestByPath(FIND_CONSTRUCTION_SITES);

    if(target) {
        /*
         * creep.build spends carried energy on the site. If the site is too far
         * away, moveTo starts moving the creep toward build range.
         */
        if(creep.build(target) === ERR_NOT_IN_RANGE) {
            creep.moveTo(target, {visualizePathStyle: {stroke: '#ffffff'}});
        }
        return;
    }

    // Builders can help the controller when there is nothing to build.
    /*
     * creep.room.controller is the room controller object when the room has one.
     * upgradeController spends energy to improve your Room Controller Level.
     */
    if(creep.room.controller && creep.upgradeController(creep.room.controller) === ERR_NOT_IN_RANGE) {
        creep.moveTo(creep.room.controller, {visualizePathStyle: {stroke: '#ffffff'}});
    }
}

function findStoredEnergy(creep) {
    /*
     * Prefer storage first because it is the central room energy bank.
     * creep.room.storage is undefined until the room owns a storage structure.
     */
    if(creep.room.storage && creep.room.storage.store[RESOURCE_ENERGY] > 0) {
        return creep.room.storage;
    }

    /*
     * FIND_STRUCTURES returns all visible structures in the room. The filter
     * keeps only containers with at least one energy available.
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
     * Last stored-energy choice is dropped energy on the ground. This returns
     * a Resource object, which collectEnergy later handles with creep.pickup.
     */
    return creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: function(resource) {
            return resource.resourceType === RESOURCE_ENERGY && resource.amount > 0;
        }
    });
}

module.exports = roleArtificer;
