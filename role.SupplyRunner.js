/*
 * role.SupplyRunner.js
 *
 * Expansion hauler. SupplyRunners collect energy in the origin room and deliver
 * it to Pioneers or the first spawn construction site in the target room.
 */
var travel = require('utility.Travel.Creep');

var SUPPLY_PATH_STYLE = {
    stroke: '#ffaa00'
};

var roleSupplyRunner = {
    /** @param {Creep} creep **/
    run: function(creep) {
        if (!creep || creep.spawning) {
            return;
        }

        var originRoomName = creep.memory.homeRoom;
        var targetRoomName = creep.memory.targetRoom;

        if (!originRoomName || !targetRoomName) {
            creep.memory.supplyRunnerState = 'idleMissingRoom';
            return;
        }

        if (creep.store[RESOURCE_ENERGY] === 0) {
            creep.memory.supplyRunnerWorking = false;
        }

        if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
            creep.memory.supplyRunnerWorking = true;
        }

        if (!creep.memory.supplyRunnerWorking) {
            collectOriginEnergy(creep, originRoomName);
            return;
        }

        deliverTargetEnergy(creep, targetRoomName);
    }
};

function collectOriginEnergy(creep, originRoomName) {
    if (creep.room.name !== originRoomName) {
        creep.memory.supplyRunnerState = 'movingToOrigin';
        travel.moveToRoom(creep, originRoomName, {
            range: 22,
            visualizePathStyle: SUPPLY_PATH_STYLE
        });
        return true;
    }

    var target = findOriginEnergySource(creep.room);

    if (!target) {
        creep.memory.supplyRunnerState = 'waitingForOriginEnergy';
        return false;
    }

    creep.memory.supplyRunnerState = 'withdrawingOriginEnergy';

    var result = creep.withdraw(target, RESOURCE_ENERGY);

    if (result === OK) {
        return true;
    }

    if (result === ERR_NOT_IN_RANGE) {
        travel.move(creep, target, {
            range: 1,
            visualizePathStyle: SUPPLY_PATH_STYLE
        });
        return true;
    }

    return false;
}

function findOriginEnergySource(room) {
    if (!room) {
        return null;
    }

    if (
        room.storage &&
        room.storage.store &&
        room.storage.store.getUsedCapacity(RESOURCE_ENERGY) >= 500
    ) {
        return room.storage;
    }

    var container = findBestStructureWithEnergy(room, [STRUCTURE_CONTAINER], 100);

    if (container) {
        return container;
    }

    /*
     * Only draw from spawn/extension energy after safer stores are unavailable.
     * The threshold leaves enough room energy for emergency local spawning.
     */
    if (room.energyAvailable <= 550) {
        return null;
    }

    return findBestStructureWithEnergy(
        room,
        [STRUCTURE_SPAWN, STRUCTURE_EXTENSION],
        50
    );
}

function findBestStructureWithEnergy(room, structureTypes, minEnergy) {
    var best = null;
    var bestEnergy = 0;
    var structures = room.find(FIND_STRUCTURES, {
        filter: function(structure) {
            return structureTypes.indexOf(structure.structureType) !== -1 &&
                structure.store &&
                structure.store.getUsedCapacity(RESOURCE_ENERGY) >= minEnergy;
        }
    });

    for (var i = 0; i < structures.length; i++) {
        var energy = structures[i].store.getUsedCapacity(RESOURCE_ENERGY);

        if (energy > bestEnergy) {
            bestEnergy = energy;
            best = structures[i];
        }
    }

    return best;
}

function deliverTargetEnergy(creep, targetRoomName) {
    if (creep.room.name !== targetRoomName) {
        creep.memory.supplyRunnerState = 'movingToTarget';
        travel.moveToRoom(creep, targetRoomName, {
            range: 22,
            visualizePathStyle: SUPPLY_PATH_STYLE
        });
        return true;
    }

    if (transferToPioneer(creep)) {
        return true;
    }

    if (dropNearSpawnSite(creep)) {
        return true;
    }

    if (fillTargetSpawnEnergy(creep)) {
        return true;
    }

    creep.memory.supplyRunnerState = 'droppingEnergy';
    return creep.drop(RESOURCE_ENERGY) === OK;
}

function transferToPioneer(creep) {
    var pioneer = findPioneerNeedingEnergy(creep);

    if (!pioneer) {
        return false;
    }

    creep.memory.supplyRunnerState = 'supplyingPioneer';

    var result = creep.transfer(pioneer, RESOURCE_ENERGY);

    if (result === OK) {
        return true;
    }

    if (result === ERR_NOT_IN_RANGE) {
        travel.move(creep, pioneer, {
            range: 1,
            visualizePathStyle: SUPPLY_PATH_STYLE
        });
        return true;
    }

    return false;
}

function findPioneerNeedingEnergy(creep) {
    var best = null;
    var bestRange = Infinity;

    for (var creepName in Game.creeps) {
        if (!Game.creeps.hasOwnProperty(creepName)) {
            continue;
        }

        var pioneer = Game.creeps[creepName];

        if (
            !pioneer ||
            !pioneer.memory ||
            pioneer.memory.role !== 'Pioneer' ||
            pioneer.memory.targetRoom !== creep.memory.targetRoom ||
            pioneer.room.name !== creep.room.name ||
            pioneer.store.getFreeCapacity(RESOURCE_ENERGY) <= 0
        ) {
            continue;
        }

        if (
            pioneer.memory.needsExpansionEnergy !== true &&
            pioneer.store[RESOURCE_ENERGY] > 0
        ) {
            continue;
        }

        var range = creep.pos.getRangeTo(pioneer);

        if (range < bestRange) {
            best = pioneer;
            bestRange = range;
        }
    }

    return best;
}

function dropNearSpawnSite(creep) {
    var site = getSpawnConstructionSite(creep.room);

    if (!site) {
        return false;
    }

    creep.memory.supplyRunnerState = 'deliveringToSpawnSite';

    if (!creep.pos.inRangeTo(site, 1)) {
        travel.move(creep, site, {
            range: 1,
            visualizePathStyle: SUPPLY_PATH_STYLE
        });
        return true;
    }

    return creep.drop(RESOURCE_ENERGY) === OK;
}

function fillTargetSpawnEnergy(creep) {
    var target = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
        filter: function(structure) {
            return (
                structure.structureType === STRUCTURE_SPAWN ||
                structure.structureType === STRUCTURE_EXTENSION
            ) &&
                structure.store &&
                structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
        }
    });

    if (!target) {
        return false;
    }

    creep.memory.supplyRunnerState = 'fillingTargetSpawnEnergy';

    var result = creep.transfer(target, RESOURCE_ENERGY);

    if (result === OK) {
        return true;
    }

    if (result === ERR_NOT_IN_RANGE) {
        travel.move(creep, target, {
            range: 1,
            visualizePathStyle: SUPPLY_PATH_STYLE
        });
        return true;
    }

    return false;
}

function getSpawnConstructionSite(room) {
    if (!room) {
        return null;
    }

    var expansionSite = Memory.expansion && Memory.expansion.spawnSiteId ?
        Game.getObjectById(Memory.expansion.spawnSiteId) : null;

    if (
        expansionSite &&
        expansionSite.pos &&
        expansionSite.pos.roomName === room.name &&
        expansionSite.structureType === STRUCTURE_SPAWN
    ) {
        return expansionSite;
    }

    var sites = room.find(FIND_MY_CONSTRUCTION_SITES, {
        filter: function(site) {
            return site.structureType === STRUCTURE_SPAWN;
        }
    });

    return sites.length > 0 ? sites[0] : null;
}

module.exports = roleSupplyRunner;
