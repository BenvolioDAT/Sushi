/*
 * role.Freighter.js
 *
 * Hauler role.
 *
 * Freighters move mined energy from the source side of the room to the base
 * side. The role uses lightweight reservations in creep memory so multiple
 * Freighters spread across piles/containers instead of all choosing the same
 * largest target every tick.
 */
var travel = require('utility.Travel.Creep');
var RemotePlanner = require('Planner.Remote');

var MIN_DROPPED_ENERGY = 50;
var MIN_CONTAINER_ENERGY = 50;

var roleFreighter = {

    /** @param {Creep} creep **/
    run: function(creep) {
        /*
         * Freighters are haulers.
         *
         * They collect energy from:
         * 1. dropped energy piles first
         * 2. source containers second
         *
         * Then they deliver that energy to the base.
         */
        if(!creep || creep.spawning) {
            return;
        }

        updateWorkingState(creep);

        if(creep.memory.FreighterWorking) {
            if(creep.memory.remoteFreighting || creep.memory.remoteReturning) {
                deliverRemoteEnergy(creep);
            } else {
                deliverEnergy(creep);
            }
        } else {
            collectEnergy(creep);
        }
    }
};

function updateWorkingState(creep) {
    /*
     * If the Freighter was delivering but is now empty,
     * switch back to collection mode.
     */
    if(creep.memory.FreighterWorking && creep.store[RESOURCE_ENERGY] === 0) {
        creep.memory.FreighterWorking = false;
        if(creep.memory.remoteFreighting || creep.memory.remoteReturning) {
            clearRemoteReturnMemory(creep);
        } else {
            clearPickupMemory(creep);
        }
    }

    /*
     * If the Freighter was collecting and is now full,
     * switch to delivery mode.
     *
     * We also clear pickup memory so this creep stops reserving
     * the old pickup target.
     */
    if(!creep.memory.FreighterWorking && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
        creep.memory.FreighterWorking = true;
        clearPickupMemory(creep);
    }
}

function collectEnergy(creep) {
    /*
     * If this Freighter is already committed to a remote target, keep traveling
     * to it. A non-visible remote target is not treated as invalid until the
     * Freighter actually has room vision and can prove it disappeared or emptied.
     */
    if(creep.memory.remoteFreighting) {
        if(handleRemoteCollection(creep)) {
            return;
        }

        var replacementRemotePickup = RemotePlanner.getBestRemotePickupForFreighter(creep);
        if(replacementRemotePickup) {
            RemotePlanner.claimRemotePickupTarget(creep, replacementRemotePickup);
            handleRemoteCollection(creep);
            return;
        }

        if(creep.store[RESOURCE_ENERGY] > 0) {
            creep.memory.FreighterWorking = true;
            deliverRemoteEnergy(creep);
            return;
        }

        moveTowardHomeRoom(creep);
        return;
    }

    if(creep.memory.remoteFreightingWanted) {
        /*
         * Remote-wanted Freighters count as remote hauling capacity, so they try
         * remote work before local crumbs. If no remote target is ready, the flag
         * stays and local pickup can be used only as temporary fallback work.
         */
        var wantedRemotePickup = RemotePlanner.getBestRemotePickupForFreighter(creep);

        if(wantedRemotePickup) {
            RemotePlanner.claimRemotePickupTarget(creep, wantedRemotePickup);
            handleRemoteCollection(creep);
            return;
        }
    }

    /*
     * Normal Freighters still prefer local hauling first. Remote-wanted
     * Freighters reach this block only after no remote pickup was available.
     */
    var target = getRememberedPickupTarget(creep);

    if(!target) {
        target = findBestDroppedEnergyTarget(creep);

        if(!target) {
            target = findBestSourceContainerTarget(creep);
        }
    }

    if(target) {
        collectFromTarget(creep, target);
        return;
    }

    var remotePickup = RemotePlanner.getBestRemotePickupForFreighter(creep);

    if(remotePickup) {
        RemotePlanner.claimRemotePickupTarget(creep, remotePickup);
        handleRemoteCollection(creep);
        return;
    }

    idleNearUsefulSource(creep);
}

function handleRemoteCollection(creep) {
    if(!creep.memory.remoteFreighting) {
        return false;
    }

    var remoteRoomName = creep.memory.freighterRemoteRoom;
    var remoteRoom = remoteRoomName ? Game.rooms[remoteRoomName] : null;

    if(remoteRoom && isRemoteRoomDangerous(remoteRoom)) {
        /*
         * If danger appears while carrying partial cargo, switch to delivery
         * before clearing remote pickup memory. This keeps the home room saved
         * and prevents the Freighter from forgetting to bring energy home.
         */
        var homeRoomName = creep.memory.freighterHomeRoom || creep.memory.homeRoom;

        if(creep.store[RESOURCE_ENERGY] > 0) {
            creep.memory.FreighterWorking = true;
            creep.memory.remoteReturning = true;
            creep.memory.homeRoom = homeRoomName || creep.memory.homeRoom;
            creep.memory.freighterHomeRoom = homeRoomName || creep.memory.homeRoom;
            clearRemotePickupOnly(creep);
            deliverRemoteEnergy(creep);
            return true;
        }

        clearRemoteReturnMemory(creep);
        moveTowardHomeRoom(creep);
        return true;
    }

    var targetId = creep.memory.freighterPickupTargetId;
    var target = targetId ? Game.getObjectById(targetId) : null;

    if(target) {
        if(!isValidEnergyPickupTarget(target)) {
            RemotePlanner.clearRemoteFreighterMemory(creep);
            return false;
        }

        collectFromRemoteTarget(creep, target);
        return true;
    }

    /*
     * If the target room is visible and the id no longer resolves, the target is
     * really gone. If the room is not visible, keep traveling toward the remote
     * source/path instead of clearing useful memory too early.
     */
    if(remoteRoom && creep.room.name === remoteRoomName) {
        RemotePlanner.clearRemoteFreighterMemory(creep);
        return false;
    }

    return RemotePlanner.moveFreighterToRemotePickup(creep);
}


function getRememberedPickupTarget(creep) {
    if(creep.memory.remoteFreighting) {
        return null;
    }

    if(!creep.memory.freighterPickupTargetId) {
        return null;
    }

    var target = Game.getObjectById(creep.memory.freighterPickupTargetId);

    if(!isValidEnergyPickupTarget(target)) {
        clearPickupMemory(creep);
        return null;
    }

    return target;
}

function clearPickupMemory(creep) {
    delete creep.memory.freighterPickupTargetId;
    delete creep.memory.freighterPickupSourceId;
    delete creep.memory.freighterPickupType;
}

function clearRemotePickupOnly(creep) {
    /*
     * Used when a remote Freighter must return home with partial cargo. We clear
     * only the pickup reservation, not the home-return state, so next tick still
     * uses deliverRemoteEnergy() instead of local delivery logic.
     */
    var homeRoomName = creep.memory.freighterHomeRoom || creep.memory.homeRoom;

    if(
        homeRoomName &&
        Memory.rooms &&
        Memory.rooms[homeRoomName] &&
        Memory.rooms[homeRoomName].remotePlanner &&
        Memory.rooms[homeRoomName].remotePlanner.remoteFreighterAssignments
    ) {
        delete Memory.rooms[homeRoomName].remotePlanner.remoteFreighterAssignments[creep.name];
    }

    delete creep.memory.freighterRemoteRoom;
    delete creep.memory.freighterPickupTargetId;
    delete creep.memory.freighterPickupSourceId;
    delete creep.memory.freighterPickupType;
}

function clearRemoteReturnMemory(creep) {
    /*
     * Fully clear remote return state after energy has been delivered or when an
     * empty remote Freighter is no longer assigned. Keep remoteFreightingWanted:
     * spawn-demand Freighters should keep preferring future remote work.
     */
    var keepRemoteWanted = creep.memory.remoteFreightingWanted === true;

    clearRemotePickupOnly(creep);
    delete creep.memory.remoteFreighting;
    delete creep.memory.remoteReturning;

    if(!keepRemoteWanted) {
        delete creep.memory.freighterHomeRoom;
    }
}

function isValidEnergyPickupTarget(target) {
    if(!target) {
        return false;
    }

    /*
     * Dropped resources have:
     * - resourceType
     * - amount
     */
    if(target.resourceType) {
        return target.resourceType === RESOURCE_ENERGY && target.amount > 0;
    }

    /*
     * Containers have:
     * - store
     */
    if(target.store) {
        return getStoredEnergy(target) > 0;
    }

    return false;
}

function collectFromTarget(creep, target) {
    var result;

    /*
     * Dropped energy uses pickup().
     */
    if(target.resourceType) {
        result = creep.pickup(target);
    } else {
        /*
         * Containers use withdraw().
         */
        result = creep.withdraw(target, RESOURCE_ENERGY);
    }

    if(result === OK) {
        return;
    }

    if(result === ERR_NOT_IN_RANGE) {
        travel.move(creep, target, {
            range: 1,
            visualizePathStyle: {
                stroke: '#ffaa00'
            }
        });
        return;
    }

    /*
     * If something went wrong, forget the target.
     *
     * Example:
     * - target became empty
     * - target disappeared
     * - target is no longer usable
     */
    clearPickupMemory(creep);
}

function findBestDroppedEnergyTarget(creep) {
    var droppedEnergyList = creep.room.find(FIND_DROPPED_RESOURCES, {
        filter: function(resource) {
            return (
                resource.resourceType === RESOURCE_ENERGY &&
                resource.amount >= MIN_DROPPED_ENERGY
            );
        }
    });

    if(!droppedEnergyList || droppedEnergyList.length === 0) {
        return null;
    }

    var reservations = buildFreighterReservations(creep);
    var bestOption = null;

    /*
     * Pass 1:
     * Pick the biggest dropped pile that has no Freighter assigned yet.
     *
     * This creates the split behavior.
     *
     * Example:
     * - pile A has 500 energy
     * - pile B has 300 energy
     * - pile C has 100 energy
     *
     * Freighter 1 picks A.
     * Freighter 2 sees A is already reserved, so it picks B.
     * Freighter 3 sees A and B reserved, so it picks C.
     */
    for(var i = 0; i < droppedEnergyList.length; i++) {
        var drop = droppedEnergyList[i];
        var reservedCount = reservations.byTargetCount[drop.id] || 0;

        if(reservedCount > 0) {
            continue;
        }

        if(!bestOption || isBetterDroppedEnergyOption(creep, drop, bestOption)) {
            bestOption = drop;
        }
    }

    if(bestOption) {
        rememberPickupTarget(creep, bestOption, getSourceIdNearTarget(bestOption, 3), 'dropped');
        return bestOption;
    }

    /*
     * Pass 2:
     * If every dropped pile already has at least one Freighter,
     * send extra Freighters to the pile with the most unreserved energy.
     *
     * This means big piles can get more than one Freighter,
     * but only after the smaller piles also got attention.
     */
    var bestRemainingDrop = null;
    var bestRemainingAmount = 0;
    var bestReservedCount = 999999;

    for(var j = 0; j < droppedEnergyList.length; j++) {
        var candidate = droppedEnergyList[j];

        var reservedEnergy = reservations.byTargetEnergy[candidate.id] || 0;
        var candidateReservedCount = reservations.byTargetCount[candidate.id] || 0;
        var remainingAmount = candidate.amount - reservedEnergy;

        if(remainingAmount <= 0) {
            continue;
        }

        /*
         * Prefer fewer assigned Freighters first.
         * If tied, prefer the most remaining energy.
         */
        if(
            candidateReservedCount < bestReservedCount ||
            (
                candidateReservedCount === bestReservedCount &&
                remainingAmount > bestRemainingAmount
            )
        ) {
            bestRemainingDrop = candidate;
            bestRemainingAmount = remainingAmount;
            bestReservedCount = candidateReservedCount;
        }
    }

    if(bestRemainingDrop) {
        rememberPickupTarget(creep, bestRemainingDrop, getSourceIdNearTarget(bestRemainingDrop, 3), 'dropped');
        return bestRemainingDrop;
    }

    return null;
}

function isBetterDroppedEnergyOption(creep, candidate, currentBest) {
    /*
     * Biggest pile wins.
     */
    if(candidate.amount > currentBest.amount) {
        return true;
    }

    if(candidate.amount < currentBest.amount) {
        return false;
    }

    /*
     * If same amount, closer wins.
     */
    return creep.pos.getRangeTo(candidate) < creep.pos.getRangeTo(currentBest);
}

function findBestSourceContainerTarget(creep) {
    var sourceContainers = getSourceContainerOptions(creep);

    if(!sourceContainers || sourceContainers.length === 0) {
        return null;
    }

    var reservations = buildFreighterReservations(creep);
    var bestOption = null;

    for(var i = 0; i < sourceContainers.length; i++) {
        var option = sourceContainers[i];

        var reservedEnergy = reservations.byTargetEnergy[option.target.id] || 0;
        var remainingEnergy = option.amount - reservedEnergy;

        /*
         * If other Freighters already have enough carry capacity reserved
         * to empty this container, skip it.
         */
        if(remainingEnergy <= 0) {
            continue;
        }

        if(!bestOption || isBetterContainerOption(creep, option, bestOption, reservations)) {
            bestOption = option;
        }
    }

    if(!bestOption) {
        return null;
    }

    rememberPickupTarget(creep, bestOption.target, bestOption.sourceId, 'container');

    return bestOption.target;
}

function getSourceContainerOptions(creep) {
    var containers = creep.room.find(FIND_STRUCTURES, {
        filter: function(structure) {
            return (
                structure.structureType === STRUCTURE_CONTAINER &&
                structure.store &&
                getStoredEnergy(structure) >= MIN_CONTAINER_ENERGY &&
                getSourceNearPosition(structure.pos, 2) !== null
            );
        }
    });

    var options = [];

    for(var i = 0; i < containers.length; i++) {
        var container = containers[i];
        var source = getSourceNearPosition(container.pos, 2);

        if(!source) {
            continue;
        }

        options.push({
            target: container,
            sourceId: source.id,
            amount: getStoredEnergy(container)
        });
    }

    return options;
}

function isBetterContainerOption(creep, candidate, currentBest, reservations) {
    var candidateAssignedCount = reservations.bySourceCount[candidate.sourceId] || 0;
    var bestAssignedCount = reservations.bySourceCount[currentBest.sourceId] || 0;

    /*
     * Main rule:
     * Pick the source container with fewer assigned Freighters.
     *
     * This is what gives you:
     * - 2 Freighters, 2 source containers = 1 and 1
     * - 4 Freighters, 2 source containers = 2 and 2
     */
    if(candidateAssignedCount < bestAssignedCount) {
        return true;
    }

    if(candidateAssignedCount > bestAssignedCount) {
        return false;
    }

    /*
     * If both source containers have the same number of Freighters assigned,
     * choose the one with more energy.
     */
    if(candidate.amount > currentBest.amount) {
        return true;
    }

    if(candidate.amount < currentBest.amount) {
        return false;
    }

    /*
     * If energy is tied too, pick the closer one.
     */
    return creep.pos.getRangeTo(candidate.target) < creep.pos.getRangeTo(currentBest.target);
}

function rememberPickupTarget(creep, target, sourceId, pickupType) {
    if(creep.memory.remoteFreighting) {
        RemotePlanner.clearRemoteFreighterMemory(creep);
    }

    /*
     * These memory fields are not permanent ownership. They are an intent:
     * "this Freighter is currently heading to this target/source." Other
     * Freighters read those intents when spreading themselves across work.
     */
    creep.memory.freighterPickupTargetId = target.id;
    creep.memory.freighterPickupSourceId = sourceId || target.id;
    creep.memory.freighterPickupType = pickupType;
}

function buildFreighterReservations(creep) {
    /*
     * Reservation maps summarize other collecting Freighters:
     *
     * byTargetCount:
     * - how many Freighters are heading to a specific dropped pile/container.
     *
     * byTargetEnergy:
     * - how much carry capacity is already heading there.
     *
     * bySourceCount:
     * - how many Freighters are assigned near each source, which helps balance
     *   haulers between source lanes.
     */
    var reservations = {
        byTargetCount: {},
        byTargetEnergy: {},
        bySourceCount: {}
    };

    for(var creepName in Game.creeps) {
        if(!Game.creeps.hasOwnProperty(creepName)) {
            continue;
        }

        var otherCreep = Game.creeps[creepName];

        if(!otherCreep || !otherCreep.memory) {
            continue;
        }

        if(otherCreep.name === creep.name) {
            continue;
        }

        if(otherCreep.memory.role !== 'Freighter') {
            continue;
        }

        if(otherCreep.memory.remoteFreighting) {
            continue;
        }

        /*
         * Only collecting Freighters reserve pickup targets.
         * Delivering Freighters should not block a pickup target.
         */
        if(otherCreep.memory.FreighterWorking) {
            continue;
        }

        if(otherCreep.room.name !== creep.room.name) {
            continue;
        }

        var targetId = otherCreep.memory.freighterPickupTargetId;
        var sourceId = otherCreep.memory.freighterPickupSourceId;

        if(!targetId) {
            continue;
        }

        var target = Game.getObjectById(targetId);

        if(!isValidEnergyPickupTarget(target)) {
            continue;
        }

        var freeCapacity = otherCreep.store.getFreeCapacity(RESOURCE_ENERGY);

        if(freeCapacity <= 0) {
            continue;
        }

        reservations.byTargetCount[targetId] = (reservations.byTargetCount[targetId] || 0) + 1;
        reservations.byTargetEnergy[targetId] = (reservations.byTargetEnergy[targetId] || 0) + freeCapacity;

        if(sourceId) {
            reservations.bySourceCount[sourceId] = (reservations.bySourceCount[sourceId] || 0) + 1;
        }
    }

    return reservations;
}

function getSourceIdNearTarget(target, range) {
    if(!target || !target.pos) {
        return null;
    }

    var source = getSourceNearPosition(target.pos, range);

    if(!source) {
        return null;
    }

    return source.id;
}

function getSourceNearPosition(position, range) {
    if(!position) {
        return null;
    }

    var sources = position.findInRange(FIND_SOURCES, range);

    if(!sources || sources.length === 0) {
        return null;
    }

    return sources[0];
}

function getStoredEnergy(target) {
    /*
     * Screeps store objects can be read with getUsedCapacity in modern code,
     * but some older objects or private server shims may still expose
     * store[RESOURCE_ENERGY]. Supporting both makes this helper tolerant.
     */
    if(!target || !target.store) {
        return 0;
    }

    if(typeof target.store.getUsedCapacity === 'function') {
        return target.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    }

    return target.store[RESOURCE_ENERGY] || 0;
}

function idleNearUsefulSource(creep) {
    /*
     * If no pickup target exists, move near the source that has the fewest
     * Freighters currently assigned.
     *
     * This keeps idle Freighters spread out instead of all parking at
     * the closest source.
     */
    var sources = creep.room.find(FIND_SOURCES);

    if(!sources || sources.length === 0) {
        return;
    }

    var reservations = buildFreighterReservations(creep);
    var bestSource = null;
    var bestAssignedCount = 999999;

    for(var i = 0; i < sources.length; i++) {
        var source = sources[i];
        var assignedCount = reservations.bySourceCount[source.id] || 0;

        if(assignedCount < bestAssignedCount) {
            bestAssignedCount = assignedCount;
            bestSource = source;
        }
    }

    if(bestSource && creep.pos.getRangeTo(bestSource) > 3) {
        travel.move(creep, bestSource, {
            range: 3,
            visualizePathStyle: {
                stroke: '#bbbbbb'
            }
        });
    }
}

function collectFromRemoteTarget(creep, target) {
    var result;

    if(target.resourceType) {
        result = creep.pickup(target);
    } else {
        result = creep.withdraw(target, RESOURCE_ENERGY);
    }

    if(result === OK) {
        return;
    }

    if(result === ERR_NOT_IN_RANGE) {
        RemotePlanner.moveFreighterToRemotePickup(creep);
        return;
    }

    RemotePlanner.clearRemoteFreighterMemory(creep);
}

function deliverRemoteEnergy(creep) {
    var homeRoomName = creep.memory.freighterHomeRoom || creep.memory.homeRoom;

    if(homeRoomName && creep.room.name !== homeRoomName) {
        travel.moveToRoom(creep, homeRoomName, {
            range: 22,
            reusePath: 20,
            visualizePathStyle: {
                stroke: '#ffffff'
            }
        });
        return;
    }

    var target = RemotePlanner.getHomeDeliveryTarget(creep);

    if(!target) {
        return;
    }

    var result = creep.transfer(target, RESOURCE_ENERGY);

    if(result === OK) {
        if(creep.store[RESOURCE_ENERGY] === 0) {
            clearRemoteReturnMemory(creep);
        }
        return;
    }

    if(result === ERR_NOT_IN_RANGE) {
        travel.move(creep, target, {
            range: 1,
            visualizePathStyle: {
                stroke: '#ffffff'
            }
        });
        return;
    }

    clearRemoteReturnMemory(creep);
}

function moveTowardHomeRoom(creep) {
    var homeRoomName = creep.memory.freighterHomeRoom || creep.memory.homeRoom;

    if(!homeRoomName || creep.room.name === homeRoomName) {
        return;
    }

    travel.moveToRoom(creep, homeRoomName, {
        range: 22,
        reusePath: 20,
        visualizePathStyle: {
            stroke: '#ffffff'
        }
    });
}

function isRemoteRoomDangerous(room) {
    if(!room) {
        return false;
    }

    if(typeof STRUCTURE_INVADER_CORE !== 'undefined') {
        var cores = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: function(structure) {
                return structure.structureType === STRUCTURE_INVADER_CORE;
            }
        });

        if(cores.length > 0) {
            return true;
        }
    }

    var dangerousCreeps = room.find(FIND_HOSTILE_CREEPS, {
        filter: function(hostile) {
            return hostile.getActiveBodyparts(ATTACK) > 0 ||
                hostile.getActiveBodyparts(RANGED_ATTACK) > 0 ||
                hostile.getActiveBodyparts(HEAL) > 0;
        }
    });

    return dangerousCreeps.length > 0;
}

function deliverEnergy(creep) {
    var target = null;

    /*
     * Priority 1:
     * Fill spawn and extensions first so the room can keep spawning creeps.
     */
    target = findSpawnOrExtensionToFill(creep);

    /*
     * Priority 2:
     * Fill towers.
     */
    if(!target) {
        target = findTowerToFill(creep);
    }

    /*
     * Priority 3:
     * Fill controller container.
     */
    if(!target) {
        target = findControllerContainerToFill(creep);
    }

    /*
     * Priority 4:
     * Fill storage.
     */
    if(!target) {
        target = findStorageToFill(creep);
    }

    if(!target) {
        return;
    }

    if(creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        travel.move(creep, target, {
            range: 1,
            visualizePathStyle: {
                stroke: '#ffffff'
            }
        });
    }
}

function findSpawnOrExtensionToFill(creep) {
    return creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
        filter: function(structure) {
            return (
                (
                    structure.structureType === STRUCTURE_SPAWN ||
                    structure.structureType === STRUCTURE_EXTENSION
                ) &&
                structure.store &&
                structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0
            );
        }
    });
}

function findTowerToFill(creep) {
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
    if(
        creep.room.storage &&
        creep.room.storage.store &&
        creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0
    ) {
        return creep.room.storage;
    }

    return null;
}

module.exports = roleFreighter;












/////BELOW IS OLD CODE TO IGNORE - DO NOT SUGGEST CHANGES TO THIS CODE/////



/*


var roleFreighter = {

    run: function(creep) {
        
         // Freighters are haulers. They need to exist and be done spawning before
         // they can withdraw, pick up, transfer, or move.
         
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
    //If the hauler was delivering but has zero energy, it must go collect more.
   
    if(creep.memory.FreighterWorking && creep.store[RESOURCE_ENERGY] === 0) {
        creep.memory.FreighterWorking = false;
    }

    
     //If the hauler was collecting and has no free energy capacity, it is full
     //and should switch to delivery mode.
     
    if(!creep.memory.FreighterWorking && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
        creep.memory.FreighterWorking = true;
    }
}

function collectEnergy(creep) {
    
     //Prefer source containers, then dropped energy. Source containers represent
     //energy mined by Extractors and waiting for transport.
     
    var target = findSourceContainer(creep) || findDroppedEnergy(creep);

    if(!target) {
        
         //No pickup target exists. Idling near a source keeps the Freighter near
         //future energy drops without doing more expensive searches.
         
        idleNearSource(creep);
        return;
    }

    
     //Dropped Resource objects have resourceType and use pickup().
     //Structures have stores and use withdraw().
     
    if(target.resourceType) {
        if(creep.pickup(target) === ERR_NOT_IN_RANGE) {
            travel.move(creep, target, {visualizePathStyle: {stroke: '#ffaa00'}});
        }
    } else if(creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        travel.move(creep, target, {visualizePathStyle: {stroke: '#ffaa00'}});
    }
}

function deliverEnergy(creep) {
    var target = null;

    
     //Priority 1:
     // Fill spawn and extensions first so the room can keep making creeps.
     // If these are empty, the whole bee hive starts coughing dust.
     
    target = findSpawnOrExtensionToFill(creep);

    
     //Priority 2:
     // Fill towers after spawn/extensions. Towers keep the room defended and
     // can repair when they have energy.
     
    if(!target) {
        target = findTowerToFill(creep);
    }

    
     //Priority 3:
     // Fill the controller container. This gives Upgraders a local energy buffer
     // so they do not have to waddle back and forth like tired penguins.
     
    if(!target) {
        target = findControllerContainerToFill(creep);
    }

    
     //Priority 4:
     // Put leftover energy into storage. Storage is last because it has huge
     // capacity and would otherwise steal all Freighter deliveries forever.
     
    if(!target) {
        target = findStorageToFill(creep);
    }

    if(!target) {
        
         // No valid destination has free capacity, so there is no transfer action
         // to take this tick.
         
        return;
    }

    
     //transfer returns ERR_NOT_IN_RANGE when the target has room but is too far
     // away. moveTo starts pathing toward transfer range.
     
    if(creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        travel.move(creep, target, {visualizePathStyle: {stroke: '#ffffff'}});
    }
}

function findSpawnOrExtensionToFill(creep) {
    
     //Spawns and extensions are the highest-priority delivery target because
     //they directly control whether the room can spawn new creeps.
     
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
    
     //Towers are useful for defense and repairs. This fills any tower that has
     //room for more energy.
     
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
    
     //This looks for a container near the room controller.
     //
     // Range 3 is used because Upgraders can usually stand around the controller
     // and withdraw from a nearby container without the container needing to be
     // directly touching the controller.
     //
     // This ignores source containers because source containers are near sources,
     // while this function only cares about containers near the controller.
     
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
    
     //Storage is the fallback delivery target. It should not be first because
     //storage has so much capacity that it can prevent smaller important targets,
     //like the controller container, from being filled.
     
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
    
     //This finds containers that both contain energy and are within range 2 of a
     // source, which marks them as mining containers rather than random storage.
     
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
    
     //Ignore tiny piles under 50 energy so the Freighter does not spend lots of
     // travel time cleaning up very small scraps.
     
    return creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: function(resource) {
            return resource.resourceType === RESOURCE_ENERGY && resource.amount >= 50;
        }
    });
}

function idleNearSource(creep) {
    
     //Standing near sources makes the hauler ready for new dropped energy or
     // container energy without blocking the source directly.
     
    var source = creep.pos.findClosestByPath(FIND_SOURCES);
    if(source && creep.pos.getRangeTo(source) > 3) {
        travel.move(creep, source, {visualizePathStyle: {stroke: '#bbbbbb'}});
    }
}

module.exports = roleFreighter;

*/
