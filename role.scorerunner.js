/*
 * Dedicated Season score collector.
 *
 * Score objects are collected by occupying their exact tile. This role never
 * calls pickup, harvest, withdraw, or transfer; its MOVE-only body and range-0
 * Traveler request are intentional.
 */

var travel = require('utility.Travel.Creep');
var scoreSeason = require('Season.Score');

var LOCAL_STUCK_TICKS = 6;
var REMOTE_STUCK_TICKS = 10;
var FRIENDLY_BLOCK_STUCK_TICKS = 12;
var FAILED_TARGET_TTL = 25;
var EXPLORE_ROOM_TTL = 150;

function clearTravelState(creep) {
    if (!creep || !creep.memory) {
        return;
    }
    if (typeof travel.clearTravelMemory === 'function') {
        travel.clearTravelMemory(creep);
    }
    delete creep.memory._trav;
    delete creep.memory._move;
    delete creep.memory._sushiRoute;
}

function clearTarget(creep, releaseClaim, removeTarget) {
    if (!creep || !creep.memory) {
        return;
    }

    var targetId = creep.memory.scoreTargetId;
    if (targetId && releaseClaim) {
        scoreSeason.releaseTarget(targetId, creep.name, removeTarget === true);
    }

    delete creep.memory.scoreTargetId;
    delete creep.memory.scoreTargetRoom;
    delete creep.memory.scoreTargetDecayTime;
}

function setDebug(creep, state, detail) {
    creep.memory.scoreDebug = {
        tick: Game.time,
        state: state,
        detail: detail || null,
        targetId: creep.memory.scoreTargetId || null,
        targetRoom: creep.memory.scoreTargetRoom || null
    };
}

function isOnExit(pos) {
    return pos && (pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49);
}

function isStandingOnScore(creep) {
    var scores = scoreSeason.getVisibleScores(creep.room, true);

    for (var i = 0; i < scores.length; i++) {
        var score = scores[i] && scores[i].pos ? scores[i] :
            scores[i] && scores[i].score && scores[i].score.pos ? scores[i].score : null;
        if (
            score && score.pos &&
            score.pos.x === creep.pos.x && score.pos.y === creep.pos.y
        ) {
            return true;
        }
    }
    return false;
}

function hasAdjacentFriendlyCreep(creep) {
    if (typeof FIND_MY_CREEPS === 'undefined') {
        return false;
    }
    var nearby = creep.pos.findInRange(FIND_MY_CREEPS, 1);
    return nearby && nearby.length > 1;
}

function updateStuckState(creep) {
    var memory = creep.memory;
    var samePosition = memory.scoreLastX === creep.pos.x &&
        memory.scoreLastY === creep.pos.y &&
        memory.scoreLastRoom === creep.pos.roomName;

    memory.scoreLastX = creep.pos.x;
    memory.scoreLastY = creep.pos.y;
    memory.scoreLastRoom = creep.pos.roomName;

    if (
        !samePosition ||
        creep.fatigue > 0 ||
        isOnExit(creep.pos) ||
        isStandingOnScore(creep)
    ) {
        memory.scoreStillTicks = 0;
        return;
    }

    memory.scoreStillTicks = (memory.scoreStillTicks || 0) + 1;
    var remote = memory.scoreTargetRoom &&
        memory.scoreTargetRoom !== creep.room.name;
    var limit = hasAdjacentFriendlyCreep(creep) ? FRIENDLY_BLOCK_STUCK_TICKS :
        remote ? REMOTE_STUCK_TICKS : LOCAL_STUCK_TICKS;

    if (memory.scoreStillTicks < limit) {
        return;
    }

    if (memory.scoreTargetId) {
        memory.scoreAvoidTargetId = memory.scoreTargetId;
        memory.scoreAvoidTargetUntil = Game.time + FAILED_TARGET_TTL;
    }
    clearTarget(creep, true, false);
    clearTravelState(creep);
    memory.scoreStillTicks = 0;
    setDebug(creep, 'stuckReset', remote ? 'remote travel' : 'local traffic');
}

function getRememberedTarget(creep) {
    var targetId = creep.memory.scoreTargetId;
    if (!targetId) {
        return null;
    }

    var target = scoreSeason.getTarget(targetId);
    if (
        !target ||
        target.decayTime <= Game.time ||
        scoreSeason.isRoomUnsafe(target.roomName)
    ) {
        clearTarget(creep, true, !target || target.decayTime <= Game.time);
        clearTravelState(creep);
        return null;
    }

    if (!scoreSeason.claimTarget(target.id, creep.name)) {
        clearTarget(creep, false, false);
        clearTravelState(creep);
        return null;
    }

    return target;
}

function chooseTarget(creep) {
    if (
        creep.memory.scoreAvoidTargetUntil &&
        creep.memory.scoreAvoidTargetUntil <= Game.time
    ) {
        delete creep.memory.scoreAvoidTargetId;
        delete creep.memory.scoreAvoidTargetUntil;
    }

    var ranked = scoreSeason.getBestTarget(creep, {
        excludedTargetId: creep.memory.scoreAvoidTargetId || null
    });

    if (!ranked || !ranked.target) {
        return null;
    }

    var target = ranked.target;
    if (!scoreSeason.claimTarget(target.id, creep.name)) {
        return null;
    }

    creep.memory.scoreTargetId = target.id;
    creep.memory.scoreTargetRoom = target.roomName;
    creep.memory.scoreTargetDecayTime = target.decayTime;
    delete creep.memory.scoreExploreRoom;
    delete creep.memory.scoreExploreUntil;
    return target;
}

function makeTargetPosition(target) {
    return new RoomPosition(target.x, target.y, target.roomName);
}

function moveToScore(creep, target) {
    if (!target) {
        return ERR_INVALID_TARGET;
    }

    if (
        creep.pos.roomName === target.roomName &&
        creep.pos.x === target.x &&
        creep.pos.y === target.y
    ) {
        setDebug(creep, 'onScore', target.id);
        return OK;
    }

    var maximumRoomRange = scoreSeason.ensureSettings().scoreRunnerMaximumRoomRange;
    var isCrossRoomTarget = target.roomName !== creep.room.name;
    var result = travel.move(creep, makeTargetPosition(target), {
        range: 0,
        maxRooms: Math.max(1, maximumRoomRange + 2),
        reusePath: 20,
        allowHostile: false,
        /* Traveler otherwise skips findRoute for destinations within two rooms. */
        useFindRoute: isCrossRoomTarget,
        disableSharedRouteCache: isCrossRoomTarget,
        routeCallback: function(roomName) {
            return scoreSeason.isRoomUnsafe(roomName) ? Infinity : 1;
        },
        visualizePathStyle: {
            stroke: '#ffd700'
        }
    });

    setDebug(creep, 'moveToScore', target.id);

    if (
        result === ERR_NO_PATH ||
        result === ERR_INVALID_TARGET ||
        result === ERR_INVALID_ARGS
    ) {
        creep.memory.scoreAvoidTargetId = target.id;
        creep.memory.scoreAvoidTargetUntil = Game.time + FAILED_TARGET_TTL;
        clearTarget(creep, true, false);
        clearTravelState(creep);
        setDebug(creep, 'scoreMoveFailed', result);
    }

    return result;
}

function getAdjacentRooms(roomName) {
    if (!Game.map || typeof Game.map.describeExits !== 'function') {
        return [];
    }
    var exits = Game.map.describeExits(roomName) || {};
    var rooms = [];
    for (var direction in exits) {
        if (exits.hasOwnProperty(direction)) {
            rooms.push(exits[direction]);
        }
    }
    rooms.sort();
    return rooms;
}

function hashName(name) {
    var hash = 0;
    for (var i = 0; i < name.length; i++) {
        hash = ((hash * 31) + name.charCodeAt(i)) & 2147483647;
    }
    return hash;
}

function chooseExploreRoom(creep) {
    if (
        creep.memory.scoreExploreRoom &&
        creep.memory.scoreExploreUntil > Game.time &&
        !scoreSeason.isRoomUnsafe(creep.memory.scoreExploreRoom)
    ) {
        return creep.memory.scoreExploreRoom;
    }

    var rooms = getAdjacentRooms(creep.room.name);
    if (rooms.length === 0) {
        return null;
    }

    var start = (hashName(creep.name) + Game.time) % rooms.length;
    for (var i = 0; i < rooms.length; i++) {
        var roomName = rooms[(start + i) % rooms.length];
        if (
            roomName !== creep.memory.scoreLastExploreRoom &&
            !scoreSeason.isRoomUnsafe(roomName)
        ) {
            creep.memory.scoreExploreRoom = roomName;
            creep.memory.scoreExploreUntil = Game.time + EXPLORE_ROOM_TTL;
            return roomName;
        }
    }

    return null;
}

function explore(creep) {
    var roomName = chooseExploreRoom(creep);
    if (!roomName) {
        setDebug(creep, 'idle', 'no safe adjacent room');
        return ERR_NO_PATH;
    }

    if (creep.room.name === roomName) {
        creep.memory.scoreLastExploreRoom = roomName;
        delete creep.memory.scoreExploreRoom;
        delete creep.memory.scoreExploreUntil;
        roomName = chooseExploreRoom(creep);
    }

    if (!roomName) {
        return ERR_NO_PATH;
    }

    setDebug(creep, 'explore', roomName);
    return travel.moveToRoom(creep, roomName, {
        range: 22,
        reusePath: 20,
        allowHostile: false,
        routeCallback: function(routeRoomName) {
            return scoreSeason.isRoomUnsafe(routeRoomName) ? Infinity : 1;
        },
        visualizePathStyle: {
            stroke: '#c8a800'
        }
    });
}

function fleeHostileRoom(creep) {
    var homeRoom = creep.memory.homeRoom;
    if (homeRoom && homeRoom !== creep.room.name && !scoreSeason.isRoomUnsafe(homeRoom)) {
        return travel.moveToRoom(creep, homeRoom, {
            range: 22,
            reusePath: 5,
            allowHostile: false
        });
    }

    var rooms = getAdjacentRooms(creep.room.name);
    for (var i = 0; i < rooms.length; i++) {
        if (!scoreSeason.isRoomUnsafe(rooms[i])) {
            return travel.moveToRoom(creep, rooms[i], {
                range: 22,
                reusePath: 5,
                allowHostile: false
            });
        }
    }
    return ERR_NO_PATH;
}

function run(creep) {
    if (!creep || creep.spawning || !creep.room) {
        return;
    }

    scoreSeason.maintain();
    scoreSeason.reportVisibleRoom(creep.room, creep.name, true);

    var threat = scoreSeason.getVisibleThreat(creep.room);
    if (threat) {
        scoreSeason.markHostileRoom(creep.room.name, threat.reason, threat.ttl);
        clearTarget(creep, true, false);
        clearTravelState(creep);
        setDebug(creep, 'hostileFlee', threat.reason);
        fleeHostileRoom(creep);
        return;
    }

    if (scoreSeason.isRoomUnsafe(creep.room.name, null)) {
        clearTarget(creep, true, false);
        clearTravelState(creep);
        setDebug(creep, 'hostileFlee', 'temporary room avoidance');
        fleeHostileRoom(creep);
        return;
    }

    updateStuckState(creep);

    var target = getRememberedTarget(creep) || chooseTarget(creep);
    if (target) {
        moveToScore(creep, target);
        return;
    }

    clearTarget(creep, false, false);
    explore(creep);
}

function findScoreObjects(room) {
    return scoreSeason.getVisibleScores(room, true);
}

function rememberVisibleScores(room, scannerName) {
    return scoreSeason.reportVisibleRoom(room, scannerName || 'console', true);
}

function getBestScoreTarget(creep) {
    var ranked = scoreSeason.getBestTarget(creep, {});
    return ranked ? ranked.target : null;
}

function idleScoreRunner(creep) {
    return explore(creep);
}

function getScoreMemoryStats() {
    var stats = scoreSeason.getStats();
    var runners = 0;
    for (var creepName in Game.creeps) {
        if (
            Game.creeps.hasOwnProperty(creepName) &&
            Game.creeps[creepName].memory &&
            Game.creeps[creepName].memory.role === 'ScoreRunner'
        ) {
            runners++;
        }
    }
    stats.runners = runners;
    return stats;
}

module.exports = {
    run: run,
    findScoreObjects: findScoreObjects,
    rememberVisibleScores: rememberVisibleScores,
    getBestScoreTarget: getBestScoreTarget,
    moveToScore: moveToScore,
    idleScoreRunner: idleScoreRunner,
    getScoreMemoryStats: getScoreMemoryStats
};
