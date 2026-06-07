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
var utility = require('utility');
var travel = require('utility.Travel.Creep');

/**
 * Check if the creep has any energy.
 *
 * @param {Creep} creep
 * @returns {boolean}
 */
function hasEnergy(creep) {
    /*
     * creep.store is the Screeps inventory object for creeps. Guarding it keeps
     * this helper safe if a bad value is passed from a role.
     */
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
    /*
     * A dropped resource is different from a structure. It has resourceType and
     * amount instead of a store.
     */
    if (!creep || !droppedEnergy) {
        return false;
    }

    if (droppedEnergy.resourceType !== RESOURCE_ENERGY) {
        return false;
    }

    var result = creep.pickup(droppedEnergy);

    /*
     * OK means the pickup happened this tick. ERR_NOT_IN_RANGE means the target
     * exists but the creep must walk closer before picking it up.
     */
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
    /*
     * findClosestByPath uses Screeps pathfinding to choose a reachable target,
     * which is usually better than simply choosing the closest by range.
     */
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
    /*
     * withdraw only works on objects with a .store, such as storage,
     * containers, links, tombstones, and ruins.
     */
    if (!creep || !target || !target.store) {
        return false;
    }

    if (isFull(creep)) {
        return false;
    }

    if ((target.store.getUsedCapacity(RESOURCE_ENERGY) || 0) <= 0) {
        return false;
    }

    /*
     * creep.withdraw moves energy from the target store into the creep store.
     */
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

    /*
     * FIND_STRUCTURES includes all visible structures. The filter narrows this
     * to containers that actually have energy available.
     */
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

    /*
     * Tombstones appear when creeps die. Recovering their energy prevents waste.
     */
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

    /*
     * Ruins can contain resources after structures are destroyed. They use the
     * same store API as many structures.
     */
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

    /*
     * harvest uses the creep's WORK parts. It returns OK when energy is gained,
     * or ERR_NOT_IN_RANGE when the creep needs to stand next to the source.
     */
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

    /*
     * Each helper returns true if it took action or started moving toward a
     * target. Returning immediately prevents the creep from trying multiple
     * energy jobs in the same tick.
     */
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
    /*
     * transfer only works on targets with a store and free capacity.
     */
    if (!creep || !target || !target.store) {
        return false;
    }

    if (isEmpty(creep)) {
        return false;
    }

    if (target.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) {
        return false;
    }

    /*
     * creep.transfer moves energy from the creep into the target. It returns
     * ERR_NOT_IN_RANGE if the target is valid but too far away.
     */
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

    /*
     * Spawns and extensions are the first priority because they are required to
     * create new creeps. This search includes only structures with free energy
     * capacity.
     */
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

function updateWorkingState(creep, memoryKey) {
    /*
     * memoryKey lets several roles reuse the same two-state pattern while each
     * role keeps its own flag, such as foremanWorking or repairWorking.
     */
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
    /*
     * This shared collector reads room storage first, then containers, then
     * dropped energy. It writes no Memory, but it may issue movement commands.
     */
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
    /*
     * This helper is used by Foreman. It chooses a structure that needs energy
     * and transfers to it, or idles near base if everything is full.
     */
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
    /*
     * FIND_MY_STRUCTURES returns only your structures. The filter keeps spawns
     * and extensions with remaining energy capacity.
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

function findTower(creep) {
    /*
     * Towers use energy for attacks, healing, and repairs. This helper finds
     * the closest owned tower that can accept more energy.
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

function idleNearBase(creep) {
    /*
     * Use storage as the home anchor when it exists. Otherwise, fall back to the
     * closest owned spawn. Staying near the base reduces future travel time.
     */
    var anchor = creep.room.storage || creep.pos.findClosestByPath(FIND_MY_SPAWNS);
    if(anchor && creep.pos.getRangeTo(anchor) > 2) {
        creep.moveTo(anchor, {visualizePathStyle: {stroke: '#bbbbbb'}});
    }
}

/**
 * Find or claim the best source for this Veinseeker.
 *
 * This function does several jobs:
 * 1. Looks at Memory.rooms[roomName].sources.
 * 2. Cleans dead creep IDs out of each source's assignedMinner list.
 * 3. Keeps this creep on its old source if the assignment is still valid.
 * 4. Otherwise picks the source with the fewest assigned miners.
 * 5. Respects seatCount, so a source with 3 seats can hold up to 3 miners.
 *
 * @param {Creep} creep
 * @returns {Source|null}
 */
function getAssignedSource(creep) {
    if(!creep || !creep.room) {
        return null;
    }

    var sourceRecords = getSourceRecordsFromRoomMemory(creep);

    if(!sourceRecords || sourceRecords.length === 0) {
        return getFallbackAssignedSource(creep);
    }

    // Make sure this creep is not listed under more than one source.
    removeCreepFromAllSourceAssignments(sourceRecords, creep.id);

    // If this creep already remembers a source, try to keep that source.
    // Stable assignments are good because they stop creeps from bouncing around.
    var existingSource = reclaimRememberedSource(creep, sourceRecords);

    if(existingSource) {
        return existingSource;
    }

    // No valid old source was found, so pick the best source now.
    var bestRecord = findBestSourceRecord(creep, sourceRecords);

    if(!bestRecord) {
        return null;
    }

    claimSourceRecord(creep, bestRecord);

    return bestRecord.source;
}

/**
 * Build a clean list of source records from room memory.
 *
 * A "source record" is just a small helper object that keeps the real Source,
 * the source memory, the source ID, and the seat count together.
 *
 * @param {Creep} creep
 * @returns {Array}
 */
function getSourceRecordsFromRoomMemory(creep) {
    var roomMemory = Memory.rooms && Memory.rooms[creep.room.name];

    if(!roomMemory || !roomMemory.sources) {
        return [];
    }

    var sourceRecords = [];

    for(var sourceId in roomMemory.sources) {
        if(!roomMemory.sources.hasOwnProperty(sourceId)) {
            continue;
        }

        var sourceMemory = roomMemory.sources[sourceId];

        if(!sourceMemory) {
            continue;
        }

        // Your room scanner stores the ID inside the source memory,
        // but the memory key also appears to be the source ID.
        // This supports both formats.
        var realSourceId = sourceMemory.id || sourceId;
        var source = Game.getObjectById(realSourceId);

        if(!source) {
            continue;
        }

        normalizeAssignedMinnerList(sourceMemory);
        cleanDeadAssignedMinners(sourceMemory);

        sourceRecords.push({
            sourceId: realSourceId,
            source: source,
            sourceMemory: sourceMemory,
            seatCount: getSafeSeatCount(sourceMemory)
        });
    }

    return sourceRecords;
}

/**
 * Make sure sourceMemory.assignedMinner is always an array.
 *
 * This lets the code support:
 * - assignedMinner: null
 * - assignedMinner: "oneCreepId"
 * - assignedMinner: ["creepIdOne", "creepIdTwo"]
 *
 * @param {*} sourceMemory
 */
function normalizeAssignedMinnerList(sourceMemory) {
    if(!sourceMemory.assignedMinner) {
        sourceMemory.assignedMinner = [];
        return;
    }

    if(Array.isArray(sourceMemory.assignedMinner)) {
        return;
    }

    if(typeof sourceMemory.assignedMinner === 'string') {
        sourceMemory.assignedMinner = [sourceMemory.assignedMinner];
        return;
    }

    sourceMemory.assignedMinner = [];
}

/**
 * Remove dead creep IDs and duplicate creep IDs from one source's assignedMinner list.
 *
 * Game.getObjectById(id) returns the object if it can be found, or null if it
 * cannot be found. That makes it useful for clearing dead creep IDs.
 *
 * @param {*} sourceMemory
 */
function cleanDeadAssignedMinners(sourceMemory) {
    var cleanList = [];
    var seenIds = {};

    for(var i = 0; i < sourceMemory.assignedMinner.length; i++) {
        var creepId = sourceMemory.assignedMinner[i];

        if(!creepId) {
            continue;
        }

        if(seenIds[creepId]) {
            continue;
        }

        var assignedCreep = Game.getObjectById(creepId);

        if(!assignedCreep || !assignedCreep.my) {
            continue;
        }

        seenIds[creepId] = true;
        cleanList.push(creepId);
    }

    sourceMemory.assignedMinner = cleanList;
}

/**
 * Read seatCount safely.
 *
 * If the room scanner did not save seatCount yet, use 1 as the safe default.
 *
 * @param {*} sourceMemory
 * @returns {number}
 */
function getSafeSeatCount(sourceMemory) {
    if(!sourceMemory.seatCount || sourceMemory.seatCount < 1) {
        return 1;
    }

    return sourceMemory.seatCount;
}

/**
 * Remove this creep from every source assignment list.
 *
 * This prevents one creep from accidentally being claimed by Source A and Source B.
 *
 * @param {Array} sourceRecords
 * @param {string} creepId
 */
function removeCreepFromAllSourceAssignments(sourceRecords, creepId) {
    for(var i = 0; i < sourceRecords.length; i++) {
        var sourceMemory = sourceRecords[i].sourceMemory;
        var newList = [];

        for(var j = 0; j < sourceMemory.assignedMinner.length; j++) {
            if(sourceMemory.assignedMinner[j] !== creepId) {
                newList.push(sourceMemory.assignedMinner[j]);
            }
        }

        sourceMemory.assignedMinner = newList;
    }
}

/**
 * Try to keep the creep on the source saved in creep.memory.sourceId.
 *
 * @param {Creep} creep
 * @param {Array} sourceRecords
 * @returns {Source|null}
 */
function reclaimRememberedSource(creep, sourceRecords) {
    if(!creep.memory.sourceId) {
        return null;
    }

    for(var i = 0; i < sourceRecords.length; i++) {
        var record = sourceRecords[i];

        if(record.sourceId !== creep.memory.sourceId) {
            continue;
        }

        // If this source has an open seat, claim it again.
        if(record.sourceMemory.assignedMinner.length < record.seatCount) {
            record.sourceMemory.assignedMinner.push(creep.id);
            return record.source;
        }

        // If this source is full, forget it and pick a new one.
        delete creep.memory.sourceId;
        return null;
    }

    // The remembered source no longer exists in room memory.
    delete creep.memory.sourceId;
    return null;
}

/**
 * Pick the best source for this creep.
 *
 * Rule:
 * - Prefer sources that still have open seats.
 * - Among open sources, pick the one with the fewest assigned miners.
 * - If tied, pick the closer one.
 * - If all sources are full, pick the least crowded source anyway.
 *
 * @param {Creep} creep
 * @param {Array} sourceRecords
 * @returns {*|null}
 */
function findBestSourceRecord(creep, sourceRecords) {
    var bestOpenRecord = null;
    var bestOverflowRecord = null;

    for(var i = 0; i < sourceRecords.length; i++) {
        var record = sourceRecords[i];
        var assignedCount = record.sourceMemory.assignedMinner.length;

        if(assignedCount < record.seatCount) {
            if(isBetterSourceChoice(creep, record, bestOpenRecord)) {
                bestOpenRecord = record;
            }

            continue;
        }

        if(isBetterOverflowChoice(creep, record, bestOverflowRecord)) {
            bestOverflowRecord = record;
        }
    }

    return bestOpenRecord || bestOverflowRecord;
}

/**
 * Decide if this source is better than the current best open source.
 *
 * @param {Creep} creep
 * @param {*} candidateRecord
 * @param {*} bestRecord
 * @returns {boolean}
 */
function isBetterSourceChoice(creep, candidateRecord, bestRecord) {
    if(!bestRecord) {
        return true;
    }

    var candidateCount = candidateRecord.sourceMemory.assignedMinner.length;
    var bestCount = bestRecord.sourceMemory.assignedMinner.length;

    if(candidateCount < bestCount) {
        return true;
    }

    if(candidateCount > bestCount) {
        return false;
    }

    return creep.pos.getRangeTo(candidateRecord.source) < creep.pos.getRangeTo(bestRecord.source);
}

/**
 * Decide if this source is the least bad overflow choice.
 *
 * This only matters when all sources are already at or above seatCount.
 *
 * @param {Creep} creep
 * @param {*} candidateRecord
 * @param {*} bestRecord
 * @returns {boolean}
 */
function isBetterOverflowChoice(creep, candidateRecord, bestRecord) {
    if(!bestRecord) {
        return true;
    }

    var candidatePressure = candidateRecord.sourceMemory.assignedMinner.length / candidateRecord.seatCount;
    var bestPressure = bestRecord.sourceMemory.assignedMinner.length / bestRecord.seatCount;

    if(candidatePressure < bestPressure) {
        return true;
    }

    if(candidatePressure > bestPressure) {
        return false;
    }

    return creep.pos.getRangeTo(candidateRecord.source) < creep.pos.getRangeTo(bestRecord.source);
}

/**
 * Claim a source for this creep.
 *
 * This writes both:
 * - creep.memory.sourceId
 * - Memory.rooms[roomName].sources[sourceId].assignedMinner
 *
 * @param {Creep} creep
 * @param {*} sourceRecord
 */
function claimSourceRecord(creep, sourceRecord) {
    sourceRecord.sourceMemory.assignedMinner.push(creep.id);
    creep.memory.sourceId = sourceRecord.sourceId;
}

/**
 * Fallback for rooms that do not have source memory yet.
 *
 * This keeps your Veinseeker from completely shutting down if your room scanner
 * has not created Memory.rooms[roomName].sources yet.
 *
 * @param {Creep} creep
 * @returns {Source|null}
 */
function getFallbackAssignedSource(creep) {
    var source = null;

    if(creep.memory.sourceId) {
        source = Game.getObjectById(creep.memory.sourceId);

        if(source) {
            return source;
        }

        delete creep.memory.sourceId;
    }

    var sources = creep.room.find(FIND_SOURCES);

    if(!sources || sources.length === 0) {
        return null;
    }

    source = creep.pos.findClosestByPath(sources) || sources[0];
    creep.memory.sourceId = source.id;

    return source;
}
/////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////
// Repair helpers. These are used by creeps but they are separate from
// the main energy collection and transfer helpers because repair logic can be
// complex and you may want to reuse the repair rules in other roles later, such
// as Foreman or other creeps with WORK parts that can repair as a side job.

var REPAIR_LIMITS = {
    /*
     * Roads and containers decay over time, so repair them when they drop below
     * 80%, then repair them all the way to full.
     */
    normalRepairPercent: 0.80,

    /*
     * Ramparts and walls have crazy huge max hits.
     * Do NOT repair them to full. That is how your energy goes into the shadow realm.
     */
    rampartTargetHits: 10000,
    wallTargetHits: 10000
};

function shouldRepairStructure(structure) {
    /*
     * Safety check.
     */
    if (!structure) {
        return false;
    }

    /*
     * If it is already fully repaired, skip it.
     */
    if (structure.hits >= structure.hitsMax) {
        return false;
    }

    /*
     * Ramparts:
     * Only repair if below our chosen rampart limit.
     *
     * Example:
     * If rampartTargetHits is 10000, repair ramparts until they reach 10000.
     */
    if (structure.structureType === STRUCTURE_RAMPART) {
        return structure.hits < REPAIR_LIMITS.rampartTargetHits;
    }

    /*
     * Walls:
     * Same idea as ramparts. Do not try to repair walls to hitsMax.
     */
    if (structure.structureType === STRUCTURE_WALL) {
        return structure.hits < REPAIR_LIMITS.wallTargetHits;
    }

    /*
     * Everything else:
     * Repair only when it drops below 80%.
     *
     * Example:
     * Container max hits = 250000.
     * 80% damaged threshold means start repairing below 200000.
     */
    return structure.hits < structure.hitsMax * REPAIR_LIMITS.normalRepairPercent;
}


function getRepairTargetFromMemory(creep) {
    /*
     * Safety check.
     */
    if (!creep || !creep.room) {
        return null;
    }

    /*
     * Get this room's repair list.
     *
     * Memory path:
     * Memory.rooms[roomName].RepairStructure
     */
    var roomMemory = Memory.rooms && Memory.rooms[creep.room.name];

    if (!roomMemory || !roomMemory.RepairStructure) {
        return null;
    }

    var repairList = roomMemory.RepairStructure;

    /*
     * Go through the saved structure IDs.
     */
    for (var i = 0; i < repairList.length; i++) {
        var structureId = repairList[i];

        /*
         * Convert ID back into the real structure object.
         */
        var structure = Game.getObjectById(structureId);

        /*
         * If the object is gone, skip it.
         */
        if (!structure) {
            continue;
        }

        /*
         * Ask our repair rule:
         * "Is this worth repairing right now?"
         */
        if (shouldRepairStructure(structure)) {
            return structure;
        }
    }

    return null;
}

function repairFromMemory(creep) {
    var target = getRepairTargetFromMemory(creep);

    if (!target) {
        return false;
    }

    /*
     * Creep repair works within range 3.
     * If too far away, move closer.
     */
    if (creep.repair(target) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, {
            visualizePathStyle: {
                stroke: '#ffaa00'
            }
        });
    }

    return true;
}
///////////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////////
// ============================================================================
// Exports
// ============================================================================
module.exports = {
    hasEnergy,
    isEmpty,
    isFull,

    updateWorkingState,
    collectEnergy,
    fillRoomEnergy,

    pickupEnergy,
    pickupClosestDroppedEnergy,

    withdrawEnergy,
    withdrawFromStorage,
    withdrawFromClosestContainer,
    withdrawFromClosestTombstone,
    withdrawFromClosestRuin,

    harvestEnergy,
    harvestClosestSource,

    getEnergy,

    transferEnergy,
    findClosestSpawnOrExtensionNeedingEnergy,
    findClosestTowerNeedingEnergy,
    fillBaseEnergy,

    getAssignedSource,

    dropEnergy,
};
