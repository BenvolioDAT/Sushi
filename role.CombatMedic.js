var roleCombatMedic = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if(!creep || creep.spawning) {
            return;
        }

        if(creep.hits < creep.hitsMax) {
            creep.heal(creep);
        }

        if(creep.memory.targetRoom && creep.room.name !== creep.memory.targetRoom) {
            moveToRoom(creep, creep.memory.targetRoom);
            return;
        }

        var target = creep.pos.findClosestByPath(FIND_MY_CREEPS, {
            filter: function(ally) {
                return ally.hits < ally.hitsMax;
            }
        });

        if(!target) {
            followCombatCreep(creep);
            return;
        }

        if(creep.heal(target) === ERR_NOT_IN_RANGE) {
            if(creep.rangedHeal(target) === ERR_NOT_IN_RANGE) {
                creep.moveTo(target, {visualizePathStyle: {stroke: '#00ff00'}});
            }
        }
    }
};

function followCombatCreep(creep) {
    var ally = creep.pos.findClosestByPath(FIND_MY_CREEPS, {
        filter: function(other) {
            return (
                other.name !== creep.name &&
                other.memory &&
                (other.memory.role === 'CombatMelee' || other.memory.role === 'CombatArcher')
            );
        }
    });

    if(ally && creep.pos.getRangeTo(ally) > 2) {
        creep.moveTo(ally, {visualizePathStyle: {stroke: '#00ff00'}});
        return;
    }

    var spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
    if(spawn && creep.pos.getRangeTo(spawn) > 3) {
        creep.moveTo(spawn, {visualizePathStyle: {stroke: '#bbbbbb'}});
    }
}

function moveToRoom(creep, roomName) {
    var exitDir = Game.map.findExit(creep.room, roomName);
    if(exitDir < 0) {
        return false;
    }

    var exit = creep.pos.findClosestByRange(exitDir);
    if(exit) {
        creep.moveTo(exit, {visualizePathStyle: {stroke: '#00ff00'}});
    }
    return true;
}

module.exports = roleCombatMedic;
