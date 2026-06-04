var roleDismantler = {

    /** @param {Creep} creep **/
    run: function(creep) {
        /*
         * Dismantlers need a real active creep. While spawning, Screeps has not
         * placed the creep in normal room action range yet.
         */
        if(!creep || creep.spawning) {
            return;
        }

        /*
         * Optional mission memory: move to targetRoom before selecting targets.
         * Returning here keeps the creep focused on travel until it arrives.
         */
        if(creep.memory.targetRoom && creep.room.name !== creep.memory.targetRoom) {
            moveToRoom(creep, creep.memory.targetRoom);
            return;
        }

        /*
         * getDismantleTarget may read and write creep.memory.targetId so the
         * creep can keep attacking the same object across multiple ticks.
         */
        var target = getDismantleTarget(creep);
        if(!target) {
            idleNearAttackFlag(creep);
            return;
        }

        dismantleOrAttack(creep, target);
    }
};

function getDismantleTarget(creep) {
    /*
     * First try the remembered target id. Game.getObjectById returns the live
     * game object for an id, or null if it no longer exists or is not visible.
     */
    if(creep.memory.targetId) {
        var remembered = Game.getObjectById(creep.memory.targetId);
        if(remembered) {
            return remembered;
        }
        /*
         * If the remembered object disappeared, clear memory so the creep can
         * choose a new target instead of checking a bad id forever.
         */
        delete creep.memory.targetId;
    }

    /*
     * An Attack flag lets the player point at a specific structure manually.
     * This is safer than auto-selecting walls or ramparts.
     */
    var flagTarget = getStructureAtAttackFlag();
    if(flagTarget) {
        creep.memory.targetId = flagTarget.id;
        return flagTarget;
    }

    /*
     * Without a flag, attack the closest hostile non-controller structure.
     * Controllers need special controller actions, not dismantle targeting.
     */
    var hostile = creep.pos.findClosestByPath(FIND_HOSTILE_STRUCTURES, {
        filter: function(structure) {
            return structure.structureType !== STRUCTURE_CONTROLLER;
        }
    });

    if(hostile) {
        creep.memory.targetId = hostile.id;
        return hostile;
    }

    // Walls and ramparts are dangerous to auto-target. Use an Attack flag, a
    // remembered targetId, or set memory.allowWallDismantle = true.
    /*
     * This memory flag is an intentional safety switch. Without it, the creep
     * will not randomly chew through defensive walls or ramparts.
     */
    if(creep.memory.allowWallDismantle === true) {
        var wall = creep.pos.findClosestByPath(FIND_STRUCTURES, {
            filter: function(structure) {
                return structure.structureType === STRUCTURE_WALL ||
                    structure.structureType === STRUCTURE_RAMPART;
            }
        });

        if(wall) {
            creep.memory.targetId = wall.id;
        }
        return wall;
    }

    return null;
}

function getStructureAtAttackFlag() {
    /*
     * Game.flags.Attack reads the flag named exactly "Attack". If the flag's
     * room is not visible in Game.rooms, lookFor cannot inspect that position.
     */
    var flag = Game.flags.Attack;
    if(!flag || !Game.rooms[flag.pos.roomName]) {
        return null;
    }

    /*
     * lookFor(LOOK_STRUCTURES) checks the exact tile where the flag sits and
     * returns structures on that tile.
     */
    var structures = flag.pos.lookFor(LOOK_STRUCTURES);
    if(!structures || structures.length === 0) {
        return null;
    }

    return structures[0];
}

function dismantleOrAttack(creep, target) {
    /*
     * Prefer dismantle because WORK parts remove structures and return energy
     * from some targets. ERR_NO_BODYPART means this creep cannot dismantle.
     */
    var result = ERR_NO_BODYPART;

    if(creep.getActiveBodyparts(WORK) > 0) {
        result = creep.dismantle(target);
    }

    /*
     * If there are no usable WORK parts, fall back to normal attack parts.
     */
    if(result === ERR_NO_BODYPART && creep.getActiveBodyparts(ATTACK) > 0) {
        result = creep.attack(target);
    }

    /*
     * Both dismantle and attack require close range. When Screeps returns
     * ERR_NOT_IN_RANGE, the target is valid but the creep must walk closer.
     */
    if(result === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, {visualizePathStyle: {stroke: '#ff0000'}});
    }

    /*
     * When a target is nearly destroyed, forget it so the next tick can pick a
     * fresh target. This is a Memory write to creep.memory.targetId.
     */
    if(result === OK && target.hits <= 1000) {
        delete creep.memory.targetId;
    }
}

function idleNearAttackFlag(creep) {
    /*
     * If there is no valid structure on the Attack flag, wait near the flag.
     * This keeps the creep close to the player's intended operation area.
     */
    var flag = Game.flags.Attack;
    if(flag) {
        creep.moveTo(flag, {visualizePathStyle: {stroke: '#bbbbbb'}});
    }
}

function moveToRoom(creep, roomName) {
    /*
     * World-map room travel starts by finding the exit direction that leads
     * toward the destination room.
     */
    var exitDir = Game.map.findExit(creep.room, roomName);
    if(exitDir < 0) {
        return false;
    }

    var exit = creep.pos.findClosestByRange(exitDir);
    if(exit) {
        creep.moveTo(exit, {visualizePathStyle: {stroke: '#ff0000'}});
    }
    return true;
}

module.exports = roleDismantler;
