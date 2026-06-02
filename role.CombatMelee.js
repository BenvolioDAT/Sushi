var roleCombatMelee = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if(!creep || creep.spawning) {
            return;
        }

        if(creep.memory.targetRoom && creep.room.name !== creep.memory.targetRoom) {
            moveToRoom(creep, creep.memory.targetRoom);
            return;
        }

        var target = findCombatTarget(creep);
        if(!target) {
            idleNearSpawn(creep);
            return;
        }

        if(creep.attack(target) === ERR_NOT_IN_RANGE) {
            creep.moveTo(target, {visualizePathStyle: {stroke: '#ff0000'}});
        }
    }
};

function findCombatTarget(creep) {
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

module.exports = roleCombatMelee;
