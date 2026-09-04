/*
 * role.Extractor.js
 *
 * Source miner role.
 *
 * Extractor chooses a source through utility.Creep assignment helpers, moves to
 * an assigned mining seat when one exists, harvests until full, then offloads to
 * a nearby container/link/storage or drops energy for haulers.
 */
var utility = require('utility');
var utilityCreep = require('utility.Creep');
var utilityTravelCreep = require('utility.Travel.Creep');
var RemotePlanner = require('Planner.Remote');
var Economy = require('HiveMind.Economy');

var SOURCE_HAUL_SCAN_INTERVAL = 5;

var roleExtractor = {

    /** @param {Creep} creep **/
    run: function(creep) {
        /*
         * Extractors are source harvesters. If the creep is missing or still
         * spawning, it cannot harvest, transfer, or drop energy this tick.
         */
        if(!creep || creep.spawning) {
            return;
        }
        /*
         * Keep source container planning fresh for this room. This may read
         * Memory.rooms[roomName].sources and write container planning fields.
         */
        utility.planSourceContainers(creep.room.name);

        // A Veinseeker is a basic source miner. It remembers one source if it can.
        /*
         * getAssignedSource uses room memory to spread miners between sources.
         * It may write creep.memory.sourceId and source assignment lists.
         */
        var source = utilityCreep.getAssignedSource(creep);
        //var source = getAssignedSource(creep);
        if(source && isHomeRoomSource(creep, source)) {
            delete creep.memory.remoteMining;
        }

        if(!source) {
            /*
             * Local room mining always gets first chance. Only when local source
             * assignment returns null (usually because local sources are full) do
             * we ask the remote planner for an extra source.
             */
            var remoteResult = getRemoteAssignedSourceResult(creep);

            if(remoteResult.moved) {
                creep.memory.extractorState = 'movingToRemoteSource';
                return;
            }

            source = remoteResult.source;
        }

        if(!source) {
            /*
             * No local or remote source means there is nothing useful for this
             * creep to mine. Idle near home instead of crowding a full source.
             */
            creep.memory.extractorState = 'idleNoSource';
            idleNearHome(creep);
            return;
        }

        creep.memory.extractorState = isHomeRoomSource(creep, source) ?
            'miningLocalSource' :
            'miningRemoteSource';

        /*
         * Keep the source-side pickup advertisement fresh every tick with
         * vision, including ticks where mining-seat handling returns early.
         */
        refreshVisibleSourceHaulTarget(creep, source);

        /*
         * If the creep has free energy capacity, keep harvesting. The RESOURCE_ENERGY
         * argument asks Screeps specifically about energy space, not other resources.
         */
        var miningSeat = utilityCreep.getAssignedMiningSeat(creep, source);

        if (!miningSeat && creep.memory.extractorState === 'waitingForContainerSeat') {
            waitForContainerSeat(creep, source);
            return;
        }

        setExtractorWorkingArea(creep, source);
        updateSourceHaulMemory(creep, source, false);

        if (miningSeat && !isCreepOnPosition(creep, miningSeat)) {
            /*
             * If the creep is already beside the source, let it harvest while
             * it moves onto the better seat. This keeps the WORK parts useful
             * during seat correction instead of spending a tick only walking.
             */
            if (creep.pos.getRangeTo(source.pos) <= 1 && creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                creep.harvest(source);
            }

            utilityTravelCreep.move(creep, miningSeat, {
                range: 0,
                visualizePathStyle: {
                    stroke: '#ffaa00'
                }
            });

            return;
        }

        if(creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            harvestSource(creep, source);
            return;
        }

        /* During a total wipe the miner temporarily closes the source-to-spawn
         * loop itself. This stops naturally as soon as local hauling returns. */
        if (isHomeRoomSource(creep, source) && deliverBootstrapEnergy(creep)) {
            return;
        }

        // When full, prefer a nearby container/link. If none exists, drop energy
        // so a Trucker can collect it instead of letting the miner stand idle.
        if(!offloadEnergy(creep, source)) {
            if(creep.drop(RESOURCE_ENERGY) === OK) {
                markSourceHaulForRescan(creep, source);
            }
        }
    }
};

function deliverBootstrapEnergy(creep) {
    var homeRoomName = creep.memory.homeRoom || creep.room.name;
    if (creep.room.name !== homeRoomName || !Economy.shouldBootstrapSelfDeliver(homeRoomName)) {
        return false;
    }

    var target = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
        filter: function(structure) {
            return (structure.structureType === STRUCTURE_SPAWN ||
                structure.structureType === STRUCTURE_EXTENSION) &&
                structure.store && structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
        }
    });

    if (!target) return false;
    var result = creep.transfer(target, RESOURCE_ENERGY);
    if (result === ERR_NOT_IN_RANGE) {
        utilityTravelCreep.move(creep, target, { visualizePathStyle: { stroke: '#ff5555' } });
    }
    creep.memory.extractorState = 'bootstrapSelfDelivery';
    return result === OK || result === ERR_NOT_IN_RANGE;
}



function isHomeRoomSource(creep, source) {
    if (!creep || !source || !source.pos) {
        return false;
    }

    var homeRoomName = creep.memory.homeRoom || creep.room.name;
    return source.pos.roomName === homeRoomName;
}

function getRemoteAssignedSourceResult(creep) {
    /*
     * A remote Extractor is still role: 'Extractor'. Planner.Remote only adds a
     * remoteMining assignment plus sourceId, targetSourceId, sourceRoom,
     * targetRoom, and homeRoom memory; there is no separate remote role.
     */
    var remoteInfo = RemotePlanner.getBestRemoteSourceForExtractor(creep);

    if (!remoteInfo) {
        delete creep.memory.remoteMining;
        return {
            source: null,
            moved: false
        };
    }

    var source = Game.getObjectById(remoteInfo.sourceId);

    if (source) {
        return {
            source: source,
            moved: false
        };
    }

    moveTowardRemoteSource(creep, remoteInfo);
    return {
        source: null,
        moved: true
    };
}

function moveTowardRemoteSource(creep, remoteInfo) {
    if (!creep || !remoteInfo) {
        return;
    }

    var homeRoomName = creep.memory.homeRoom;

    /*
     * If the saved lane is available, step along it. Planner.Remote keeps this
     * rebuilt path in heap/global cache and keeps only packed coordinates in
     * Memory so remote paths stay compact.
     */
    if (RemotePlanner.moveExtractorAlongRemotePath(creep, homeRoomName, remoteInfo.sourceId)) {
        return;
    }

    var targetPosition = RemotePlanner.getRemoteSourcePosition(homeRoomName, remoteInfo.sourceId);

    if (!targetPosition) {
        utilityTravelCreep.moveToRoom(creep, remoteInfo.roomName, {
            range: 22,
            visualizePathStyle: {
                stroke: '#ffaa00'
            }
        });
        return;
    }

    utilityTravelCreep.move(creep, targetPosition, {
        range: 1,
        visualizePathStyle: {
            stroke: '#ffaa00'
        }
    });
}

function idleNearHome(creep) {
    var homeRoomName = creep && creep.memory ? creep.memory.homeRoom : null;
    var homeRoom = homeRoomName ? Game.rooms[homeRoomName] : null;
    var target = null;

    if (!creep || !creep.room) {
        return;
    }

    if (homeRoom && homeRoom.storage) {
        target = homeRoom.storage;
    }

    if (!target && homeRoom) {
        target = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
    }

    if (target && target.pos && target.pos.roomName !== creep.pos.roomName) {
        utilityTravelCreep.moveToRoom(creep, target.pos.roomName, {
            range: 22,
            visualizePathStyle: {
                stroke: '#777777'
            }
        });
        return;
    }

    if (target && creep.pos.getRangeTo(target) > 3) {
        utilityTravelCreep.move(creep, target, {
            range: 3,
            visualizePathStyle: {
                stroke: '#777777'
            }
        });
    }
}

function isCreepOnPosition(creep, position) {
    if (!creep || !position) {
        return false;
    }

    return (
        creep.pos.x === position.x &&
        creep.pos.y === position.y &&
        creep.pos.roomName === position.roomName
    );
}

function setExtractorWorkingArea(creep, source) {
    /*
     * Traffic manager may gently shuffle idle creeps to unblock a room. Source
     * miners should stay useful, so keep any idle shuffle within harvest range.
     */
    if (
        !creep ||
        !source ||
        !source.pos ||
        typeof creep.setWorkingArea !== 'function'
    ) {
        return;
    }

    creep.setWorkingArea(source.pos, 1);
}

function waitForContainerSeat(creep, source) {
    if (!creep || !source || !source.pos) {
        return;
    }

    if (typeof creep.setWorkingArea === 'function') {
        creep.setWorkingArea(source.pos, 3);
    }

    var range = creep.pos.getRangeTo(source.pos);

    if (range >= 2 && range <= 3) {
        return;
    }

    if (range > 3) {
        utilityTravelCreep.move(creep, source, {
            range: 2,
            visualizePathStyle: {
                stroke: '#777777'
            }
        });
        return;
    }

    /* Move outward one tile without pathing through the occupied container. */
    var outwardDirection = source.pos.getDirectionTo(creep.pos);

    if (outwardDirection) {
        creep.move(outwardDirection);
    }
}

function getSourceFromRoomMemory(creep) {
    /*
     * Room scan data lives under Memory.rooms[roomName]. If the room has never
     * been scanned, there is no source memory to read.
     */
    if(!Memory.rooms || !Memory.rooms[creep.room.name]) {
        return null;
    }

    var sourcesMemory = Memory.rooms[creep.room.name].sources;
    if(!sourcesMemory) {
        return null;
    }

    // Sushi's room scan stores sources as Memory.rooms[roomName].sources[sourceId].
    /*
     * Loop through each remembered source record. hasOwnProperty avoids reading
     * inherited JavaScript properties that are not real source ids.
     */
    for(var sourceId in sourcesMemory) {
        if(!sourcesMemory.hasOwnProperty(sourceId)) {
            continue;
        }

        var sourceMemory = sourcesMemory[sourceId];
        var id = sourceMemory && sourceMemory.id ? sourceMemory.id : sourceId;
        var source = Game.getObjectById(id);
        if(source) {
            return source;
        }
    }

    return null;
}

function harvestSource(creep, source) {
    /*
     * creep.harvest uses WORK parts to take energy from a Source. OK means the
     * harvest happened; ERR_NOT_IN_RANGE means the source is valid but too far.
     */
    var result = creep.harvest(source);
    if(result === ERR_NOT_IN_RANGE) {
        utilityTravelCreep.move(creep, source, {visualizePathStyle: {stroke: '#ffaa00'}});
    }
}

function offloadEnergy(creep, source) {
    /*
     * Source miners try to put energy into nearby logistics structures. The
     * search is centered on source.pos because source containers are normally
     * built right beside the source.
     */
    var nearbyStores = source.pos.findInRange(FIND_STRUCTURES, 2, {
        filter: function(structure) {
            return (
                (structure.structureType === STRUCTURE_CONTAINER ||
                 structure.structureType === STRUCTURE_LINK ||
                 structure.structureType === STRUCTURE_STORAGE) &&
                structure.store &&
                structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0
            );
        }
    });

    if(nearbyStores && nearbyStores.length > 0) {
        /*
         * transfer moves energy from the creep into the structure store.
         * Returning true tells run() that offloading was handled this tick.
         */
        var transferTarget = nearbyStores[0];
        var transferResult = creep.transfer(transferTarget, RESOURCE_ENERGY);

        if(transferResult === ERR_NOT_IN_RANGE) {
            utilityTravelCreep.move(creep, nearbyStores[0], {visualizePathStyle: {stroke: '#ffffff'}});
        }
        else if(transferResult === OK) {
            recordSourceContainerHaul(creep, source, transferTarget);
        }
        return true;
    }

    return false;
}

function updateSourceHaulMemory(creep, source, force) {
    if (!creep || !source || !source.pos) {
        return;
    }

    var homeRoomName = creep.memory.homeRoom || creep.room.name;
    var haul = utility.ensureSourceHaulMemory(source.pos.roomName, source.id, homeRoomName);

    if (!haul) {
        return;
    }

    if (
        !force &&
        typeof haul.lastScannedAt === 'number' &&
        Game.time - haul.lastScannedAt < SOURCE_HAUL_SCAN_INTERVAL
    ) {
        return;
    }

    haul.lastScannedAt = Game.time;
    clearDeadHaulReservation(haul);

    var options = [];
    var droppedEnergy = source.pos.findInRange(FIND_DROPPED_RESOURCES, 3, {
        filter: function(resource) {
            return resource.resourceType === RESOURCE_ENERGY && resource.amount > 0;
        }
    });
    var sourceContainers = source.pos.findInRange(FIND_STRUCTURES, 2, {
        filter: function(structure) {
            return structure.structureType === STRUCTURE_CONTAINER &&
                structure.store &&
                getStoredEnergy(structure) > 0;
        }
    });

    for (var containerIndex = 0; containerIndex < sourceContainers.length; containerIndex++) {
        options.push({
            targetId: sourceContainers[containerIndex].id,
            targetType: 'container',
            amount: getStoredEnergy(sourceContainers[containerIndex]),
            capacity: sourceContainers[containerIndex].store.getCapacity(RESOURCE_ENERGY) || 2000
        });
    }

    for (var dropIndex = 0; dropIndex < droppedEnergy.length; dropIndex++) {
        options.push({
            targetId: droppedEnergy[dropIndex].id,
            targetType: 'dropped',
            amount: droppedEnergy[dropIndex].amount
        });
    }

    var best = null;
    var current = null;

    for (var optionIndex = 0; optionIndex < options.length; optionIndex++) {
        var option = options[optionIndex];

        if (option.targetId === haul.targetId) {
            current = option;
        }

        if (!best || option.amount > best.amount) {
            best = option;
        }
    }

    /*
     * Do not switch a live reservation to a different pile while a Freighter is
     * already traveling. Once that reservation ends, the largest nearby target
     * becomes the advertised job on the next scan.
     */
    var hasLivingReservation = isLivingHaulReservation(haul);

    if (hasLivingReservation) {
        if (current) {
            best = current;
        }
        else if (best) {
            haul.homeRoom = homeRoomName;
            return;
        }
    }

    if (!best) {
        clearObservedHaulTargetFields(haul);
        if (!hasLivingReservation) {
            clearHaulReservation(haul);
        }
        haul.lastSeen = Game.time;
        haul.homeRoom = homeRoomName;
        return;
    }

    if (haul.targetId !== best.targetId) {
        clearHaulReservation(haul);
    }

    haul.targetId = best.targetId;
    haul.targetType = best.targetType;
    haul.amount = best.amount;
    haul.capacity = best.capacity || haul.capacity || 0;
    haul.lastSeen = Game.time;
    haul.homeRoom = homeRoomName;
}

function refreshVisibleSourceHaulTarget(creep, source) {
    if (!creep || !creep.memory || !source || !source.pos) {
        return;
    }

    var homeRoomName = creep.memory.homeRoom || creep.room.name;
    var haul = utility.ensureSourceHaulMemory(source.pos.roomName, source.id, homeRoomName);

    if (!haul) {
        return;
    }

    clearDeadHaulReservation(haul);

    var bestContainer = null;
    var bestDrop = null;
    var currentTarget = null;
    var sourceContainers = source.pos.findInRange(FIND_STRUCTURES, 2, {
        filter: function(structure) {
            return structure.structureType === STRUCTURE_CONTAINER &&
                structure.store &&
                getStoredEnergy(structure) > 0;
        }
    });
    var droppedEnergy = source.pos.findInRange(FIND_DROPPED_RESOURCES, 3, {
        filter: function(resource) {
            return resource.resourceType === RESOURCE_ENERGY && resource.amount > 0;
        }
    });

    for (var containerIndex = 0; containerIndex < sourceContainers.length; containerIndex++) {
        var containerOption = {
            targetId: sourceContainers[containerIndex].id,
            targetType: 'container',
            amount: getStoredEnergy(sourceContainers[containerIndex]),
            capacity: sourceContainers[containerIndex].store.getCapacity(RESOURCE_ENERGY) || 2000
        };

        if (containerOption.targetId === haul.targetId) {
            currentTarget = containerOption;
        }

        if (!bestContainer || containerOption.amount > bestContainer.amount) {
            bestContainer = containerOption;
        }
    }

    for (var dropIndex = 0; dropIndex < droppedEnergy.length; dropIndex++) {
        var dropOption = {
            targetId: droppedEnergy[dropIndex].id,
            targetType: 'dropped',
            amount: droppedEnergy[dropIndex].amount
        };

        if (dropOption.targetId === haul.targetId) {
            currentTarget = dropOption;
        }

        if (!bestDrop || dropOption.amount > bestDrop.amount) {
            bestDrop = dropOption;
        }
    }

    /* Containers win ties; a larger dropped pile is still worth advertising. */
    var bestTarget = bestContainer;
    if (bestDrop && (!bestTarget || bestDrop.amount > bestTarget.amount)) {
        bestTarget = bestDrop;
    }

    if (!bestTarget) {
        var preserveReservation = isLivingHaulReservation(haul);
        clearObservedHaulTargetFields(haul);
        if (!preserveReservation) {
            clearHaulReservation(haul);
        }
        recordHaulAdvertisement(haul, creep, source, homeRoomName);
        return;
    }

    if (haul.targetId === bestTarget.targetId) {
        updateObservedHaulTarget(haul, bestTarget);
        recordHaulAdvertisement(haul, creep, source, homeRoomName);
        return;
    }

    if (isLivingHaulReservation(haul)) {
        if (currentTarget) {
            updateObservedHaulTarget(haul, currentTarget);
            recordHaulAdvertisement(haul, creep, source, homeRoomName);
        }
        else {
            /* Keep the claim stable, but do not refresh an unobserved target. */
            recordHaulAdvertisement(haul, creep, source, homeRoomName, false);
        }
        return;
    }

    clearHaulReservation(haul);
    updateObservedHaulTarget(haul, bestTarget);
    recordHaulAdvertisement(haul, creep, source, homeRoomName);
}

function updateObservedHaulTarget(haul, target) {
    haul.targetId = target.targetId;
    haul.targetType = target.targetType;
    haul.amount = target.amount;
    haul.capacity = target.capacity || haul.capacity || 0;
}

function recordHaulAdvertisement(haul, creep, source, homeRoomName, updateLastSeen) {
    if (updateLastSeen !== false) {
        haul.lastSeen = Game.time;
    }
    haul.homeRoom = homeRoomName;
    haul.roomName = source.pos.roomName;
    haul.sourceId = source.id;
    haul.lastAdvertisedBy = creep.name;
    haul.lastAdvertisedRoom = creep.room.name;
    haul.lastAdvertisedAt = Game.time;
}

function recordSourceContainerHaul(creep, source, target) {
    var homeRoomName = creep.memory.homeRoom || creep.room.name;
    var haul = utility.ensureSourceHaulMemory(source.pos.roomName, source.id, homeRoomName);

    if (!haul) {
        return;
    }

    if (target.structureType !== STRUCTURE_CONTAINER) {
        haul.lastSeen = 0;
        return;
    }

    if (haul.targetId !== target.id && isLivingHaulReservation(haul)) {
        haul.lastSeen = 0;
        return;
    }

    if (haul.targetId !== target.id) {
        clearHaulReservation(haul);
    }

    haul.targetId = target.id;
    haul.targetType = 'container';
    haul.amount = getStoredEnergy(target) + (creep.store[RESOURCE_ENERGY] || 0);
    haul.capacity = target.store.getCapacity(RESOURCE_ENERGY) || 2000;
    haul.lastSeen = Game.time;
    haul.homeRoom = homeRoomName;
}

function markSourceHaulForRescan(creep, source) {
    var homeRoomName = creep.memory.homeRoom || creep.room.name;
    var haul = utility.ensureSourceHaulMemory(source.pos.roomName, source.id, homeRoomName);

    if (haul) {
        haul.lastSeen = 0;
    }
}

function isLivingHaulReservation(haul) {
    return haul &&
        haul.reservedBy &&
        haul.reservedUntil >= Game.time &&
        Game.creeps[haul.reservedBy];
}

function clearDeadHaulReservation(haul) {
    if (!haul || isLivingHaulReservation(haul)) {
        return;
    }

    if (haul.reservedBy || haul.reservedUntil || haul.reservedCarry) {
        clearHaulReservation(haul);
    }
}

function clearObservedHaulTargetFields(haul) {
    haul.targetId = null;
    haul.targetType = null;
    haul.amount = 0;
}

function clearHaulReservation(haul) {
    haul.reservedBy = null;
    haul.reservedUntil = 0;
    haul.reservedCarry = 0;
}

function getStoredEnergy(target) {
    if (!target || !target.store) {
        return 0;
    }

    if (typeof target.store.getUsedCapacity === 'function') {
        return target.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    }

    return target.store[RESOURCE_ENERGY] || 0;
}

module.exports = roleExtractor;
