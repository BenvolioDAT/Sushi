var creepUtility = require('utility.Creep');
var utilityTravelCreep = require('utility.Travel.Creep');

var MAX_REPAIR_ARTIFICERS = 2;

var REPAIR_LIST_MEMORY_KEY = 'RepairStructure';
var REPAIR_WORKERS_MEMORY_KEY = 'ArtificerRepairWorkers';
var REPAIR_CLAIMS_MEMORY_KEY = 'ArtificerRepairClaims';

var REPAIR_WORKER_STALE_TICKS = 25;

var roleArtificer = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if(!creep || creep.spawning) {
            return;
        }

        setupRepairMemory(creep.room);
        cleanRepairMemory(creep.room);

        updateWorkingState(creep);

        /*
         * If there is repair work, only 2 Artificers get repair-worker slots.
         * The 3rd Artificer keeps building.
         */
        if(hasRepairWork(creep.room)) {
            claimRepairWorkerSlot(creep);
        } else {
            clearRepairDuty(creep);
        }

        if(creep.memory.builderWorking) {
            repairBuildOrUpgrade(creep);
        } else {
            collectEnergy(creep);
        }
    }
};

function updateWorkingState(creep) {
    if(creep.memory.builderWorking && creep.store[RESOURCE_ENERGY] === 0) {
        creep.memory.builderWorking = false;
    }

    if(!creep.memory.builderWorking && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
        creep.memory.builderWorking = true;
    }
}

function repairBuildOrUpgrade(creep) {
    /*
     * Repair comes before building, but only if this Artificer has one of the
     * 2 repair-worker slots.
     */
    if(isRepairWorker(creep)) {
        if(repairClaimedTarget(creep)) {
            return;
        }
    }

    /*
     * If this Artificer is not a repair worker, or there is no repair target
     * available, do normal Artificer work.
     */
    buildOrUpgrade(creep);
}

function setupRepairMemory(room) {
    if(!Memory.rooms) {
        Memory.rooms = {};
    }

    if(!Memory.rooms[room.name]) {
        Memory.rooms[room.name] = {};
    }

    if(!Memory.rooms[room.name][REPAIR_LIST_MEMORY_KEY]) {
        Memory.rooms[room.name][REPAIR_LIST_MEMORY_KEY] = [];
    }

    if(!Memory.rooms[room.name][REPAIR_WORKERS_MEMORY_KEY]) {
        Memory.rooms[room.name][REPAIR_WORKERS_MEMORY_KEY] = {};
    }

    if(!Memory.rooms[room.name][REPAIR_CLAIMS_MEMORY_KEY]) {
        Memory.rooms[room.name][REPAIR_CLAIMS_MEMORY_KEY] = {};
    }
}

function cleanRepairMemory(room) {
    var roomMemory = Memory.rooms[room.name];
    var workers = roomMemory[REPAIR_WORKERS_MEMORY_KEY];
    var claims = roomMemory[REPAIR_CLAIMS_MEMORY_KEY];

    var creepName;

    /*
     * Remove dead or stale repair workers.
     */
    for(creepName in workers) {
        if(!workers.hasOwnProperty(creepName)) {
            continue;
        }

        if(!Game.creeps[creepName]) {
            delete workers[creepName];
            continue;
        }

        if(Game.time - workers[creepName] > REPAIR_WORKER_STALE_TICKS) {
            delete workers[creepName];
        }
    }

    /*
     * Remove bad target claims.
     */
    for(var targetId in claims) {
        if(!claims.hasOwnProperty(targetId)) {
            continue;
        }

        creepName = claims[targetId];

        var target = Game.getObjectById(targetId);

        if(!Game.creeps[creepName]) {
            delete claims[targetId];
            continue;
        }

        if(!target) {
            delete claims[targetId];
            continue;
        }

        if(!structureNeedsRepair(target)) {
            delete claims[targetId];
            continue;
        }

        if(!workers[creepName]) {
            delete claims[targetId];
        }
    }
}

function claimRepairWorkerSlot(creep) {
    var roomMemory = Memory.rooms[creep.room.name];
    var workers = roomMemory[REPAIR_WORKERS_MEMORY_KEY];

    /*
     * If this creep already has a repair-worker slot, keep it fresh.
     */
    if(workers[creep.name]) {
        workers[creep.name] = Game.time;
        return true;
    }

    /*
     * Count current repair workers.
     */
    var count = 0;

    for(var creepName in workers) {
        if(workers.hasOwnProperty(creepName)) {
            count++;
        }
    }

    /*
     * Only allow 2 Artificers to be repair workers.
     */
    if(count >= MAX_REPAIR_ARTIFICERS) {
        return false;
    }

    workers[creep.name] = Game.time;
    return true;
}

function isRepairWorker(creep) {
    var roomMemory = Memory.rooms[creep.room.name];
    var workers = roomMemory[REPAIR_WORKERS_MEMORY_KEY];

    return !!workers[creep.name];
}

function hasRepairWork(room) {
    var roomMemory = Memory.rooms[room.name];
    var repairList = roomMemory[REPAIR_LIST_MEMORY_KEY];

    if(!repairList || repairList.length === 0) {
        return false;
    }

    for(var i = 0; i < repairList.length; i++) {
        var target = Game.getObjectById(repairList[i]);

        if(target && structureNeedsRepair(target)) {
            return true;
        }
    }

    return false;
}

function repairClaimedTarget(creep) {
    /*
     * First try to keep repairing the target this creep already picked.
     * This makes the Artificer stay on one job until it is done.
     */
    var oldTarget = getRememberedRepairTarget(creep);

    if(oldTarget) {
        return repairTarget(creep, oldTarget);
    }

    /*
     * No remembered target, so claim a new one from room memory.
     */
    var newTarget = claimNewRepairTarget(creep);

    if(newTarget) {
        return repairTarget(creep, newTarget);
    }

    return false;
}

function getRememberedRepairTarget(creep) {
    if(!creep.memory.repairTargetId) {
        return null;
    }

    var target = Game.getObjectById(creep.memory.repairTargetId);

    if(!target || !structureNeedsRepair(target)) {
        releaseRepairTarget(creep);
        return null;
    }

    var roomMemory = Memory.rooms[creep.room.name];
    var claims = roomMemory[REPAIR_CLAIMS_MEMORY_KEY];
    var claimedBy = claims[target.id];

    /*
     * If nobody has the target, claim it.
     */
    if(!claimedBy) {
        claims[target.id] = creep.name;
        return target;
    }

    /*
     * If this creep has the claim, keep it.
     */
    if(claimedBy === creep.name) {
        return target;
    }

    /*
     * Someone else has it. Forget this target.
     */
    delete creep.memory.repairTargetId;
    return null;
}

function claimNewRepairTarget(creep) {
    var roomMemory = Memory.rooms[creep.room.name];
    var repairList = roomMemory[REPAIR_LIST_MEMORY_KEY];
    var claims = roomMemory[REPAIR_CLAIMS_MEMORY_KEY];

    if(!repairList || repairList.length === 0) {
        return null;
    }

    for(var i = 0; i < repairList.length; i++) {
        var targetId = repairList[i];
        var target = Game.getObjectById(targetId);

        if(!target) {
            continue;
        }

        if(!structureNeedsRepair(target)) {
            continue;
        }

        /*
         * If another Artificer already claimed this target, skip it.
         */
        if(claims[targetId] && claims[targetId] !== creep.name) {
            continue;
        }

        /*
         * Claim the target.
         */
        claims[targetId] = creep.name;
        creep.memory.repairTargetId = targetId;

        return target;
    }

    return null;
}

function releaseRepairTarget(creep) {
    if(!creep || !creep.room || !creep.memory.repairTargetId) {
        return;
    }

    var roomMemory = Memory.rooms[creep.room.name];

    if(roomMemory && roomMemory[REPAIR_CLAIMS_MEMORY_KEY]) {
        var claims = roomMemory[REPAIR_CLAIMS_MEMORY_KEY];

        if(claims[creep.memory.repairTargetId] === creep.name) {
            delete claims[creep.memory.repairTargetId];
        }
    }

    delete creep.memory.repairTargetId;
}

function clearRepairDuty(creep) {
    var roomMemory = Memory.rooms[creep.room.name];

    roomMemory[REPAIR_WORKERS_MEMORY_KEY] = {};
    roomMemory[REPAIR_CLAIMS_MEMORY_KEY] = {};

    delete creep.memory.repairTargetId;
}

function structureNeedsRepair(structure) {
    /*
     * This uses the repair rule you added to utility.Creep.js.
     *
     * If utility.Creep.js does not export shouldRepairStructure yet,
     * this fallback still works, but it will repair anything damaged.
     */
    if(creepUtility.shouldRepairStructure) {
        return creepUtility.shouldRepairStructure(structure);
    }

    return structure && structure.hits < structure.hitsMax;
}

function repairTarget(creep, target) {
    /*
     * creep.repair works from range 3.
     */
    var result = creep.repair(target);

    if(result === ERR_NOT_IN_RANGE) {
        utilityTravelCreep.move(creep, target, {
            visualizePathStyle: {
                stroke: '#ffaa00'
            }
        });
    }

    return true;
}

function collectEnergy(creep) {
    var target = findStoredEnergy(creep);

    if(target) {
        if(target.resourceType) {
            if(creep.pickup(target) === ERR_NOT_IN_RANGE) {
                utilityTravelCreep.move(creep, target, {visualizePathStyle: {stroke: '#ffaa00'}});
            }
        } else if(creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            utilityTravelCreep.move(creep, target, {visualizePathStyle: {stroke: '#ffaa00'}});
        }

        return;
    }

    var source = creep.pos.findClosestByPath(FIND_SOURCES);

    if(source && creep.harvest(source) === ERR_NOT_IN_RANGE) {
        utilityTravelCreep.move(creep, source, {visualizePathStyle: {stroke: '#ffaa00'}});
    }
}

function buildOrUpgrade(creep) {
    var target = creep.pos.findClosestByPath(FIND_CONSTRUCTION_SITES);

    if(target) {
        if(creep.build(target) === ERR_NOT_IN_RANGE) {
            utilityTravelCreep.move(creep, target, {visualizePathStyle: {stroke: '#ffffff'}});
        }

        return;
    }

    if(creep.room.controller && creep.upgradeController(creep.room.controller) === ERR_NOT_IN_RANGE) {
        utilityTravelCreep.move(creep, creep.room.controller, {visualizePathStyle: {stroke: '#ffffff'}});
    }
}

function findStoredEnergy(creep) {
    if(creep.room.storage && creep.room.storage.store[RESOURCE_ENERGY] > 0) {
        return creep.room.storage;
    }

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

    return creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: function(resource) {
            return resource.resourceType === RESOURCE_ENERGY && resource.amount > 0;
        }
    });
}

module.exports = roleArtificer;
