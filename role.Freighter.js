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
var Economy = require('HiveMind.Economy');
var LogisticsJobs = require('Logistics.Jobs');

var MIN_DROPPED_ENERGY = 50;
var MIN_CONTAINER_ENERGY = 50;
var REMOTE_HAUL_MEMORY_STALE_TICKS = 25;
var SPAWN_STOCKPILE_IGNORE_RANGE = 3;
var SPAWN_STOCKPILE_MIN_RANGE = 1;
var SPAWN_STOCKPILE_MAX_RANGE = 3;

var roleFreighter = {

    /** @param {Creep} creep **/
    run: function(creep) {
        /*
         * Freighters are haulers.
         *
         * They collect the best available energy job, whether that job is a
         * home-room pile/container or a remembered remote haul target. Then
         * they deliver that energy to the base.
         */
        if(!creep || creep.spawning) {
            return;
        }

        normalizeFreighterMemory(creep);
        updateWorkingState(creep);

        if(creep.memory.FreighterWorking) {
            if(creep.memory.freighterJob === 'remote' || creep.memory.freighterJob === 'remoteDelivery') {
                deliverRemoteEnergy(creep);
            } else if (creep.memory.freighterJob === 'transport' || creep.memory.freighterJob === 'transportDelivery') {
                deliverTransportJob(creep);
            } else {
                deliverEnergy(creep);
            }
        } else {
            collectEnergy(creep);
        }
    }
};

function updateWorkingState(creep) {
    var assignedResource = creep.memory.resourceType || RESOURCE_ENERGY;
    /*
     * If the Freighter was delivering but is now empty,
     * switch back to collection mode.
     */
    if(creep.memory.FreighterWorking && (creep.store[assignedResource] || 0) === 0) {
        creep.memory.FreighterWorking = false;
        if(creep.memory.freighterJob === 'remote' || creep.memory.freighterJob === 'remoteDelivery') {
            RemotePlanner.clearRemoteFreighterMemory(creep);
        } else if (creep.memory.freighterJob === 'transport' || creep.memory.freighterJob === 'transportDelivery') {
            LogisticsJobs.clear(creep);
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
    if(!creep.memory.FreighterWorking && creep.store.getFreeCapacity(assignedResource) === 0) {
        creep.memory.FreighterWorking = true;
        if(creep.memory.freighterJob === 'remote') {
            finishRemotePickup(creep);
        } else if (creep.memory.freighterJob === 'transport') {
            creep.memory.freighterJob = 'transportDelivery';
        } else {
            clearPickupMemory(creep);
        }
    }
}

function collectEnergy(creep) {
    if (creep.memory.freighterJob === 'transport') {
        collectTransportJob(creep);
        return;
    }
    /*
     * If this Freighter is already committed to a remote target, keep traveling
     * to it. A non-visible remote target is not treated as invalid until the
     * Freighter actually has room vision and can prove it disappeared or emptied.
     */
    var hadRemoteJob = creep.memory.freighterJob === 'remote';

    if (hadRemoteJob && !Economy.canSpend(creep.memory.homeRoom, 'remoteMaintenance')) {
        RemotePlanner.clearRemoteFreighterMemory(creep);
        if (creep.store[RESOURCE_ENERGY] > 0) {
            creep.memory.FreighterWorking = true;
            deliverEnergy(creep);
        }
        else if (creep.room.name !== creep.memory.homeRoom) {
            moveTowardHomeRoom(creep);
        }
        return;
    }

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

    var rememberedTarget = getRememberedPickupTarget(creep);
    var selectedCandidate = null;

    if(rememberedTarget) {
        selectedCandidate = chooseBestPickupCandidate(getAllPickupCandidates(creep));

        if(
            !selectedCandidate ||
            selectedCandidate.targetId === rememberedTarget.id ||
            !isCandidateBetterThanRememberedTarget(selectedCandidate, rememberedTarget)
        ) {
            collectFromTarget(creep, rememberedTarget);
            return;
        }

        /* A much better job exists, so let this Freighter retarget cleanly. */
        clearPickupMemory(creep);
    }

    if(
        homeRoomNeedsUrgentEnergy(creep) &&
        creep.room.name !== creep.memory.homeRoom
    ) {
        moveTowardHomeRoom(creep);
        return;
    }

    if(!selectedCandidate) {
        selectedCandidate = chooseBestPickupCandidate(getAllPickupCandidates(creep));
    }

    if(selectedCandidate && applySelectedPickupCandidate(creep, selectedCandidate)) {
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

    if(!isValidEnergyPickupTarget(target) || isProtectedSpawnStockpileDrop(creep, target)) {
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
    RemotePlanner.recordRemoteTripLeg(creep, 'OUTBOUND');
    if (creep.memory.remoteTrip && creep.memory.remoteTrip.direction === 'RETURN') {
        creep.memory.remoteTrip.returnStartedAt = Game.time;
    }
    creep.memory.remoteDeliveryRoom = creep.memory.pickupRoom;
    creep.memory.remoteDeliverySourceId = creep.memory.pickupSourceId;
    RemotePlanner.releaseRemoteFreighterReservation(creep);
    delete creep.memory.pickupRoom;
    delete creep.memory.pickupSourceId;
    delete creep.memory.pickupTargetId;
    delete creep.memory.pickupTargetType;
    delete creep.memory.freighterReservedCarry;
    delete creep.memory.freighterReservedUntil;
    creep.memory.freighterJob = 'remoteDelivery';
}

function collectTransportJob(creep) {
    var origin = creep.memory.originRoom || creep.memory.pickupRoom;
    var resource = creep.memory.resourceType || RESOURCE_ENERGY;
    if (creep.room.name !== origin) {
        travel.moveToRoom(creep, origin, { range: 22, reusePath: 20 });
        return;
    }
    var target = creep.memory.pickupTargetId && Game.getObjectById(creep.memory.pickupTargetId);
    if (!target) {
        target = creep.room.storage && (creep.room.storage.store[resource] || 0) > 0 ? creep.room.storage :
            creep.room.terminal && (creep.room.terminal.store[resource] || 0) > 0 ? creep.room.terminal : null;
    }
    if (!target) return;
    creep.memory.pickupTargetId = target.id;
    var amount = creep.memory.logisticsAmount || undefined;
    var result = creep.withdraw(target, resource, amount ? Math.min(amount, creep.store.getFreeCapacity(resource)) : undefined);
    if (result === ERR_NOT_IN_RANGE) travel.move(creep, target, { range: 1 });
    if (result === OK && (creep.store[resource] || 0) > 0) {
        creep.memory.FreighterWorking = true;
        creep.memory.freighterJob = 'transportDelivery';
    }
}

function deliverTransportJob(creep) {
    var destination = LogisticsJobs.destination(creep);
    var resource = creep.memory.resourceType || RESOURCE_ENERGY;
    if (creep.room.name !== destination) {
        travel.moveToRoom(creep, destination, { range: 22, reusePath: 20 });
        return;
    }
    var target = resource === RESOURCE_ENERGY ? RemotePlanner.getHomeDeliveryTarget(creep, destination) :
        (creep.room.storage || creep.room.terminal);
    if (!target) return;
    var result = creep.transfer(target, resource);
    if (result === ERR_NOT_IN_RANGE) travel.move(creep, target, { range: 1 });
    if (result === OK && (creep.store[resource] || 0) === 0) {
        creep.memory.FreighterWorking = false;
        LogisticsJobs.clear(creep);
    }
}

function recordRemoteDelivery(creep) {
    var roomName = creep.memory.remoteDeliveryRoom;
    var sourceId = creep.memory.remoteDeliverySourceId;
    var sourceMemory = roomName && sourceId && Memory.rooms && Memory.rooms[roomName] &&
        Memory.rooms[roomName].sources && Memory.rooms[roomName].sources[sourceId];
    if (sourceMemory && sourceMemory.haul) sourceMemory.haul.lastDeliveryAt = Game.time;
}


function getAllPickupCandidates(creep) {
    var localReservations = buildFreighterReservations(creep);
    var remoteReservations = buildRemoteFreighterReservations(creep);
    var candidates = [];

    candidates = candidates.concat(getLocalPickupCandidates(creep, localReservations));
    candidates = candidates.concat(getRemotePickupCandidates(creep, remoteReservations));

    return candidates;
}

function getLocalPickupCandidates(creep, reservations) {
    var homeRoomName = creep.memory.homeRoom || creep.room.name;

    /* Local pickup jobs are only the home room's source-side energy jobs. */
    if(creep.room.name !== homeRoomName) {
        return [];
    }

    return getLocalDroppedEnergyCandidates(creep, reservations).concat(
        getLocalSourceContainerCandidates(creep, reservations)
    );
}

function getLocalDroppedEnergyCandidates(creep, reservations) {
    var droppedEnergyList = creep.room.find(FIND_DROPPED_RESOURCES, {
        filter: function(resource) {
            return (
                resource.resourceType === RESOURCE_ENERGY &&
                resource.amount >= MIN_DROPPED_ENERGY &&
                !isProtectedSpawnStockpileDrop(creep, resource)
            );
        }
    });
    var candidates = [];

    for(var i = 0; i < droppedEnergyList.length; i++) {
        var drop = droppedEnergyList[i];
        var reservedEnergy = reservations.byTargetEnergy[drop.id] || 0;
        var remainingEnergy = drop.amount - reservedEnergy;

        if(remainingEnergy <= 0) {
            continue;
        }

        candidates.push({
            jobType: 'local',
            targetId: drop.id,
            target: drop,
            pickupRoom: creep.room.name,
            sourceId: getSourceIdNearTarget(drop, 3),
            type: 'dropped',
            amount: drop.amount,
            remainingEnergy: remainingEnergy,
            assignedCount: reservations.byTargetCount[drop.id] || 0,
            estimatedDistance: creep.pos.getRangeTo(drop),
            homeRoomName: creep.memory.homeRoom || creep.room.name,
            remoteRoomName: null
        });
    }

    return candidates;
}

function getLocalSourceContainerCandidates(creep, reservations) {
    var sourceContainers = getSourceContainerOptions(creep);
    var candidates = [];

    for(var i = 0; i < sourceContainers.length; i++) {
        var option = sourceContainers[i];
        var reservedEnergy = reservations.byTargetEnergy[option.target.id] || 0;
        var remainingEnergy = option.amount - reservedEnergy;

        if(remainingEnergy <= 0) {
            continue;
        }

        candidates.push({
            jobType: 'local',
            targetId: option.target.id,
            target: option.target,
            pickupRoom: creep.room.name,
            sourceId: option.sourceId,
            type: 'container',
            amount: option.amount,
            remainingEnergy: remainingEnergy,
            assignedCount: Math.max(
                reservations.byTargetCount[option.target.id] || 0,
                reservations.bySourceCount[option.sourceId] || 0
            ),
            estimatedDistance: creep.pos.getRangeTo(option.target),
            homeRoomName: creep.memory.homeRoom || creep.room.name,
            remoteRoomName: null
        });
    }

    return candidates;
}

function getRemotePickupCandidates(creep, reservations) {
    if(!creep || !creep.memory || !creep.store || creep.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) {
        return [];
    }

    var homeRoomName = creep.memory.homeRoom || creep.room.name;
    var activeSources = RemotePlanner.getActiveRemoteSourcesForHome(homeRoomName);
    var candidates = [];

    if(!activeSources || activeSources.length === 0) {
        return candidates;
    }

    for(var i = 0; i < activeSources.length; i++) {
        var sourceInfo = activeSources[i];

        if(!sourceInfo || !sourceInfo.sourceId || !sourceInfo.roomName) {
            continue;
        }

        if(!RemotePlanner.shouldUseRemoteSource(homeRoomName, sourceInfo.sourceId)) {
            continue;
        }

        var haul = utility.ensureSourceHaulMemory(sourceInfo.roomName, sourceInfo.sourceId, homeRoomName);

        if(!haul || !haul.targetId) {
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
        var prediction = predictRemotePickup(sourceInfo, haul, creep, reservedCarry, assignedCount);
        var remainingEnergy = prediction.unreservedProjectedEnergy;

        if(!prediction.shouldDispatch || remainingEnergy <= 0) {
            continue;
        }

        haul.productionRate = prediction.productionRate;
        haul.ticksToFull = prediction.ticksToFull;
        haul.travelTicks = prediction.arrivalETA;
        haul.projectedFillAtArrival = prediction.projectedEnergyAtArrival;
        haul.inboundFreighters = assignedCount;
        haul.reservedCarry = reservedCarry;
        haul.dispatchSafetyTicks = prediction.dispatchSafetyTicks;
        haul.dispatchReason = prediction.dispatchReason;

        candidates.push({
            jobType: 'remote',
            targetId: haul.targetId,
            target: null,
            pickupRoom: sourceInfo.roomName,
            sourceId: sourceInfo.sourceId,
            type: haul.targetType,
            amount: haul.amount,
            projectedEnergyAtArrival: prediction.projectedEnergyAtArrival,
            ticksToFull: prediction.ticksToFull,
            arrivalETA: prediction.arrivalETA,
            remainingEnergy: remainingEnergy,
            assignedCount: assignedCount,
            estimatedDistance: sourceInfo.distance || getFallbackRemoteDistance(creep, sourceInfo.roomName),
            homeRoomName: homeRoomName,
            remoteRoomName: sourceInfo.roomName
        });
    }

    return candidates;
}

function predictRemotePickup(sourceInfo, haul, creep, reservedCarry, inboundFreighters) {
    var productionRate = Math.max(0, sourceInfo.effectiveEnergyPerTick ||
        sourceInfo.grossEnergyPerTick || haul.productionRate || 0);
    var currentEnergy = Math.max(0, haul.amount || 0);
    var isContainer = haul.targetType === 'container';
    var capacity = isContainer ? Math.max(currentEnergy, haul.capacity || 2000) : 0;
    var routeEstimate = creep && creep.body && creep.body.length ?
        RemotePlanner.getRouteTravelEstimate(sourceInfo, creep.body, false) : null;
    var arrivalETA = Math.max(1, routeEstimate && routeEstimate.outboundTicks ||
        sourceInfo.oneWayTravelTicks || sourceInfo.distance || 1);
    var futureEnergy = currentEnergy + productionRate * arrivalETA;
    var projectedEnergyAtArrival = isContainer ? Math.min(capacity, futureEnergy) : futureEnergy;
    var ticksToFull = isContainer && productionRate > 0 ?
        Math.max(0, (capacity - currentEnergy) / productionRate) : Infinity;
    var freeCarry = creep && creep.store && creep.store.getFreeCapacity ?
        creep.store.getFreeCapacity(RESOURCE_ENERGY) : 0;
    var unreservedProjectedEnergy = Math.max(0, projectedEnergyAtArrival - Math.max(0, reservedCarry || 0));
    var effectiveCapacity = isContainer ? capacity : Math.max(freeCarry, currentEnergy);
    var efficientLoad = Math.max(50, Math.min(freeCarry || 50, effectiveCapacity * 0.5));
    var route = sourceInfo.route || {};
    var terrain = route.terrain || {};
    var samples = route.travelSamples || 0;
    var deviation = route.travelDeviation || 0;
    var uncertainty = samples >= 5 ? 0 : Math.max(3, (route.length || sourceInfo.distance || 1) * 0.08);
    var dispatchSafetyTicks = Math.ceil(Math.max(3, Math.min(100,
        3 + (route.length || sourceInfo.distance || 1) * 0.03 + (terrain.swamp || 0) * 0.15 +
        deviation * 1.5 + uncertainty - Math.max(0, inboundFreighters || 0) * 2)));
    var dispatchReason = null;
    if (isContainer && ticksToFull <= arrivalETA + dispatchSafetyTicks) {
        dispatchReason = 'CONTAINER_FILL_BEFORE_ARRIVAL';
    }
    else if (unreservedProjectedEnergy >= efficientLoad) dispatchReason = 'PROJECTED_EFFICIENT_LOAD';
    else if (freeCarry > 0 && unreservedProjectedEnergy > freeCarry) {
        dispatchReason = 'UNRESERVED_ENERGY_EXCEEDS_INBOUND_CARRY';
    }
    var shouldDispatch = dispatchReason !== null;
    return {
        productionRate: productionRate,
        currentEnergy: currentEnergy,
        capacity: capacity,
        arrivalETA: arrivalETA,
        ticksToFull: ticksToFull,
        projectedEnergyAtArrival: projectedEnergyAtArrival,
        unreservedProjectedEnergy: unreservedProjectedEnergy,
        dispatchSafetyTicks: dispatchSafetyTicks,
        dispatchReason: dispatchReason,
        shouldDispatch: shouldDispatch
    };
}

function chooseBestPickupCandidate(candidates) {
    if(!candidates || candidates.length === 0) {
        return null;
    }

    /*
     * Pass 1 spreads Freighters across all local and remote targets together.
     * The largest unassigned energy job wins, so tiny local crumbs cannot block
     * a large remote container or pile.
     */
    var bestOpenTarget = null;

    for(var i = 0; i < candidates.length; i++) {
        var openCandidate = candidates[i];

        if(openCandidate.assignedCount > 0) {
            continue;
        }

        if(!bestOpenTarget || isBetterOpenPickupCandidate(openCandidate, bestOpenTarget)) {
            bestOpenTarget = openCandidate;
        }
    }

    if(bestOpenTarget) {
        return bestOpenTarget;
    }

    /*
     * Pass 2 doubles up only when all good targets already have a Freighter.
     * The biggest unreserved amount wins, then fewer assigned Freighters, then
     * shorter travel distance.
     */
    var bestSharedTarget = null;

    for(var j = 0; j < candidates.length; j++) {
        var sharedCandidate = candidates[j];

        if(sharedCandidate.remainingEnergy <= 0) {
            continue;
        }

        if(!bestSharedTarget || isBetterSharedPickupCandidate(sharedCandidate, bestSharedTarget)) {
            bestSharedTarget = sharedCandidate;
        }
    }

    return bestSharedTarget;
}

function isBetterOpenPickupCandidate(candidate, currentBest) {
    if(candidate.remainingEnergy > currentBest.remainingEnergy) {
        return true;
    }

    if(candidate.remainingEnergy < currentBest.remainingEnergy) {
        return false;
    }

    if(candidate.estimatedDistance < currentBest.estimatedDistance) {
        return true;
    }

    if(candidate.estimatedDistance > currentBest.estimatedDistance) {
        return false;
    }

    return candidate.jobType === 'local' && currentBest.jobType !== 'local';
}

function isBetterSharedPickupCandidate(candidate, currentBest) {
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

    if(candidate.estimatedDistance < currentBest.estimatedDistance) {
        return true;
    }

    if(candidate.estimatedDistance > currentBest.estimatedDistance) {
        return false;
    }

    return candidate.jobType === 'local' && currentBest.jobType !== 'local';
}

function applySelectedPickupCandidate(creep, candidate) {
    if(!candidate) {
        return false;
    }

    if(candidate.jobType === 'local') {
        if(!candidate.target || !isValidEnergyPickupTarget(candidate.target)) {
            return false;
        }

        rememberPickupTarget(creep, candidate.target, candidate.sourceId, candidate.type);
        collectFromTarget(creep, candidate.target);
        return true;
    }

    if(candidate.jobType === 'remote') {
        if(RemotePlanner.claimRemotePickupTarget(creep, candidate)) {
            handleRemoteCollection(creep);
            return true;
        }
    }

    return false;
}

function isCandidateBetterThanRememberedTarget(candidate, rememberedTarget) {
    var rememberedAmount = getEnergyPickupAmount(rememberedTarget);

    if(rememberedAmount <= 0) {
        return true;
    }

    return candidate.remainingEnergy > rememberedAmount;
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
     * The spawn-side pile is reserved for Foreman, Artificer, and Tech.
     * Freighters create it as overflow, but must not collect it again.
     */
    if(isProtectedSpawnStockpileDrop(creep, target)) {
        clearPickupMemory(creep);
        return;
    }

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

    if (creep.pos && creep.pos.isNearTo && creep.pos.isNearTo(target)) {
        RemotePlanner.recordRemoteTripLeg(creep, 'OUTBOUND');
    }

    if(target.resourceType) {
        result = creep.pickup(target);
    } else {
        result = creep.withdraw(target, RESOURCE_ENERGY);
    }

    if(result === OK) {
        var haul = utility.ensureSourceHaulMemory(
            creep.memory.pickupRoom,
            creep.memory.pickupSourceId,
            creep.memory.homeRoom
        );
        if (haul) haul.lastPickupAt = Game.time;
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
    var destinationRoomName = RemotePlanner.getLogisticsDestinationRoom(creep) || homeRoomName;

    if(destinationRoomName && creep.room.name !== destinationRoomName) {
        if (destinationRoomName === homeRoomName && creep.memory.remoteDeliverySourceId &&
            RemotePlanner.moveFreighterAlongRemotePath(
            creep, homeRoomName, creep.memory.remoteDeliverySourceId, true)) return;
        travel.moveToRoom(creep, destinationRoomName, {
            range: 22,
            reusePath: 20,
            visualizePathStyle: {
                stroke: '#ffffff'
            }
        });
        return;
    }

    RemotePlanner.recordRemoteTripLeg(creep, 'RETURN');

    var target = RemotePlanner.getHomeDeliveryTarget(creep, destinationRoomName);

    if(!target) {
        /*
         * Remote Freighters use the same spawn overflow pile as local
         * Freighters when normal home delivery targets cannot receive energy.
         */
        if(deliverToSpawnStockpile(creep) && creep.store[RESOURCE_ENERGY] === 0) {
            recordRemoteDelivery(creep);
            RemotePlanner.clearRemoteFreighterMemory(creep);
        }
        return;
    }

    var result = creep.transfer(target, RESOURCE_ENERGY);

    if(result === OK) {
        if(creep.store[RESOURCE_ENERGY] === 0) {
            recordRemoteDelivery(creep);
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

function getFreighterHomeRoomName(creep) {
    if(!creep || !creep.memory) {
        return null;
    }

    return creep.memory.homeRoom || creep.room.name;
}

function getRoomMemory(roomName, createIfMissing) {
    if(!roomName) {
        return null;
    }

    if(!Memory.rooms) {
        if(!createIfMissing) {
            return null;
        }

        Memory.rooms = {};
    }

    if(!Memory.rooms[roomName]) {
        if(!createIfMissing) {
            return null;
        }

        Memory.rooms[roomName] = {};
    }

    return Memory.rooms[roomName];
}

function getMainSpawnInRoom(room) {
    if(!room) {
        return null;
    }

    var spawns = room.find(FIND_MY_STRUCTURES, {
        filter: function(structure) {
            return structure.structureType === STRUCTURE_SPAWN;
        }
    });

    if(!spawns || spawns.length === 0) {
        return null;
    }

    var mainSpawn = spawns[0];

    for(var i = 1; i < spawns.length; i++) {
        if(spawns[i].name < mainSpawn.name) {
            mainSpawn = spawns[i];
        }
    }

    return mainSpawn;
}

function getSpawnStockpilePosition(creep) {
    var roomName = getFreighterHomeRoomName(creep);
    var room = roomName ? Game.rooms[roomName] : null;

    if(!room) {
        return null;
    }

    var spawn = getMainSpawnInRoom(room);

    if(!spawn) {
        return null;
    }

    var roomMemory = getRoomMemory(roomName, false);
    var cached = roomMemory ? roomMemory.freighterSpawnStockpilePos : null;

    if(
        cached &&
        cached.roomName === roomName &&
        typeof cached.x === 'number' &&
        typeof cached.y === 'number' &&
        isValidSpawnStockpilePosition(room, spawn, cached.x, cached.y)
    ) {
        return new RoomPosition(cached.x, cached.y, cached.roomName);
    }

    if(cached && roomMemory) {
        delete roomMemory.freighterSpawnStockpilePos;
    }

    var position = calculateSpawnStockpilePosition(room, spawn);

    if(!position) {
        return null;
    }

    roomMemory = getRoomMemory(roomName, true);

    if(roomMemory) {
        roomMemory.freighterSpawnStockpilePos = {
            x: position.x,
            y: position.y,
            roomName: position.roomName
        };
    }

    return position;
}

function calculateSpawnStockpilePosition(room, spawn) {
    var bestPosition = null;
    var bestScore = 999999;

    for(var x = spawn.pos.x - SPAWN_STOCKPILE_MAX_RANGE; x <= spawn.pos.x + SPAWN_STOCKPILE_MAX_RANGE; x++) {
        for(var y = spawn.pos.y - SPAWN_STOCKPILE_MAX_RANGE; y <= spawn.pos.y + SPAWN_STOCKPILE_MAX_RANGE; y++) {
            if(!isValidSpawnStockpilePosition(room, spawn, x, y)) {
                continue;
            }

            var score = getSpawnStockpilePositionScore(room, spawn, x, y);

            if(score < bestScore) {
                bestScore = score;
                bestPosition = new RoomPosition(x, y, room.name);
            }
        }
    }

    return bestPosition;
}

function isValidSpawnStockpilePosition(room, spawn, x, y) {
    if(!room || !spawn || x <= 0 || x >= 49 || y <= 0 || y >= 49) {
        return false;
    }

    if(spawn.pos.x === x && spawn.pos.y === y) {
        return false;
    }

    var position = new RoomPosition(x, y, room.name);
    var range = position.getRangeTo(spawn);

    if(range < SPAWN_STOCKPILE_MIN_RANGE || range > SPAWN_STOCKPILE_MAX_RANGE) {
        return false;
    }

    var terrain = room.lookForAt(LOOK_TERRAIN, x, y);

    if(terrain && terrain[0] === 'wall') {
        return false;
    }

    var structures = room.lookForAt(LOOK_STRUCTURES, x, y);

    for(var i = 0; i < structures.length; i++) {
        if(!isWalkableStockpileStructure(structures[i])) {
            return false;
        }
    }

    return true;
}

function isWalkableStockpileStructure(structure) {
    return (
        structure.structureType === STRUCTURE_ROAD ||
        structure.structureType === STRUCTURE_CONTAINER ||
        (
            structure.structureType === STRUCTURE_RAMPART &&
            (structure.my || structure.isPublic)
        )
    );
}

function getSpawnStockpilePositionScore(room, spawn, x, y) {
    var position = new RoomPosition(x, y, room.name);
    var score = position.getRangeTo(spawn);
    var terrain = room.lookForAt(LOOK_TERRAIN, x, y);
    var structures = room.lookForAt(LOOK_STRUCTURES, x, y);
    var constructionSites = room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);

    if(terrain && terrain[0] === 'swamp') {
        score += 1;
    }

    if(structures && structures.length > 0) {
        score += 20;
    }

    if(constructionSites && constructionSites.length > 0) {
        score += 25;
    }

    return score;
}

function isProtectedSpawnStockpileDrop(creep, resource) {
    if(
        !creep ||
        !resource ||
        !resource.pos ||
        !resource.resourceType ||
        resource.resourceType !== RESOURCE_ENERGY
    ) {
        return false;
    }

    var homeRoomName = getFreighterHomeRoomName(creep);

    if(!homeRoomName || resource.pos.roomName !== homeRoomName) {
        return false;
    }

    var stockpilePosition = getSpawnStockpilePosition(creep);

    if(
        stockpilePosition &&
        resource.pos.roomName === stockpilePosition.roomName &&
        resource.pos.getRangeTo(stockpilePosition) <= SPAWN_STOCKPILE_IGNORE_RANGE
    ) {
        return true;
    }

    var homeRoom = Game.rooms[homeRoomName];
    var spawn = getMainSpawnInRoom(homeRoom);

    return !!(spawn && resource.pos.getRangeTo(spawn) <= SPAWN_STOCKPILE_IGNORE_RANGE);
}

function deliverToSpawnStockpile(creep) {
    if(!creep || !creep.store || (creep.store[RESOURCE_ENERGY] || 0) <= 0) {
        return false;
    }

    var homeRoomName = getFreighterHomeRoomName(creep);

    if(homeRoomName && creep.room.name !== homeRoomName) {
        travel.moveToRoom(creep, homeRoomName, {
            range: 22,
            reusePath: 20,
            visualizePathStyle: {
                stroke: '#ffffff'
            }
        });
        return true;
    }

    var stockpilePosition = getSpawnStockpilePosition(creep);

    if(!stockpilePosition) {
        return false;
    }

    if(creep.pos.getRangeTo(stockpilePosition) <= 1) {
        /*
         * Intentional controlled overflow: Freighters drop here so Foreman,
         * Artificer, and Tech can consume the spawn-side stockpile later.
         * Dropping within range 1 prevents exact-tile traffic jams.
         */
        if(creep.drop(RESOURCE_ENERGY) === OK) {
            clearPickupMemory(creep);
        }

        return true;
    }

    travel.move(creep, stockpilePosition, {
        range: 1,
        visualizePathStyle: {
            stroke: '#ffffff'
        }
    });

    return true;
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
        deliverToSpawnStockpile(creep);
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

roleFreighter._test = {
    predictRemotePickup: predictRemotePickup,
    getRemotePickupCandidates: getRemotePickupCandidates,
    deliverRemoteEnergy: deliverRemoteEnergy,
    collectTransportJob: collectTransportJob,
    deliverTransportJob: deliverTransportJob,
    updateWorkingState: updateWorkingState
};

module.exports = roleFreighter;
