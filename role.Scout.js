var utility = require('utility');
var utilityTravelCreep = require('utility.Travel.Creep');

var roleScout = {

    /** @param {Creep} creep **/
    run: function(creep) {
        /*
         * Scouts only need MOVE parts, but they still cannot do anything while
         * spawning. This guard keeps the rest of the role from using bad data.
         */
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
    /*
     * This helper is currently not called by run(), but it shows how Scout intel
     * can be stored. Memory.rooms is the long-term memory object organized by
     * room name.
     */
    if(!Memory.rooms) {
        Memory.rooms = {};
    }

    if(!Memory.rooms[creep.room.name]) {
        Memory.rooms[creep.room.name] = {};
    }

    /*
     * This writes a compact scouting snapshot to Memory.rooms[roomName].scout.
     * The live room.find calls count visible objects at the time of the visit.
     */
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
    /*
     * Return false instead of throwing if the caller gives bad input. That makes
     * the Scout role safe to run every tick.
     */
    if(!creep || !creep.room) {
        return false;
    }

    var currentRoomName = creep.room.name;
    /*
     * Game.map.describeExits does not require vision in neighboring rooms. It
     * reads map topology and tells us which rooms border the current room.
     */
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
         * This reduces back-and-forth movement across the same border.
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

    /*
     * Remember where we came from and where we are going. Both values are saved
     * in creep.memory so they survive into future ticks.
     */
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
        /*
         * Deleting targetRoom makes run() choose a new neighboring room on a
         * later tick. This is how the Scout keeps exploring instead of stopping.
         */
        delete creep.memory.targetRoom;

        var controller = creep.room.controller;

        /*
         * Move near the controller after entering the room. This can improve
         * vision around the controller area before the next room is selected.
         */
        if(controller && creep.pos.getRangeTo(controller) > 3) {
            utilityTravelCreep.move(creep, controller, {
                visualizePathStyle: {
                    stroke: '#ffffff'
                }
            });
        }

        return;
    }

    var exitDir = Game.map.findExit(creep.room, roomName);

    if(exitDir < 0) {
        /*
         * If Screeps cannot find an exit route, forget this target so the Scout
         * can choose a different neighbor later instead of getting stuck.
         */
        delete creep.memory.targetRoom;
        return;
    }

    /*
     * Find the closest border tile for the chosen exit direction and walk to it.
     */
    var exit = creep.pos.findClosestByRange(exitDir);

    if(exit) {
        utilityTravelCreep.move(creep, exit, {
            visualizePathStyle: {
                stroke: '#ffffff'
            }
        });
    }
}

function idleOrWander(creep) {
    /*
     * If no target room could be selected, stay near a spawn when possible.
     */
    var spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);

    if(spawn && creep.pos.getRangeTo(spawn) > 3) {
        utilityTravelCreep.move(creep, spawn, {
            visualizePathStyle: {
                stroke: '#bbbbbb'
            }
        });

        return;
    }

    /*
     * Last fallback: every 10 ticks, move in a random direction number from 1
     * to 8. Screeps direction constants use 1=top, then clockwise.
     */
    if(Game.time % 10 === 0) {
        utilityTravelCreep.moveDirection(creep, Math.floor(Math.random() * 8) + 1);
    }
}

module.exports = roleScout;
