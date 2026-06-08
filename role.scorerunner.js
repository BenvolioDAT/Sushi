var travel = require('utility.Travel.Creep');

var SCORE_MEMORY_TTL = 1000;
var SCORE_VISUALS_ENABLED = true;
var SCORE_SCAN_MEMORY_KEY = 'scoreSeason';

/*
 * ScoreRunner role.
 *
 * Season 10 Score objects are collected by stepping onto their tile. This role
 * does not use market or terminal logic; it only finds Score positions and
 * moves creeps onto them.
 */
function run(creep) {
    if(!creep || creep.spawning) {
        return;
    }

    ensureScoreMemory();

    /*
     * Scan visible rooms once per tick. Multiple ScoreRunners can share the
     * same Memory.scoreSeason.knownScores records instead of each creep doing
     * independent long-term tracking.
     */
    rememberAllVisibleScores();

    var target = getBestScoreTarget(creep);

    if(target) {
        moveToScore(creep, target);
        return;
    }

    idleScoreRunner(creep);
}

function ensureScoreMemory() {
    if(!Memory[SCORE_SCAN_MEMORY_KEY]) {
        Memory[SCORE_SCAN_MEMORY_KEY] = {};
    }

    if(!Memory[SCORE_SCAN_MEMORY_KEY].knownScores) {
        Memory[SCORE_SCAN_MEMORY_KEY].knownScores = {};
    }

    return Memory[SCORE_SCAN_MEMORY_KEY];
}

function cleanOldScoreMemory() {
    var scoreMemory = ensureScoreMemory();
    var knownScores = scoreMemory.knownScores;
    var oldestAllowedSeenTick = Game.time - SCORE_MEMORY_TTL;

    for(var scoreId in knownScores) {
        if(!knownScores.hasOwnProperty(scoreId)) {
            continue;
        }

        var record = knownScores[scoreId];

        if(!record || record.seen < oldestAllowedSeenTick) {
            delete knownScores[scoreId];
        }
    }
}

function rememberAllVisibleScores() {
    var scoreMemory = ensureScoreMemory();

    /*
     * This keeps the visible-room scan cheap when more than one ScoreRunner is
     * alive. The first ScoreRunner scans; the rest reuse the result.
     */
    if(scoreMemory.lastVisibleScanTick === Game.time) {
        return;
    }

    cleanOldScoreMemory();

    for(var roomName in Game.rooms) {
        if(!Game.rooms.hasOwnProperty(roomName)) {
            continue;
        }

        rememberVisibleScores(Game.rooms[roomName]);
    }

    scoreMemory.lastVisibleScanTick = Game.time;
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

function getScoreResourceTypeMap() {
    var scoreTypes = {
        score: true,
        Score: true,
        SCORE: true
    };

    if(typeof RESOURCE_SCORE !== 'undefined') {
        scoreTypes[RESOURCE_SCORE] = true;
    }

    return scoreTypes;
}

function isScoreResource(resource) {
    if(!resource || !resource.resourceType) {
        return false;
    }

    var scoreTypes = getScoreResourceTypeMap();

    return scoreTypes[resource.resourceType] === true;
}

function isScoreLikeObject(target) {
    if(!target || !target.id || !target.pos) {
        return false;
    }

    /*
     * Official Season 10 Score objects have a numeric .score field.
     */
    if(typeof target.score === 'number') {
        return true;
    }

    /*
     * This fallback supports older or private-server implementations that might
     * expose score as a dropped resource instead of a Score object.
     */
    if(isScoreResource(target)) {
        return true;
    }

    return false;
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

    /*
     * Season 10 documentation exposes FIND_SCORES. FIND_SCORE is checked too
     * because private servers sometimes use slightly different constant names.
     */
    if(typeof FIND_SCORES !== 'undefined') {
        addScoreList(scores, seenIds, tryRoomFind(room, FIND_SCORES));
    }

    if(typeof FIND_SCORE !== 'undefined') {
        addScoreList(scores, seenIds, tryRoomFind(room, FIND_SCORE));
    }

    /*
     * Resource-style fallback. It is skipped safely when the normal Screeps
     * resource constant is not available.
     */
    if(typeof FIND_DROPPED_RESOURCES !== 'undefined') {
        addScoreList(scores, seenIds, tryRoomFind(room, FIND_DROPPED_RESOURCES, {
            filter: function(resource) {
                return isScoreResource(resource);
            }
        }));
    }

    /*
     * LOOK_SCORE is a fallback when a room has the Score look constant but no
     * FIND_SCORES constant. It scans a visible room, so it only runs when needed.
     */
    if(scores.length === 0) {
        addScoreList(scores, seenIds, findScoresByLook(room));
    }

    return scores;
}

function rememberVisibleScores(room) {
    var scoreMemory = ensureScoreMemory();
    var knownScores = scoreMemory.knownScores;
    var scores = findScoreObjects(room);
    var seenInRoom = {};

    if(!room) {
        return scores;
    }

    for(var i = 0; i < scores.length; i++) {
        var target = scores[i];

        seenInRoom[target.id] = true;

        knownScores[target.id] = {
            id: target.id,
            roomName: room.name,
            x: target.pos.x,
            y: target.pos.y,
            score: target.score || target.amount || 0,
            seen: Game.time
        };
    }

    /*
     * If the room is visible and a remembered Score is no longer found there,
     * remove it immediately. That usually means it decayed or was collected.
     */
    for(var scoreId in knownScores) {
        if(!knownScores.hasOwnProperty(scoreId)) {
            continue;
        }

        var record = knownScores[scoreId];

        if(!record || record.roomName !== room.name) {
            continue;
        }

        if(!seenInRoom[scoreId]) {
            delete knownScores[scoreId];
        }
    }

    return scores;
}

function clearCreepScoreTarget(creep) {
    if(!creep || !creep.memory) {
        return;
    }

    delete creep.memory.scoreTargetId;
    delete creep.memory.scoreTargetRoom;
}

function rememberCreepScoreTarget(creep, target) {
    if(!creep || !creep.memory || !target || !target.id) {
        return;
    }

    creep.memory.scoreTargetId = target.id;
    creep.memory.scoreTargetRoom = target.pos ? target.pos.roomName : target.roomName;
}

function getRecordPosition(record) {
    if(!record || !record.roomName) {
        return null;
    }

    if(
        typeof record.x !== 'number' ||
        typeof record.y !== 'number'
    ) {
        return null;
    }

    return new RoomPosition(record.x, record.y, record.roomName);
}

function makeRememberedTarget(record) {
    var position = getRecordPosition(record);

    if(!position) {
        return null;
    }

    return {
        id: record.id,
        pos: position,
        roomName: record.roomName,
        score: record.score || 0,
        remembered: true
    };
}

function getCachedScoreTarget(creep) {
    if(!creep || !creep.memory || !creep.memory.scoreTargetId) {
        return null;
    }

    var scoreMemory = ensureScoreMemory();
    var targetId = creep.memory.scoreTargetId;
    var visibleTarget = Game.getObjectById(targetId);

    if(isScoreLikeObject(visibleTarget)) {
        return visibleTarget;
    }

    var record = scoreMemory.knownScores[targetId];

    if(!record) {
        clearCreepScoreTarget(creep);
        return null;
    }

    if(record.seen < Game.time - SCORE_MEMORY_TTL) {
        delete scoreMemory.knownScores[targetId];
        clearCreepScoreTarget(creep);
        return null;
    }

    /*
     * If the target room is visible and Game.getObjectById cannot find it, the
     * Score is gone. Clear both global and creep memory right away.
     */
    if(Game.rooms[record.roomName]) {
        rememberVisibleScores(Game.rooms[record.roomName]);
        visibleTarget = Game.getObjectById(targetId);

        if(isScoreLikeObject(visibleTarget)) {
            return visibleTarget;
        }

        delete scoreMemory.knownScores[targetId];
        clearCreepScoreTarget(creep);
        return null;
    }

    return makeRememberedTarget(record);
}

function chooseClosestReachableScore(creep, scores) {
    if(!creep || !creep.pos || !scores || scores.length === 0) {
        return null;
    }

    /*
     * findClosestByPath gives us a reachable same-room target without manually
     * running expensive PathFinder searches for every Score every tick.
     */
    var closest = creep.pos.findClosestByPath(scores, {
        ignoreCreeps: true
    });

    if(closest) {
        return closest;
    }

    return null;
}

function isRoomStatusAllowed(roomName) {
    if(!roomName || !Game.map || typeof Game.map.getRoomStatus !== 'function') {
        return true;
    }

    var roomStatus = Game.map.getRoomStatus(roomName);

    if(!roomStatus || !roomStatus.status) {
        return true;
    }

    return roomStatus.status !== 'closed';
}

function getRouteDistance(fromRoomName, toRoomName) {
    if(!fromRoomName || !toRoomName) {
        return 999999;
    }

    if(fromRoomName === toRoomName) {
        return 0;
    }

    if(!Game.map || typeof Game.map.findRoute !== 'function') {
        if(Game.map && typeof Game.map.getRoomLinearDistance === 'function') {
            return Game.map.getRoomLinearDistance(fromRoomName, toRoomName);
        }

        return 999999;
    }

    var route = Game.map.findRoute(fromRoomName, toRoomName);

    if(!route || typeof route.length !== 'number') {
        return 999999;
    }

    return route.length;
}

function getPositionTieBreakRange(creep, position) {
    if(!creep || !creep.pos || !position) {
        return 999999;
    }

    if(creep.pos.roomName === position.roomName) {
        return creep.pos.getRangeTo(position);
    }

    if(Game.map && typeof Game.map.getRoomLinearDistance === 'function') {
        return Game.map.getRoomLinearDistance(creep.pos.roomName, position.roomName) * 50;
    }

    return 999999;
}

function isBetterKnownScore(creep, candidate, best) {
    if(!best) {
        return true;
    }

    var candidateDistance = getRouteDistance(creep.room.name, candidate.pos.roomName);
    var bestDistance = getRouteDistance(creep.room.name, best.pos.roomName);

    if(candidateDistance < bestDistance) {
        return true;
    }

    if(candidateDistance > bestDistance) {
        return false;
    }

    if((candidate.score || 0) > (best.score || 0)) {
        return true;
    }

    if((candidate.score || 0) < (best.score || 0)) {
        return false;
    }

    return getPositionTieBreakRange(creep, candidate.pos) < getPositionTieBreakRange(creep, best.pos);
}

function getBestKnownScoreTarget(creep) {
    var scoreMemory = ensureScoreMemory();
    var knownScores = scoreMemory.knownScores;
    var best = null;

    cleanOldScoreMemory();

    for(var scoreId in knownScores) {
        if(!knownScores.hasOwnProperty(scoreId)) {
            continue;
        }

        var record = knownScores[scoreId];

        if(!record || !isRoomStatusAllowed(record.roomName)) {
            delete knownScores[scoreId];
            continue;
        }

        var visibleTarget = Game.getObjectById(scoreId);
        var candidate = null;

        if(isScoreLikeObject(visibleTarget)) {
            candidate = visibleTarget;
        } else if(Game.rooms[record.roomName]) {
            delete knownScores[scoreId];
            continue;
        } else {
            candidate = makeRememberedTarget(record);
        }

        if(!candidate || getRouteDistance(creep.room.name, candidate.pos.roomName) >= 999999) {
            continue;
        }

        if(isBetterKnownScore(creep, candidate, best)) {
            best = candidate;
        }
    }

    return best;
}

function getBestScoreTarget(creep) {
    if(!creep || !creep.room) {
        return null;
    }

    rememberAllVisibleScores();

    var cachedTarget = getCachedScoreTarget(creep);

    /*
     * A valid cached target in this room stays locked. This avoids new path
     * searches every tick while the creep is already chasing a nearby Score.
     */
    if(cachedTarget && cachedTarget.pos.roomName === creep.room.name) {
        return cachedTarget;
    }

    /*
     * Current-room Score always wins over remote remembered targets.
     */
    var currentRoomScores = findScoreObjects(creep.room);
    var currentRoomTarget = chooseClosestReachableScore(creep, currentRoomScores);

    if(currentRoomTarget) {
        rememberCreepScoreTarget(creep, currentRoomTarget);
        return currentRoomTarget;
    }

    if(cachedTarget) {
        return cachedTarget;
    }

    var knownTarget = getBestKnownScoreTarget(creep);

    if(knownTarget) {
        rememberCreepScoreTarget(creep, knownTarget);
        return knownTarget;
    }

    clearCreepScoreTarget(creep);
    return null;
}

function drawScoreVisual(creep, target) {
    if(!SCORE_VISUALS_ENABLED) {
        return;
    }

    var scoreMemory = ensureScoreMemory();

    if(scoreMemory.visuals === false) {
        return;
    }

    if(!creep || !creep.room || !target || !target.pos) {
        return;
    }

    if(creep.room.name === target.pos.roomName) {
        creep.room.visual.line(creep.pos, target.pos, {
            color: '#55ddff',
            lineStyle: 'dashed',
            opacity: 0.5
        });

        creep.room.visual.text('SCORE', target.pos.x, target.pos.y - 0.35, {
            color: '#55ddff',
            font: 0.45,
            stroke: '#000000',
            strokeWidth: 0.08
        });
    }
}

function removeKnownScore(targetId) {
    var scoreMemory = ensureScoreMemory();

    if(targetId && scoreMemory.knownScores[targetId]) {
        delete scoreMemory.knownScores[targetId];
    }
}

function moveToScore(creep, target) {
    if(!creep || !target || !target.pos) {
        clearCreepScoreTarget(creep);
        return ERR_INVALID_TARGET;
    }

    drawScoreVisual(creep, target);

    /*
     * If the creep is already on the tile, the game should collect the Score.
     * Clear the target so next tick can search for the next one.
     */
    if(creep.pos.isEqualTo(target.pos)) {
        removeKnownScore(target.id);
        clearCreepScoreTarget(creep);
        return OK;
    }

    var result = travel.move(creep, target.pos, {
        range: 0,
        reusePath: 20,
        visualizePathStyle: {
            stroke: '#55ddff'
        }
    });

    if(result === ERR_NO_PATH || result === ERR_INVALID_TARGET || result === ERR_INVALID_ARGS) {
        removeKnownScore(target.id);
        clearCreepScoreTarget(creep);
    }

    return result;
}

function getHomeRoomName(creep) {
    if(!creep || !creep.memory) {
        return null;
    }

    return creep.memory.homeRoom || creep.memory.spawnRoom || creep.room.name;
}

function getScoutRoomFromMemory(creep) {
    var homeRoom = getHomeRoomName(creep);

    if(
        !homeRoom ||
        !Memory.rooms ||
        !Memory.rooms[homeRoom] ||
        !Memory.rooms[homeRoom].scoutPlan ||
        !Memory.rooms[homeRoom].scoutPlan.rooms
    ) {
        return null;
    }

    var planRooms = Memory.rooms[homeRoom].scoutPlan.rooms;
    var bestRoom = null;

    for(var roomName in planRooms) {
        if(!planRooms.hasOwnProperty(roomName)) {
            continue;
        }

        var roomRecord = planRooms[roomName];

        if(!roomRecord || roomName === creep.room.name) {
            continue;
        }

        if(roomRecord.unreachableUntil && roomRecord.unreachableUntil > Game.time) {
            continue;
        }

        if(!isRoomStatusAllowed(roomName)) {
            continue;
        }

        if(
            !bestRoom ||
            roomRecord.lastScanTick === null ||
            roomRecord.lastScanTick === undefined ||
            (
                bestRoom.lastScanTick !== null &&
                bestRoom.lastScanTick !== undefined &&
                roomRecord.lastScanTick < bestRoom.lastScanTick
            )
        ) {
            bestRoom = roomRecord;
        }
    }

    return bestRoom ? bestRoom.roomName : null;
}

function ensureRoomMemory(roomName) {
    if(!roomName) {
        return null;
    }

    if(!Memory.rooms) {
        Memory.rooms = {};
    }

    if(!Memory.rooms[roomName]) {
        Memory.rooms[roomName] = {};
    }

    return Memory.rooms[roomName];
}

function isBadIdlePosition(room, position) {
    if(!room || !position) {
        return true;
    }

    if(position.x <= 0 || position.x >= 49 || position.y <= 0 || position.y >= 49) {
        return true;
    }

    var terrain = room.getTerrain();

    if(terrain && terrain.get(position.x, position.y) === TERRAIN_MASK_WALL) {
        return true;
    }

    if(typeof LOOK_STRUCTURES !== 'undefined') {
        var structures = position.lookFor(LOOK_STRUCTURES);

        for(var i = 0; i < structures.length; i++) {
            if(
                structures[i].structureType === STRUCTURE_ROAD ||
                structures[i].structureType === STRUCTURE_SPAWN ||
                structures[i].structureType === STRUCTURE_EXTENSION
            ) {
                return true;
            }
        }
    }

    if(typeof FIND_SOURCES !== 'undefined') {
        var nearbySources = position.findInRange(FIND_SOURCES, 1);

        if(nearbySources && nearbySources.length > 0) {
            return true;
        }
    }

    return false;
}

function findIdlePosition(room) {
    if(!room) {
        return null;
    }

    var roomMemory = ensureRoomMemory(room.name);

    if(roomMemory && roomMemory.scoreRunnerIdlePos) {
        var remembered = roomMemory.scoreRunnerIdlePos;
        var rememberedPosition = new RoomPosition(remembered.x, remembered.y, room.name);

        if(!isBadIdlePosition(room, rememberedPosition)) {
            return rememberedPosition;
        }
    }

    /*
     * Search a small square around room center. The selected tile avoids roads,
     * spawns, extensions, sources, walls, and exits.
     */
    for(var radius = 3; radius <= 8; radius++) {
        for(var x = 25 - radius; x <= 25 + radius; x++) {
            for(var y = 25 - radius; y <= 25 + radius; y++) {
                var position = new RoomPosition(x, y, room.name);

                if(isBadIdlePosition(room, position)) {
                    continue;
                }

                if(roomMemory) {
                    roomMemory.scoreRunnerIdlePos = {
                        x: x,
                        y: y
                    };
                }

                return position;
            }
        }
    }

    return new RoomPosition(25, 25, room.name);
}

function idleScoreRunner(creep) {
    if(!creep || !creep.room) {
        return;
    }

    var scoutRoom = getScoutRoomFromMemory(creep);

    if(scoutRoom && scoutRoom !== creep.room.name) {
        travel.moveToRoom(creep, scoutRoom, {
            range: 22,
            reusePath: 30,
            visualizePathStyle: {
                stroke: '#bbbbbb'
            }
        });
        return;
    }

    var idlePosition = findIdlePosition(creep.room);

    if(!idlePosition) {
        return;
    }

    if(
        isBadIdlePosition(creep.room, creep.pos) ||
        creep.pos.getRangeTo(idlePosition) > 3
    ) {
        travel.move(creep, idlePosition, {
            range: 0,
            reusePath: 30,
            visualizePathStyle: {
                stroke: '#bbbbbb'
            }
        });
    }
}

module.exports = {
    run: run,
    findScoreObjects: findScoreObjects,
    rememberVisibleScores: rememberVisibleScores,
    getBestScoreTarget: getBestScoreTarget,
    moveToScore: moveToScore,
    idleScoreRunner: idleScoreRunner
};
