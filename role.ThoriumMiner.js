var travel = require('utility.Travel.Creep');
var Season11 = require('Logic.Season11');
var Season11Adapter = require('Season11.Adapter');

function moveResultFailed(result) {
    var noPath = typeof ERR_NO_PATH !== 'undefined' ? ERR_NO_PATH : -2;
    var invalidTarget = typeof ERR_INVALID_TARGET !== 'undefined' ?
        ERR_INVALID_TARGET : -7;
    var invalidArgs = typeof ERR_INVALID_ARGS !== 'undefined' ? ERR_INVALID_ARGS : -10;
    return result === noPath || result === invalidTarget || result === invalidArgs;
}

function getFreeCapacity(creep, resourceType) {
    if (!creep || !creep.store) {
        return 0;
    }
    if (typeof creep.store.getFreeCapacity === 'function') {
        return creep.store.getFreeCapacity(resourceType) || 0;
    }
    return 0;
}

function moveToRoom(creep, roomName) {
    var result = travel.moveToRoom(creep, roomName, {
        range: 22,
        reusePath: 20,
        allowHostile: false,
        visualizePathStyle: { stroke: '#66ddff' }
    });
    if (moveResultFailed(result)) {
        Season11.noteRouteFailure(creep.room.name, roomName,
            creep.name + ' miner route');
    }
    return result;
}

function deliver(creep, staging, resourceType) {
    if (!staging) {
        return false;
    }
    var result = creep.transfer(staging, resourceType);
    var notInRange = typeof ERR_NOT_IN_RANGE !== 'undefined' ? ERR_NOT_IN_RANGE : -9;
    if (result === notInRange) {
        travel.move(creep, staging, {
            range: 1,
            reusePath: 10,
            visualizePathStyle: { stroke: '#66ddff' }
        });
    }
    return result === 0;
}

var roleThoriumMiner = {
    run: function(creep) {
        if (!creep || creep.spawning || !creep.memory ||
            !Season11.isOperatingMode()) {
            return;
        }

        var resourceType = Season11.getThoriumResourceType();
        var sourceRoom = creep.memory.season11SourceRoom;
        if (!resourceType || !sourceRoom) {
            return;
        }

        var carried = Season11.getStoreAmount(creep, resourceType);
        var staging = typeof Game.getObjectById === 'function' ?
            Game.getObjectById(creep.memory.season11StagingId) : null;

        if (creep.room.name !== sourceRoom) {
            moveToRoom(creep, sourceRoom);
            return;
        }

        var mineral = typeof Game.getObjectById === 'function' ?
            Game.getObjectById(creep.memory.season11MineralId) : null;
        if (!mineral || (typeof mineral.mineralAmount === 'number' &&
            mineral.mineralAmount <= 0)) {
            Season11.markThoriumDepleted(sourceRoom,
                creep.memory.season11MineralId);
            if (carried > 0) {
                deliver(creep, staging, resourceType);
            }
            return;
        }

        if (!staging) {
            Season11.noteRouteFailure(sourceRoom, sourceRoom,
                sourceRoom + ' missing Thorium staging');
            return;
        }

        if (carried > 0 && getFreeCapacity(creep, resourceType) <= 0) {
            deliver(creep, staging, resourceType);
            return;
        }

        if (Season11.shouldPauseMining(sourceRoom)) {
            if (carried > 0) deliver(creep, staging, resourceType);
            return;
        }
        var result = Season11Adapter.harvestThorium(creep, mineral);
        var notInRange = typeof ERR_NOT_IN_RANGE !== 'undefined' ? ERR_NOT_IN_RANGE : -9;
        var exhausted = typeof ERR_NOT_ENOUGH_RESOURCES !== 'undefined' ?
            ERR_NOT_ENOUGH_RESOURCES : -6;
        var noExtractor = typeof ERR_NOT_FOUND !== 'undefined' ? ERR_NOT_FOUND : -5;

        if (result === notInRange) {
            travel.move(creep, mineral, {
                range: 1,
                reusePath: 10,
                visualizePathStyle: { stroke: '#66ddff' }
            });
        }
        else if (result === exhausted) {
            Season11.markThoriumDepleted(sourceRoom, mineral.id);
        }
        else if (result === noExtractor) {
            Season11.noteRouteFailure(sourceRoom, sourceRoom,
                sourceRoom + ' extractor missing or inactive');
        }
    }
};

module.exports = roleThoriumMiner;
