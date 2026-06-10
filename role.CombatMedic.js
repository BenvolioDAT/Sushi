/*
 * role.CombatMedic.js
 *
 * Simple healer companion for the older CombatMelee/CombatArcher roles.
 *
 * The important lesson is range management: heal() is stronger but range 1,
 * while rangedHeal() reaches range 3. The medic tries direct healing first,
 * then ranged healing, then movement.
 */
var utilityTravelCreep = require('utility.Travel.Creep');

var roleCombatMedic = {

    /** @param {Creep} creep **/
    run: function(creep) {
        /*
         * A spawning medic is not on the map yet, so it cannot heal or move.
         * Returning early is cheaper than running the rest of the target logic.
         */
        if(!creep || creep.spawning) {
            return;
        }

        /*
         * Heal self first. A medic that dies cannot heal anyone else, and heal
         * can target the creep itself when it has damaged hits.
         */
        if(creep.hits < creep.hitsMax) {
            creep.heal(creep);
        }

        /*
         * targetRoom is optional mission memory. If the medic has a mission room
         * and is not there yet, it moves rooms before looking for wounded allies.
         */
        if(creep.memory.targetRoom && creep.room.name !== creep.memory.targetRoom) {
            moveToRoom(creep, creep.memory.targetRoom);
            return;
        }

        /*
         * FIND_MY_CREEPS returns your creeps in the current visible room. The
         * filter keeps only allies whose current hits are below max hits.
         */
        var target = creep.pos.findClosestByPath(FIND_MY_CREEPS, {
            filter: function(ally) {
                return ally.hits < ally.hitsMax;
            }
        });

        /*
         * If nobody needs healing, follow a combat creep so the medic is already
         * nearby when fighting starts.
         */
        if(!target) {
            followCombatCreep(creep);
            return;
        }

        /*
         * creep.heal works at range 1. rangedHeal works up to range 3 but heals
         * less. If both report ERR_NOT_IN_RANGE, walk toward the wounded ally.
         */
        if(creep.heal(target) === ERR_NOT_IN_RANGE) {
            if(creep.rangedHeal(target) === ERR_NOT_IN_RANGE) {
                utilityTravelCreep.move(creep, target, {visualizePathStyle: {stroke: '#00ff00'}});
            }
        }
    }
};

function followCombatCreep(creep) {
    /*
     * When there is no healing target, find the nearest melee or archer role.
     * other.name !== creep.name prevents the medic from selecting itself.
     */
    var ally = creep.pos.findClosestByPath(FIND_MY_CREEPS, {
        filter: function(other) {
            return (
                other.name !== creep.name &&
                other.memory &&
                (other.memory.role === 'CombatMelee' || other.memory.role === 'CombatArcher')
            );
        }
    });

    if(ally && creep.pos.getRangeTo(ally) > 2) {
        utilityTravelCreep.move(creep, ally, {visualizePathStyle: {stroke: '#00ff00'}});
        return;
    }

    /*
     * Fallback idle position: stay near a spawn so the medic is safe and close
     * to the base when there is no combat group to follow.
     */
    var spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
    if(spawn && creep.pos.getRangeTo(spawn) > 3) {
        utilityTravelCreep.move(creep, spawn, {visualizePathStyle: {stroke: '#bbbbbb'}});
    }
}

function moveToRoom(creep, roomName) {
    /*
     * Game.map.findExit returns the exit direction that leads toward roomName.
     * Negative return values mean the route is invalid or unavailable.
     */
    var exitDir = Game.map.findExit(creep.room, roomName);
    if(exitDir < 0) {
        return false;
    }

    /*
     * Move to the closest tile on that exit. Crossing the border will place the
     * creep in the next room on a later tick.
     */
    var exit = creep.pos.findClosestByRange(exitDir);
    if(exit) {
        utilityTravelCreep.move(creep, exit, {visualizePathStyle: {stroke: '#00ff00'}});
    }
    return true;
}

module.exports = roleCombatMedic;
