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
var CombatMath = require('Combat.Math');
var SquadTactics = require('Squad.Tactics');
var Season11 = require('Logic.Season11');
var CombatPolicy = require('Combat.Policy');

var roleVolley = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if(!creep || creep.spawning) {
            return;
        }
        if (creep.memory.season11ReactorGuard) {
            runReactorGuard(creep);
            return;
        }

        /*
         * Local danger always matters more than a remote flag or target room.
         */
        var target = WarRoom.getCombatTarget(creep);

        if(target) {
            /*
             * Healing is a support action, so Volley can heal and still use
             * its RANGED_ATTACK parts this tick. Do not chase a heal target
             * while an enemy target exists because ranged positioning matters.
             */
            supportCombatHealing(creep, false);
            attackRangedTarget(creep, target);
            kiteMeleeTarget(creep, target);

            /*
             * Shooting and moving are separate actions. If approaching the
             * target did not already request movement, step off the exit.
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

function runReactorGuard(creep) {
    var entry = Season11.ensureMemory().reactorPortfolio.reactors[creep.memory.season11ReactorGuard];
    var home = creep.memory.homeRoom;
    var approved = Season11.isOperatingMode() && entry && entry.active && entry.healthy &&
        (entry.owned || entry.recapture && entry.recapture.approved);
    var destination = approved && (entry.defenseTier === 'HOLD' || !entry.owned) ? entry.roomName : home;
    // This small force denies claimants; it does not pursue structures or a losing fight.
    var hostileConstant = typeof FIND_HOSTILE_CREEPS !== 'undefined' ? FIND_HOSTILE_CREEPS : null;
    var enemies = approved && creep.room.name === entry.roomName && hostileConstant !== null ?
        creep.room.find(hostileConstant).filter(function(enemy) { return !CombatPolicy.isAlly(enemy); }) : [];
    var threats = enemies.map(function(enemy) { return { creep: enemy, body: CombatMath.analyzeBody(enemy) }; });
    var dangerous = threats.some(function(item) { return item.body.melee > 0 || item.body.ranged > 20 || item.body.heal > 0; });
    if (dangerous || creep.hits < creep.hitsMax * 0.6) destination = home;
    if (destination && creep.room.name !== destination) {
        travel.moveToRoom(creep, destination, { range: 22, reusePath: 10, allowHostile: false });
        return;
    }
    if (approved && !dangerous && destination === entry.roomName) {
        threats.sort(function(a, b) { return (b.body.claim || 0) - (a.body.claim || 0) ||
            creep.pos.getRangeTo(a.creep) - creep.pos.getRangeTo(b.creep); });
        var target = threats[0] && threats[0].creep;
        if (target) {
            if (creep.pos.getRangeTo(target) <= 3) creep.rangedAttack(target);
            if (creep.pos.getRangeTo(target) > 2) travel.move(creep, target, { range: 2, reusePath: 3 });
            return;
        }
        var reactor = Game.getObjectById(entry.reactorId);
        if (reactor && creep.pos.getRangeTo(reactor) > 2) travel.move(creep, reactor, { range: 2, reusePath: 10 });
    }
    travel.moveOffExit(creep);
}

function supportCombatHealing(creep, allowMoveToHealTarget) {
    /*
     * Damaged or unspawned HEAL parts cannot perform a healing action. Check
     * this before asking WarRoom to scan the room for wounded combat creeps.
     */
    if(!creep || creep.getActiveBodyparts(HEAL) <= 0) {
        return false;
    }

    /*
     * Priority 1: keep Volley alive so it can continue applying ranged damage.
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

function kiteMeleeTarget(creep, target) {
    if (!creep || !target || creep.memory._sushiMoveTick === Game.time) return false;
    if (CombatMath.analyzeBody(target).melee <= 0 || creep.pos.getRangeTo(target) > 3) return false;
    var kite = SquadTactics.chooseKitePositions(creep, null, [target]);
    if (!kite.primary) return false;
    travel.move(creep, kite.primary, {
        range: 0,
        reusePath: 0,
        trafficPriority: 70,
        fallbackPositions: kite.fallbacks,
        disableSharedRouteCache: true
    });
    creep.say('kite');
    return true;
}

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
