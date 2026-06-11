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
var travel = require('utility.Travel.Creep');

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
        if(moveToCombatRoom(creep)) {
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
    moveNearTarget(creep, target);
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
     * Volley approaches through Sushi's wrapper so ranged positioning keeps
     * the shared path reuse and one-move-per-tick protection.
     */
    return travel.move(creep, target, {
        range: 3,
        reusePath: 10,
        visualizePathStyle: { stroke: '#ffaa00' }
    });
}

module.exports = roleVolley;
