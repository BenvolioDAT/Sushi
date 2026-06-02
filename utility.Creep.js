/*
 * utility.Creep.js
 *
 * Reusable creep helper functions for Sushi.
 *
 * Role files should make the decisions.
 * This file should do common actions.
 *
 * Example:
 * - role.Queen.js decides "I need energy."
 * - utility.Creep.js handles "withdraw from storage" or "pick up dropped energy."
 */

var travel = require('utility.Travel.Creep');

/**
 * Check if the creep has any energy.
 *
 * @param {Creep} creep
 * @returns {boolean}
 */
function hasEnergy(creep) {
    if (!creep || !creep.store) {
        return false;
    }

    return creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
}

/**
 * Check if the creep has no energy.
 *
 * @param {Creep} creep
 * @returns {boolean}
 */
function isEmpty(creep) {
    return !hasEnergy(creep);
}

/**
 * Check if the creep's energy carry is full.
 *
 * @param {Creep} creep
 * @returns {boolean}
 */
function isFull(creep) {
    if (!creep || !creep.store) {
        return false;
    }

    return creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0;
}

/**
 * Pick up a specific dropped energy pile.
 *
 * Returns true if the creep picked it up or moved toward it.
 * Returns false if the target is invalid.
 *
 * @param {Creep} creep
 * @param {Resource} droppedEnergy
 * @returns {boolean}
 */
function pickupEnergy(creep, droppedEnergy) {
    if (!creep || !droppedEnergy) {
        return false;
    }

    if (droppedEnergy.resourceType !== RESOURCE_ENERGY) {
        return false;
    }

    var result = creep.pickup(droppedEnergy);

    if (result === OK) {
        return true;
    }

    if (result === ERR_NOT_IN_RANGE) {
        travel.move(creep, droppedEnergy, {
            range: 1
        });

        return true;
    }

    return false;
}

/**
 * Find and pick up the closest dropped energy.
 *
 * This is useful for early rooms and cleanup behavior.
 *
 * @param {Creep} creep
 * @returns {boolean}
 */
function pickupClosestDroppedEnergy(creep) {
    if (!creep || !creep.room) {
        return false;
    }

    if (isFull(creep)) {
        return false;
    }

    var droppedEnergy = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: function(resource) {
            return resource.resourceType === RESOURCE_ENERGY && resource.amount > 0;
        }
    });

    if (!droppedEnergy) {
        return false;
    }

    return pickupEnergy(creep, droppedEnergy);
}

/**
 * Withdraw energy from a specific target.
 *
 * Good targets:
 * - storage
 * - container
 * - link
 * - tombstone
 * - ruin
 *
 * @param {Creep} creep
 * @param {*} target - Object with a store.
 * @returns {boolean}
 */
function withdrawEnergy(creep, target) {
    if (!creep || !target || !target.store) {
        return false;
    }

    if (isFull(creep)) {
        return false;
    }

    if ((target.store.getUsedCapacity(RESOURCE_ENERGY) || 0) <= 0) {
        return false;
    }

    var result = creep.withdraw(target, RESOURCE_ENERGY);

    if (result === OK) {
        return true;
    }

    if (result === ERR_NOT_IN_RANGE) {
        travel.move(creep, target, {
            range: 1
        });

        return true;
    }

    return false;
}

/**
 * Withdraw energy from room storage.
 *
 * @param {Creep} creep
 * @returns {boolean}
 */
function withdrawFromStorage(creep) {
    if (!creep || !creep.room || !creep.room.storage) {
        return false;
    }

    return withdrawEnergy(creep, creep.room.storage);
}

/**
 * Withdraw energy from the closest container with energy.
 *
 * @param {Creep} creep
 * @returns {boolean}
 */
function withdrawFromClosestContainer(creep) {
    if (!creep || !creep.room) {
        return false;
    }

    if (isFull(creep)) {
        return false;
    }

    var container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
        filter: function(structure) {
            return structure.structureType === STRUCTURE_CONTAINER &&
                structure.store &&
                structure.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
        }
    });

    if (!container) {
        return false;
    }

    return withdrawEnergy(creep, container);
}

/**
 * Withdraw energy from the closest tombstone.
 *
 * @param {Creep} creep
 * @returns {boolean}
 */
function withdrawFromClosestTombstone(creep) {
    if (!creep || !creep.room) {
        return false;
    }

    if (isFull(creep)) {
        return false;
    }

    var tombstone = creep.pos.findClosestByPath(FIND_TOMBSTONES, {
        filter: function(target) {
            return target.store &&
                target.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
        }
    });

    if (!tombstone) {
        return false;
    }

    return withdrawEnergy(creep, tombstone);
}

/**
 * Withdraw energy from the closest ruin.
 *
 * @param {Creep} creep
 * @returns {boolean}
 */
function withdrawFromClosestRuin(creep) {
    if (!creep || !creep.room) {
        return false;
    }

    if (isFull(creep)) {
        return false;
    }

    var ruin = creep.pos.findClosestByPath(FIND_RUINS, {
        filter: function(target) {
            return target.store &&
                target.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
        }
    });

    if (!ruin) {
        return false;
    }

    return withdrawEnergy(creep, ruin);
}

/**
 * Harvest from a specific source.
 *
 * @param {Creep} creep
 * @param {Source} source
 * @returns {boolean}
 */
function harvestEnergy(creep, source) {
    if (!creep || !source) {
        return false;
    }

    if (isFull(creep)) {
        return false;
    }

    var result = creep.harvest(source);

    if (result === OK) {
        return true;
    }

    if (result === ERR_NOT_IN_RANGE) {
        travel.move(creep, source, {
            range: 1
        });

        return true;
    }

    return false;
}

/**
 * Harvest from the closest source.
 *
 * @param {Creep} creep
 * @returns {boolean}
 */
function harvestClosestSource(creep) {
    if (!creep || !creep.room) {
        return false;
    }

    if (isFull(creep)) {
        return false;
    }

    var source = creep.pos.findClosestByPath(FIND_SOURCES);

    if (!source) {
        return false;
    }

    return harvestEnergy(creep, source);
}

/**
 * Simple general-purpose energy getter.
 *
 * Priority:
 * 1. dropped energy
 * 2. tombstones
 * 3. ruins
 * 4. storage
 * 5. containers
 * 6. harvest from source
 *
 * This is good for simple roles like Upgrader or Builder.
 * For Queen/Trucker, you may want more specific helpers later.
 *
 * @param {Creep} creep
 * @returns {boolean}
 */
function getEnergy(creep) {
    if (!creep) {
        return false;
    }

    if (isFull(creep)) {
        return false;
    }

    if (pickupClosestDroppedEnergy(creep)) {
        return true;
    }

    if (withdrawFromClosestTombstone(creep)) {
        return true;
    }

    if (withdrawFromClosestRuin(creep)) {
        return true;
    }

    if (withdrawFromStorage(creep)) {
        return true;
    }

    if (withdrawFromClosestContainer(creep)) {
        return true;
    }

    if (harvestClosestSource(creep)) {
        return true;
    }

    return false;
}

/**
 * Transfer energy to a specific target.
 *
 * Good targets:
 * - spawn
 * - extension
 * - tower
 * - storage
 * - container
 *
 * @param {Creep} creep
 * @param {*} target - Object with a store.
 * @returns {boolean}
 */
function transferEnergy(creep, target) {
    if (!creep || !target || !target.store) {
        return false;
    }

    if (isEmpty(creep)) {
        return false;
    }

    if (target.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) {
        return false;
    }

    var result = creep.transfer(target, RESOURCE_ENERGY);

    if (result === OK) {
        return true;
    }

    if (result === ERR_NOT_IN_RANGE) {
        travel.move(creep, target, {
            range: 1
        });

        return true;
    }

    return false;
}

/**
 * Find the closest spawn or extension that needs energy.
 *
 * Useful for Queen or early harvesters.
 *
 * @param {Creep} creep
 * @returns {*|null}
 */
function findClosestSpawnOrExtensionNeedingEnergy(creep) {
    if (!creep || !creep.room) {
        return null;
    }

    return creep.pos.findClosestByPath(FIND_STRUCTURES, {
        filter: function(structure) {
            var isSpawnOrExtension =
                structure.structureType === STRUCTURE_SPAWN ||
                structure.structureType === STRUCTURE_EXTENSION;

            return isSpawnOrExtension &&
                structure.store &&
                structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
        }
    });
}

/**
 * Find the closest tower that needs energy.
 *
 * @param {Creep} creep
 * @returns {*|null}
 */
function findClosestTowerNeedingEnergy(creep) {
    if (!creep || !creep.room) {
        return null;
    }

    return creep.pos.findClosestByPath(FIND_STRUCTURES, {
        filter: function(structure) {
            return structure.structureType === STRUCTURE_TOWER &&
                structure.store &&
                structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
        }
    });
}

/**
 * Fill spawn/extensions first, then towers.
 *
 * This is useful for Queen.
 *
 * @param {Creep} creep
 * @returns {boolean}
 */
function fillBaseEnergy(creep) {
    if (!creep || isEmpty(creep)) {
        return false;
    }

    var target = findClosestSpawnOrExtensionNeedingEnergy(creep);

    if (target) {
        return transferEnergy(creep, target);
    }

    target = findClosestTowerNeedingEnergy(creep);

    if (target) {
        return transferEnergy(creep, target);
    }

    return false;
}

/**
 * Drop energy on the ground.
 *
 * Not something you use often, but useful for testing or emergency behavior.
 *
 * @param {Creep} creep
 * @returns {boolean}
 */
function dropEnergy(creep) {
    if (!creep || isEmpty(creep)) {
        return false;
    }

    var result = creep.drop(RESOURCE_ENERGY);

    return result === OK;
}

module.exports = {
    hasEnergy: hasEnergy,
    isEmpty: isEmpty,
    isFull: isFull,

    pickupEnergy: pickupEnergy,
    pickupClosestDroppedEnergy: pickupClosestDroppedEnergy,

    withdrawEnergy: withdrawEnergy,
    withdrawFromStorage: withdrawFromStorage,
    withdrawFromClosestContainer: withdrawFromClosestContainer,
    withdrawFromClosestTombstone: withdrawFromClosestTombstone,
    withdrawFromClosestRuin: withdrawFromClosestRuin,

    harvestEnergy: harvestEnergy,
    harvestClosestSource: harvestClosestSource,

    getEnergy: getEnergy,

    transferEnergy: transferEnergy,
    findClosestSpawnOrExtensionNeedingEnergy: findClosestSpawnOrExtensionNeedingEnergy,
    findClosestTowerNeedingEnergy: findClosestTowerNeedingEnergy,
    fillBaseEnergy: fillBaseEnergy,

    dropEnergy: dropEnergy
};