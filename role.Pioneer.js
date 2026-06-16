/*
 * role.Pioneer.js
 *
 * Expansion worker sent from the origin room to the target room. Pioneers build
 * the first spawn, then continue with basic construction or controller upgrade.
 */
var travel = require('utility.Travel.Creep');

var PIONEER_PATH_STYLE = {
    stroke: '#66d9ff'
};

var rolePioneer = {
    /** @param {Creep} creep **/
    run: function(creep) {
        if (!creep || creep.spawning) {
            return;
        }

        var targetRoomName = creep.memory.targetRoom;

        if (!targetRoomName) {
            creep.memory.pioneerState = 'idleNoTarget';
            return;
        }

        if (creep.room.name !== targetRoomName) {
            creep.memory.pioneerState = 'movingToTargetRoom';
            travel.moveToRoom(creep, targetRoomName, {
                range: 22,
                visualizePathStyle: PIONEER_PATH_STYLE
            });
            return;
        }

        if (creep.store[RESOURCE_ENERGY] === 0) {
            creep.memory.pioneerWorking = false;
        }

        if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
            creep.memory.pioneerWorking = true;
        }

        if (!creep.memory.pioneerWorking) {
            collectEnergy(creep);
            return;
        }

        if (buildSpawnSite(creep)) {
            return;
        }

        if (buildBootstrapConstruction(creep)) {
            return;
        }

        upgradeController(creep);
    }
};

function collectEnergy(creep) {
    creep.memory.needsExpansionEnergy = true;

    if (pickupDroppedEnergy(creep)) {
        return true;
    }

    if (withdrawNearbyStoredEnergy(creep)) {
        return true;
    }

    if (moveTowardSupplyRunner(creep)) {
        return true;
    }

    return harvestLocalSource(creep);
}

function pickupDroppedEnergy(creep) {
    var dropped = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: function(resource) {
            return resource.resourceType === RESOURCE_ENERGY && resource.amount > 0;
        }
    });

    if (!dropped) {
        return false;
    }

    var result = creep.pickup(dropped);

    if (result === OK) {
        return true;
    }

    if (result === ERR_NOT_IN_RANGE) {
        travel.move(creep, dropped, {
            range: 1,
            visualizePathStyle: PIONEER_PATH_STYLE
        });
        return true;
    }

    return false;
}

function withdrawNearbyStoredEnergy(creep) {
    var target = creep.pos.findClosestByPath(FIND_STRUCTURES, {
        filter: function(structure) {
            return (
                structure.structureType === STRUCTURE_CONTAINER ||
                structure.structureType === STRUCTURE_STORAGE
            ) &&
                structure.store &&
                structure.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
        }
    });

    if (!target) {
        return false;
    }

    var result = creep.withdraw(target, RESOURCE_ENERGY);

    if (result === OK) {
        return true;
    }

    if (result === ERR_NOT_IN_RANGE) {
        travel.move(creep, target, {
            range: 1,
            visualizePathStyle: PIONEER_PATH_STYLE
        });
        return true;
    }

    return false;
}

function moveTowardSupplyRunner(creep) {
    var runner = findEnergySupplyRunner(creep);

    if (!runner) {
        return false;
    }

    creep.memory.requestedSupplyRunner = runner.name;

    if (creep.pos.inRangeTo(runner, 1)) {
        return true;
    }

    travel.move(creep, runner, {
        range: 1,
        visualizePathStyle: PIONEER_PATH_STYLE
    });

    return true;
}

function findEnergySupplyRunner(creep) {
    var best = null;
    var bestRange = Infinity;
    var targetRoomName = creep.memory.targetRoom;

    for (var creepName in Game.creeps) {
        if (!Game.creeps.hasOwnProperty(creepName)) {
            continue;
        }

        var runner = Game.creeps[creepName];

        if (
            !runner ||
            !runner.memory ||
            runner.memory.role !== 'SupplyRunner' ||
            runner.memory.targetRoom !== targetRoomName ||
            runner.store[RESOURCE_ENERGY] <= 0 ||
            runner.room.name !== creep.room.name
        ) {
            continue;
        }

        var range = creep.pos.getRangeTo(runner);

        if (range < bestRange) {
            best = runner;
            bestRange = range;
        }
    }

    return best;
}

function harvestLocalSource(creep) {
    var source = creep.pos.findClosestByPath(FIND_SOURCES);

    if (!source) {
        return false;
    }

    var result = creep.harvest(source);

    if (result === OK) {
        return true;
    }

    if (result === ERR_NOT_IN_RANGE) {
        travel.move(creep, source, {
            range: 1,
            visualizePathStyle: PIONEER_PATH_STYLE
        });
        return true;
    }

    return false;
}

function buildSpawnSite(creep) {
    var site = getSpawnConstructionSite(creep.room);

    if (!site) {
        return false;
    }

    creep.memory.needsExpansionEnergy = false;
    creep.memory.pioneerState = 'buildingSpawn';
    return buildSite(creep, site);
}

function buildBootstrapConstruction(creep) {
    var site = creep.pos.findClosestByPath(FIND_MY_CONSTRUCTION_SITES, {
        filter: function(constructionSite) {
            return constructionSite.structureType === STRUCTURE_EXTENSION ||
                constructionSite.structureType === STRUCTURE_CONTAINER ||
                constructionSite.structureType === STRUCTURE_ROAD;
        }
    });

    if (!site) {
        site = creep.pos.findClosestByPath(FIND_MY_CONSTRUCTION_SITES);
    }

    if (!site) {
        return false;
    }

    creep.memory.needsExpansionEnergy = false;
    creep.memory.pioneerState = 'buildingBootstrap';
    return buildSite(creep, site);
}

function buildSite(creep, site) {
    var result = creep.build(site);

    if (result === OK) {
        return true;
    }

    if (result === ERR_NOT_IN_RANGE) {
        travel.move(creep, site, {
            range: 3,
            visualizePathStyle: PIONEER_PATH_STYLE
        });
        return true;
    }

    return false;
}

function upgradeController(creep) {
    if (!creep.room.controller || !creep.room.controller.my) {
        return false;
    }

    creep.memory.needsExpansionEnergy = false;
    creep.memory.pioneerState = 'upgrading';

    var result = creep.upgradeController(creep.room.controller);

    if (result === ERR_NOT_IN_RANGE) {
        travel.move(creep, creep.room.controller, {
            range: 3,
            visualizePathStyle: PIONEER_PATH_STYLE
        });
        return true;
    }

    return result === OK;
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

module.exports = rolePioneer;
