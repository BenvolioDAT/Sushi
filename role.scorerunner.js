var travel = require('utility.Travel.Creep');

var SCORE_SCAN_MEMORY_KEY = 'scoreSeason';
var RUNNER_INTENT_TTL = 75;
var HOSTILE_ROOM_TTL = 2000;
var TARGET_MIN_TTL = 50;
var TARGET_MAX_TTL = 150;

var lastMaintenanceTick = -1;

cleanHeavyScoreSeasonMemory();

/*
 * Low-memory Season 10 ScoreRunner.
 *
 * Until Sushi has Observer support, a runner only knows about Scores in the
 * room it can currently see. It does not remember remote Score objects and it
 * does not build a large exploration plan.
 */
function run(creep) {
    if(!creep || creep.spawning || !creep.room) {
        return;
    }

    ensureScoreMemory();
    maintainScoreSeasonMemory();
    clearOldCreepScoreMemory(creep);

    var hostileReason = getHostileRoomReason(creep.room);

    if(hostileReason) {
        markHostileRoom(creep.room.name, hostileReason);
        clearCreepScoreTarget(creep);
        moveOutOfHostileRoom(creep);
        return;
    }

    if(isHostileRoomBlacklisted(creep.room.name)) {
        clearCreepScoreTarget(creep);
        moveOutOfHostileRoom(creep);
        return;
    }

    var target = getBestScoreTarget(creep);

    if(target) {
        moveToScore(creep, target);
        return;
    }

    idleScoreRunner(creep, true);
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanHeavyScoreSeasonMemory() {
    if(typeof Memory === 'undefined') {
        return;
    }

    if(!isPlainObject(Memory[SCORE_SCAN_MEMORY_KEY])) {
        return;
    }

    var scoreMemory = Memory[SCORE_SCAN_MEMORY_KEY];

    delete scoreMemory.knownScores;
    delete scoreMemory.rooms;
    delete scoreMemory.exploreRooms;
    delete scoreMemory.lastVisibleScanTick;
    delete scoreMemory.lastMaintenanceTick;

    for(var key in scoreMemory) {
        if(!scoreMemory.hasOwnProperty(key)) {
            continue;
        }

        if(key !== 'hostileRooms' && key !== 'runnerIntents' && key !== 'observer') {
            delete scoreMemory[key];
        }
    }
}

function ensureScoreMemory() {
    if(!isPlainObject(Memory[SCORE_SCAN_MEMORY_KEY])) {
        Memory[SCORE_SCAN_MEMORY_KEY] = {};
    }

    cleanHeavyScoreSeasonMemory();

    var scoreMemory = Memory[SCORE_SCAN_MEMORY_KEY];

    if(!isPlainObject(scoreMemory.hostileRooms)) {
        scoreMemory.hostileRooms = {};
    }

    if(!isPlainObject(scoreMemory.runnerIntents)) {
        scoreMemory.runnerIntents = {};
    }

    if(!isPlainObject(scoreMemory.observer)) {
        scoreMemory.observer = {};
    }

    /*
     * Future Observer mode can write short-lived records to:
     * Memory.scoreSeason.observer.liveScores
     *
     * This role intentionally does not create or consume that data yet.
     */

    return scoreMemory;
}

function maintainScoreSeasonMemory() {
    if(lastMaintenanceTick === Game.time) {
        return;
    }

    ensureScoreMemory();
    cleanRunnerIntents();
    cleanExpiredHostileRooms();
    cleanObserverLiveScores();

    lastMaintenanceTick = Game.time;
}

function cleanRunnerIntents() {
    var scoreMemory = ensureScoreMemory();
    var intents = scoreMemory.runnerIntents;

    for(var creepName in intents) {
        if(!intents.hasOwnProperty(creepName)) {
            continue;
        }

        var intent = intents[creepName];

        if(!intent || !Game.creeps[creepName] || !intent.until || intent.until <= Game.time) {
            delete intents[creepName];
        }
    }
}

function cleanExpiredHostileRooms() {
    var scoreMemory = ensureScoreMemory();
    var hostileRooms = scoreMemory.hostileRooms;

    for(var roomName in hostileRooms) {
        if(!hostileRooms.hasOwnProperty(roomName)) {
            continue;
        }

        var record = hostileRooms[roomName];

        if(!record || !record.until || record.until <= Game.time) {
            delete hostileRooms[roomName];
        }
    }
}

function cleanObserverLiveScores() {
    var scoreMemory = ensureScoreMemory();
    var observer = scoreMemory.observer;

    if(!isPlainObject(observer.liveScores)) {
        return;
    }

    for(var scoreId in observer.liveScores) {
        if(!observer.liveScores.hasOwnProperty(scoreId)) {
            continue;
        }

        var record = observer.liveScores[scoreId];
        var until = record && (record.until || record.expires || record.expire);

        if(!record || !until || until <= Game.time) {
            delete observer.liveScores[scoreId];
        }
    }
}

function clearOldCreepScoreMemory(creep) {
    if(!creep || !creep.memory) {
        return;
    }

    delete creep.memory.scoreExploreRoom;
    delete creep.memory.scoreExploreUntil;
    delete creep.memory.scoreExploreSource;
    delete creep.memory.scoreExploreHome;
}

function tryRoomFind(room, findConstant, options) {
    if(!room || typeof room.find !== 'function' || findConstant === undefined) {
        return [];
    }

    try {
        return room.find(findConstant, options);
    } catch(error) {
        return [];
    }
}

function getHostileRoomReason(room) {
    if(!room) {
        return null;
    }

    if(
        room.controller &&
        room.controller.owner &&
        !room.controller.my
    ) {
        return 'enemyController';
    }

    if(hasEnemyCreeps(room)) {
        return 'enemyCreeps';
    }

    if(roomHasInvaderCore(room)) {
        return 'invaderCore';
    }

    return null;
}

function hasEnemyCreeps(room) {
    if(typeof FIND_HOSTILE_CREEPS === 'undefined') {
        return false;
    }

    return tryRoomFind(room, FIND_HOSTILE_CREEPS).length > 0;
}

function roomHasInvaderCore(room) {
    if(
        !room ||
        typeof FIND_HOSTILE_STRUCTURES === 'undefined' ||
        typeof STRUCTURE_INVADER_CORE === 'undefined'
    ) {
        return false;
    }

    var invaderCores = tryRoomFind(room, FIND_HOSTILE_STRUCTURES, {
        filter: function(structure) {
            return structure.structureType === STRUCTURE_INVADER_CORE;
        }
    });

    return invaderCores.length > 0;
}

function markHostileRoom(roomName, reason) {
    if(!roomName) {
        return;
    }

    var scoreMemory = ensureScoreMemory();

    scoreMemory.hostileRooms[roomName] = {
        reason: reason || 'hostile',
        until: Game.time + HOSTILE_ROOM_TTL
    };
}

function isHostileRoomBlacklisted(roomName) {
    if(!roomName) {
        return false;
    }

    var scoreMemory = ensureScoreMemory();
    var record = scoreMemory.hostileRooms[roomName];

    if(record && record.until > Game.time) {
        return true;
    }

    if(record) {
        delete scoreMemory.hostileRooms[roomName];
    }

    return false;
}

function isRoomUsableForScore(roomName) {
    if(!roomName || isHostileRoomBlacklisted(roomName)) {
        return false;
    }

    if(Game.map && typeof Game.map.getRoomStatus === 'function') {
        var status = Game.map.getRoomStatus(roomName);

        if(status && status.status && status.status !== 'normal') {
            return false;
        }
    }

    return true;
}

function isScoreLikeObject(target) {
    if(!target || !target.id || !target.pos) {
        return false;
    }

    return typeof target.pos.x === 'number' &&
        typeof target.pos.y === 'number' &&
        typeof target.pos.roomName === 'string';
}

function addUniqueScore(scores, seenIds, target) {
    if(!isScoreLikeObject(target)) {
        return;
    }

    if(seenIds[target.id]) {
        return;
    }

    seenIds[target.id] = true;
    scores.push(target);
}

function addScoreList(scores, seenIds, list) {
    if(!list || list.length === 0) {
        return;
    }

    for(var i = 0; i < list.length; i++) {
        addUniqueScore(scores, seenIds, list[i]);
    }
}

function getScoreFromLookEntry(lookEntry) {
    if(!lookEntry) {
        return null;
    }

    if(typeof LOOK_SCORE !== 'undefined' && lookEntry.type === LOOK_SCORE) {
        return lookEntry[LOOK_SCORE] || lookEntry.score || null;
    }

    if(lookEntry.score && isScoreLikeObject(lookEntry.score)) {
        return lookEntry.score;
    }

    return null;
}

function findScoresByLook(room) {
    var scores = [];

    if(
        !room ||
        typeof LOOK_SCORE === 'undefined' ||
        typeof room.lookAtArea !== 'function'
    ) {
        return scores;
    }

    var seenIds = {};
    var lookEntries;

    try {
        lookEntries = room.lookAtArea(0, 0, 49, 49, true);
    } catch(error) {
        return scores;
    }

    if(!lookEntries) {
        return scores;
    }

    for(var i = 0; i < lookEntries.length; i++) {
        addUniqueScore(scores, seenIds, getScoreFromLookEntry(lookEntries[i]));
    }

    return scores;
}

function findScoreObjects(room) {
    var scores = [];
    var seenIds = {};

    if(!room) {
        return scores;
    }

    if(typeof FIND_SCORES !== 'undefined') {
        addScoreList(scores, seenIds, tryRoomFind(room, FIND_SCORES));
    }

    if(typeof FIND_SCORE !== 'undefined') {
        addScoreList(scores, seenIds, tryRoomFind(room, FIND_SCORE));
    }

    if(scores.length === 0) {
        addScoreList(scores, seenIds, findScoresByLook(room));
    }

    return scores;
}

function rememberVisibleScores(room, scanner) {
    var hostileReason = room ? getHostileRoomReason(room) : null;

    if(room && hostileReason) {
        markHostileRoom(room.name, hostileReason);
    }

    return findScoreObjects(room);
}

function getScoreObjectValue(target) {
    if(target && typeof target.score === 'number') {
        return target.score;
    }

    return 0;
}

function getBestScoreTarget(creep) {
    if(!creep || !creep.room) {
        return null;
    }

    var scores = findScoreObjects(creep.room);
    var best = null;
    var bestRank = 999999;

    for(var i = 0; i < scores.length; i++) {
        var target = scores[i];

        if(!isScoreLikeObject(target) || target.pos.roomName !== creep.room.name) {
            continue;
        }

        var range = creep.pos.getRangeTo(target.pos);
        var value = getScoreObjectValue(target);
        var rank = range - Math.min(value, 100) / 100;

        if(rank < bestRank) {
            best = target;
            bestRank = rank;
        }
    }

    return best;
}

function clearCreepScoreTarget(creep) {
    if(!creep || !creep.memory) {
        return;
    }

    delete creep.memory.scoreTargetId;
    delete creep.memory.scoreTargetRoom;
    delete creep.memory.scoreTargetUntil;
}

function clearCreepScoreId(creep) {
    if(!creep || !creep.memory) {
        return;
    }

    delete creep.memory.scoreTargetId;
}

function rememberCreepScoreTarget(creep, target) {
    if(!creep || !creep.memory || !target || !target.id || !target.pos) {
        return;
    }

    creep.memory.scoreTargetId = target.id;
    creep.memory.scoreTargetRoom = target.pos.roomName;
    creep.memory.scoreTargetUntil = Game.time + RUNNER_INTENT_TTL;
}

function writeRunnerIntent(creep, purpose, targetRoom) {
    if(!creep || !creep.name) {
        return;
    }

    var scoreMemory = ensureScoreMemory();

    scoreMemory.runnerIntents[creep.name] = {
        purpose: purpose || 'room',
        roomName: targetRoom || (creep.room && creep.room.name) || null,
        until: Game.time + RUNNER_INTENT_TTL
    };
}

function countRoomIntents(roomName) {
    var count = 0;
    var scoreMemory = ensureScoreMemory();
    var intents = scoreMemory.runnerIntents;

    for(var creepName in intents) {
        if(!intents.hasOwnProperty(creepName)) {
            continue;
        }

        var intent = intents[creepName];

        if(intent && intent.until > Game.time && intent.roomName === roomName) {
            count++;
        }
    }

    return count;
}

function moveToScore(creep, target) {
    if(!creep || !target || !target.pos) {
        clearCreepScoreTarget(creep);
        return ERR_INVALID_TARGET;
    }

    if(target.pos.roomName !== creep.room.name || !isRoomUsableForScore(target.pos.roomName)) {
        clearCreepScoreTarget(creep);
        return ERR_INVALID_TARGET;
    }

    rememberCreepScoreTarget(creep, target);
    writeRunnerIntent(creep, 'score', target.pos.roomName);
    drawScoreVisual(creep, target);

    if(creep.pos.isEqualTo(target.pos)) {
        clearCreepScoreTarget(creep);
        return OK;
    }

    var result = travel.move(creep, target.pos, {
        range: 0,
        maxRooms: 1,
        reusePath: 10,
        visualizePathStyle: {
            stroke: '#55ddff'
        }
    });

    if(result === ERR_NO_PATH || result === ERR_INVALID_TARGET || result === ERR_INVALID_ARGS) {
        clearCreepScoreTarget(creep);
    }

    return result;
}

function getHomeRoomName(creep) {
    if(!creep || !creep.memory) {
        return creep && creep.room ? creep.room.name : null;
    }

    return creep.memory.homeRoom || creep.memory.spawnRoom || (creep.room && creep.room.name) || null;
}

function getStoredTargetRoom(creep) {
    if(!creep || !creep.memory) {
        return null;
    }

    var roomName = creep.memory.scoreTargetRoom;

    if(!roomName || !creep.memory.scoreTargetUntil || creep.memory.scoreTargetUntil <= Game.time) {
        clearCreepScoreTarget(creep);
        return null;
    }

    if(!isRoomUsableForScore(roomName)) {
        clearCreepScoreTarget(creep);
        return null;
    }

    if(roomName === creep.room.name) {
        clearCreepScoreTarget(creep);
        return null;
    }

    return roomName;
}

function rememberTargetRoom(creep, roomName) {
    if(!creep || !creep.memory || !roomName) {
        return;
    }

    clearCreepScoreId(creep);

    creep.memory.scoreTargetRoom = roomName;
    creep.memory.scoreTargetUntil = Game.time + getTargetRoomTtl(creep, roomName);

    writeRunnerIntent(creep, 'room', roomName);
}

function getTargetRoomTtl(creep, roomName) {
    var range = TARGET_MAX_TTL - TARGET_MIN_TTL + 1;
    var hash = hashString((creep ? creep.name : '') + roomName + Game.time);

    return TARGET_MIN_TTL + hash % range;
}

function hashString(value) {
    var text = String(value || '');
    var hash = 0;

    for(var i = 0; i < text.length; i++) {
        hash = (hash * 31 + text.charCodeAt(i)) % 100000;
    }

    return hash;
}

function addExitRooms(sourceRoom, rooms, seen) {
    if(!sourceRoom || !Game.map || typeof Game.map.describeExits !== 'function') {
        return;
    }

    var exits = Game.map.describeExits(sourceRoom);

    if(!exits) {
        return;
    }

    for(var direction in exits) {
        if(!exits.hasOwnProperty(direction)) {
            continue;
        }

        var roomName = exits[direction];

        if(!roomName || seen[roomName]) {
            continue;
        }

        seen[roomName] = true;
        rooms.push(roomName);
    }
}

function getExitRooms(sourceRoom) {
    var rooms = [];
    var seen = {};

    addExitRooms(sourceRoom, rooms, seen);

    return rooms;
}

function getNearbyRooms(creep) {
    var rooms = [];
    var seen = {};

    if(!creep || !creep.room) {
        return rooms;
    }

    addExitRooms(creep.room.name, rooms, seen);

    var homeRoom = getHomeRoomName(creep);

    if(homeRoom && homeRoom !== creep.room.name) {
        addExitRooms(homeRoom, rooms, seen);
    }

    return rooms;
}

function getRoomChoiceRank(creep, roomName) {
    return hashString(creep.name + ':' + roomName + ':' + Math.floor(Game.time / RUNNER_INTENT_TTL));
}

function chooseNearbyRoom(creep) {
    var rooms = getNearbyRooms(creep);
    var bestRoom = null;
    var bestRank = 999999;

    for(var i = 0; i < rooms.length; i++) {
        var roomName = rooms[i];

        if(roomName === creep.room.name || !isRoomUsableForScore(roomName)) {
            continue;
        }

        var intentCount = countRoomIntents(roomName);
        var rank = intentCount * 100000 + getRoomChoiceRank(creep, roomName);

        if(rank < bestRank) {
            bestRoom = roomName;
            bestRank = rank;
        }
    }

    if(bestRoom) {
        rememberTargetRoom(creep, bestRoom);
    }

    return bestRoom;
}

function moveToExploreRoom(creep, roomName) {
    if(!creep || !roomName) {
        return ERR_INVALID_ARGS;
    }

    if(roomName === creep.room.name) {
        clearCreepScoreTarget(creep);
        return OK;
    }

    writeRunnerIntent(creep, 'room', roomName);

    var result = travel.moveToRoom(creep, roomName, {
        range: 22,
        reusePath: 15,
        visualizePathStyle: {
            stroke: '#bbbbbb'
        }
    });

    if(result === ERR_NO_PATH || result === ERR_INVALID_TARGET || result === ERR_INVALID_ARGS) {
        clearCreepScoreTarget(creep);
    }

    return result;
}

function moveOutOfHostileRoom(creep) {
    if(!creep || !creep.room) {
        return ERR_INVALID_ARGS;
    }

    var rooms = getExitRooms(creep.room.name);

    for(var i = 0; i < rooms.length; i++) {
        if(isRoomUsableForScore(rooms[i])) {
            writeRunnerIntent(creep, 'flee', rooms[i]);
            return travel.moveToRoom(creep, rooms[i], {
                range: 22,
                reusePath: 5,
                visualizePathStyle: {
                    stroke: '#ff7777'
                }
            });
        }
    }

    var homeRoom = getHomeRoomName(creep);

    if(homeRoom && homeRoom !== creep.room.name && isRoomUsableForScore(homeRoom)) {
        writeRunnerIntent(creep, 'flee', homeRoom);
        return travel.moveToRoom(creep, homeRoom, {
            range: 22,
            reusePath: 5,
            visualizePathStyle: {
                stroke: '#ff7777'
            }
        });
    }

    writeRunnerIntent(creep, 'flee', creep.room.name);
    return ERR_NO_PATH;
}

function idleScoreRunner(creep, skipScoreSearch) {
    if(!creep || !creep.room) {
        return;
    }

    if(!skipScoreSearch) {
        var target = getBestScoreTarget(creep);

        if(target) {
            moveToScore(creep, target);
            return;
        }
    }

    clearCreepScoreId(creep);

    var targetRoom = getStoredTargetRoom(creep);

    if(!targetRoom) {
        targetRoom = chooseNearbyRoom(creep);
    }

    if(targetRoom) {
        moveToExploreRoom(creep, targetRoom);
        return;
    }

    writeRunnerIntent(creep, 'idle', creep.room.name);

    if(travel.moveOffExit && travel.moveOffExit(creep)) {
        return;
    }
}

function drawScoreVisual(creep, target) {
    if(!creep || !creep.room || !target || !target.pos || !creep.room.visual) {
        return;
    }

    creep.room.visual.circle(target.pos.x, target.pos.y, {
        radius: 0.45,
        fill: 'transparent',
        stroke: '#55ddff',
        strokeWidth: 0.12,
        opacity: 0.5
    });
}

function countObjectKeys(object) {
    var count = 0;

    if(!isPlainObject(object)) {
        return count;
    }

    for(var key in object) {
        if(object.hasOwnProperty(key)) {
            count++;
        }
    }

    return count;
}

function getRawMemorySize() {
    if(typeof RawMemory === 'undefined' || typeof RawMemory.get !== 'function') {
        return null;
    }

    try {
        return RawMemory.get().length;
    } catch(error) {
        return null;
    }
}

function getScoreMemoryStats() {
    /*
     * Console helper only; nothing calls this every tick. Example:
     * require('role.scorerunner').getScoreMemoryStats()
     */
    var scoreMemory = ensureScoreMemory();
    var stats = {
        hostileRooms: countObjectKeys(scoreMemory.hostileRooms),
        runnerIntents: countObjectKeys(scoreMemory.runnerIntents)
    };
    var rawMemorySize = getRawMemorySize();

    if(isPlainObject(scoreMemory.observer) && isPlainObject(scoreMemory.observer.liveScores)) {
        stats.observerLiveScores = countObjectKeys(scoreMemory.observer.liveScores);
    }

    if(rawMemorySize !== null) {
        stats.rawMemorySize = rawMemorySize;
    }

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
