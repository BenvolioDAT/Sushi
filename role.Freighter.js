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
var LogisticsIndex = require('Logistics.Index');

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
        require('Freighter.Renewal').prune(creep);
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
    LogisticsJobs.reconcileDelivery(creep);
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
            if (creep.memory.logisticsRemaining > 0) creep.memory.freighterJob = 'transport';
            else LogisticsJobs.clear(creep);
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
            !isCandidateBetterThanRememberedTarget(selectedCandidate, rememberedTarget, creep)
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

    // A depleted pickup must not strand a partial load in collection mode.
    if ((creep.store[RESOURCE_ENERGY] || 0) > 0) {
        clearPickupMemory(creep);
        creep.memory.FreighterWorking = true;
        if (creep.room.name !== creep.memory.homeRoom) moveTowardHomeRoom(creep);
        else deliverEnergy(creep);
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

    if (RemotePlanner.moveFreighterAlongRemotePath(creep, creep.memory.homeRoom, creep.memory.pickupSourceId, false)) return true;

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
        RemotePlanner.retreatRemoteCreep(creep, creep.memory.homeRoom);
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
    var remaining = creep.memory.logisticsRemaining;
    if (remaining === undefined) remaining = creep.memory.logisticsRemaining = Math.max(0, creep.memory.logisticsAmount || 0);
    if (remaining <= 0) { LogisticsJobs.clear(creep); return; }
    var amount = Math.min(remaining - (creep.store[resource] || 0), creep.store.getFreeCapacity(resource), target.store[resource] || 0);
    if (amount <= 0) return;
    var result = creep.withdraw(target, resource, amount);
    if (result === ERR_NOT_IN_RANGE) travel.move(creep, target, { range: 1 });
    if (result === OK) {
        creep.memory.FreighterWorking = true;
        creep.memory.freighterJob = 'transportDelivery';
    }
}

function deliverTransportJob(creep) {
    LogisticsJobs.reconcileDelivery(creep);
    if (creep.memory.logisticsPendingDelivery) return;
    var destination = LogisticsJobs.destination(creep);
    var resource = creep.memory.resourceType || RESOURCE_ENERGY;
    if (creep.room.name !== destination) {
        travel.moveToRoom(creep, destination, { range: 22, reusePath: 20 });
        return;
    }
    var target = resource === RESOURCE_ENERGY ? RemotePlanner.getHomeDeliveryTarget(creep, destination) :
        (creep.room.storage || creep.room.terminal);
    if (!target) return;
    var amount = Math.min(creep.store[resource] || 0, creep.memory.logisticsRemaining || 0, target.store.getFreeCapacity(resource));
    if (amount <= 0) return;
    var before = creep.store[resource] || 0;
    var result = creep.transfer(target, resource, amount);
    if (result === OK) {
        creep.memory.logisticsPendingDelivery = { before: before, amount: amount, tick: Game.time };
        LogisticsJobs.reconcileDelivery(creep);
    }
    if (result === ERR_NOT_IN_RANGE) travel.move(creep, target, { range: 1 });
    if (result === OK && (creep.store[resource] || 0) === 0) {
        creep.memory.FreighterWorking = false;
        if (creep.memory.logisticsRemaining > 0) creep.memory.freighterJob = 'transport';
        else LogisticsJobs.clear(creep);
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
    return require('Diagnostics').measureOperation('pickupSelection', function() { return buildPickupCandidates(creep); });
}

function buildPickupCandidates(creep) {
    var localReservations = buildFreighterReservations(creep);
    var remoteReservations = buildRemoteFreighterReservations(creep);
    var candidates = [];

    candidates = candidates.concat(getLocalPickupCandidates(creep, localReservations));
    candidates = candidates.concat(getRemotePickupCandidates(creep, remoteReservations));

    return candidates;
}

function getLocalPickupCandidates(creep, reservations) {
    var homeRoomName = creep.memory.homeRoom || creep.room.name;

    if (creep.memory.assignmentFunction === 'remoteHauling') return [];

    /* Local pickup jobs are only the home room's source-side energy jobs. */
    if(creep.room.name !== homeRoomName) {
        return [];
    }

    var candidates = [];
    for (var option of LogisticsIndex.localPickupOptions(creep.room)) {
        var target = option.target;
        if (pickupBlocked(creep, target.id) ||
            option.type === 'dropped' && isProtectedSpawnStockpileDrop(creep, target)) continue;
        var remaining = option.amount - (reservations.byTargetEnergy[target.id] || 0);
        if (remaining <= 0) continue;
        var distance = creep.pos.getRangeTo(target);
        candidates.push({ jobType: 'local', targetId: target.id, target: target,
            pickupRoom: creep.room.name, sourceId: option.sourceId, type: option.type,
            amount: option.amount, remainingEnergy: remaining,
            assignedCount: Math.max(reservations.byTargetCount[target.id] || 0,
                option.type === 'container' ? reservations.bySourceCount[option.sourceId] || 0 : 0),
            estimatedDistance: distance,
            score: Math.min(creep.store.getFreeCapacity(RESOURCE_ENERGY), remaining) / (distance + 2),
            homeRoomName: homeRoomName, remoteRoomName: null });
    }
    return candidates;
}

function getRemotePickupCandidates(creep, reservations) {
    if(!creep || !creep.memory || creep.memory.assignmentFunction === 'localLogistics' ||
        !creep.store || creep.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) {
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
    if (candidate.jobType === 'local' && currentBest.jobType === 'local' && candidate.score !== currentBest.score) return candidate.score > currentBest.score;
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
    if (candidate.jobType === 'local' && currentBest.jobType === 'local' && candidate.score !== currentBest.score) return candidate.score > currentBest.score;
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

function isCandidateBetterThanRememberedTarget(candidate, rememberedTarget, creep) {
    var rememberedAmount = getEnergyPickupAmount(rememberedTarget);

    if(rememberedAmount <= 0) {
        return true;
    }

    if (candidate.jobType === 'local') {
        var score = Math.min(creep.store.getFreeCapacity(RESOURCE_ENERGY), rememberedAmount) / (creep.pos.getRangeTo(rememberedTarget) + 2);
        return candidate.score > score * 1.5;
    }
    return candidate.remainingEnergy > rememberedAmount * 1.5;
}

function pickupBlocked(creep, id) {
    return creep.memory.freighterPickupBlockedId === id && creep.memory.freighterPickupBlockedUntil > Game.time;
}


function buildRemoteFreighterReservations(creep) {
    return LogisticsIndex.reservations(creep, true);
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

    var byType = require('HiveMind.Index').get().structuresByRoom.get(homeRoom.name);
    return (byType && byType.get(STRUCTURE_TOWER) || []).some(function(structure) {
        if (structure.my === false || !structure.store) return false;
        var capacity = structure.store.getCapacity(RESOURCE_ENERGY) || 0;
        return capacity > 0 && structure.store.getUsedCapacity(RESOURCE_ENERGY) < capacity / 2;
    });
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
    if (!creep.memory.assignmentFunction) {
        if (creep.memory.freighterJob === 'remote' || creep.memory.freighterJob === 'remoteDelivery') {
            creep.memory.assignmentFunction = 'remoteHauling';
        } else if (creep.memory.freighterJob === 'transport' || creep.memory.freighterJob === 'transportDelivery') {
            creep.memory.assignmentFunction = 'otherLogistics';
        } else if (creep.memory.freighterJob === 'local' && creep.room.name === creep.memory.homeRoom) {
            creep.memory.assignmentFunction = 'localLogistics';
        }
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
        var moved = travel.move(creep, target, {
            range: 1,
            visualizePathStyle: {
                stroke: '#ffaa00'
            }
        });
        if (moved === ERR_NO_PATH || moved === ERR_INVALID_TARGET) {
            creep.memory.freighterPickupBlockedId = target.id;
            creep.memory.freighterPickupBlockedUntil = Game.time + 10;
            clearPickupMemory(creep);
        }
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

function rememberPickupTarget(creep, target, sourceId, pickupType) {
    delete creep.memory.freighterIdleSourceId;
    if(creep.memory.freighterJob === 'remote' || creep.memory.freighterJob === 'remoteDelivery') {
        RemotePlanner.clearRemoteFreighterMemory(creep);
    }

    /*
     * These memory fields are not permanent ownership. They are an intent:
     * "this Freighter is currently heading to this target/source." Other
     * Freighters read those intents when spreading themselves across work.
     */
    creep.memory.freighterJob = 'local';
    creep.memory.assignmentFunction = 'localLogistics';
    creep.memory.pickupRoom = creep.room.name;
    creep.memory.pickupTargetId = target.id;
    creep.memory.pickupSourceId = sourceId || target.id;
    creep.memory.pickupTargetType = pickupType;
    creep.memory.homeRoom = creep.memory.homeRoom || creep.room.name;
}

function buildFreighterReservations(creep) {
    return LogisticsIndex.reservations(creep, false);
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
    // Dedicated remote workers cannot collect local energy. Parking them at
    // mining lanes creates travel and congestion without a possible local job.
    if (creep.memory.assignmentFunction === 'remoteHauling') {
        delete creep.memory.freighterIdleSourceId;
        return;
    }
    /*
     * If no pickup target exists, move near the source that has the fewest
     * Freighters currently assigned.
     *
     * This keeps idle Freighters spread out instead of all parking at
     * the closest source.
     */
    var sources = require('HiveMind.Index').getSources(creep.room);

    if(!sources || sources.length === 0) {
        return;
    }

    var reservations = buildFreighterReservations(creep);
    var bestSource = null;
    var bestAssignedCount = 999999;
    var index = LogisticsIndex.snapshot();

    for(var i = 0; i < sources.length; i++) {
        var source = sources[i];
        var key = creep.room.name + '|' + source.id;
        var assignedCount = (reservations.bySourceCount[source.id] || 0) + (index.idleCounts[key] || 0) -
            (index.idleRows[creep.name] === key ? 1 : 0);

        if(assignedCount < bestAssignedCount || assignedCount === bestAssignedCount && source.id === creep.memory.freighterIdleSourceId) {
            bestAssignedCount = assignedCount;
            bestSource = source;
        }
    }

    if (bestSource) { creep.memory.freighterIdleSourceId = bestSource.id; LogisticsIndex.update(creep); }

    if(bestSource && creep.pos.getRangeTo(bestSource) > 3) {
        var cpu = require('CPU.Status').getCpuStatus();
        if (cpu.mode === 'low' || cpu.mode === 'critical') return;
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

    if (creep.memory.remoteDeliverySourceId && Memory.rooms[homeRoomName] &&
        Memory.rooms[homeRoomName].remotePlanner && RemotePlanner.moveFreighterAlongRemotePath(
        creep, homeRoomName, creep.memory.remoteDeliverySourceId, true)) return;
    if(destinationRoomName && creep.room.name !== destinationRoomName) {
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
        var moved = travel.move(creep, target, {
            range: 1,
            visualizePathStyle: {
                stroke: '#ffffff'
            }
        });
        if (moved === ERR_NO_PATH || moved === ERR_INVALID_TARGET) LogisticsIndex.blockDelivery(creep);
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

    var structures = require('HiveMind.Index').get().structuresByRoom.get(room.name);
    var spawns = (structures && structures.get(STRUCTURE_SPAWN) || []).filter(spawn => spawn.my !== false);

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
    var target = LogisticsIndex.deliveryTarget(creep, creep.memory.homeRoom || creep.room.name, false);

    if(!target) {
        deliverToSpawnStockpile(creep);
        return;
    }

    if(creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        var moved = travel.move(creep, target, {
            range: 1,
            visualizePathStyle: {
                stroke: '#ffffff'
            }
        });
        if (moved === ERR_NO_PATH || moved === ERR_INVALID_TARGET) LogisticsIndex.blockDelivery(creep);
    }
}

roleFreighter._test = {
    predictRemotePickup: predictRemotePickup,
    getRemotePickupCandidates: getRemotePickupCandidates,
    deliverRemoteEnergy: deliverRemoteEnergy,
    collectTransportJob: collectTransportJob,
    deliverTransportJob: deliverTransportJob,
    handleRemoteCollection: handleRemoteCollection,
    updateWorkingState: updateWorkingState
};

var runFreighter = roleFreighter.run;
roleFreighter.run = function(creep) {
    if (!creep || creep.spawning) return;
    var previous = creep.memory.freighterFlow;
    var cargo = creep.store[RESOURCE_ENERGY] || 0;
    var position = creep.pos.roomName + ':' + creep.pos.x + ':' + creep.pos.y;
    var consecutive = previous && previous.tick === Game.time - 1;
    var delta = consecutive ? cargo - previous.cargo : 0;
    var moved = !!(consecutive && position !== previous.position);
    var jobMovement = moved && !!(creep.memory.freighterJob || creep.memory.FreighterWorking && cargo > 0);
    var active = delta !== 0 || jobMovement;
    if (delta < 0 && creep.memory.remoteDeliverySourceId) recordRemoteDelivery(creep);
    creep.memory.freighterFlow = { tick: Game.time, cargo: cargo, position: position, active: active,
        picked: Math.min(1000000000, (previous && previous.picked || 0) + Math.max(0, delta)),
        delivered: Math.min(1000000000, (previous && previous.delivered || 0) + Math.max(0, -delta)),
        observedTicks: Math.min(1000000, (previous && previous.observedTicks || 0) + (consecutive ? 1 : 0)),
        workTicks: Math.min(1000000, (previous && previous.workTicks || 0) + (active ? 1 : 0)),
        parkingTicks: Math.min(1000000, (previous && previous.parkingTicks || 0) + (moved && !jobMovement ? 1 : 0)),
        idleTicks: active ? 0 : Math.min(1000000, (previous && previous.idleTicks || 0) + 1) };
    LogisticsIndex.update(creep);
    try { return runFreighter(creep); }
    finally { LogisticsIndex.update(creep); }
};
module.exports = roleFreighter;
