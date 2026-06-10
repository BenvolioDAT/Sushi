/*
 * role.Pioneer.js
 *
 * Pioneer is a controller worker for remote rooms.
 *
 * Depending on creep.memory.mode / creep.memory.claimerMode, it either claims
 * a room controller or reserves it. The same movement pattern is used for both:
 * first enter the target room, then act on the visible controller.
 */
var utilityTravelCreep = require('utility.Travel.Creep');

var rolePioneer = {

    /** @param {Creep} creep **/
    run: function(creep) {
        /*
         * A Pioneer/claimer only acts after spawning is complete. The !creep
         * check is defensive in case run is called with a bad value.
         */
        if(!creep || creep.spawning) {
            return;
        }

        /*
         * targetRoom is required because claim/reserve creeps are only useful
         * when they know which room controller to work on.
         */
        var targetRoom = creep.memory.targetRoom;
        if(!targetRoom) {
            return;
        }

        /*
         * If the creep is not in the target room yet, move toward that room and
         * stop. The controller action must wait until the room is visible.
         */
        if(creep.room.name !== targetRoom) {
            moveToRoom(creep, targetRoom);
            return;
        }

        /*
         * Some rooms do not have controllers. This guard prevents calling claim
         * or reserve methods with an undefined target.
         */
        if(!creep.room.controller) {
            return;
        }

        runControllerAction(creep, creep.room.controller);
    }
};

function runControllerAction(creep, controller) {
    /*
     * This role can either reserve a neutral controller or claim it. The mode is
     * chosen from creep memory so the same code can support both jobs.
     */
    var mode = getClaimerMode(creep);

    if(mode === 'reserve') {
        reserveController(creep, controller);
        return;
    }

    claimController(creep, controller);
}

function getClaimerMode(creep) {
    /*
     * Support both memory names. String(...).toLowerCase() makes "Reserve" and
     * "reserve" behave the same.
     */
    if(creep.memory.claimerMode) {
        return String(creep.memory.claimerMode).toLowerCase();
    }
    if(creep.memory.mode) {
        return String(creep.memory.mode).toLowerCase();
    }

    // A Claimer claims by default. Set memory.mode = 'reserve' to reserve instead.
    return 'claim';
}

function claimController(creep, controller) {
    /*
     * If another player owns the controller, attackController is the Screeps API
     * used to weaken that ownership before claiming can happen.
     */
    if(controller.owner && !controller.my) {
        if(creep.attackController(controller) === ERR_NOT_IN_RANGE) {
            utilityTravelCreep.move(creep, controller, {visualizePathStyle: {stroke: '#ff0000'}});
        }
        return;
    }

    /*
     * claimController attempts to make the room yours. ERR_GCL_NOT_ENOUGH means
     * your account cannot own another room yet, so the code reserves instead.
     */
    var result = creep.claimController(controller);
    if(result === ERR_NOT_IN_RANGE) {
        utilityTravelCreep.move(creep, controller, {visualizePathStyle: {stroke: '#ffffff'}});
    } else if(result === ERR_GCL_NOT_ENOUGH) {
        reserveController(creep, controller);
    }
}

function reserveController(creep, controller) {
    /*
     * If another player has the reservation, attackController reduces or removes
     * that reservation before this creep tries to reserve it for you.
     */
    if(controller.reservation && controller.reservation.username !== creep.owner.username) {
        if(creep.attackController(controller) === ERR_NOT_IN_RANGE) {
            utilityTravelCreep.move(creep, controller, {visualizePathStyle: {stroke: '#ff0000'}});
        }
        return;
    }

    /*
     * reserveController extends your reservation timer on a neutral controller.
     * ERR_NOT_IN_RANGE means the creep must move closer to the controller.
     */
    if(creep.reserveController(controller) === ERR_NOT_IN_RANGE) {
        utilityTravelCreep.move(creep, controller, {visualizePathStyle: {stroke: '#ffffff'}});
    }
}

function moveToRoom(creep, roomName) {
    /*
     * Game.map.findExit chooses which room edge leads toward the requested room.
     */
    var exitDir = Game.map.findExit(creep.room, roomName);
    if(exitDir < 0) {
        return false;
    }

    var exit = creep.pos.findClosestByRange(exitDir);
    if(exit) {
        utilityTravelCreep.move(creep, exit, {visualizePathStyle: {stroke: '#ffffff'}});
    }
    return true;
}

module.exports = rolePioneer;
