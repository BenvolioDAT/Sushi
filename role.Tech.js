/*
 * role.Tech.js
 *
 * Upgrader role.
 *
 * Tech keeps the controller upgraded. The teaching point in this file is
 * priority ordering: a controller-adjacent container is best for upgrader CPU
 * and travel time, then storage, then opportunistic free energy, then mining as
 * the slow emergency fallback.
 */
var creepUtility = require('utility.Creep');
var travel = require('utility.Travel.Creep');

var roleTech = {
    run: function(creep) {
        /*
         * Tech is the upgrader role.
         *
         * creep.memory.upgrading:
         * false = collect energy
         * true  = upgrade controller
         */
        if (creep.memory.upgrading && creepUtility.isEmpty(creep)) {
            creep.memory.upgrading = false;
        }

        if (!creep.memory.upgrading && creepUtility.isFull(creep)) {
            creep.memory.upgrading = true;
        }

        if (creep.memory.upgrading) {
            upgradeRoomController(creep);
            return;
        }

        /*
         * Tech uses its own energy order now:
         *
         * 1. Controller container
         * 2. Storage
         * 3. Local dropped energy stockpiles, but not source drops
         * 4. Tombstones
         * 5. Ruins
         * 6. Source containers
         * 7. Mine its own energy
         */
        getEnergyForTech(creep);
    }
};

function upgradeRoomController(creep) {
    if (!creep.room.controller) {
        return;
    }

    /*
     * Upgrading works from range 3.
     * So we move to range 3 instead of standing directly on top of the controller.
     */
    if (creep.upgradeController(creep.room.controller) === ERR_NOT_IN_RANGE) {
        travel.move(creep, creep.room.controller, {
            range: 3
        });
    }
}

function getEnergyForTech(creep) {
    if (!creep || !creep.room) {
        return false;
    }

    if (creepUtility.isFull(creep)) {
        return false;
    }

    /*
     * Priority 1:
     * Use the controller container first.
     *
     * This keeps the Tech working near the controller instead of running across
     * the room like a confused shopping cart.
     */
    if (withdrawFromControllerContainer(creep)) {
        return true;
    }

    /*
     * Priority 2:
     * If the controller container is empty, use storage next.
     */
    if (creepUtility.withdrawFromStorage(creep)) {
        return true;
    }

    /*
     * Priority 3:
     * Pick up local dropped energy stockpiles, but not source drops.
     *
     * Freighters may drop energy near spawn as a shared stockpile for worker
     * creeps. Tech should use that pile, but should not steal dropped energy
     * beside sources because source logistics and Freighters own that flow.
     */
    if (pickupDroppedEnergyForTech(creep)) {
        return true;
    }

    /*
     * Priority 4:
     * Pull energy from tombstones.
     * Tombstones are fallen creeps. If they have energy, grab it before
     * checking ruins because tombstones decay away faster.
     */

    if (creepUtility.withdrawFromClosestTombstone(creep)) {
        return true;
    }

    /*
     * Priority 5:
     * Pull energy from ruins.
     */
    if (creepUtility.withdrawFromClosestRuin(creep)) {
        return true;
    }

    /*
     * Priority 6:
     * Withdraw from source containers.
     *
     * This comes after storage because Tech should not steal source-container
     * energy unless the better upgrader fuel spots are empty.
     */
    if (withdrawFromSourceContainer(creep)) {
        return true;
    }

    /*
     * Priority 7:
     * Last resort. Mine its own energy.
     *
     * This is slow, but it keeps the Tech alive in a weak room.
     */
    if (creepUtility.harvestClosestSource(creep)) {
        return true;
    }

    return false;
}

function withdrawFromControllerContainer(creep) {
    var container = findControllerContainerWithEnergy(creep);

    if (!container) {
        return false;
    }

    return creepUtility.withdrawEnergy(creep, container);
}

function findControllerContainerWithEnergy(creep) {
    if (!creep || !creep.room || !creep.room.controller) {
        return null;
    }

    /*
     * Range 3 is intentional.
     *
     * A Tech can stand near this container, withdraw energy, and still be close
     * enough to upgrade the controller. This catches both truly adjacent
     * containers and good upgrader containers placed a couple tiles away.
     */
    return creep.pos.findClosestByPath(FIND_STRUCTURES, {
        filter: function(structure) {
            return (
                structure.structureType === STRUCTURE_CONTAINER &&
                structure.store &&
                structure.store.getUsedCapacity(RESOURCE_ENERGY) > 0 &&
                structure.pos.getRangeTo(creep.room.controller) <= 3
            );
        }
    });
}

function pickupDroppedEnergyForTech(creep) {
    var droppedEnergy = findDroppedEnergyForTech(creep);

    if (!droppedEnergy) {
        return false;
    }

    return creepUtility.pickupEnergy(creep, droppedEnergy);
}

function findDroppedEnergyForTech(creep) {
    if (!creep || !creep.room) {
        return null;
    }

    /*
     * Freighters can create useful dropped-energy stockpiles near spawn.
     * Choose the closest usable pile by path, like Artificers do.
     *
     * Drops close to sources are intentionally ignored. Those piles belong to
     * source logistics, where Freighters or source workers should handle them.
     */
    return creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: function(resource) {
            return (
                resource.resourceType === RESOURCE_ENERGY &&
                resource.amount > 0 &&
                resource.pos.findInRange(FIND_SOURCES, 3).length === 0
            );
        }
    });
}

function withdrawFromSourceContainer(creep) {
    var container = findSourceContainerWithEnergy(creep);

    if (!container) {
        return false;
    }

    return creepUtility.withdrawEnergy(creep, container);
}

function findSourceContainerWithEnergy(creep) {
    if (!creep || !creep.room) {
        return null;
    }

    /*
     * Source containers are containers within range 2 of a source.
     *
     * This keeps the Tech from treating the controller container as a source
     * container too. We already checked the controller container first.
     */
    return creep.pos.findClosestByPath(FIND_STRUCTURES, {
        filter: function(structure) {
            return (
                structure.structureType === STRUCTURE_CONTAINER &&
                structure.store &&
                structure.store.getUsedCapacity(RESOURCE_ENERGY) > 0 &&
                structure.pos.findInRange(FIND_SOURCES, 2).length > 0
            );
        }
    });
}

module.exports = roleTech;
