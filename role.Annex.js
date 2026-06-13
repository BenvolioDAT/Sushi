/*
 * Annex reserves controllers in active remote mining rooms.
 *
 * Expansion support intentionally stops at a placeholder. Remote mining rooms
 * must be reserved, not permanently claimed.
 */
var travel = require('utility.Travel.Creep');

var ANNEX_PATH_STYLE = {
    stroke: '#b366ff'
};
var ANNEX_SIGN = '\uD83D\uDC1D Sushi Annex \u2014 reserved for remote logistics.';

var roleAnnex = {
    /** @param {Creep} creep **/
    run: function(creep) {
        if (!creep || creep.spawning) {
            return;
        }

        if (creep.memory.annexMode === 'expand') {
            creep.memory.annexState = 'expandPlaceholder';
            /*
             * Future expansion mode belongs here. It may claim a controller and
             * coordinate spawn planning only after that workflow is designed.
             * Do not claim controllers from this reservation-only version.
             */
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

        /* Signing is secondary: the reservation intent is always issued first. */
        if ((!controller.sign || controller.sign.text !== ANNEX_SIGN) && creep.pos.inRangeTo(controller, 1)) {
            if (creep.signController(controller, ANNEX_SIGN) === OK) {
                creep.memory.annexState = 'signing';
            }
        }
    }
};

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
