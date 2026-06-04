var roleCombatArcher = {

    /** @param {Creep} creep **/
    run: function(creep) {
        /*
         * Combat creeps cannot act while they are still spawning. The !creep
         * guard also prevents crashes if this function is called incorrectly.
         */
        if(!creep || creep.spawning) {
            return;
        }

        /*
         * If this archer has HEAL body parts, it patches itself up before doing
         * combat movement. getActiveBodyparts(HEAL) counts non-destroyed HEAL
         * parts, so damaged-off parts do not count.
         */
        if(creep.hits < creep.hitsMax && creep.getActiveBodyparts(HEAL) > 0) {
            creep.heal(creep);
        }

        /*
         * targetRoom is optional memory set when spawning or from the console.
         * If it exists and the archer is not there yet, travel toward that room
         * and return so it does not waste CPU looking for targets in the wrong room.
         */
        if(creep.memory.targetRoom && creep.room.name !== creep.memory.targetRoom) {
            moveToRoom(creep, creep.memory.targetRoom);
            return;
        }

        /*
         * Look for a hostile creep first, then hostile structures. If nothing is
         * found, the archer idles near home instead of wandering randomly.
         */
        var target = findRangedTarget(creep);
        if(!target) {
            idleNearSpawn(creep);
            return;
        }

        /*
         * Ranged attacks work at range 1-3. If range is greater than 3, moveTo
         * approaches the target while trying to stop at range 3.
         */
        var range = creep.pos.getRangeTo(target);
        if(range <= 3) {
            creep.rangedAttack(target);
        }
        if(range > 3) {
            creep.moveTo(target, {range: 3, visualizePathStyle: {stroke: '#ff0000'}});
        }
    }
};

function findRangedTarget(creep) {
    /*
     * FIND_HOSTILE_CREEPS means creeps not owned by you. By checking creeps
     * first, the archer prioritizes active threats over buildings.
     */
    var hostile = creep.pos.findClosestByPath(FIND_HOSTILE_CREEPS);
    if(hostile) {
        return hostile;
    }

    /*
     * Controllers cannot be destroyed with normal attacks, so the filter skips
     * them and targets other hostile structures instead.
     */
    return creep.pos.findClosestByPath(FIND_HOSTILE_STRUCTURES, {
        filter: function(structure) {
            return structure.structureType !== STRUCTURE_CONTROLLER;
        }
    });
}

function moveToRoom(creep, roomName) {
    /*
     * Game.map.findExit returns a direction constant for the exit that leads
     * toward roomName. Negative values mean Screeps could not find a route.
     */
    var exitDir = Game.map.findExit(creep.room, roomName);
    if(exitDir < 0) {
        return false;
    }

    /*
     * findClosestByRange chooses the nearest exit tile by straight-line range.
     * moveTo then pathfinds toward that exit.
     */
    var exit = creep.pos.findClosestByRange(exitDir);
    if(exit) {
        creep.moveTo(exit, {visualizePathStyle: {stroke: '#ff0000'}});
    }
    return true;
}

function idleNearSpawn(creep) {
    /*
     * When no enemy is visible, stay near an owned spawn so the defender is
     * close to the base but does not block the spawn tile directly.
     */
    var spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
    if(spawn && creep.pos.getRangeTo(spawn) > 3) {
        creep.moveTo(spawn, {visualizePathStyle: {stroke: '#bbbbbb'}});
    }
}

module.exports = roleCombatArcher;
