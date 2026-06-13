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
 * WarRoom radar settings.
 *
 * The WarRoom only reacts to threats in spawn rooms and their directly
 * adjacent visible rooms. This keeps far-away scouts and remote rooms from
 * pulling all combat creeps across the map.
 */
var MAX_SPAWN_DEFENSE_ROOM_DISTANCE = 1;
var THREAT_FORGET_TICKS = 50;
var WAR_ROOM_ATTACK_FLAG_NAME = 'WarRoom_Attack';

/*
 * WarRoom writes one shared threat record. Individual combat roles still make
 * their own local action choices, but they can agree on where the fight is and
 * what broad target should matter.
 */

/*
 * Run the shared WarRoom brain once per tick.
 *
 * Jobs:
 * - scan spawn rooms and directly adjacent rooms that are visible in Game.rooms
 * - ignore all other visible rooms
 * - find the best hostile creep or hostile structure
 * - create or move one shared attack flag
 * - remember the active threat in Memory.WarRoom.activeThreat
 * - remove old memory and the flag after the threat is stale
 */
WarRoom.run = function() {
    WarRoom.ensureMemory();

    var spawnRoomNames = WarRoom.getSpawnRoomNames();
    var bestThreatInfo = null;

    for(var roomName in Game.rooms) {
        var room = Game.rooms[roomName];

        if(!room) {
            continue;
        }

        /*
         * Only spawn rooms and directly adjacent visible rooms are automatic
         * defense targets. Far-away scouts and remote rooms must not pull
         * combat creeps across the map.
         */
        if(!WarRoom.isRoomNearSpawnRoom(roomName, spawnRoomNames)) {
            continue;
        }

        var roomThreatInfo = WarRoom.findBestThreatInRoom(room);

        if(!roomThreatInfo) {
            continue;
        }

        /*
         * The room picked its best local threat. Now add a simple distance
         * bonus before comparing it against threats from other rooms.
         */
        var closestSpawnDistance = WarRoom.getClosestSpawnRoomDistance(roomName, spawnRoomNames);

        roomThreatInfo.score += WarRoom.getDistanceScoreBonus(closestSpawnDistance);

        if(!bestThreatInfo || roomThreatInfo.score > bestThreatInfo.score) {
            bestThreatInfo = roomThreatInfo;
        }
    }

    if(bestThreatInfo && bestThreatInfo.target) {
        WarRoom.saveActiveThreat(bestThreatInfo.target, bestThreatInfo.type);
        WarRoom.placeAttackFlag(bestThreatInfo.target);
        return;
    }

    WarRoom.forgetStaleThreat();
};

/*
 * Make sure the WarRoom memory object exists before reading or writing it.
 */
WarRoom.ensureMemory = function() {
    if(!Memory.WarRoom) {
        Memory.WarRoom = {};
    }
};

/*
 * Find each unique room that contains one of our spawns.
 */
WarRoom.getSpawnRoomNames = function() {
    var spawnRoomNames = [];
    var seenRooms = {};

    for(var spawnName in Game.spawns) {
        var spawn = Game.spawns[spawnName];

        if(!spawn || !spawn.room || !spawn.room.name) {
            continue;
        }

        if(seenRooms[spawn.room.name]) {
            continue;
        }

        seenRooms[spawn.room.name] = true;
        spawnRoomNames.push(spawn.room.name);
    }

    return spawnRoomNames;
};

/*
 * Return true when a room is a spawn room or directly adjacent to one.
 */
WarRoom.isRoomNearSpawnRoom = function(roomName, spawnRoomNames) {
    if(!roomName || !spawnRoomNames || spawnRoomNames.length === 0) {
        return false;
    }

    for(var i = 0; i < spawnRoomNames.length; i++) {
        var spawnRoomName = spawnRoomNames[i];
        var distance = Game.map.getRoomLinearDistance(roomName, spawnRoomName);

        if(distance <= MAX_SPAWN_DEFENSE_ROOM_DISTANCE) {
            return true;
        }
    }

    return false;
};

/*
 * Find the closest spawn room by linear room distance.
 */
WarRoom.getClosestSpawnRoomDistance = function(roomName, spawnRoomNames) {
    if(!roomName || !spawnRoomNames || spawnRoomNames.length === 0) {
        return null;
    }

    var closestDistance = null;

    for(var i = 0; i < spawnRoomNames.length; i++) {
        var distance = Game.map.getRoomLinearDistance(roomName, spawnRoomNames[i]);

        if(closestDistance === null || distance < closestDistance) {
            closestDistance = distance;
        }
    }

    return closestDistance;
};

/*
 * Nearby threats should beat similar far-away threats.
 */
WarRoom.getDistanceScoreBonus = function(distance) {
    var remainingDistance = MAX_SPAWN_DEFENSE_ROOM_DISTANCE - distance;

    if(remainingDistance < 0) {
        return 0;
    }

    return remainingDistance * 2000;
};

/*
 * Pick the best threat inside one visible room.
 */
WarRoom.findBestThreatInRoom = function(room) {
    /*
     * A room can contain both hostile creeps and hostile structures. Hostile
     * creeps usually matter more because they move and attack, but a high-value
     * structure such as a tower or invader core can beat a weak creep by score.
     */
    if(!room) {
        return null;
    }

    var bestCreepInfo = WarRoom.findBestHostileCreepInRoom(room);
    var bestStructureInfo = WarRoom.findBestHostileStructureInRoom(room);

    if(bestCreepInfo && (!bestStructureInfo || bestCreepInfo.score >= bestStructureInfo.score)) {
        return bestCreepInfo;
    }

    if(bestStructureInfo) {
        return bestStructureInfo;
    }

    return null;
};

/*
 * Return true when a hostile creep has an active body part that can threaten
 * our creeps, structures, or operations.
 */
WarRoom.isHostileCreepThreat = function(hostile) {
    if(!hostile) {
        return false;
    }

    return (
        hostile.getActiveBodyparts(ATTACK) > 0 ||
        hostile.getActiveBodyparts(RANGED_ATTACK) > 0 ||
        hostile.getActiveBodyparts(HEAL) > 0 ||
        hostile.getActiveBodyparts(WORK) > 0
    );
};

/*
 * Find the highest-scoring hostile creep in a visible room.
 */
WarRoom.findBestHostileCreepInRoom = function(room) {
    var hostiles = room.find(FIND_HOSTILE_CREEPS, {
        filter: function(hostile) {
            return WarRoom.isHostileCreepThreat(hostile);
        }
    });

    if(hostiles.length === 0) {
        return null;
    }

    var bestTarget = null;
    var bestScore = -1;

    for(var i = 0; i < hostiles.length; i++) {
        var hostile = hostiles[i];
        var score = WarRoom.getHostileCreepScore(hostile);

        if(!bestTarget || score > bestScore) {
            bestTarget = hostile;
            bestScore = score;
        }
    }

    return {
        type: 'creep',
        target: bestTarget,
        score: bestScore
    };
};

/*
 * Find the highest-scoring hostile structure in a visible room.
 */
WarRoom.findBestHostileStructureInRoom = function(room) {
    var structures = room.find(FIND_HOSTILE_STRUCTURES, {
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

    if(structures.length === 0) {
        return null;
    }

    var bestTarget = null;
    var bestScore = -1;

    for(var i = 0; i < structures.length; i++) {
        var structure = structures[i];
        var score = WarRoom.getHostileStructureScore(structure);

        if(!bestTarget || score > bestScore) {
            bestTarget = structure;
            bestScore = score;
        }
    }

    return {
        type: 'structure',
        target: bestTarget,
        score: bestScore
    };
};

/*
 * Save simple threat data in Memory.
 *
 * Memory should hold plain values, not full game objects.
 */
WarRoom.saveActiveThreat = function(threat, type) {
    if(!threat || !threat.pos) {
        return;
    }

    WarRoom.ensureMemory();

    var ownerName = 'unknown';

    if(threat.owner && threat.owner.username) {
        ownerName = threat.owner.username;
    }

    var activeThreat = {
        type: type,
        id: threat.id,
        roomName: threat.pos.roomName,
        x: threat.pos.x,
        y: threat.pos.y,
        owner: ownerName,
        structureType: threat.structureType || null,
        lastSeen: Game.time
    };

    if(type === 'creep' && threat.body) {
        activeThreat.threatParts = {
            attack: threat.getActiveBodyparts(ATTACK),
            ranged: threat.getActiveBodyparts(RANGED_ATTACK),
            heal: threat.getActiveBodyparts(HEAL),
            work: threat.getActiveBodyparts(WORK)
        };
    }

    Memory.WarRoom.activeThreat = activeThreat;
};

/*
 * Create the shared attack flag, or move it to the current threat.
 */
WarRoom.placeAttackFlag = function(threat) {
    if(!threat || !threat.pos) {
        return false;
    }

    var flag = Game.flags[WAR_ROOM_ATTACK_FLAG_NAME];

    if(flag) {
        flag.setPosition(threat.pos);
        return true;
    }

    threat.pos.createFlag(WAR_ROOM_ATTACK_FLAG_NAME);
    return true;
};

/*
 * If the WarRoom has not seen a threat recently, forget it and remove the flag.
 */
WarRoom.forgetStaleThreat = function() {
    WarRoom.ensureMemory();

    var activeThreat = Memory.WarRoom.activeThreat;

    if(!activeThreat || activeThreat.lastSeen === undefined) {
        return false;
    }

    if(Game.time - activeThreat.lastSeen <= THREAT_FORGET_TICKS) {
        return false;
    }

    delete Memory.WarRoom.activeThreat;

    var flag = Game.flags[WAR_ROOM_ATTACK_FLAG_NAME];

    if(flag) {
        flag.remove();
    }

    return true;
};

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

        return null;
    }

    var sharedFlag = Game.flags[WAR_ROOM_ATTACK_FLAG_NAME];

    if(sharedFlag && sharedFlag.pos) {
        return sharedFlag.pos.roomName;
    }

    if(Memory.WarRoom && Memory.WarRoom.activeThreat && Memory.WarRoom.activeThreat.roomName) {
        return Memory.WarRoom.activeThreat.roomName;
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
    if(!creep || !creep.memory) {
        return false;
    }

    var flag = null;

    if(creep.memory[TARGET_FLAG_MEMORY_KEY]) {
        flag = Game.flags[creep.memory[TARGET_FLAG_MEMORY_KEY]];
    } else {
        flag = Game.flags[WAR_ROOM_ATTACK_FLAG_NAME];

        /*
         * Manual targetRoom still wins over automatic WarRoom targeting.
         * If the shared flag is in a different room, do not pull this creep
         * away from its manually assigned room.
         */
        if(
            flag &&
            flag.pos &&
            creep.memory[TARGET_ROOM_MEMORY_KEY] &&
            flag.pos.roomName !== creep.memory[TARGET_ROOM_MEMORY_KEY]
        ) {
            return false;
        }
    }

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

    return creep.room.find(FIND_HOSTILE_CREEPS, {
        filter: function(hostile) {
            return WarRoom.isHostileCreepThreat(hostile);
        }
    });
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
    /*
     * Remembering a target id prevents target thrashing. Without this, two
     * equal enemies could make the creep alternate targets every tick and spread
     * damage instead of finishing one enemy.
     */
    if(!creep || !creep.memory) {
        return null;
    }

    if(creep.memory[COMBAT_TARGET_MEMORY_KEY]) {
        var oldTarget = Game.getObjectById(creep.memory[COMBAT_TARGET_MEMORY_KEY]);

        if(
            oldTarget &&
            oldTarget.hits > 0 &&
            oldTarget.pos &&
            oldTarget.pos.roomName === creep.room.name &&
            (!oldTarget.body || WarRoom.isHostileCreepThreat(oldTarget))
        ) {
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
            return friendly.hits < friendly.hitsMax && WarRoom.isCombatCreep(friendly);
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
 * Combat healers should focus on the combat team, not every worker in the room.
 */
WarRoom.isCombatCreep = function(creep) {
    if(!creep || !creep.memory) {
        return false;
    }

    return (
        creep.memory.role === COMBAT_ROLE_RONIN ||
        creep.memory.role === COMBAT_ROLE_VOLLEY ||
        creep.memory.role === COMBAT_ROLE_CLERIC
    );
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
