var utilityTravelCreep = require('utility.Travel.Creep');

var roleCombatMelee = {

    /** @param {Creep} creep **/
    run: function(creep) {
        /*
         * The role runner may be called every tick for every creep. This guard
         * keeps invalid or still-spawning creeps from running combat code.
         */
        if(!creep || creep.spawning) {
            return;
        }

        /*
         * If targetRoom is set in creep.memory, this creep is on an assignment
         * outside its current room. Move first, then stop this tick's logic so it
         * does not attack unrelated targets on the way.
         */
        if(creep.memory.targetRoom && creep.room.name !== creep.memory.targetRoom) {
            moveToRoom(creep, creep.memory.targetRoom);
            return;
        }

        /*
         * Pick a combat target in the current room. If no target exists, the
         * creep waits near the spawn instead of burning CPU on more searches.
         */
        var target = findCombatTarget(creep);
        if(!target) {
            idleNearSpawn(creep);
            return;
        }

        /*
         * creep.attack only works next to the target. ERR_NOT_IN_RANGE means the
         * target is valid, but the creep must walk closer first.
         */
        if(creep.attack(target) === ERR_NOT_IN_RANGE) {
            utilityTravelCreep.move(creep, target, {visualizePathStyle: {stroke: '#ff0000'}});
        }
    }
};

function findCombatTarget(creep) {
    /*
     * Hostile creeps are the immediate danger, so they are checked before
     * hostile structures.
     */
    var hostile = creep.pos.findClosestByPath(FIND_HOSTILE_CREEPS);
    if(hostile) {
        return hostile;
    }

    /*
     * Controllers are special room objects and are not useful normal attack
     * targets, so the structure search ignores them.
     */
    return creep.pos.findClosestByPath(FIND_HOSTILE_STRUCTURES, {
        filter: function(structure) {
            return structure.structureType !== STRUCTURE_CONTROLLER;
        }
    });
}

function moveToRoom(creep, roomName) {
    /*
     * findExit asks the world map which exit direction leads toward the desired
     * room. A negative result means there is no valid path from here.
     */
    var exitDir = Game.map.findExit(creep.room, roomName);
    if(exitDir < 0) {
        return false;
    }

    /*
     * The exit direction is then used as a find constant. Screeps finds the
     * nearest tile on that border, and moveTo starts pathing to it.
     */
    var exit = creep.pos.findClosestByRange(exitDir);
    if(exit) {
        utilityTravelCreep.move(creep, exit, {visualizePathStyle: {stroke: '#ff0000'}});
    }
    return true;
}

function idleNearSpawn(creep) {
    /*
     * Keep idle defenders close enough to respond, but outside range 3 they walk
     * back toward the closest owned spawn.
     */
    var spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
    if(spawn && creep.pos.getRangeTo(spawn) > 3) {
        utilityTravelCreep.move(creep, spawn, {visualizePathStyle: {stroke: '#bbbbbb'}});
    }
}

module.exports = roleCombatMelee;
