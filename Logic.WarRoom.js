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
var tickCache = require('Tick.Cache');
var combatThreat = require('Combat.Threat');

var WarRoom = {};

var COMBAT_ROLE_RONIN = 'Ronin';
var COMBAT_ROLE_VOLLEY = 'Volley';
var COMBAT_ROLE_CLERIC = 'Cleric';

var TARGET_ROOM_MEMORY_KEY = 'targetRoom';
var TARGET_FLAG_MEMORY_KEY = 'targetFlag';
var COMBAT_TARGET_MEMORY_KEY = 'combatTargetId';
var COMBAT_TARGET_UNTIL_MEMORY_KEY = 'combatTargetUntil';
var COMBAT_TARGET_SCORE_MEMORY_KEY = 'combatTargetScore';
var COMBAT_TARGET_LOCK_TICKS = 3;
var HEALER_PARTNER_MEMORY_KEY = 'healerPartnerId';
var HEALER_PARTNER_UNTIL_MEMORY_KEY = 'healerPartnerUntil';
var RAMPART_CLAIM_TICKS = 3;
var rampartClaimTick = null;
var rampartClaims = {};

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

    var visibleRooms = tickCache.getVisibleRooms();
    for(var roomIndex = 0; roomIndex < visibleRooms.length; roomIndex++) {
        var room = visibleRooms[roomIndex];
        var roomName = room.name;

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
    var rooms = tickCache.getOwnedSpawnRooms();

    for(var roomIndex = 0; roomIndex < rooms.length; roomIndex++) {
        spawnRoomNames.push(rooms[roomIndex].name);
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

    return combatThreat.analyze(hostile, hostile.room).dangerous;
};

/*
 * Find the highest-scoring hostile creep in a visible room.
 */
WarRoom.findBestHostileCreepInRoom = function(room) {
    var roomHostiles = tickCache.getHostileCreeps(room);
    var hostiles = [];
    for(var hostileIndex = 0; hostileIndex < roomHostiles.length; hostileIndex++) {
        if(WarRoom.isHostileCreepThreat(roomHostiles[hostileIndex])) {
            hostiles.push(roomHostiles[hostileIndex]);
        }
    }

    if(hostiles.length === 0) {
        return null;
    }

    var bestTarget = null;
    var bestScore = -1;

    for(var i = 0; i < hostiles.length; i++) {
        var hostile = hostiles[i];
        var score = WarRoom.getHostileCreepScore(hostile, room);

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
    var roomStructures = tickCache.getHostileStructures(room);
    var structures = [];
    for(var structureIndex = 0; structureIndex < roomStructures.length; structureIndex++) {
        if(roomStructures[structureIndex].structureType !== STRUCTURE_CONTROLLER) {
            structures.push(roomStructures[structureIndex]);
        }
    }

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
        var analysis = combatThreat.analyze(threat, threat.room);
        activeThreat.threatParts = {
            attack: analysis.activeParts.attack || 0,
            ranged: analysis.activeParts.ranged_attack || 0,
            heal: analysis.activeParts.heal || 0,
            work: analysis.activeParts.work || 0
        };
        activeThreat.category = analysis.category;
        activeThreat.totalThreat = analysis.totalThreat;
    }

    var oldThreat = Memory.WarRoom.activeThreat;
    if (
        oldThreat &&
        oldThreat.id === activeThreat.id &&
        oldThreat.roomName === activeThreat.roomName &&
        oldThreat.type === activeThreat.type &&
        Game.time - (oldThreat.lastSeen || 0) < 5
    ) {
        return;
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
        if (
            !flag.pos ||
            flag.pos.roomName !== threat.pos.roomName ||
            flag.pos.x !== threat.pos.x ||
            flag.pos.y !== threat.pos.y
        ) {
            flag.setPosition(threat.pos);
        }
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

    var roomHostiles = tickCache.getHostileCreeps(creep.room);
    var hostiles = [];
    for(var i = 0; i < roomHostiles.length; i++) {
        if(WarRoom.isHostileCreepThreat(roomHostiles[i])) {
            hostiles.push(roomHostiles[i]);
        }
    }
    return hostiles;
};

/*
 * Give an enemy creep a simple danger score.
 *
 * Bigger score = more important target.
 */
WarRoom.getHostileCreepScore = function(hostile, room) {
    if(!hostile) {
        return 0;
    }

    var analysis = combatThreat.analyze(hostile, room || hostile.room);
    var finishBonus = Math.floor(
        Math.max(0, (hostile.hitsMax || 0) - (hostile.hits || 0)) / 10
    );
    return analysis.totalThreat + finishBonus;
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
        var score = WarRoom.getHostileCreepScore(hostile, creep.room);
        var roomMemory = Memory.rooms && Memory.rooms[creep.room.name];
        if (roomMemory && roomMemory.towerTargetId === hostile.id) {
            score += 300;
        }

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

    var roomStructures = tickCache.getHostileStructures(creep.room);
    var structures = [];
    for(var i = 0; i < roomStructures.length; i++) {
        if(roomStructures[i].structureType === STRUCTURE_CONTROLLER) {
            continue;
        }
        if (
            roomStructures[i].structureType === STRUCTURE_INVADER_CORE &&
            typeof creep.getActiveBodyparts === 'function' &&
            creep.getActiveBodyparts(ATTACK) <= 0
        ) {
            continue;
        }
        structures.push(roomStructures[i]);
    }
    return structures;
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

    var oldTarget = null;
    if(creep.memory[COMBAT_TARGET_MEMORY_KEY]) {
        oldTarget = Game.getObjectById(creep.memory[COMBAT_TARGET_MEMORY_KEY]);
        if(!WarRoom.isValidCombatTarget(creep, oldTarget)) {
            oldTarget = null;
            WarRoom.clearCombatTarget(creep);
        }
    }

    var target = WarRoom.findBestHostileCreep(creep);
    if(!target) {
        target = WarRoom.findBestHostileStructure(creep);
    }

    var targetScore = WarRoom.getCombatTargetScore(target, creep.room);
    var oldScore = WarRoom.getCombatTargetScore(oldTarget, creep.room);
    var criticalNewThreat = target && oldTarget && target.id !== oldTarget.id &&
        targetScore > Math.max(oldScore * 1.35, oldScore + 250);

    if(
        oldTarget &&
        creep.memory[COMBAT_TARGET_UNTIL_MEMORY_KEY] > Game.time &&
        !criticalNewThreat
    ) {
        return oldTarget;
    }

    if(target) {
        creep.memory[COMBAT_TARGET_MEMORY_KEY] = target.id;
        creep.memory[COMBAT_TARGET_UNTIL_MEMORY_KEY] =
            Game.time + COMBAT_TARGET_LOCK_TICKS;
        creep.memory[COMBAT_TARGET_SCORE_MEMORY_KEY] = targetScore;
    }
    else {
        WarRoom.clearCombatTarget(creep);
    }

    return target;
};

WarRoom.isValidCombatTarget = function(creep, target) {
    if (
        target &&
        typeof STRUCTURE_INVADER_CORE !== 'undefined' &&
        target.structureType === STRUCTURE_INVADER_CORE &&
        typeof creep.getActiveBodyparts === 'function' &&
        creep.getActiveBodyparts(ATTACK) <= 0
    ) {
        return false;
    }
    return !!(
        creep && target && target.hits > 0 && target.pos &&
        target.pos.roomName === creep.room.name &&
        (!target.body || WarRoom.isHostileCreepThreat(target))
    );
};

WarRoom.getCombatTargetScore = function(target, room) {
    if(!target) {
        return 0;
    }
    return target.body ? WarRoom.getHostileCreepScore(target, room) :
        WarRoom.getHostileStructureScore(target);
};

/*
 * Clear this creep's remembered combat target.
 */
WarRoom.clearCombatTarget = function(creep) {
    if(creep && creep.memory) {
        delete creep.memory[COMBAT_TARGET_MEMORY_KEY];
        delete creep.memory[COMBAT_TARGET_UNTIL_MEMORY_KEY];
        delete creep.memory[COMBAT_TARGET_SCORE_MEMORY_KEY];
    }
};

/*
 * Find the friendly creep that needs healing the most.
 */
WarRoom.findBestHealTarget = function(creep) {
    if(!creep || !creep.room) {
        return null;
    }

    var roomCreeps = tickCache.getMyCreepsInRoom(creep.room);
    var hurtCreeps = [];
    for(var hurtIndex = 0; hurtIndex < roomCreeps.length; hurtIndex++) {
        if(
            roomCreeps[hurtIndex].hits < roomCreeps[hurtIndex].hitsMax &&
            WarRoom.isCombatCreep(roomCreeps[hurtIndex])
        ) {
            hurtCreeps.push(roomCreeps[hurtIndex]);
        }
    }

    if(hurtCreeps.length === 0) {
        return null;
    }

    var bestTarget = null;
    var bestDangerScore = -1;
    var hostiles = tickCache.getHostileCreeps(creep.room);

    for(var i = 0; i < hurtCreeps.length; i++) {
        var target = hurtCreeps[i];
        var missingHits = target.hitsMax - target.hits;
        var incoming = WarRoom.getIncomingDamage(target, hostiles);
        var hitRatio = target.hits / Math.max(1, target.hitsMax);
        var dangerScore = missingHits + incoming * 10 +
            Math.round((1 - hitRatio) * 500);

        if(
            !bestTarget ||
            dangerScore > bestDangerScore ||
            (dangerScore === bestDangerScore && creep.pos.getRangeTo(target) < creep.pos.getRangeTo(bestTarget))
        ) {
            bestTarget = target;
            bestDangerScore = dangerScore;
        }
    }

    return bestTarget;
};

WarRoom.getIncomingDamage = function(target, hostiles) {
    var incoming = 0;
    hostiles = hostiles || [];
    for(var i = 0; i < hostiles.length; i++) {
        var analysis = combatThreat.analyze(hostiles[i], target.room);
        var range = combatThreat.getRange(hostiles[i].pos, target.pos);
        if(range <= 1) {
            incoming += analysis.attackPower;
        }
        if(range <= 3) {
            incoming += analysis.rangedPower;
        }
    }
    return incoming;
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

    var remembered = creep.memory[HEALER_PARTNER_MEMORY_KEY] ?
        Game.getObjectById(creep.memory[HEALER_PARTNER_MEMORY_KEY]) : null;
    if (
        remembered && remembered.hits > 0 && remembered.room === creep.room &&
        remembered.memory &&
        (
            remembered.memory.role === COMBAT_ROLE_RONIN ||
            remembered.memory.role === COMBAT_ROLE_VOLLEY
        ) &&
        creep.memory[HEALER_PARTNER_UNTIL_MEMORY_KEY] > Game.time
    ) {
        return remembered;
    }

    delete creep.memory[HEALER_PARTNER_MEMORY_KEY];
    delete creep.memory[HEALER_PARTNER_UNTIL_MEMORY_KEY];

    var roomCreeps = tickCache.getMyCreepsInRoom(creep.room);
    var best = null;
    var bestScore = -1;
    for(var i = 0; i < roomCreeps.length; i++) {
        var friendly = roomCreeps[i];
        if(
            friendly.name === creep.name || !friendly.memory ||
            (
                friendly.memory.role !== COMBAT_ROLE_RONIN &&
                friendly.memory.role !== COMBAT_ROLE_VOLLEY
            )
        ) {
            continue;
        }
        var range = creep.pos.getRangeTo(friendly);
        var score = (friendly.hitsMax - friendly.hits) * 2 - range;
        if(!best || score > bestScore) {
            best = friendly;
            bestScore = score;
        }
    }
    if(best) {
        creep.memory[HEALER_PARTNER_MEMORY_KEY] = best.id;
        creep.memory[HEALER_PARTNER_UNTIL_MEMORY_KEY] = Game.time + 10;
    }
    return best;
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

function resetRampartClaims() {
    if(rampartClaimTick !== Game.time) {
        rampartClaimTick = Game.time;
        rampartClaims = {};
    }
}

WarRoom.findDefensiveRampart = function(creep, target, desiredRange) {
    if(
        !creep || !creep.room || !target ||
        !creep.room.controller || !creep.room.controller.my
    ) {
        return null;
    }
    resetRampartClaims();
    var structures = tickCache.getMyStructures(creep.room);
    var best = null;
    var bestScore = 9999;
    for(var i = 0; i < structures.length; i++) {
        var rampart = structures[i];
        if(rampart.structureType !== STRUCTURE_RAMPART || rampart.my === false) {
            continue;
        }
        var claimedBy = rampartClaims[rampart.id];
        if(claimedBy && claimedBy !== (creep.id || creep.name)) {
            continue;
        }
        var targetRange = combatThreat.getRange(rampart.pos, target.pos);
        var rangePenalty = desiredRange <= 1 ?
            Math.abs(targetRange - 1) * 12 :
            targetRange < 2 ? 18 : targetRange > 3 ? (targetRange - 3) * 12 : 0;
        if(desiredRange <= 1 && targetRange > 1) {
            continue;
        }
        if(desiredRange > 1 && targetRange > 3) {
            continue;
        }
        var score = rangePenalty + combatThreat.getRange(creep.pos, rampart.pos);
        if(!best || score < bestScore) {
            best = rampart;
            bestScore = score;
        }
    }
    if(best) {
        rampartClaims[best.id] = creep.id || creep.name;
        creep.memory.defenseRampartId = best.id;
        creep.memory.defenseRampartUntil = Game.time + RAMPART_CLAIM_TICKS;
    }
    else {
        delete creep.memory.defenseRampartId;
        delete creep.memory.defenseRampartUntil;
    }
    return best;
};

WarRoom.moveToDefensiveRampart = function(creep, target, desiredRange) {
    var rampart = WarRoom.findDefensiveRampart(creep, target, desiredRange);
    if(!rampart) {
        return false;
    }
    if(creep.pos.x === rampart.pos.x && creep.pos.y === rampart.pos.y) {
        return true;
    }
    if(creep.memory._sushiMoveTick !== Game.time) {
        travel.move(creep, rampart, {
            range: 0,
            reusePath: 5,
            visualizePathStyle: { stroke: '#66ccff' }
        });
    }
    return true;
};

WarRoom.shouldRetreat = function(creep) {
    if(!creep || creep.hitsMax <= 0) {
        return false;
    }
    var ratio = creep.hits / creep.hitsMax;
    var activeHeal = typeof creep.getActiveBodyparts === 'function' ?
        creep.getActiveBodyparts(HEAL) : 0;
    return ratio < 0.25 || (ratio < 0.40 && activeHeal <= 0);
};

WarRoom.retreatDefender = function(creep) {
    if(!creep || !creep.room || creep.memory._sushiMoveTick === Game.time) {
        return false;
    }
    var structures = tickCache.getMyStructures(creep.room);
    var best = null;
    var bestScore = 9999;
    for(var i = 0; i < structures.length; i++) {
        var structure = structures[i];
        if(
            structure.structureType !== STRUCTURE_RAMPART &&
            structure.structureType !== STRUCTURE_TOWER &&
            structure.structureType !== STRUCTURE_SPAWN
        ) {
            continue;
        }
        var score = combatThreat.getRange(creep.pos, structure.pos);
        if(structure.structureType === STRUCTURE_RAMPART) {
            score -= 3;
        }
        if(!best || score < bestScore) {
            best = structure;
            bestScore = score;
        }
    }
    if(!best) {
        return false;
    }
    creep.memory.defenseRetreat = true;
    travel.move(creep, best, {
        range: best.structureType === STRUCTURE_RAMPART ? 0 : 1,
        reusePath: 5,
        visualizePathStyle: { stroke: '#ffffff' }
    });
    return true;
};

WarRoom.clearRetreat = function(creep) {
    if(creep && creep.memory) {
        delete creep.memory.defenseRetreat;
    }
};

WarRoom.shouldUseRangedMassAttack = function(creep) {
    if(!creep || !creep.room) {
        return false;
    }
    var hostiles = WarRoom.findHostileCreeps(creep);
    var massDamage = 0;
    for(var i = 0; i < hostiles.length; i++) {
        var range = creep.pos.getRangeTo(hostiles[i]);
        massDamage += range <= 1 ? 10 : range === 2 ? 4 : range === 3 ? 1 : 0;
    }
    return massDamage > 10;
};

WarRoom.kiteFromTarget = function(creep, target) {
    if(!creep || !target || creep.memory._sushiMoveTick === Game.time) {
        return false;
    }
    var targetPos = target.pos || target;
    var dx = creep.pos.x === targetPos.x ? 0 : creep.pos.x > targetPos.x ? 1 : -1;
    var dy = creep.pos.y === targetPos.y ? 0 : creep.pos.y > targetPos.y ? 1 : -1;
    var x = Math.max(1, Math.min(48, creep.pos.x + dx * 3));
    var y = Math.max(1, Math.min(48, creep.pos.y + dy * 3));
    var retreatPosition = new RoomPosition(x, y, creep.room.name);
    travel.move(creep, retreatPosition, {
        range: 0,
        reusePath: 2,
        visualizePathStyle: { stroke: '#ffcc66' }
    });
    return true;
};

WarRoom.getRampartClaims = function() {
    resetRampartClaims();
    return rampartClaims;
};

WarRoom.isOnClaimedRampart = function(creep) {
    if(
        !creep || !creep.memory ||
        creep.memory.defenseRampartUntil < Game.time ||
        !creep.memory.defenseRampartId
    ) {
        return false;
    }
    var rampart = Game.getObjectById(creep.memory.defenseRampartId);
    return !!(
        rampart && rampart.pos &&
        rampart.pos.x === creep.pos.x && rampart.pos.y === creep.pos.y &&
        rampart.pos.roomName === creep.pos.roomName
    );
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
