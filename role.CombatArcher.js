var roleCombatArcher = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if(!creep || creep.spawning) {
            return;
        }

        if(creep.hits < creep.hitsMax && creep.getActiveBodyparts(HEAL) > 0) {
            creep.heal(creep);
        }

        if(creep.memory.targetRoom && creep.room.name !== creep.memory.targetRoom) {
            moveToRoom(creep, creep.memory.targetRoom);
            return;
        }

        var target = findRangedTarget(creep);
        if(!target) {
            idleNearSpawn(creep);
            return;
        }

        var range = creep.pos.getRangeTo(target);
        if(range <= 3) {
            creep.rangedAttack(target);
        }
        if(range > 3) {
            creep.moveTo(target, {range: 3, visualizePathStyle: {stroke: '#ff0000'}});
        }
    }
};

function findRangedTarget(creep) {
    var hostile = creep.pos.findClosestByPath(FIND_HOSTILE_CREEPS);
    if(hostile) {
        return hostile;
    }

    return creep.pos.findClosestByPath(FIND_HOSTILE_STRUCTURES, {
        filter: function(structure) {
            return structure.structureType !== STRUCTURE_CONTROLLER;
        }
    });
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

function idleNearSpawn(creep) {
    var spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
    if(spawn && creep.pos.getRangeTo(spawn) > 3) {
        creep.moveTo(spawn, {visualizePathStyle: {stroke: '#bbbbbb'}});
    }
}

module.exports = roleCombatArcher;
