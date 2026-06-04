var rolePioneer = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if(!creep || creep.spawning) {
            return;
        }

        var targetRoom = creep.memory.targetRoom;
        if(!targetRoom) {
            return;
        }

        if(creep.room.name !== targetRoom) {
            moveToRoom(creep, targetRoom);
            return;
        }

        if(!creep.room.controller) {
            return;
        }

        runControllerAction(creep, creep.room.controller);
    }
};

function runControllerAction(creep, controller) {
    var mode = getClaimerMode(creep);

    if(mode === 'reserve') {
        reserveController(creep, controller);
        return;
    }

    claimController(creep, controller);
}

function getClaimerMode(creep) {
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
    if(controller.owner && !controller.my) {
        if(creep.attackController(controller) === ERR_NOT_IN_RANGE) {
            creep.moveTo(controller, {visualizePathStyle: {stroke: '#ff0000'}});
        }
        return;
    }

    var result = creep.claimController(controller);
    if(result === ERR_NOT_IN_RANGE) {
        creep.moveTo(controller, {visualizePathStyle: {stroke: '#ffffff'}});
    } else if(result === ERR_GCL_NOT_ENOUGH) {
        reserveController(creep, controller);
    }
}

function reserveController(creep, controller) {
    if(controller.reservation && controller.reservation.username !== creep.owner.username) {
        if(creep.attackController(controller) === ERR_NOT_IN_RANGE) {
            creep.moveTo(controller, {visualizePathStyle: {stroke: '#ff0000'}});
        }
        return;
    }

    if(creep.reserveController(controller) === ERR_NOT_IN_RANGE) {
        creep.moveTo(controller, {visualizePathStyle: {stroke: '#ffffff'}});
    }
}

function moveToRoom(creep, roomName) {
    var exitDir = Game.map.findExit(creep.room, roomName);
    if(exitDir < 0) {
        return false;
    }

    var exit = creep.pos.findClosestByRange(exitDir);
    if(exit) {
        creep.moveTo(exit, {visualizePathStyle: {stroke: '#ffffff'}});
    }
    return true;
}

module.exports = rolePioneer;
