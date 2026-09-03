var travel = require('utility.Travel.Creep');
var Season11 = require('Logic.Season11');
var Season11Operations = require('Season11.Operations');

function moveFailed(result) {
    var noPath = typeof ERR_NO_PATH !== 'undefined' ? ERR_NO_PATH : -2;
    var invalidTarget = typeof ERR_INVALID_TARGET !== 'undefined' ?
        ERR_INVALID_TARGET : -7;
    var invalidArgs = typeof ERR_INVALID_ARGS !== 'undefined' ? ERR_INVALID_ARGS : -10;
    return result === noPath || result === invalidTarget || result === invalidArgs;
}

function travelToRoom(creep, roomName, label) {
    var result = travel.moveToRoom(creep, roomName, {
        range: 22,
        reusePath: 20,
        allowHostile: false,
        visualizePathStyle: { stroke: '#aa66ff' }
    });
    if (moveFailed(result)) {
        Season11.noteRouteFailure(creep.room.name, roomName,
            creep.name + ' ' + label);
    }
    return result;
}

function waitNear(creep, target) {
    if (target && creep.pos.getRangeTo(target) > 2) {
        travel.move(creep, target, {
            range: 2,
            reusePath: 10,
            visualizePathStyle: { stroke: '#8866aa' }
        });
    }
}

function returnCargo(creep, staging, resourceType) {
    if (!staging) {
        return;
    }
    if (creep.room.name !== staging.pos.roomName) {
        travelToRoom(creep, staging.pos.roomName, 'cargo return');
        return;
    }
    var result = creep.transfer(staging, resourceType);
    var notInRange = typeof ERR_NOT_IN_RANGE !== 'undefined' ? ERR_NOT_IN_RANGE : -9;
    if (result === notInRange) {
        travel.move(creep, staging, { range: 1, reusePath: 10 });
    }
}

var roleThoriumHauler = {
    run: function(creep) {
        if (!creep || creep.spawning || !creep.memory ||
            !Season11.isOperatingMode()) {
            return;
        }

        var resourceType = Season11.getThoriumResourceType();
        if (!resourceType) {
            return;
        }

        var staging = typeof Game.getObjectById === 'function' ?
            Game.getObjectById(creep.memory.season11StagingId) : null;
        var reactor = typeof Game.getObjectById === 'function' ?
            Game.getObjectById(creep.memory.season11ReactorId) : null;
        var reactorRecord = Season11.ensureMemory().reactors[creep.memory.season11ReactorId];
        var sourceRoom = creep.memory.season11SourceRoom;
        var reactorRoom = creep.memory.season11ReactorRoom;
        var carried = Season11.getStoreAmount(creep, resourceType);
        var tileAging = Season11.observeTileThorium(creep.pos);
        creep.memory.season11ObservedTileThorium = tileAging.total;
        creep.memory.season11AgingMultiplier = tileAging.multiplier;
        creep.memory.season11AgingEstimateSource = tileAging.source;

        if (!staging) {
            Season11.noteRouteFailure(creep.room.name, sourceRoom,
                sourceRoom + ' staging disappeared');
            return;
        }

        /* Never feed an unclaimed or stolen Reactor. Bring cargo back safely. */
        if ((reactor && reactor.my !== true) || (!reactor && reactorRecord && reactorRecord.my !== true)) {
            if (carried > 0) {
                returnCargo(creep, staging, resourceType);
            }
            else {
                waitNear(creep, staging);
            }
            return;
        }

        if (carried > 0) {
            var routeTiles = Math.max(1,
                Number(creep.memory.season11RouteDistance) || 50);
            var eta = creep.room.name === reactorRoom && reactor ?
                creep.pos.getRangeTo(reactor) : routeTiles;
            Season11.noteCreepEta(creep, eta);

            if (!reactor) {
                if (creep.room.name !== reactorRoom) {
                    travelToRoom(creep, reactorRoom, 'Reactor delivery');
                }
                return;
            }

            var transferResult = creep.transfer(reactor, resourceType);
            var notInRange = typeof ERR_NOT_IN_RANGE !== 'undefined' ?
                ERR_NOT_IN_RANGE : -9;
            if (transferResult === notInRange) {
                travel.move(creep, reactor, {
                    range: 1,
                    reusePath: 10,
                    visualizePathStyle: { stroke: '#aa66ff' }
                });
            }
            else if (transferResult === (typeof OK !== 'undefined' ? OK : 0)) {
                Season11Operations.noteDelivery(carried, {
                    creepName: creep.name,
                    sourceRoom: sourceRoom,
                    reactorId: reactor.id,
                    reactorRoom: reactorRoom
                });
            }
            return;
        }

        delete creep.memory.season11DeliveryEta;
        if (creep.room.name !== sourceRoom) {
            travelToRoom(creep, sourceRoom, 'Thorium pickup');
            return;
        }

        if (Season11.getStoreAmount(staging, resourceType) <= 0) {
            waitNear(creep, staging);
            return;
        }

        var withdrawResult = creep.withdraw(staging, resourceType);
        var withdrawRange = typeof ERR_NOT_IN_RANGE !== 'undefined' ?
            ERR_NOT_IN_RANGE : -9;
        if (withdrawResult === withdrawRange) {
            travel.move(creep, staging, {
                range: 1,
                reusePath: 10,
                visualizePathStyle: { stroke: '#aa66ff' }
            });
        }
    }
};

module.exports = roleThoriumHauler;
