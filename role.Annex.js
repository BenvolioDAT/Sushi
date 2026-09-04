/*
 * Annex reserves controllers in active remote mining rooms. When explicitly
 * spawned with annexMode === 'expand', it claims the configured expansion
 * target instead. Normal remote mining rooms still use reserve mode.
 */
var travel = require('utility.Travel.Creep');
var HiveMemory = require('HiveMind.Memory');
var RemotePlanner = require('Planner.Remote');

var ANNEX_PATH_STYLE = {
    stroke: '#b366ff'
};
var ANNEX_SIGN = '\uD83D\uDC1D Sushi Annex \u2014 reserved for remote logistics.';
var ANNEX_EXPAND_SIGN = 'Sushi expansion outpost.';

var roleAnnex = {
    /** @param {Creep} creep **/
    run: function(creep) {
        if (!creep || creep.spawning) {
            return;
        }

        if (creep.memory.annexMode === 'expand') {
            runExpandMode(creep);
            return;
        }

        creep.memory.annexMode = 'reserve';

        var targetRoomName = creep.memory.targetRoom;
        if (!targetRoomName) {
            creep.memory.annexState = 'idleNoTarget';
            idleNearHome(creep);
            return;
        }

        /*
         * Ownership and hostile-reservation blocks are terminal for this first
         * version. Keep the assignment for debugging, but do not path back into
         * the blocked room after the creep has started returning home.
         */
        if (isTerminalReserveState(creep.memory.annexState)) {
            idleNearHome(creep);
            return;
        }

        var homePlanner = Memory.rooms[creep.memory.homeRoom] && Memory.rooms[creep.memory.homeRoom].remotePlanner;
        if (homePlanner && homePlanner.sourceInfos) {
            var known = Object.values(homePlanner.sourceInfos).filter(function(info) { return info.roomName === targetRoomName; });
            if (known.length && !known.some(function(info) {
                return info.active && info.operational !== false && (!info.route || info.route.valid !== false);
            })) {
                creep.memory.annexState = 'waitingForRemoteRoute';
                RemotePlanner.retreatRemoteCreep(creep, creep.memory.homeRoom);
                return;
            }
        }
        var targetRoom = Game.rooms[targetRoomName];
        if (!targetRoom) {
            creep.memory.annexState = 'movingToTargetRoom';
            travel.moveToRoom(creep, targetRoomName, {
                range: 22,
                visualizePathStyle: ANNEX_PATH_STYLE
            });
            return;
        }

        var controller = targetRoom.controller;
        if (!controller) {
            creep.memory.annexState = 'invalidReserveTarget';
            idleNearHome(creep);
            return;
        }

        creep.memory.targetControllerId = controller.id;

        if (controller.owner && controller.owner.username !== creep.owner.username) {
            creep.memory.annexState = 'blockedOwnedController';
            idleNearHome(creep);
            return;
        }

        if (controller.my) {
            creep.memory.annexState = 'alreadyMine';
            idleNearHome(creep);
            return;
        }

        if (
            controller.reservation &&
            controller.reservation.username !== creep.owner.username
        ) {
            creep.memory.annexState = 'blockedHostileReservation';
            idleNearHome(creep);
            return;
        }

        var reserveResult = creep.reserveController(controller);

        if (reserveResult === ERR_NOT_IN_RANGE) {
            creep.memory.annexState = 'movingToController';
            travel.move(creep, controller, {
                range: 1,
                visualizePathStyle: ANNEX_PATH_STYLE
            });
            return;
        }

        if (reserveResult === ERR_INVALID_TARGET) {
            creep.memory.annexState = 'invalidReserveTarget';
            return;
        }

        if (reserveResult !== OK) {
            creep.memory.annexState = 'invalidReserveTarget';
            return;
        }

        creep.memory.annexState = 'reserving';
        if (Game.time % 25 === 0) {
            RemotePlanner.scoreRemoteRoom(creep.memory.homeRoom, targetRoomName);
        }

        /* Signing is secondary: the reservation intent is always issued first. */
        if ((!controller.sign || controller.sign.text !== ANNEX_SIGN) && creep.pos.inRangeTo(controller, 1)) {
            if (creep.signController(controller, ANNEX_SIGN) === OK) {
                creep.memory.annexState = 'signing';
            }
        }
    }
};

function runExpandMode(creep) {
    var targetRoomName = creep.memory.targetRoom;

    if (!targetRoomName) {
        creep.memory.annexState = 'expandNoTarget';
        idleNearHome(creep);
        return;
    }

    if (creep.room.name !== targetRoomName) {
        creep.memory.annexState = 'expandMovingToTargetRoom';
        travel.moveToRoom(creep, targetRoomName, {
            range: 22,
            visualizePathStyle: ANNEX_PATH_STYLE
        });
        return;
    }

    var controller = creep.room.controller;

    if (!controller) {
        creep.memory.annexState = 'expandInvalidTarget';
        blockExpansion(targetRoomName, 'Target room has no controller');
        idleNearHome(creep);
        return;
    }

    creep.memory.targetControllerId = controller.id;

    if (controller.owner && !controller.my) {
        creep.memory.annexState = 'expandBlockedOwnedController';
        blockExpansion(targetRoomName, 'Target controller is owned by another player');
        idleNearHome(creep);
        return;
    }

    if (
        controller.reservation &&
        controller.reservation.username !== getMyUsername(creep)
    ) {
        creep.memory.annexState = 'expandBlockedHostileReservation';
        blockExpansion(targetRoomName, 'Target controller has a hostile reservation');
        idleNearHome(creep);
        return;
    }

    if (controller.my) {
        creep.memory.annexState = 'expandClaimed';
        markExpansionClaimed(targetRoomName);
        signExpansionController(creep, controller);
        return;
    }

    var claimResult = creep.claimController(controller);

    if (claimResult === ERR_NOT_IN_RANGE) {
        creep.memory.annexState = 'expandMovingToController';
        travel.move(creep, controller, {
            range: 1,
            visualizePathStyle: ANNEX_PATH_STYLE
        });
        return;
    }

    if (claimResult === OK) {
        creep.memory.annexState = 'expandClaiming';
        markExpansionClaimed(targetRoomName);
        signExpansionController(creep, controller);
        return;
    }

    if (claimResult === ERR_GCL_NOT_ENOUGH) {
        creep.memory.annexState = 'expandBlockedGcl';
        blockExpansion(targetRoomName, 'Not enough GCL to claim target controller');
        return;
    }

    creep.memory.annexState = 'expandBlockedClaimResult';
    blockExpansion(targetRoomName, 'claimController failed: ' + claimResult);
}

function signExpansionController(creep, controller) {
    if (!controller || !creep.pos.inRangeTo(controller, 1)) {
        return false;
    }

    if (controller.sign && controller.sign.text === ANNEX_EXPAND_SIGN) {
        return true;
    }

    return creep.signController(controller, ANNEX_EXPAND_SIGN) === OK;
}

function markExpansionClaimed(targetRoomName) {
    var expansion = HiveMemory.ensure().expansion;
    if (expansion.targetRoom !== targetRoomName) {
        return;
    }

    expansion.state = 'placeSpawn';
    expansion.claimedAt = expansion.claimedAt || Game.time;
    expansion.blockReason = null;
}

function blockExpansion(targetRoomName, reason) {
    var expansion = HiveMemory.ensure().expansion;
    if (expansion.targetRoom !== targetRoomName) {
        return;
    }

    expansion.state = 'blocked';
    expansion.blockReason = reason;
    expansion.lastUpdated = Game.time;
}

function getMyUsername(creep) {
    if (creep && creep.owner && creep.owner.username) {
        return creep.owner.username;
    }

    return HiveMemory.ensure().identity.username || null;
}

function idleNearHome(creep) {
    var homeRoomName = creep.memory.homeRoom;
    var homeRoom = homeRoomName ? Game.rooms[homeRoomName] : null;
    var target = null;

    if (homeRoomName && creep.room.name !== homeRoomName) {
        travel.moveToRoom(creep, homeRoomName, {
            range: 22,
            visualizePathStyle: ANNEX_PATH_STYLE
        });
        return;
    }

    if (homeRoom && homeRoom.storage) {
        target = homeRoom.storage;
    } else if (homeRoom) {
        var spawns = homeRoom.find(FIND_MY_SPAWNS);
        target = spawns.length > 0 ? spawns[0] : null;
    }

    if (target && creep.pos.getRangeTo(target) > 3) {
        travel.move(creep, target, {
            range: 3,
            visualizePathStyle: ANNEX_PATH_STYLE
        });
    }
}

function isTerminalReserveState(state) {
    return state === 'blockedOwnedController' ||
        state === 'blockedHostileReservation' ||
        state === 'alreadyMine' ||
        state === 'invalidReserveTarget';
}

module.exports = roleAnnex;
