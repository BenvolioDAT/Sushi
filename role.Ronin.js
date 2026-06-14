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
         * Local danger always matters more than a remote flag or target room.
         */
        var target = WarRoom.getCombatTarget(creep);

        if(target) {
            /*
             * Healing is a support action, so Ronin can heal and still use its
             * ATTACK parts this tick. Do not chase a heal target while an
             * enemy target exists because melee positioning comes first.
             */
            supportCombatHealing(creep, false);
            attackMeleeTarget(creep, target);

            /*
             * Attacking and moving are separate actions. If the attack did not
             * already request movement, step inward after crossing an exit.
             */
            travel.moveOffExit(creep);
            return;
        }

        /*
         * With no enemy target, help a wounded combat creep before marching
         * away or idling. The helper may move toward a distant ally through
         * Sushi's normal travel wrapper.
         */
        if(supportCombatHealing(creep, true)) {
            travel.moveOffExit(creep);
            return;
        }

        /*
         * Leave the room edge before normal marching so an old path cannot
         * send the creep back through the exit on the next tick.
         */
        if(travel.moveOffExit(creep)) {
            creep.say('inward');
            return;
        }

        /*
         * Only march toward a remote assignment when this room is quiet.
         */
        if(moveToCombatRoom(creep)) {
            creep.say('march');
            return;
        }

        WarRoom.idleCombat(creep);
    }
};

function supportCombatHealing(creep, allowMoveToHealTarget) {
    /*
     * Damaged or unspawned HEAL parts cannot perform a healing action. Check
     * this before asking WarRoom to scan the room for wounded combat creeps.
     */
    if(!creep || creep.getActiveBodyparts(HEAL) <= 0) {
        return false;
    }

    /*
     * Priority 1: keep Ronin alive so it can continue holding melee range.
     */
    if(creep.hits < creep.hitsMax) {
        creep.heal(creep);
        creep.say('patch');
        return true;
    }

    /*
     * Priority 2: support the most wounded Ronin, Volley, or Cleric in this
     * room. Logic.WarRoom owns that shared target selection.
     */
    var healTarget = WarRoom.findBestHealTarget(creep);

    if(!healTarget) {
        return false;
    }

    var range = creep.pos.getRangeTo(healTarget);

    /* Direct healing is strongest and works at range 1. */
    if(range <= 1) {
        creep.heal(healTarget);
        creep.say('heal');
        return true;
    }

    /* Ranged healing supports allies at range 2 or 3 without repositioning. */
    if(range <= 3) {
        creep.rangedHeal(healTarget);
        creep.say('mend');
        return true;
    }

    /*
     * Only approach a distant heal target when run() found no attack target.
     * The movement guard keeps healing support from replacing another move.
     */
    if(allowMoveToHealTarget && creep.memory._sushiMoveTick !== Game.time) {
        travel.move(creep, healTarget, {
            range: 1,
            reusePath: 10,
            visualizePathStyle: { stroke: '#00ff88' }
        });

        creep.say('aid');
        return true;
    }

    return false;
}

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
