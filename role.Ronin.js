/*
 * role.Ronin.js
 *
 * Ronin is the melee combat creep.
 *
 * Primary job:
 * - get close to enemy creeps or structures
 * - attack at range 1
 *
 * Learning note:
 * Ronin does not choose rooms or targets by itself. It delegates that shared
 * combat context to Logic.WarRoom, then handles only the melee-specific action:
 * stand adjacent and attack.
 *
 * Memory used:
 * creep.memory.targetRoom = 'W39S48';
 * creep.memory.targetFlag = 'AttackRoom';
 */

var WarRoom = require('Logic.WarRoom');
var travel = require('utility.Travel.Creep');

var roleRonin = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if(!creep || creep.spawning) {
            return;
        }

        /*
         * If Ronin has a remote target room and is not there yet,
         * travel to that room first.
         */
        if(moveToCombatRoom(creep)) {
            creep.say('march');
            return;
        }

        /*
         * Find something hostile to attack.
         */
        var target = WarRoom.getCombatTarget(creep);

        if(!target) {
            WarRoom.idleCombat(creep);
            return;
        }

        /*
         * Ronin is melee, so it must stand beside the target.
         */
        attackMeleeTarget(creep, target);
    }
};

function attackMeleeTarget(creep, target) {
    /*
     * Attack first.
     *
     * If the target is beside us, attack succeeds.
     * If not, attack returns ERR_NOT_IN_RANGE and we move closer.
     */
    var result = creep.attack(target);

    if(result === ERR_NOT_IN_RANGE) {
        moveNearTarget(creep, target);
        return;
    }

    /*
     * If the target was invalid or destroyed, forget it.
     */
    if(result === ERR_INVALID_TARGET) {
        WarRoom.clearCombatTarget(creep);
        return;
    }

    creep.say('slice');
}

function moveToCombatRoom(creep) {
    var targetRoomName = WarRoom.getTargetRoomName(creep);

    if(!targetRoomName || creep.room.name === targetRoomName) {
        return false;
    }

    /*
     * Use Sushi's travel wrapper for cross-room movement and do not submit a
     * second movement request if another system already moved this creep.
     */
    if(creep.memory._sushiMoveTick !== Game.time) {
        travel.moveToRoom(creep, targetRoomName, {
            range: 22,
            reusePath: 20,
            visualizePathStyle: { stroke: '#ff4444' }
        });
    }

    return true;
}

function moveNearTarget(creep, target) {
    if(creep.memory._sushiMoveTick === Game.time) {
        return ERR_BUSY;
    }

    /*
     * Ronin approaches through Sushi's wrapper so melee movement shares the
     * same path reuse and one-move-per-tick guard as the rest of the colony.
     */
    return travel.move(creep, target, {
        range: 1,
        reusePath: 10,
        visualizePathStyle: { stroke: '#ff0000' }
    });
}

module.exports = roleRonin;
