/*
 * role.Volley.js
 *
 * Volley is the ranged combat creep.
 *
 * Primary job:
 * - stay near range 3
 * - shoot enemy creeps or structures
 *
 * Learning note:
 * Volley shares target selection with Ronin through Logic.WarRoom, but uses a
 * different action range. This is a common role pattern: shared target logic,
 * role-specific execution.
 *
 * Memory used:
 * creep.memory.targetRoom = 'W39S48';
 * creep.memory.targetFlag = 'AttackRoom';
 */

var WarRoom = require('Logic.WarRoom');

var roleVolley = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if(!creep || creep.spawning) {
            return;
        }

        /*
         * If Volley has a remote target room and is not there yet,
         * travel to that room first.
         */
        if(WarRoom.moveToTargetRoom(creep)) {
            creep.say('march');
            return;
        }

        /*
         * Find something hostile to shoot.
         */
        var target = WarRoom.getCombatTarget(creep);

        if(!target) {
            WarRoom.idleCombat(creep);
            return;
        }

        attackRangedTarget(creep, target);
    }
};

function attackRangedTarget(creep, target) {
    var range = creep.pos.getRangeTo(target);

    /*
     * Ranged attack works up to range 3.
     */
    if(range <= 3) {
        var result = creep.rangedAttack(target);

        if(result === ERR_INVALID_TARGET) {
            WarRoom.clearCombatTarget(creep);
            return;
        }

        creep.say('pew');

        /*
         * Simple beginner behavior:
         * If too close, step away is not added yet.
         * For now we keep it simple and just shoot.
         */
        return;
    }

    /*
     * Too far away, move into range 3.
     * Moving to range 3 keeps the ranged creep useful without forcing it onto
     * the same tile ring as melee creeps.
     */
    WarRoom.moveToRange(creep, target, 3, '#ffaa00');
}

module.exports = roleVolley;
