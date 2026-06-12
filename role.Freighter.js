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
var utility = require('utility');
var RemotePlanner = require('Planner.Remote');

var MIN_DROPPED_ENERGY = 50;
var MIN_CONTAINER_ENERGY = 50;
var REMOTE_HAUL_MEMORY_STALE_TICKS = 25;

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

        normalizeFreighterMemory(creep);
        updateWorkingState(creep);

        if(creep.memory.FreighterWorking) {
            if(creep.memory.freighterJob === 'remote' || creep.memory.freighterJob === 'remoteDelivery') {
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
        if(creep.memory.freighterJob === 'remote' || creep.memory.freighterJob === 'remoteDelivery') {
            RemotePlanner.clearRemoteFreighterMemory(creep);
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
        if(creep.memory.freighterJob === 'remote') {
            finishRemotePickup(creep);
        } else {
            clearPickupMemory(creep);
        }
    }
}

function collectEnergy(creep) {
    /*
     * If this Freighter is already committed to a remote target, keep traveling
     * to it. A non-visible remote target is not treated as invalid until the
     * Freighter actually has room vision and can prove it disappeared or emptied.
     */
    var hadRemoteJob = creep.memory.freighterJob === 'remote';

    if(hadRemoteJob) {
        if(handleRemoteCollection(creep)) {
            return;
        }
    }

    if(hadRemoteJob && creep.store[RESOURCE_ENERGY] > 0) {
        creep.memory.FreighterWorking = true;
        creep.memory.freighterJob = 'remoteDelivery';
        deliverRemoteEnergy(creep);
        return;
    }

    var target = getRememberedPickupTarget(creep);

    if(target) {
        collectFromTarget(creep, target);
        return;
    }

    if(
        homeRoomNeedsUrgentEnergy(creep) &&
        creep.room.name !== creep.memory.homeRoom
    ) {
        moveTowardHomeRoom(creep);
        return;
    }

    /*
     * Freighters in their home room always check local dropped energy and
     * source containers before accepting a remote job. This prevents local
     * source containers from filling while every Freighter travels remotely.
     */
    if(creep.room.name === creep.memory.homeRoom) {
        target = findBestLocalPickupTarget(creep);

        if(target) {
            collectFromTarget(creep, target);
            return;
        }
    }

    var remotePickup = findBestRemotePickupTarget(creep);

    if(remotePickup && RemotePlanner.claimRemotePickupTarget(creep, remotePickup)) {
        handleRemoteCollection(creep);
        return;
    }

    if(creep.room.name !== creep.memory.homeRoom) {
        moveTowardHomeRoom(creep);
        return;
    }

    idleNearUsefulSource(creep);
}

function handleRemoteCollection(creep) {
    if(creep.memory.freighterJob !== 'remote') {
        return false;
    }

    var remoteRoomName = creep.memory.pickupRoom;
    var remoteRoom = remoteRoomName ? Game.rooms[remoteRoomName] : null;

    if(remoteRoom && isRemoteRoomDangerous(remoteRoom)) {
        /*
         * If danger appears while carrying partial cargo, switch to delivery
         * before clearing remote pickup memory. This keeps the home room saved
         * and prevents the Freighter from forgetting to bring energy home.
         */
        if(creep.store[RESOURCE_ENERGY] > 0) {
            creep.memory.FreighterWorking = true;
            finishRemotePickup(creep);
            deliverRemoteEnergy(creep);
            return true;
        }

        RemotePlanner.clearRemoteFreighterMemory(creep);
        moveTowardHomeRoom(creep);
        return true;
    }

    if(!RemotePlanner.refreshRemoteFreighterReservation(creep)) {
        RemotePlanner.clearRemoteFreighterMemory(creep);
        return false;
    }

    var targetId = creep.memory.pickupTargetId;
    var target = targetId ? Game.getObjectById(targetId) : null;

    if(target) {
        if(!isValidEnergyPickupTarget(target)) {
            return handleRemoteTargetGone(creep);
        }

        collectFromRemoteTarget(creep, target);
        return true;
    }

    /*
     * If the target room is visible and the id no longer resolves, the target is
     * really gone. If the room is not visible, keep traveling toward the remote
     * source/path instead of clearing useful memory too early.
     */
    if(remoteRoom) {
        return handleRemoteTargetGone(creep);
    }

    return RemotePlanner.moveFreighterToRemotePickup(creep);
}


function getRememberedPickupTarget(creep) {
    if(creep.memory.freighterJob !== 'local') {
        return null;
    }

    if(!creep.memory.pickupTargetId) {
        return null;
    }

    var target = Game.getObjectById(creep.memory.pickupTargetId);

    if(!isValidEnergyPickupTarget(target)) {
        clearPickupMemory(creep);
        return null;
    }

    return target;
}

function clearPickupMemory(creep) {
    if(creep.memory.freighterJob === 'remote' || creep.memory.freighterJob === 'remoteDelivery') {
        RemotePlanner.clearRemoteFreighterMemory(creep);
        return;
    }

    delete creep.memory.freighterJob;
    delete creep.memory.pickupRoom;
    delete creep.memory.pickupSourceId;
    delete creep.memory.pickupTargetId;
    delete creep.memory.pickupTargetType;

    /* Remove local pickup fields written by the previous implementation. */
    delete creep.memory.freighterPickupTargetId;
    delete creep.memory.freighterPickupSourceId;
    delete creep.memory.freighterPickupType;
}

function finishRemotePickup(creep) {
    RemotePlanner.releaseRemoteFreighterReservation(creep);
    delete creep.memory.pickupRoom;
    delete creep.memory.pickupSourceId;
    delete creep.memory.pickupTargetId;
    delete creep.memory.pickupTargetType;
    delete creep.memory.freighterReservedCarry;
    delete creep.memory.freighterReservedUntil;
    creep.memory.freighterJob = 'remoteDelivery';
}


function findBestRemotePickupTarget(creep) {
    if(!creep || !creep.memory || !creep.store || creep.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) {
        return null;
    }

    var homeRoomName = creep.memory.homeRoom || creep.room.name;
    var activeSources = RemotePlanner.getActiveRemoteSourcesForHome(homeRoomName);

    if(!activeSources || activeSources.length === 0) {
        return null;
    }

    var reservations = buildRemoteFreighterReservations(creep);
    var candidates = [];

    for(var i = 0; i < activeSources.length; i++) {
        var sourceInfo = activeSources[i];

        if(!sourceInfo || !sourceInfo.sourceId || !sourceInfo.roomName) {
            continue;
        }

        if(!RemotePlanner.shouldUseRemoteSource(homeRoomName, sourceInfo.sourceId)) {
            continue;
        }

        var haul = utility.ensureSourceHaulMemory(sourceInfo.roomName, sourceInfo.sourceId, homeRoomName);

        if(!haul || !haul.targetId || haul.amount <= 0) {
            continue;
        }

        if(haul.homeRoom && haul.homeRoom !== homeRoomName) {
            continue;
        }

        if(!haul.lastSeen || Game.time - haul.lastSeen > REMOTE_HAUL_MEMORY_STALE_TICKS) {
            continue;
        }

        var visibleRoom = Game.rooms[sourceInfo.roomName];

        if(visibleRoom) {
            if(isRemoteRoomDangerous(visibleRoom)) {
                continue;
            }

            var liveTarget = Game.getObjectById(haul.targetId);
            var liveAmount = getEnergyPickupAmount(liveTarget);

            if(!liveTarget || liveAmount <= 0) {
                clearRemoteHaulTarget(haul);
                haul.lastSeen = Game.time;
                continue;
            }

            /* Keep the remembered amount fresh whenever we have room vision. */
            haul.amount = liveAmount;
            haul.lastSeen = Game.time;
        }

        var reservationKey = getRemoteReservationKey(sourceInfo.roomName, sourceInfo.sourceId, haul.targetId);
        var assignedCount = reservations.byTargetCount[reservationKey] || 0;
        var reservedCarry = reservations.byTargetEnergy[reservationKey] || 0;
        var remainingEnergy = haul.amount - reservedCarry;
        var estimatedDistance = sourceInfo.distance || getFallbackRemoteDistance(creep, sourceInfo.roomName);

        candidates.push({
            targetId: haul.targetId,
            type: haul.targetType,
            amount: haul.amount,
            remainingEnergy: remainingEnergy,
            sourceId: sourceInfo.sourceId,
            remoteRoomName: sourceInfo.roomName,
            pickupRoom: sourceInfo.roomName,
            homeRoomName: homeRoomName,
            estimatedDistance: estimatedDistance,
            assignedCount: assignedCount
        });
    }

    /*
     * Pass 1:
     * Spread Freighters first by choosing the biggest target with nobody
     * already assigned. Distance only breaks ties between equally full targets.
     */
    var bestOpenTarget = null;

    for(var j = 0; j < candidates.length; j++) {
        var openCandidate = candidates[j];

        if(openCandidate.assignedCount > 0) {
            continue;
        }

        if(!bestOpenTarget || isBetterOpenRemoteTarget(openCandidate, bestOpenTarget)) {
            bestOpenTarget = openCandidate;
        }
    }

    if(bestOpenTarget) {
        return bestOpenTarget;
    }

    /*
     * Pass 2:
     * Once every valid target has a Freighter, send extra Freighters to the
     * target with the most unreserved energy. Fewer assigned Freighters and
     * shorter distance are only tie breakers.
     */
    var bestSharedTarget = null;

    for(var k = 0; k < candidates.length; k++) {
        var sharedCandidate = candidates[k];

        if(sharedCandidate.remainingEnergy <= 0) {
            continue;
        }

        if(!bestSharedTarget || isBetterSharedRemoteTarget(sharedCandidate, bestSharedTarget)) {
            bestSharedTarget = sharedCandidate;
        }
    }

    return bestSharedTarget;
}

function buildRemoteFreighterReservations(creep) {
    var reservations = {
        byTargetCount: {},
        byTargetEnergy: {}
    };

    /*
     * Scan living Freighters once. Their memory is treated as intention data:
     * collecting remote Freighters reserve the target they are traveling to.
     */
    for(var creepName in Game.creeps) {
        if(!Game.creeps.hasOwnProperty(creepName)) {
            continue;
        }

        var other = Game.creeps[creepName];

        if(!other || !other.memory) {
            continue;
        }

        if(other.name === creep.name) {
            continue;
        }

        if(other.memory.role !== 'Freighter') {
            continue;
        }

        if(other.memory.freighterJob !== 'remote' || other.memory.FreighterWorking) {
            continue;
        }

        if((other.memory.freighterReservedUntil || 0) < Game.time) {
            continue;
        }

        if(!other.memory.pickupRoom || !other.memory.pickupSourceId || !other.memory.pickupTargetId) {
            continue;
        }

        var key = getRemoteReservationKey(
            other.memory.pickupRoom,
            other.memory.pickupSourceId,
            other.memory.pickupTargetId
        );
        var reservedCarry = other.memory.freighterReservedCarry || other.store.getFreeCapacity(RESOURCE_ENERGY) || 0;

        reservations.byTargetCount[key] = (reservations.byTargetCount[key] || 0) + 1;
        reservations.byTargetEnergy[key] = (reservations.byTargetEnergy[key] || 0) + reservedCarry;
    }

    return reservations;
}

function getRemoteReservationKey(roomName, sourceId, targetId) {
    return roomName + '|' + sourceId + '|' + targetId;
}

function isBetterOpenRemoteTarget(candidate, currentBest) {
    if(candidate.amount > currentBest.amount) {
        return true;
    }

    if(candidate.amount < currentBest.amount) {
        return false;
    }

    return candidate.estimatedDistance < currentBest.estimatedDistance;
}

function isBetterSharedRemoteTarget(candidate, currentBest) {
    if(candidate.remainingEnergy > currentBest.remainingEnergy) {
        return true;
    }

    if(candidate.remainingEnergy < currentBest.remainingEnergy) {
        return false;
    }

    if(candidate.assignedCount < currentBest.assignedCount) {
        return true;
    }

    if(candidate.assignedCount > currentBest.assignedCount) {
        return false;
    }

    return candidate.estimatedDistance < currentBest.estimatedDistance;
}

function clearRemoteHaulTarget(haul) {
    haul.targetId = null;
    haul.targetType = null;
    haul.amount = 0;
    haul.reservedBy = null;
    haul.reservedUntil = 0;
    haul.reservedCarry = 0;
}

function getEnergyPickupAmount(target) {
    if(!target) {
        return 0;
    }

    if(target.resourceType) {
        return target.resourceType === RESOURCE_ENERGY ? target.amount : 0;
    }

    return getStoredEnergy(target);
}

function getFallbackRemoteDistance(creep, remoteRoomName) {
    if(!remoteRoomName) {
        return 999999;
    }

    return Game.map.getRoomLinearDistance(creep.room.name, remoteRoomName) * 50;
}

function handleRemoteTargetGone(creep) {
    if(creep.store[RESOURCE_ENERGY] > 0) {
        creep.memory.FreighterWorking = true;
        finishRemotePickup(creep);
        deliverRemoteEnergy(creep);
        return true;
    }

    RemotePlanner.clearRemoteFreighterMemory(creep);
    return false;
}

function findBestLocalPickupTarget(creep) {
    var target = findBestDroppedEnergyTarget(creep);

    if(!target) {
        target = findBestSourceContainerTarget(creep);
    }

    return target;
}

function homeRoomNeedsUrgentEnergy(creep) {
    var homeRoom = Game.rooms[creep.memory.homeRoom];

    if(!homeRoom) {
        return false;
    }

    if(homeRoom.energyAvailable < homeRoom.energyCapacityAvailable) {
        return true;
    }

    var lowTower = homeRoom.find(FIND_MY_STRUCTURES, {
        filter: function(structure) {
            if(structure.structureType !== STRUCTURE_TOWER || !structure.store) {
                return false;
            }

            var capacity = structure.store.getCapacity(RESOURCE_ENERGY) || 0;
            return capacity > 0 && structure.store.getUsedCapacity(RESOURCE_ENERGY) < capacity / 2;
        }
    });

    return lowTower.length > 0;
}

function normalizeFreighterMemory(creep) {
    if(!creep.memory.homeRoom) {
        creep.memory.homeRoom = creep.memory.freighterHomeRoom || creep.room.name;
    }

    if(!creep.memory.freighterJob && creep.memory.remoteFreighting) {
        creep.memory.freighterJob = creep.memory.FreighterWorking ? 'remoteDelivery' : 'remote';
        creep.memory.pickupRoom = creep.memory.freighterRemoteRoom;
        creep.memory.pickupSourceId = creep.memory.freighterPickupSourceId;
        creep.memory.pickupTargetId = creep.memory.freighterPickupTargetId;
        creep.memory.pickupTargetType = creep.memory.freighterPickupType;
    }
    else if(!creep.memory.freighterJob && creep.memory.freighterPickupTargetId) {
        creep.memory.freighterJob = 'local';
        creep.memory.pickupRoom = creep.room.name;
        creep.memory.pickupSourceId = creep.memory.freighterPickupSourceId;
        creep.memory.pickupTargetId = creep.memory.freighterPickupTargetId;
        creep.memory.pickupTargetType = creep.memory.freighterPickupType;
    }

    delete creep.memory.remoteFreighting;
    delete creep.memory.remoteFreightingWanted;
    delete creep.memory.remoteReturning;
    delete creep.memory.freighterHomeRoom;
    delete creep.memory.freighterRemoteRoom;
    delete creep.memory.freighterPickupTargetId;
    delete creep.memory.freighterPickupSourceId;
    delete creep.memory.freighterPickupType;
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
    if(creep.memory.freighterJob === 'remote' || creep.memory.freighterJob === 'remoteDelivery') {
        RemotePlanner.clearRemoteFreighterMemory(creep);
    }

    /*
     * These memory fields are not permanent ownership. They are an intent:
     * "this Freighter is currently heading to this target/source." Other
     * Freighters read those intents when spreading themselves across work.
     */
    creep.memory.freighterJob = 'local';
    creep.memory.pickupRoom = creep.room.name;
    creep.memory.pickupTargetId = target.id;
    creep.memory.pickupSourceId = sourceId || target.id;
    creep.memory.pickupTargetType = pickupType;
    creep.memory.homeRoom = creep.memory.homeRoom || creep.room.name;
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

        if(otherCreep.memory.freighterJob !== 'local') {
            continue;
        }

        /*
         * Only collecting Freighters reserve pickup targets.
         * Delivering Freighters should not block a pickup target.
         */
        if(otherCreep.memory.FreighterWorking) {
            continue;
        }

        if(otherCreep.memory.pickupRoom !== creep.room.name) {
            continue;
        }

        var targetId = otherCreep.memory.pickupTargetId;
        var sourceId = otherCreep.memory.pickupSourceId;

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

    handleRemoteTargetGone(creep);
}

function deliverRemoteEnergy(creep) {
    var homeRoomName = creep.memory.homeRoom;

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
            RemotePlanner.clearRemoteFreighterMemory(creep);
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

    if(result !== ERR_FULL) {
        RemotePlanner.clearRemoteFreighterMemory(creep);
    }
}

function moveTowardHomeRoom(creep) {
    var homeRoomName = creep.memory.homeRoom;

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
