var roleDismantler = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if(!creep || creep.spawning) {
            return;
        }

        if(creep.memory.targetRoom && creep.room.name !== creep.memory.targetRoom) {
            moveToRoom(creep, creep.memory.targetRoom);
            return;
        }

        var target = getDismantleTarget(creep);
        if(!target) {
            idleNearAttackFlag(creep);
            return;
        }

        dismantleOrAttack(creep, target);
    }
};

function getDismantleTarget(creep) {
    if(creep.memory.targetId) {
        var remembered = Game.getObjectById(creep.memory.targetId);
        if(remembered) {
            return remembered;
        }
        delete creep.memory.targetId;
    }

    var flagTarget = getStructureAtAttackFlag();
    if(flagTarget) {
        creep.memory.targetId = flagTarget.id;
        return flagTarget;
    }

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
    var flag = Game.flags.Attack;
    if(!flag || !Game.rooms[flag.pos.roomName]) {
        return null;
    }

    var structures = flag.pos.lookFor(LOOK_STRUCTURES);
    if(!structures || structures.length === 0) {
        return null;
    }

    return structures[0];
}

function dismantleOrAttack(creep, target) {
    var result = ERR_NO_BODYPART;

    if(creep.getActiveBodyparts(WORK) > 0) {
        result = creep.dismantle(target);
    }

    if(result === ERR_NO_BODYPART && creep.getActiveBodyparts(ATTACK) > 0) {
        result = creep.attack(target);
    }

    if(result === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, {visualizePathStyle: {stroke: '#ff0000'}});
    }

    if(result === OK && target.hits <= 1000) {
        delete creep.memory.targetId;
    }
}

function idleNearAttackFlag(creep) {
    var flag = Game.flags.Attack;
    if(flag) {
        creep.moveTo(flag, {visualizePathStyle: {stroke: '#bbbbbb'}});
    }
}

function moveToRoom(creep, roomName) {
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
