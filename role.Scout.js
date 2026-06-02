var roleScout = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if(!creep || creep.spawning) {
            return;
        }

        rememberRoomVisit(creep);

        if(creep.memory.targetRoom) {
            moveToTargetRoom(creep, creep.memory.targetRoom);
            return;
        }

        idleOrWander(creep);
    }
};

function rememberRoomVisit(creep) {
    if(!Memory.rooms) {
        Memory.rooms = {};
    }
    if(!Memory.rooms[creep.room.name]) {
        Memory.rooms[creep.room.name] = {};
    }

    // Very small scout intel. This is useful without creating a full intel system.
    Memory.rooms[creep.room.name].scout = {
        lastVisited: Game.time,
        sources: creep.room.find(FIND_SOURCES).length,
        hostiles: creep.room.find(FIND_HOSTILE_CREEPS).length,
        controllerOwner: creep.room.controller && creep.room.controller.owner ? creep.room.controller.owner.username : null,
        controllerReservation: creep.room.controller && creep.room.controller.reservation ? creep.room.controller.reservation.username : null
    };
}

function moveToTargetRoom(creep, roomName) {
    if(creep.room.name === roomName) {
        var controller = creep.room.controller;
        if(controller && creep.pos.getRangeTo(controller) > 3) {
            creep.moveTo(controller, {visualizePathStyle: {stroke: '#ffffff'}});
        }
        return;
    }

    var exitDir = Game.map.findExit(creep.room, roomName);
    if(exitDir < 0) {
        return;
    }

    var exit = creep.pos.findClosestByRange(exitDir);
    if(exit) {
        creep.moveTo(exit, {visualizePathStyle: {stroke: '#ffffff'}});
    }
}

function idleOrWander(creep) {
    var spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
    if(spawn && creep.pos.getRangeTo(spawn) > 3) {
        creep.moveTo(spawn, {visualizePathStyle: {stroke: '#bbbbbb'}});
        return;
    }

    // Move a little now and then so the scout can reveal nearby room edges.
    if(Game.time % 10 === 0) {
        creep.move(Math.floor(Math.random() * 8) + 1);
    }
}

module.exports = roleScout;
