/*
 * role.Ronin.js
 *
 * Ronin is the melee combat creep.
 *
 * Primary job:
 * - get close to enemy creeps or structures
 * - attack at range 1
 *
 * Memory used:
 * creep.memory.targetRoom = 'W39S48';
 * creep.memory.targetFlag = 'AttackRoom';
 */

var WarRoom = require('Logic.WarRoom');

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
        if(WarRoom.moveToTargetRoom(creep)) {
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
        WarRoom.moveToRange(creep, target, 1, '#ff0000');
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

module.exports = roleRonin;