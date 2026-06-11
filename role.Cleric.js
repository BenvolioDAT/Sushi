/*
 * role.Cleric.js
 *
 * Cleric is the healing combat creep.
 *
 * Primary job:
 * - heal wounded friendly creeps
 * - follow Ronin or Volley when nobody needs healing
 *
 * Learning note:
 * Cleric uses Logic.WarRoom for shared combat awareness. That keeps healer
 * targeting consistent with Ronin and Volley instead of each combat role
 * independently deciding where the fight is.
 *
 * Memory used:
 * creep.memory.targetRoom = 'W39S48';
 * creep.memory.targetFlag = 'AttackRoom';
 */

var WarRoom = require('Logic.WarRoom');
var travel = require('utility.Travel.Creep');

var roleCleric = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if(!creep || creep.spawning) {
            return;
        }

        /*
         * A Cleric should heal itself first if hurt.
         * Self-healing first protects the body parts that let the healer keep
         * the rest of the combat group alive.
         */
        if(creep.hits < creep.hitsMax) {
            creep.heal(creep);
        }

        /*
         * Move to remote combat room if assigned.
         */
        if(moveToCombatRoom(creep)) {
            creep.say('march');
            return;
        }

        /*
         * Heal the most damaged friendly creep in the room.
         */
        var healTarget = WarRoom.findBestHealTarget(creep);

        if(healTarget) {
            healFriendly(creep, healTarget);
            return;
        }

        /*
         * If nobody needs healing, follow a combat buddy.
         */
        followCombatBuddy(creep);
    }
};

function healFriendly(creep, target) {
    var range = creep.pos.getRangeTo(target);

    /*
     * Direct heal is strongest but requires range 1.
     */
    if(range <= 1) {
        creep.heal(target);
        creep.say('heal');
        return;
    }

    /*
     * Ranged heal works from farther away.
     */
    if(range <= 3) {
        creep.rangedHeal(target);
        creep.say('mend');

        /*
         * Move closer so next tick we may direct heal.
         */
        moveNearTarget(creep, target);
        return;
    }

    /*
     * Too far away, move closer.
     */
    moveNearTarget(creep, target);
}

function followCombatBuddy(creep) {
    var buddy = WarRoom.findCombatBuddy(creep);

    if(buddy) {
        /*
         * Stay within range 1 of a fighter.
         */
        moveNearTarget(creep, buddy);
        creep.say('guard');
        return;
    }

    /*
     * If no buddy exists, move to the target flag if one exists.
     */
    WarRoom.idleCombat(creep);
}

function moveToCombatRoom(creep) {
    var targetRoomName = WarRoom.getTargetRoomName(creep);

    if(!targetRoomName || creep.room.name === targetRoomName) {
        return false;
    }

    /*
     * All role movement goes through Sushi's travel wrapper. The memory check
     * prevents this role from making a second movement request in one tick.
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
     * Cleric movement uses the shared wrapper so healing and buddy-following
     * cannot bypass Sushi's path reuse and same-tick movement protection.
     */
    return travel.move(creep, target, {
        range: 1,
        reusePath: 10,
        visualizePathStyle: { stroke: '#00ff88' }
    });
}

module.exports = roleCleric;
