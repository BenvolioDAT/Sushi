var utility = require('utility');

var roleScout = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if(!creep || creep.spawning) {
            return;
        }

        /*
         * Scan the room the Scout is currently standing in.
         * This helps Sushi remember sources, controller info, minerals, and other room data.
         */
        utility.scanRoom(creep);

        /*
         * Save small Scout intel every tick the Scout is alive.
         * This is useful because utility.scanRoom exits early after the first scan,
         * but hostile counts and reservations can change later.
         */
        //rememberRoomVisit(creep);

        /*
         * If the Scout does not currently have a target room,
         * choose one random neighboring room from the current room.
         */
        if(!creep.memory.targetRoom) {
            chooseRandomNeighborRoom(creep);
        }

        /*
         * If we now have a target room, walk toward it.
         */
        if(creep.memory.targetRoom) {
            moveToTargetRoom(creep, creep.memory.targetRoom);
            return;
        }

        /*
         * Fallback only.
         * This happens if the room has no valid exits or something went wrong.
         */
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

    Memory.rooms[creep.room.name].scout = {
        lastVisited: Game.time,
        sources: creep.room.find(FIND_SOURCES).length,
        hostiles: creep.room.find(FIND_HOSTILE_CREEPS).length,
        controllerOwner: creep.room.controller && creep.room.controller.owner ? creep.room.controller.owner.username : null,
        controllerReservation: creep.room.controller && creep.room.controller.reservation ? creep.room.controller.reservation.username : null
    };
}

/**
 * Pick one random neighboring room from the Scout's current room.
 *
 * This uses Game.map.describeExits(roomName), which returns nearby room names.
 * Example shape:
 *
 * {
 *     "1": "W8N4",
 *     "3": "W7N3",
 *     "5": "W8N2",
 *     "7": "W9N3"
 * }
 *
 * The numbers are exit direction constants:
 * 1 = top
 * 3 = right
 * 5 = bottom
 * 7 = left
 *
 * @param {Creep} creep
 * @returns {boolean}
 */
function chooseRandomNeighborRoom(creep) {
    if(!creep || !creep.room) {
        return false;
    }

    var currentRoomName = creep.room.name;
    var exits = Game.map.describeExits(currentRoomName);

    if(!exits) {
        return false;
    }

    var allChoices = [];
    var preferredChoices = [];

    for(var direction in exits) {
        if(!exits.hasOwnProperty(direction)) {
            continue;
        }

        var neighborRoomName = exits[direction];

        if(!neighborRoomName) {
            continue;
        }

        /*
         * Skip closed rooms.
         * This matters more on official servers, but it is still safe on private servers.
         */
        var roomStatus = Game.map.getRoomStatus(neighborRoomName);

        if(roomStatus && roomStatus.status === 'closed') {
            continue;
        }

        allChoices.push(neighborRoomName);

        /*
         * Prefer not to go straight back into the room we just came from.
         * This stops the Scout from doing the classic border-bounce clown dance.
         */
        if(neighborRoomName !== creep.memory.previousRoom) {
            preferredChoices.push(neighborRoomName);
        }
    }

    /*
     * Prefer a room that is not the previous room.
     * But if the only valid room is the previous room, allow it.
     */
    var choices = preferredChoices.length > 0 ? preferredChoices : allChoices;

    if(choices.length === 0) {
        return false;
    }

    var randomIndex = Math.floor(Math.random() * choices.length);
    var selectedRoomName = choices[randomIndex];

    creep.memory.previousRoom = currentRoomName;
    creep.memory.targetRoom = selectedRoomName;

    return true;
}

function moveToTargetRoom(creep, roomName) {
    /*
     * If the Scout reached the target room, clear targetRoom.
     * Next tick, it will pick a new neighboring room from this new location.
     */
    if(creep.room.name === roomName) {
        delete creep.memory.targetRoom;

        var controller = creep.room.controller;

        if(controller && creep.pos.getRangeTo(controller) > 3) {
            creep.moveTo(controller, {
                visualizePathStyle: {
                    stroke: '#ffffff'
                }
            });
        }

        return;
    }

    var exitDir = Game.map.findExit(creep.room, roomName);

    if(exitDir < 0) {
        delete creep.memory.targetRoom;
        return;
    }

    var exit = creep.pos.findClosestByRange(exitDir);

    if(exit) {
        creep.moveTo(exit, {
            visualizePathStyle: {
                stroke: '#ffffff'
            }
        });
    }
}

function idleOrWander(creep) {
    var spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);

    if(spawn && creep.pos.getRangeTo(spawn) > 3) {
        creep.moveTo(spawn, {
            visualizePathStyle: {
                stroke: '#bbbbbb'
            }
        });

        return;
    }

    if(Game.time % 10 === 0) {
        creep.move(Math.floor(Math.random() * 8) + 1);
    }
}

module.exports = roleScout;