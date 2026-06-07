/*
 * Logic.WarRoom.js
 *
 * Shared combat helper functions for Sushi combat creeps.
 *
 * This file is the combat "brain toolbox".
 *
 * Role files:
 * - role.Ronin.js  = melee brawler
 * - role.Volley.js = ranged attacker
 * - role.Cleric.js = healer
 *
 * This file helps all of them with common jobs:
 * - moving to a remote target room
 * - finding enemy creeps
 * - finding enemy structures
 * - remembering a combat target
 * - finding wounded friendly creeps
 * - following a combat buddy
 */

var travel = require('utility.Travel.Creep');

var WarRoom = {};

var COMBAT_ROLE_RONIN = 'Ronin';
var COMBAT_ROLE_VOLLEY = 'Volley';
var COMBAT_ROLE_CLERIC = 'Cleric';

var TARGET_ROOM_MEMORY_KEY = 'targetRoom';
var TARGET_FLAG_MEMORY_KEY = 'targetFlag';
var COMBAT_TARGET_MEMORY_KEY = 'combatTargetId';

/*
 * Get the room name this combat creep should move toward.
 *
 * You can set either:
 * creep.memory.targetRoom = 'W39S48';
 *
 * Or:
 * creep.memory.targetFlag = 'AttackRoom';
 */
WarRoom.getTargetRoomName = function(creep) {
    if(!creep || !creep.memory) {
        return null;
    }

    if(creep.memory[TARGET_ROOM_MEMORY_KEY]) {
        return creep.memory[TARGET_ROOM_MEMORY_KEY];
    }

    if(creep.memory[TARGET_FLAG_MEMORY_KEY]) {
        var flag = Game.flags[creep.memory[TARGET_FLAG_MEMORY_KEY]];

        if(flag && flag.pos) {
            return flag.pos.roomName;
        }
    }

    return null;
};

/*
 * Move the creep toward its assigned combat room.
 *
 * Returns true if it moved.
 * Returns false if it is already in the room or has no target room.
 */
WarRoom.moveToTargetRoom = function(creep) {
    if(!creep || !creep.room) {
        return false;
    }

    var targetRoomName = WarRoom.getTargetRoomName(creep);

    if(!targetRoomName) {
        return false;
    }

    if(creep.room.name === targetRoomName) {
        return false;
    }

    travel.moveToRoom(creep, targetRoomName, {
        range: 22,
        reusePath: 20,
        visualizePathStyle: {
            stroke: '#ff4444'
        }
    });

    return true;
};

/*
 * Move to the assigned target flag.
 *
 * This is useful when the creep reaches the attack room but sees no enemies yet.
 */
WarRoom.moveToTargetFlag = function(creep, range) {
    if(!creep || !creep.memory || !creep.memory[TARGET_FLAG_MEMORY_KEY]) {
        return false;
    }

    var flag = Game.flags[creep.memory[TARGET_FLAG_MEMORY_KEY]];

    if(!flag) {
        return false;
    }

    travel.move(creep, flag, {
        range: range || 3,
        reusePath: 20,
        visualizePathStyle: {
            stroke: '#ff8844'
        }
    });

    return true;
};

/*
 * Find enemy creeps in the current room.
 */
WarRoom.findHostileCreeps = function(creep) {
    if(!creep || !creep.room) {
        return [];
    }

    return creep.room.find(FIND_HOSTILE_CREEPS);
};

/*
 * Give an enemy creep a simple danger score.
 *
 * Bigger score = more important target.
 */
WarRoom.getHostileCreepScore = function(hostile) {
    if(!hostile) {
        return 0;
    }

    var score = 0;

    /*
     * Healers are dangerous because they undo our damage.
     */
    score += hostile.getActiveBodyparts(HEAL) * 500;

    /*
     * Ranged and melee attackers hurt our creeps.
     */
    score += hostile.getActiveBodyparts(RANGED_ATTACK) * 300;
    score += hostile.getActiveBodyparts(ATTACK) * 250;

    /*
     * WORK parts can dismantle structures.
     */
    score += hostile.getActiveBodyparts(WORK) * 100;

    /*
     * Prefer finishing wounded enemies.
     */
    score += Math.floor((hostile.hitsMax - hostile.hits) / 10);

    return score;
};

/*
 * Find the best enemy creep to attack.
 */
WarRoom.findBestHostileCreep = function(creep) {
    var hostiles = WarRoom.findHostileCreeps(creep);

    if(hostiles.length === 0) {
        return null;
    }

    var bestTarget = null;
    var bestScore = -1;

    for(var i = 0; i < hostiles.length; i++) {
        var hostile = hostiles[i];
        var score = WarRoom.getHostileCreepScore(hostile);

        if(
            !bestTarget ||
            score > bestScore ||
            (score === bestScore && creep.pos.getRangeTo(hostile) < creep.pos.getRangeTo(bestTarget))
        ) {
            bestTarget = hostile;
            bestScore = score;
        }
    }

    return bestTarget;
};

/*
 * Find enemy structures in the current room.
 *
 * This lets combat creeps attack in remote rooms even when no enemy creeps
 * are standing there.
 */
WarRoom.findHostileStructures = function(creep) {
    if(!creep || !creep.room) {
        return [];
    }

    return creep.room.find(FIND_HOSTILE_STRUCTURES, {
        filter: function(structure) {
            /*
             * Normal combat creeps cannot attack controllers directly.
             */
            if(structure.structureType === STRUCTURE_CONTROLLER) {
                return false;
            }

            return true;
        }
    });
};

/*
 * Give hostile structures a simple priority score.
 */
WarRoom.getHostileStructureScore = function(structure) {
    if(!structure) {
        return 0;
    }

    if(structure.structureType === STRUCTURE_INVADER_CORE) {
        return 10000;
    }

    if(structure.structureType === STRUCTURE_TOWER) {
        return 9000;
    }

    if(structure.structureType === STRUCTURE_SPAWN) {
        return 8000;
    }

    if(structure.structureType === STRUCTURE_EXTENSION) {
        return 2000;
    }

    return 1000;
};

/*
 * Find the best enemy structure to attack.
 */
WarRoom.findBestHostileStructure = function(creep) {
    var structures = WarRoom.findHostileStructures(creep);

    if(structures.length === 0) {
        return null;
    }

    var bestTarget = null;
    var bestScore = -1;

    for(var i = 0; i < structures.length; i++) {
        var structure = structures[i];
        var score = WarRoom.getHostileStructureScore(structure);

        if(
            !bestTarget ||
            score > bestScore ||
            (score === bestScore && creep.pos.getRangeTo(structure) < creep.pos.getRangeTo(bestTarget))
        ) {
            bestTarget = structure;
            bestScore = score;
        }
    }

    return bestTarget;
};

/*
 * Get the combat target for this creep.
 *
 * Priority:
 * 1. Keep old target if still alive.
 * 2. Attack enemy creeps.
 * 3. Attack enemy structures.
 */
WarRoom.getCombatTarget = function(creep) {
    if(!creep || !creep.memory) {
        return null;
    }

    if(creep.memory[COMBAT_TARGET_MEMORY_KEY]) {
        var oldTarget = Game.getObjectById(creep.memory[COMBAT_TARGET_MEMORY_KEY]);

        if(oldTarget && oldTarget.hits > 0) {
            return oldTarget;
        }

        delete creep.memory[COMBAT_TARGET_MEMORY_KEY];
    }

    var target = WarRoom.findBestHostileCreep(creep);

    if(!target) {
        target = WarRoom.findBestHostileStructure(creep);
    }

    if(target) {
        creep.memory[COMBAT_TARGET_MEMORY_KEY] = target.id;
    }

    return target;
};

/*
 * Clear this creep's remembered combat target.
 */
WarRoom.clearCombatTarget = function(creep) {
    if(creep && creep.memory) {
        delete creep.memory[COMBAT_TARGET_MEMORY_KEY];
    }
};

/*
 * Find the friendly creep that needs healing the most.
 */
WarRoom.findBestHealTarget = function(creep) {
    if(!creep || !creep.room) {
        return null;
    }

    var hurtCreeps = creep.room.find(FIND_MY_CREEPS, {
        filter: function(friendly) {
            return friendly.hits < friendly.hitsMax;
        }
    });

    if(hurtCreeps.length === 0) {
        return null;
    }

    var bestTarget = null;
    var bestMissingHits = -1;

    for(var i = 0; i < hurtCreeps.length; i++) {
        var target = hurtCreeps[i];
        var missingHits = target.hitsMax - target.hits;

        if(
            !bestTarget ||
            missingHits > bestMissingHits ||
            (missingHits === bestMissingHits && creep.pos.getRangeTo(target) < creep.pos.getRangeTo(bestTarget))
        ) {
            bestTarget = target;
            bestMissingHits = missingHits;
        }
    }

    return bestTarget;
};

/*
 * Find a combat buddy for Cleric to follow.
 */
WarRoom.findCombatBuddy = function(creep) {
    if(!creep || !creep.room) {
        return null;
    }

    return creep.pos.findClosestByPath(FIND_MY_CREEPS, {
        filter: function(friendly) {
            if(friendly.name === creep.name) {
                return false;
            }

            return friendly.memory && (
                friendly.memory.role === COMBAT_ROLE_RONIN ||
                friendly.memory.role === COMBAT_ROLE_VOLLEY
            );
        }
    });
};

/*
 * Move near a target using the shared Sushi travel wrapper.
 */
WarRoom.moveToRange = function(creep, target, range, strokeColor) {
    if(!creep || !target) {
        return ERR_INVALID_ARGS;
    }

    return travel.move(creep, target, {
        range: range || 1,
        reusePath: 10,
        visualizePathStyle: {
            stroke: strokeColor || '#ffffff'
        }
    });
};

/*
 * Simple idle behavior when a combat creep has no target.
 */
WarRoom.idleCombat = function(creep) {
    if(!creep) {
        return false;
    }

    if(WarRoom.moveToTargetFlag(creep, 3)) {
        return true;
    }

    creep.say('guard');
    return true;
};

module.exports = WarRoom;