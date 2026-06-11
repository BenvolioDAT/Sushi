/*
 * role.Artificer.js
 *
 * Builder role with limited repair duty.
 *
 * Artificers normally build construction sites, then upgrade the controller.
 * When the room has repair work, only MAX_REPAIR_ARTIFICERS are allowed to
 * claim repair targets. That cap prevents every builder from abandoning
 * construction because one road is damaged.
 */
var creepUtility = require('utility.Creep');
var utilityTravelCreep = require('utility.Travel.Creep');

var MAX_REPAIR_ARTIFICERS = 2;

var REPAIR_LIST_MEMORY_KEY = 'RepairStructure';
var REPAIR_WORKERS_MEMORY_KEY = 'ArtificerRepairWorkers';
var REPAIR_CLAIMS_MEMORY_KEY = 'ArtificerRepairClaims';

var REPAIR_WORKER_STALE_TICKS = 25;

var REMOTE_ROAD_REPAIR_START_PERCENT = 0.60;
var REMOTE_CONTAINER_REPAIR_START_PERCENT = 0.80;
var REMOTE_WORK_EMPTY_SCAN_COOLDOWN = 15;

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
            repairBuildRemoteBuildOrUpgrade(creep);
        } else {
            collectEnergyForArtificer(creep);
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

function repairBuildRemoteBuildOrUpgrade(creep) {
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
    if(buildLocalConstruction(creep)) {
        return;
    }

    if(doRemoteInfrastructureWork(creep)) {
        return;
    }

    upgradeController(creep);
}

function setupRepairMemory(room) {
    /*
     * This function creates the Memory buckets used by the repair-claim system.
     *
     * RepairStructure:
     * - shared list of damaged structure ids, written by main.js.
     *
     * ArtificerRepairWorkers:
     * - map of creepName -> last tick seen as an active repair worker.
     *
     * ArtificerRepairClaims:
     * - map of targetId -> creepName so two Artificers do not choose the same
     *   damaged structure unless the old claim expires.
     */
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
     * Remove dead or stale repair workers. Staleness matters because a creep can
     * switch jobs or stop running this branch without dying; after enough ticks,
     * another Artificer should be allowed to take that repair slot.
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
     * Remove bad target claims. A claim is bad if the creep died, the target is
     * gone, the structure no longer needs repair, or the creep no longer owns a
     * live repair-worker slot.
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

function collectEnergyForArtificer(creep) {
    /*
     * Artificer energy collection mirrors Repair: use stored or dropped energy
     * first, then harvest only if no reusable energy is available. If the creep
     * is already in its remote work room, it refills there instead of walking
     * home empty.
     */
    if(creep.memory.remoteWorkTargetId && creep.memory.remoteWorkRoomName === creep.room.name) {
        if(collectRemoteEnergy(creep)) {
            return;
        }
    }

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

function buildLocalConstruction(creep) {
    var homeRoomName = getHomeRoomName(creep);

    if(homeRoomName && creep.room.name !== homeRoomName) {
        return false;
    }

    /*
     * Construction wins over controller upgrading because new structures often
     * unlock capacity, defense, or logistics. Remote infrastructure is checked
     * only after the local room has no construction work.
     */
    var target = creep.pos.findClosestByPath(FIND_CONSTRUCTION_SITES);

    if(!target) {
        return false;
    }

    if(creep.build(target) === ERR_NOT_IN_RANGE) {
        utilityTravelCreep.move(creep, target, {visualizePathStyle: {stroke: '#ffffff'}});
    }

    return true;
}

function upgradeController(creep) {
    var homeRoomName = getHomeRoomName(creep);

    /*
     * Artificers should not spend spare energy on remote controllers. If remote
     * work is done while they are away from home, send them home before using
     * controller upgrading as the fallback job.
     */
    if(homeRoomName && creep.room.name !== homeRoomName) {
        utilityTravelCreep.moveToRoom(creep, homeRoomName, {range: 22, visualizePathStyle: {stroke: '#ffffff'}});
        return;
    }

    if(creep.room.controller && creep.upgradeController(creep.room.controller) === ERR_NOT_IN_RANGE) {
        utilityTravelCreep.move(creep, creep.room.controller, {visualizePathStyle: {stroke: '#ffffff'}});
    }
}


function doRemoteInfrastructureWork(creep) {
    var target = getRememberedRemoteWorkTarget(creep);

    if(!target) {
        if(travelToRememberedRemoteWorkPosition(creep)) {
            return true;
        }

        target = findRemoteInfrastructureTarget(creep);
    }

    if(!target) {
        return false;
    }

    doBuildOrRepairTarget(creep, target, creep.memory.remoteWorkType);
    return true;
}

function getRememberedRemoteWorkTarget(creep) {
    if(!creep.memory.remoteWorkTargetId) {
        return null;
    }

    var roomName = creep.memory.remoteWorkRoomName;

    var target = Game.getObjectById(creep.memory.remoteWorkTargetId);

    if(!target) {
        /*
         * Game.getObjectById returns null for objects in rooms we cannot see.
         * Keep the target while traveling there, and only forget it after the
         * creep reaches that room and still cannot find the object.
         */
        if(roomName && creep.room.name === roomName) {
            clearRemoteWorkTarget(creep);
        }

        return null;
    }

    if(creep.memory.remoteWorkType === 'repairRemoteContainer' || creep.memory.remoteWorkType === 'repairRemoteRoad') {
        if(target.hits >= target.hitsMax) {
            clearRemoteWorkTarget(creep);
            return null;
        }
    } else if(target.progressTotal !== undefined && target.progress >= target.progressTotal) {
        clearRemoteWorkTarget(creep);
        return null;
    }

    return target;
}


function travelToRememberedRemoteWorkPosition(creep) {
    var roomName = creep.memory.remoteWorkRoomName;

    if(!creep.memory.remoteWorkTargetId || !roomName || creep.room.name === roomName) {
        return false;
    }

    if(creep.memory.remoteWorkX === undefined || creep.memory.remoteWorkY === undefined) {
        utilityTravelCreep.moveToRoom(creep, roomName, {range: 22, visualizePathStyle: {stroke: '#ffffff'}});
        return true;
    }

    utilityTravelCreep.move(creep, new RoomPosition(creep.memory.remoteWorkX, creep.memory.remoteWorkY, roomName), {
        range: 3,
        visualizePathStyle: {
            stroke: '#ffffff'
        }
    });
    return true;
}

function findRemoteInfrastructureTarget(creep) {
    if(creep.memory.remoteWorkNextScan && Game.time < creep.memory.remoteWorkNextScan) {
        return null;
    }

    var homeRoomName = getHomeRoomName(creep);
    var remoteRooms = getActiveRemoteRoomNames(homeRoomName);
    var target;

    if(remoteRooms.length === 0) {
        creep.memory.remoteWorkNextScan = Game.time + REMOTE_WORK_EMPTY_SCAN_COOLDOWN;
        return null;
    }

    target = findBestRemoteConstructionSite(creep, remoteRooms, STRUCTURE_CONTAINER);
    if(target) {
        rememberRemoteWorkTarget(creep, target, 'buildRemoteContainer');
        return target;
    }

    target = findBestRemoteConstructionSite(creep, remoteRooms, STRUCTURE_ROAD);
    if(target) {
        rememberRemoteWorkTarget(creep, target, 'buildRemoteRoad');
        return target;
    }

    target = findBestRemoteRepairTarget(creep, remoteRooms, STRUCTURE_CONTAINER);
    if(target) {
        rememberRemoteWorkTarget(creep, target, 'repairRemoteContainer');
        return target;
    }

    target = findBestRemoteRepairTarget(creep, remoteRooms, STRUCTURE_ROAD);
    if(target) {
        rememberRemoteWorkTarget(creep, target, 'repairRemoteRoad');
        return target;
    }

    creep.memory.remoteWorkNextScan = Game.time + REMOTE_WORK_EMPTY_SCAN_COOLDOWN;
    return null;
}

function rememberRemoteWorkTarget(creep, target, workType) {
    creep.memory.remoteWorkTargetId = target.id;
    creep.memory.remoteWorkRoomName = target.pos.roomName;
    creep.memory.remoteWorkX = target.pos.x;
    creep.memory.remoteWorkY = target.pos.y;
    creep.memory.remoteWorkType = workType;
    creep.memory.remoteWorkHomeRoom = getHomeRoomName(creep);
}

function clearRemoteWorkTarget(creep) {
    delete creep.memory.remoteWorkTargetId;
    delete creep.memory.remoteWorkRoomName;
    delete creep.memory.remoteWorkX;
    delete creep.memory.remoteWorkY;
    delete creep.memory.remoteWorkType;
    delete creep.memory.remoteWorkHomeRoom;
}

function getHomeRoomName(creep) {
    if(creep.memory.homeRoom) {
        return creep.memory.homeRoom;
    }

    if(creep.memory.home) {
        return creep.memory.home;
    }

    if(Memory.firstSpawnRoom) {
        return Memory.firstSpawnRoom;
    }

    return creep.room.name;
}

function getActiveRemoteRoomNames(homeRoomName) {
    var roomMemory = Memory.rooms && Memory.rooms[homeRoomName];
    var planner = roomMemory && roomMemory.remotePlanner;
    var roomNames = [];
    var seen = {};

    if(!planner || !planner.sourceInfos || !planner.activeSourceIds) {
        return roomNames;
    }

    for(var i = 0; i < planner.activeSourceIds.length; i++) {
        var sourceId = planner.activeSourceIds[i];
        var sourceInfo = planner.sourceInfos[sourceId];
        var remoteRoomName = getRemoteRoomNameFromSourceInfo(sourceInfo, homeRoomName);

        if(!remoteRoomName || remoteRoomName === homeRoomName || seen[remoteRoomName] || !Game.rooms[remoteRoomName]) {
            continue;
        }

        seen[remoteRoomName] = true;
        roomNames.push(remoteRoomName);
    }

    return roomNames;
}

function getRemoteRoomNameFromSourceInfo(sourceInfo, homeRoomName) {
    if(!sourceInfo) {
        return null;
    }

    if(sourceInfo.roomName) {
        return sourceInfo.roomName;
    }

    if(sourceInfo.sourceRoomName) {
        return sourceInfo.sourceRoomName;
    }

    if(typeof sourceInfo.room === 'string') {
        return sourceInfo.room;
    }

    if(sourceInfo.pos && sourceInfo.pos.roomName) {
        return sourceInfo.pos.roomName;
    }

    if(sourceInfo.roadCoords) {
        for(var roomName in sourceInfo.roadCoords) {
            if(sourceInfo.roadCoords.hasOwnProperty(roomName) && roomName !== homeRoomName && Game.rooms[roomName]) {
                return roomName;
            }
        }
    }

    return null;
}

function findBestRemoteConstructionSite(creep, remoteRooms, structureType) {
    return findBestRemoteTarget(creep, remoteRooms, function(room) {
        return room.find(FIND_MY_CONSTRUCTION_SITES, {
            filter: function(site) {
                return site.structureType === structureType;
            }
        });
    });
}

function findBestRemoteRepairTarget(creep, remoteRooms, structureType) {
    return findBestRemoteTarget(creep, remoteRooms, function(room) {
        return room.find(FIND_STRUCTURES, {
            filter: function(structure) {
                return structure.structureType === structureType && remoteStructureNeedsRepair(structure);
            }
        });
    });
}

function findBestRemoteTarget(creep, remoteRooms, roomTargetFinder) {
    var firstTarget = null;
    var closestTarget = null;
    var closestRange = 999;

    for(var i = 0; i < remoteRooms.length; i++) {
        var roomName = remoteRooms[i];
        var room = Game.rooms[roomName];

        if(!room) {
            continue;
        }

        var targets = roomTargetFinder(room);

        if(!targets || targets.length === 0) {
            continue;
        }

        if(!firstTarget) {
            firstTarget = targets[0];
        }

        if(creep.room.name === roomName) {
            for(var j = 0; j < targets.length; j++) {
                var range = creep.pos.getRangeTo(targets[j]);

                if(range < closestRange) {
                    closestRange = range;
                    closestTarget = targets[j];
                }
            }
        }
    }

    return closestTarget || firstTarget;
}

function remoteStructureNeedsRepair(structure) {
    if(!structure || structure.hits >= structure.hitsMax) {
        return false;
    }

    if(structure.structureType === STRUCTURE_CONTAINER) {
        return structure.hits < structure.hitsMax * REMOTE_CONTAINER_REPAIR_START_PERCENT;
    }

    if(structure.structureType === STRUCTURE_ROAD) {
        return structure.hits < structure.hitsMax * REMOTE_ROAD_REPAIR_START_PERCENT;
    }

    return false;
}

function doBuildOrRepairTarget(creep, target, workType) {
    var result;

    if(workType === 'buildRemoteContainer' || workType === 'buildRemoteRoad') {
        result = creep.build(target);
    } else {
        result = creep.repair(target);
    }

    if(result === ERR_NOT_IN_RANGE) {
        utilityTravelCreep.move(creep, target, {range: 3, visualizePathStyle: {stroke: '#ffffff'}});
    }
}

function collectRemoteEnergy(creep) {
    var target = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
        filter: function(resource) {
            return resource.resourceType === RESOURCE_ENERGY && resource.amount > 0;
        }
    });

    if(target) {
        if(creep.pickup(target) === ERR_NOT_IN_RANGE) {
            utilityTravelCreep.move(creep, target, {range: 1, visualizePathStyle: {stroke: '#ffaa00'}});
        }
        return true;
    }

    target = creep.pos.findClosestByRange(FIND_TOMBSTONES, {
        filter: function(tombstone) {
            return tombstone.store && tombstone.store[RESOURCE_ENERGY] > 0;
        }
    });

    if(!target) {
        target = creep.pos.findClosestByRange(FIND_RUINS, {
            filter: function(ruin) {
                return ruin.store && ruin.store[RESOURCE_ENERGY] > 0;
            }
        });
    }

    if(target) {
        if(creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            utilityTravelCreep.move(creep, target, {range: 1, visualizePathStyle: {stroke: '#ffaa00'}});
        }
        return true;
    }

    target = creep.pos.findClosestByRange(FIND_STRUCTURES, {
        filter: function(structure) {
            return structure.structureType === STRUCTURE_CONTAINER && structure.store && structure.store[RESOURCE_ENERGY] > 0;
        }
    });

    if(target) {
        if(creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            utilityTravelCreep.move(creep, target, {range: 1, visualizePathStyle: {stroke: '#ffaa00'}});
        }
        return true;
    }

    target = findClosestActiveRemoteSource(creep);

    if(target) {
        if(creep.harvest(target) === ERR_NOT_IN_RANGE) {
            utilityTravelCreep.move(creep, target, {range: 1, visualizePathStyle: {stroke: '#ffaa00'}});
        }
        return true;
    }

    return false;
}

function findClosestActiveRemoteSource(creep) {
    var homeRoomName = creep.memory.remoteWorkHomeRoom || getHomeRoomName(creep);
    var roomMemory = Memory.rooms && Memory.rooms[homeRoomName];
    var planner = roomMemory && roomMemory.remotePlanner;
    var closestSource = null;
    var closestRange = 999;

    if(!planner || !planner.activeSourceIds || !planner.sourceInfos) {
        return creep.pos.findClosestByRange(FIND_SOURCES);
    }

    for(var i = 0; i < planner.activeSourceIds.length; i++) {
        var sourceId = planner.activeSourceIds[i];
        var sourceInfo = planner.sourceInfos[sourceId];
        var sourceRoomName = getRemoteRoomNameFromSourceInfo(sourceInfo, homeRoomName);

        if(sourceRoomName !== creep.room.name) {
            continue;
        }

        var source = Game.getObjectById(sourceId);

        if(!source) {
            continue;
        }

        var range = creep.pos.getRangeTo(source);

        if(range < closestRange) {
            closestRange = range;
            closestSource = source;
        }
    }

    return closestSource || creep.pos.findClosestByRange(FIND_SOURCES);
}

function findStoredEnergy(creep) {
    /*
     * Pick up dropped energy in the room first.
     *
     * creep.pos.findClosestByPath searches from this creep's current position,
     * so this only looks in the room the creep is currently standing in.
     */
    var droppedEnergy = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: function(resource) {
            return resource.resourceType === RESOURCE_ENERGY && resource.amount > 0;
        }
    });

    if(droppedEnergy) {
        return droppedEnergy;
    }

    /*
     * If no dropped energy exists, use storage.
     */
    if(creep.room.storage && creep.room.storage.store[RESOURCE_ENERGY] > 0) {
        return creep.room.storage;
    }

    /*
     * If no storage energy is available, use the closest container.
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

    return null;
}

module.exports = roleArtificer;
