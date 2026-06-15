var travel = require('utility.Travel.Creep');

var SCORE_MEMORY_TTL = 1000;
var SCORE_VISUALS_ENABLED = true;
var SCORE_SCAN_MEMORY_KEY = 'scoreSeason';
var RUNNER_INTENT_TTL = 50;
var HOSTILE_ROOM_TTL = 2000;
var EXPLORE_MIN_TTL = 50;
var EXPLORE_MAX_TTL = 150;
var FALLBACK_EXPLORE_MAX_RING = 5;
var SCORE_DEEP_CLEAN_INTERVAL = 50;
var FALLBACK_EXPLORE_REBUILD_TTL = 5000;
var FALLBACK_EXPLORE_UNREACHABLE_TICKS = 300;
var FALLBACK_EXPLORE_RECENT_CHECK_TTL = 500;
var SCORE_ROOM_MEMORY_TTL = 10000;
var FALLBACK_EXPLORE_PLAN_TTL = 10000;
var FALLBACK_EXPLORE_FAILURE_TTL = 2000;
var FALLBACK_EXPLORE_FINALIST_COUNT = 15;
var FALLBACK_CPU_BUCKET_MIN = 1000;
var FALLBACK_CPU_TICK_LIMIT_BUFFER = 5;
var ROUTE_IMPOSSIBLE = 999999;

var routeDistanceCacheTick = -1;
var routeDistanceCache = {};

/*
 * ScoreRunner role.
 *
 * Season 10 Score objects are collected by stepping onto their tile. This role
 * does not use market or terminal logic; it only finds Score positions and
 * moves creeps onto them.
 *
 * The role has three layers of memory:
 * - knownScores: score objects recently seen in visible rooms
 * - rooms: scan history and hostile-room cooldowns
 * - runnerIntents: what each living runner is currently trying to do
 *
 * The intent layer is what prevents a large swarm from all selecting the same
 * room or same Score when there are several useful choices.
 */
function run(creep) {
    if(!creep || creep.spawning) {
        return;
    }

    ensureScoreMemory();
    maintainScoreSeasonMemory();

    /*
     * Scan visible rooms once per tick. Multiple ScoreRunners can share the
     * same Memory.scoreSeason records instead of each creep doing independent
     * long-term tracking.
     */
    rememberAllVisibleScores(creep);

    if(isHostileRoomBlacklisted(creep.room.name)) {
        clearCreepScoreTarget(creep);
        clearCreepExploreTarget(creep);
        moveOutOfHostileRoom(creep);
        return;
    }

    var target = getBestScoreTarget(creep);

    if(target) {
        moveToScore(creep, target);
        return;
    }

    maybeLeaveCurrentRoomAfterScan(creep);
    idleScoreRunner(creep, true);
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function ensureScoreMemory() {
    if(!isPlainObject(Memory[SCORE_SCAN_MEMORY_KEY])) {
        Memory[SCORE_SCAN_MEMORY_KEY] = {};
    }

    var scoreMemory = Memory[SCORE_SCAN_MEMORY_KEY];

    if(!isPlainObject(scoreMemory.knownScores)) {
        scoreMemory.knownScores = {};
    }

    if(!isPlainObject(scoreMemory.rooms)) {
        scoreMemory.rooms = {};
    }

    if(!isPlainObject(scoreMemory.runnerIntents)) {
        scoreMemory.runnerIntents = {};
    }

    if(!isPlainObject(scoreMemory.hostileRooms)) {
        scoreMemory.hostileRooms = {};
    }

    if(!isPlainObject(scoreMemory.exploreRooms)) {
        scoreMemory.exploreRooms = {};
    }

    return scoreMemory;
}

function maintainScoreSeasonMemory() {
    /*
     * Several ScoreRunners call run() during the same tick. The
     * lastMaintenanceTick guard makes cleanup run once per tick globally, not
     * once per creep.
     */
    var scoreMemory = ensureScoreMemory();

    if(scoreMemory.lastMaintenanceTick === Game.time) {
        return;
    }

    cleanOldScoreMemory();
    cleanRunnerIntents();
    cleanExpiredHostileRooms();

    if(Game.time % SCORE_DEEP_CLEAN_INTERVAL === 0) {
        cleanOldScoreRoomMemory();
        cleanOldExploreRoomMemory();
    }

    scoreMemory.lastMaintenanceTick = Game.time;
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

function cleanRunnerIntents() {
    var scoreMemory = ensureScoreMemory();
    var runnerIntents = scoreMemory.runnerIntents;
    var oldestAllowedUpdate = Game.time - RUNNER_INTENT_TTL;

    for(var creepName in runnerIntents) {
        if(!runnerIntents.hasOwnProperty(creepName)) {
            continue;
        }

        var intent = runnerIntents[creepName];

        if(
            !intent ||
            !Game.creeps[creepName] ||
            !intent.updated ||
            intent.updated < oldestAllowedUpdate
        ) {
            delete runnerIntents[creepName];
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

        var hostileRecord = hostileRooms[roomName];

        if(!hostileRecord || hostileRecord.hostileUntil <= Game.time) {
            delete hostileRooms[roomName];

            if(
                scoreMemory.rooms[roomName] &&
                scoreMemory.rooms[roomName].hostileUntil <= Game.time
            ) {
                scoreMemory.rooms[roomName].hostileUntil = 0;
                scoreMemory.rooms[roomName].hostileReason = null;
            }
        }
    }
}

function getNewestScoreRoomTick(roomRecord) {
    if(!roomRecord) {
        return 0;
    }

    return Math.max(
        roomRecord.lastSeen || 0,
        roomRecord.lastChecked || 0,
        roomRecord.lastScoreSeen || 0
    );
}

function cleanOldScoreRoomMemory() {
    /*
     * Room intel grows as runners scout. Keep only recent rooms unless a room is
     * still on a hostile cooldown; hostile records are safety data and are
     * cleared by cleanExpiredHostileRooms() when their blacklist expires.
     */
    var scoreMemory = ensureScoreMemory();
    var oldestAllowedTick = Game.time - SCORE_ROOM_MEMORY_TTL;

    for(var roomName in scoreMemory.rooms) {
        if(!scoreMemory.rooms.hasOwnProperty(roomName)) {
            continue;
        }

        var roomRecord = scoreMemory.rooms[roomName];

        if(!roomRecord || !isPlainObject(roomRecord)) {
            delete scoreMemory.rooms[roomName];
            continue;
        }

        if(isHostileRoomBlacklisted(roomName)) {
            continue;
        }

        if(getNewestScoreRoomTick(roomRecord) < oldestAllowedTick) {
            delete scoreMemory.rooms[roomName];
        }
    }
}

function isExplorePlanInUse(homeRoom) {
    for(var creepName in Game.creeps) {
        if(!Game.creeps.hasOwnProperty(creepName)) {
            continue;
        }

        var creep = Game.creeps[creepName];

        if(
            creep &&
            creep.memory &&
            creep.memory.scoreExploreSource === 'fallback' &&
            creep.memory.scoreExploreHome === homeRoom &&
            creep.memory.scoreExploreUntil > Game.time
        ) {
            return true;
        }
    }

    return false;
}

function cleanExploreRoomRecord(record) {
    if(!record || !isPlainObject(record)) {
        return false;
    }

    /*
     * Failed route data is only a cooldown. Drop ancient failures so one bad map
     * result does not make the plan remember unreachable rooms forever.
     */
    if(record.unreachableUntil && record.unreachableUntil <= Game.time) {
        record.unreachableUntil = 0;
    }

    if(record.lastFailed && record.lastFailed < Game.time - FALLBACK_EXPLORE_FAILURE_TTL) {
        record.lastFailed = 0;
        record.failCount = 0;
    }

    return !!record.roomName;
}

function cleanOldExploreRoomMemory() {
    /*
     * Fallback plans are derived data. They can be rebuilt cheaply from the home
     * room name, so stale, invalid, or old-ring plans should not live forever.
     */
    var scoreMemory = ensureScoreMemory();

    for(var homeRoom in scoreMemory.exploreRooms) {
        if(!scoreMemory.exploreRooms.hasOwnProperty(homeRoom)) {
            continue;
        }

        var plan = scoreMemory.exploreRooms[homeRoom];

        if(!isPlainObject(plan) || !isPlainObject(plan.rooms) || plan.homeRoom !== homeRoom) {
            delete scoreMemory.exploreRooms[homeRoom];
            continue;
        }

        if(plan.maxRing !== FALLBACK_EXPLORE_MAX_RING) {
            delete scoreMemory.exploreRooms[homeRoom];
            continue;
        }

        for(var roomName in plan.rooms) {
            if(!plan.rooms.hasOwnProperty(roomName)) {
                continue;
            }

            if(!cleanExploreRoomRecord(plan.rooms[roomName])) {
                delete plan.rooms[roomName];
            }
        }

        if(
            plan.built &&
            plan.built < Game.time - FALLBACK_EXPLORE_PLAN_TTL &&
            !isExplorePlanInUse(homeRoom)
        ) {
            delete scoreMemory.exploreRooms[homeRoom];
        }
    }
}

function ensureScoreRoomMemory(roomName) {
    if(!roomName) {
        return null;
    }

    var scoreMemory = ensureScoreMemory();

    if(!isPlainObject(scoreMemory.rooms[roomName])) {
        scoreMemory.rooms[roomName] = {
            roomName: roomName,
            lastSeen: 0,
            lastChecked: 0,
            lastCheckedBy: null,
            lastScoreSeen: 0,
            scoreCountSeen: 0,
            hostileUntil: 0,
            hostileReason: null
        };
    }

    scoreMemory.rooms[roomName].roomName = roomName;

    if(!scoreMemory.rooms[roomName].lastSeen) {
        scoreMemory.rooms[roomName].lastSeen = 0;
    }

    if(!scoreMemory.rooms[roomName].lastChecked) {
        scoreMemory.rooms[roomName].lastChecked = 0;
    }

    if(!scoreMemory.rooms[roomName].lastCheckedBy) {
        scoreMemory.rooms[roomName].lastCheckedBy = null;
    }

    if(!scoreMemory.rooms[roomName].lastScoreSeen) {
        scoreMemory.rooms[roomName].lastScoreSeen = 0;
    }

    if(!scoreMemory.rooms[roomName].scoreCountSeen) {
        scoreMemory.rooms[roomName].scoreCountSeen = 0;
    }

    if(!scoreMemory.rooms[roomName].hostileUntil) {
        scoreMemory.rooms[roomName].hostileUntil = 0;
    }

    if(!scoreMemory.rooms[roomName].hostileReason) {
        scoreMemory.rooms[roomName].hostileReason = null;
    }

    return scoreMemory.rooms[roomName];
}

function getScannerName(scanner) {
    if(scanner && scanner.name) {
        return scanner.name;
    }

    return 'global';
}

function updateVisibleRoomMemory(room, scores, scanner) {
    if(!room) {
        return;
    }

    var scoreCount = scores ? scores.length : 0;
    var roomMemory = ensureScoreRoomMemory(room.name);

    if(!roomMemory) {
        return;
    }

    roomMemory.lastSeen = Game.time;
    roomMemory.lastChecked = Game.time;
    roomMemory.lastCheckedBy = getScannerName(scanner);
    roomMemory.scoreCountSeen = scoreCount;

    if(!roomMemory.lastScoreSeen) {
        roomMemory.lastScoreSeen = 0;
    }

    if(scoreCount > 0) {
        roomMemory.lastScoreSeen = Game.time;
    }

    updateHostileRoomMemory(room, roomMemory);
}

function updateHostileRoomMemory(room, roomMemory) {
    var reason = getHostileRoomReason(room);

    if(!reason) {
        return;
    }

    var scoreMemory = ensureScoreMemory();
    var hostileUntil = Game.time + HOSTILE_ROOM_TTL;

    scoreMemory.hostileRooms[room.name] = {
        roomName: room.name,
        hostileUntil: hostileUntil,
        reason: reason,
        seen: Game.time
    };

    roomMemory.hostileUntil = hostileUntil;
    roomMemory.hostileReason = reason;
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

    if(roomHasInvaderCore(room)) {
        return 'invaderCore';
    }

    return null;
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

function isHostileRoomBlacklisted(roomName) {
    if(!roomName) {
        return false;
    }

    var scoreMemory = ensureScoreMemory();
    var hostileRecord = scoreMemory.hostileRooms[roomName];

    if(hostileRecord && hostileRecord.hostileUntil > Game.time) {
        return true;
    }

    var roomRecord = scoreMemory.rooms[roomName];

    return !!(roomRecord && roomRecord.hostileUntil > Game.time);
}

function rememberAllVisibleScores(scanner) {
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

        rememberVisibleScores(Game.rooms[roomName], scanner);
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

function isScoreLikeObject(target) {
    if(!target || !target.id || !target.pos) {
        return false;
    }

    /*
     * ScoreRunners collect Season 10 Score objects by stepping onto their tile.
     * A valid remembered target must be a real map object with an id and a
     * concrete RoomPosition-like shape. Do not treat resource names, controller
     * score stats, store contents, or value-only memory records as targets.
     */
    return typeof target.pos.x === 'number' &&
        typeof target.pos.y === 'number' &&
        typeof target.pos.roomName === 'string';
}

function getScoreObjectValue(target) {
    if(!target) {
        return 0;
    }

    if(typeof target.score === 'number') {
        return target.score;
    }

    return 0;
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
     * LOOK_SCORE is a fallback when a room has the Score look constant but no
     * FIND_SCORES constant. It scans a visible room, so it only runs when needed.
     */
    if(scores.length === 0) {
        addScoreList(scores, seenIds, findScoresByLook(room));
    }

    return scores;
}

function rememberVisibleScores(room, scanner) {
    var scoreMemory = ensureScoreMemory();
    var knownScores = scoreMemory.knownScores;
    var scores = findScoreObjects(room);
    var seenInRoom = {};

    if(!room) {
        return scores;
    }

    updateVisibleRoomMemory(room, scores, scanner);

    for(var i = 0; i < scores.length; i++) {
        var target = scores[i];

        seenInRoom[target.id] = true;

        knownScores[target.id] = {
            id: target.id,
            roomName: room.name,
            x: target.pos.x,
            y: target.pos.y,
            score: getScoreObjectValue(target),
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

function clearCreepExploreTarget(creep) {
    if(!creep || !creep.memory) {
        return;
    }

    delete creep.memory.scoreExploreRoom;
    delete creep.memory.scoreExploreUntil;
    delete creep.memory.scoreExploreSource;
    delete creep.memory.scoreExploreHome;
}

function rememberCreepScoreTarget(creep, target) {
    if(!creep || !creep.memory || !target || !target.id) {
        return;
    }

    creep.memory.scoreTargetId = target.id;
    creep.memory.scoreTargetRoom = target.pos ? target.pos.roomName : target.roomName;
    clearCreepExploreTarget(creep);
}

function writeRunnerIntent(creep, purpose, targetRoom, targetId, position) {
    /*
     * Runner intents are short-lived coordination hints. They are stored in
     * Memory rather than local variables because every ScoreRunner runs
     * separately and needs to see what the earlier runners already chose.
     */
    if(!creep || !creep.name || !creep.room) {
        return;
    }

    var scoreMemory = ensureScoreMemory();
    var intentPosition = position || creep.pos;
    var safePurpose = purpose === 'score' || purpose === 'explore' || purpose === 'idle' ? purpose : 'idle';
    var safeTargetRoom = targetRoom || creep.room.name;

    scoreMemory.runnerIntents[creep.name] = {
        creepName: creep.name,
        targetRoom: safeTargetRoom,
        targetId: targetId || null,
        x: typeof intentPosition.x === 'number' ? intentPosition.x : 25,
        y: typeof intentPosition.y === 'number' ? intentPosition.y : 25,
        purpose: safePurpose,
        updated: Game.time
    };
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

    if(isScoreLikeObject(visibleTarget) && !isHostileRoomBlacklisted(visibleTarget.pos.roomName)) {
        return visibleTarget;
    }

    var record = scoreMemory.knownScores[targetId];

    if(!record) {
        clearCreepScoreTarget(creep);
        return null;
    }

    if(record.seen < Game.time - SCORE_MEMORY_TTL || isHostileRoomBlacklisted(record.roomName)) {
        clearCreepScoreTarget(creep);
        return null;
    }

    /*
     * If the target room is visible and Game.getObjectById cannot find it, the
     * Score is gone. Clear both global and creep memory right away.
     */
    if(Game.rooms[record.roomName]) {
        rememberVisibleScores(Game.rooms[record.roomName], creep);
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

function isLikelyScoreRunnerCreep(creep) {
    if(!creep || !creep.memory) {
        return false;
    }

    var roleFields = [
        creep.memory.role,
        creep.memory.roleName,
        creep.memory.job,
        creep.memory.task,
        creep.memory.type
    ];

    for(var i = 0; i < roleFields.length; i++) {
        var value = roleFields[i];

        if(typeof value !== 'string') {
            continue;
        }

        value = value.toLowerCase();

        if(value.indexOf('score') !== -1 && value.indexOf('runner') !== -1) {
            return true;
        }
    }

    return false;
}

function getLivingScoreRunnerCount(currentCreep) {
    var scoreMemory = ensureScoreMemory();
    var counted = {};
    var count = 0;

    for(var intentName in scoreMemory.runnerIntents) {
        if(!scoreMemory.runnerIntents.hasOwnProperty(intentName)) {
            continue;
        }

        if(Game.creeps[intentName] && !counted[intentName]) {
            counted[intentName] = true;
            count++;
        }
    }

    for(var creepName in Game.creeps) {
        if(!Game.creeps.hasOwnProperty(creepName)) {
            continue;
        }

        if(!counted[creepName] && isLikelyScoreRunnerCreep(Game.creeps[creepName])) {
            counted[creepName] = true;
            count++;
        }
    }

    if(currentCreep && currentCreep.name && !counted[currentCreep.name]) {
        count++;
    }

    return count;
}

function getRunnerIntentSummary(ignoreCreepName) {
    var scoreMemory = ensureScoreMemory();
    var summary = {
        targetCounts: {},
        roomCounts: {},
        recentRoomCounts: {},
        thisTickRoomCounts: {}
    };

    for(var creepName in scoreMemory.runnerIntents) {
        if(!scoreMemory.runnerIntents.hasOwnProperty(creepName)) {
            continue;
        }

        if(creepName === ignoreCreepName || !Game.creeps[creepName]) {
            continue;
        }

        var intent = scoreMemory.runnerIntents[creepName];

        if(!intent || !intent.targetRoom || intent.purpose === 'idle') {
            continue;
        }

        summary.roomCounts[intent.targetRoom] = (summary.roomCounts[intent.targetRoom] || 0) + 1;

        if(intent.updated && intent.updated >= Game.time - 10) {
            summary.recentRoomCounts[intent.targetRoom] = (summary.recentRoomCounts[intent.targetRoom] || 0) + 1;
        }

        if(intent.updated === Game.time) {
            summary.thisTickRoomCounts[intent.targetRoom] = (summary.thisTickRoomCounts[intent.targetRoom] || 0) + 1;
        }

        if(intent.targetId) {
            summary.targetCounts[intent.targetId] = (summary.targetCounts[intent.targetId] || 0) + 1;
        }
    }

    return summary;
}

function getAvailableKnownScoreCount() {
    var scoreMemory = ensureScoreMemory();
    var knownScores = scoreMemory.knownScores;
    var count = 0;

    for(var scoreId in knownScores) {
        if(!knownScores.hasOwnProperty(scoreId)) {
            continue;
        }

        var record = knownScores[scoreId];

        if(
            record &&
            record.seen >= Game.time - SCORE_MEMORY_TTL &&
            isRoomUsableForScore(record.roomName)
        ) {
            count++;
        }
    }

    return count;
}

function getRoomIntelAge(roomName) {
    var scoreMemory = ensureScoreMemory();
    var roomRecord = scoreMemory.rooms[roomName];

    if(!roomRecord || !roomRecord.lastChecked) {
        return 10000;
    }

    return Math.max(0, Game.time - roomRecord.lastChecked);
}

function getLinearRoomDistance(fromRoomName, toRoomName) {
    if(!fromRoomName || !toRoomName) {
        return ROUTE_IMPOSSIBLE;
    }

    if(fromRoomName === toRoomName) {
        return 0;
    }

    if(!Game.map || typeof Game.map.getRoomLinearDistance !== 'function') {
        return ROUTE_IMPOSSIBLE;
    }

    try {
        return Game.map.getRoomLinearDistance(fromRoomName, toRoomName);
    } catch(error) {
        return ROUTE_IMPOSSIBLE;
    }
}

function isRoomStatusAllowed(roomName) {
    if(!roomName || !Game.map || typeof Game.map.getRoomStatus !== 'function') {
        return true;
    }

    var roomStatus;

    try {
        roomStatus = Game.map.getRoomStatus(roomName);
    } catch(error) {
        return false;
    }

    if(!roomStatus || !roomStatus.status) {
        return true;
    }

    return roomStatus.status !== 'closed';
}

function isRoomUsableForScore(roomName) {
    return !!roomName && isRoomStatusAllowed(roomName) && !isHostileRoomBlacklisted(roomName);
}

function getAvoidanceRouteCallback(destinationRoomName, originRoomName) {
    return function(roomName) {
        if(!roomName) {
            return Infinity;
        }

        if(roomName === originRoomName || roomName === destinationRoomName) {
            return 1;
        }

        if(!isRoomStatusAllowed(roomName) || isHostileRoomBlacklisted(roomName)) {
            return Infinity;
        }

        return 1;
    };
}

function getRouteDistance(fromRoomName, toRoomName) {
    /*
     * Route distance can be requested many times during one tick while scoring
     * every known Score and explore room. Cache it per tick so repeated
     * fromRoom>toRoom checks do not repeatedly call Game.map.findRoute.
     */
    if(!fromRoomName || !toRoomName) {
        return ROUTE_IMPOSSIBLE;
    }

    if(fromRoomName === toRoomName) {
        return 0;
    }

    if(!isRoomUsableForScore(toRoomName)) {
        return ROUTE_IMPOSSIBLE;
    }

    if(routeDistanceCacheTick !== Game.time) {
        routeDistanceCacheTick = Game.time;
        routeDistanceCache = {};
    }

    var cacheKey = fromRoomName + '>' + toRoomName;

    if(routeDistanceCache[cacheKey] !== undefined) {
        return routeDistanceCache[cacheKey];
    }

    if(!Game.map || typeof Game.map.findRoute !== 'function') {
        routeDistanceCache[cacheKey] = getLinearRoomDistance(fromRoomName, toRoomName);
        return routeDistanceCache[cacheKey];
    }

    var route;

    try {
        route = Game.map.findRoute(fromRoomName, toRoomName, {
            routeCallback: getAvoidanceRouteCallback(toRoomName, fromRoomName)
        });
    } catch(error) {
        routeDistanceCache[cacheKey] = ROUTE_IMPOSSIBLE;
        return routeDistanceCache[cacheKey];
    }

    if(!route || typeof route.length !== 'number') {
        routeDistanceCache[cacheKey] = ROUTE_IMPOSSIBLE;
        return routeDistanceCache[cacheKey];
    }

    routeDistanceCache[cacheKey] = route.length;
    return routeDistanceCache[cacheKey];
}

function getPositionTieBreakRange(creep, position) {
    if(!creep || !creep.pos || !position) {
        return ROUTE_IMPOSSIBLE;
    }

    if(creep.pos.roomName === position.roomName) {
        return creep.pos.getRangeTo(position);
    }

    var linearDistance = getLinearRoomDistance(creep.pos.roomName, position.roomName);

    if(linearDistance < ROUTE_IMPOSSIBLE) {
        return linearDistance * 50;
    }

    return ROUTE_IMPOSSIBLE;
}

function getScoreTargetValue(creep, target, summary, runnerCount, availableScoreCount) {
    /*
     * This is a "lower score is better" cost function, not a game score value.
     *
     * It mixes route distance, local range, crowding penalties, stale-intel
     * bonuses, and actual Score object value. Each term is intentionally simple
     * so you can tune behavior by changing one weight at a time.
     */
    if(!creep || !target || !target.pos || !isRoomUsableForScore(target.pos.roomName)) {
        return ROUTE_IMPOSSIBLE;
    }

    var routeDistance = getRouteDistance(creep.room.name, target.pos.roomName);

    if(routeDistance >= ROUTE_IMPOSSIBLE) {
        return ROUTE_IMPOSSIBLE;
    }

    var rangePenalty = getPositionTieBreakRange(creep, target.pos);
    var distancePenalty = routeDistance * 100 + rangePenalty;
    var sameTargetCount = summary.targetCounts[target.id] || 0;
    var sameRoomCount = summary.roomCounts[target.pos.roomName] || 0;
    var recentRoomCount = summary.recentRoomCounts[target.pos.roomName] || 0;
    var enoughUniqueTargets = availableScoreCount >= runnerCount;
    var sameTargetPenalty = sameTargetCount * (enoughUniqueTargets ? 5000 : 800);
    var sameRoomIntentPenalty = sameRoomCount * 250;
    var recentRoomPenalty = recentRoomCount * 75;
    var staleRoomBonus = Math.min(150, getRoomIntelAge(target.pos.roomName) / 20);
    var scoreObjectValueBonus = Math.min(500, getScoreObjectValue(target) / 10);
    var currentRoomBonus = target.pos.roomName === creep.room.name ? 300 : 0;

    /*
     * Lower is better. The large same-target penalty spreads runners when
     * enough unique scores exist; when there are fewer scores than runners it
     * still nudges them toward less-crowded targets instead of hard blocking.
     */
    return distancePenalty +
        sameTargetPenalty +
        sameRoomIntentPenalty +
        recentRoomPenalty -
        staleRoomBonus -
        scoreObjectValueBonus -
        currentRoomBonus;
}

function chooseBestScoreFromList(creep, scores) {
    if(!creep || !creep.pos || !scores || scores.length === 0) {
        return null;
    }

    var summary = getRunnerIntentSummary(creep.name);
    var runnerCount = getLivingScoreRunnerCount(creep);
    var availableScoreCount = Math.max(getAvailableKnownScoreCount(), scores.length);
    var best = null;
    var bestScore = ROUTE_IMPOSSIBLE;

    for(var i = 0; i < scores.length; i++) {
        var candidate = scores[i];
        var candidateScore = getScoreTargetValue(
            creep,
            candidate,
            summary,
            runnerCount,
            availableScoreCount
        );

        if(candidateScore < bestScore) {
            best = candidate;
            bestScore = candidateScore;
        }
    }

    return best;
}

function getBestKnownScoreTarget(creep) {
    var scoreMemory = ensureScoreMemory();
    var knownScores = scoreMemory.knownScores;
    var candidates = [];

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

        if(isHostileRoomBlacklisted(record.roomName)) {
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

        if(!candidate || getRouteDistance(creep.room.name, candidate.pos.roomName) >= ROUTE_IMPOSSIBLE) {
            continue;
        }

        candidates.push(candidate);
    }

    return chooseBestScoreFromList(creep, candidates);
}

function getBestScoreTarget(creep) {
    if(!creep || !creep.room) {
        return null;
    }

    rememberAllVisibleScores(creep);

    if(isHostileRoomBlacklisted(creep.room.name)) {
        clearCreepScoreTarget(creep);
        return null;
    }

    /*
     * Current-room Score objects still get first shot, but the same scoring
     * function prevents every runner from picking the same tile when several
     * visible scores are available.
     */
    var currentRoomScores = findScoreObjects(creep.room);
    var currentRoomTarget = chooseBestScoreFromList(creep, currentRoomScores);

    if(currentRoomTarget) {
        rememberCreepScoreTarget(creep, currentRoomTarget);
        return currentRoomTarget;
    }

    /*
     * A cached target is used only if it survives the shared scoring pass. This
     * keeps old locks from causing a long conga line toward one remembered room.
     */
    getCachedScoreTarget(creep);

    var knownTarget = getBestKnownScoreTarget(creep);

    if(knownTarget) {
        rememberCreepScoreTarget(creep, knownTarget);
        return knownTarget;
    }

    clearCreepScoreTarget(creep);
    return null;
}

function drawIntentVisual(creep, text, color) {
    if(!SCORE_VISUALS_ENABLED) {
        return;
    }

    var scoreMemory = ensureScoreMemory();

    if(scoreMemory.visuals === false) {
        return;
    }

    if(!creep || !creep.room || !text) {
        return;
    }

    creep.room.visual.text(text, creep.pos.x, creep.pos.y - 0.75, {
        color: color || '#ffffff',
        font: 0.38,
        stroke: '#000000',
        strokeWidth: 0.08
    });
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

    drawIntentVisual(creep, 'score ' + target.pos.roomName, '#55ddff');

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

    if(!isRoomUsableForScore(target.pos.roomName)) {
        removeKnownScore(target.id);
        clearCreepScoreTarget(creep);
        writeRunnerIntent(creep, 'idle', creep.room.name, null, creep.pos);
        return ERR_INVALID_TARGET;
    }

    rememberCreepScoreTarget(creep, target);
    writeRunnerIntent(creep, 'score', target.pos.roomName, target.id, target.pos);
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
        routeCallback: getAvoidanceRouteCallback(target.pos.roomName, creep.room.name),
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

function parseRoomName(roomName) {
    if(typeof roomName !== 'string') {
        return null;
    }

    var match = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);

    if(!match) {
        return null;
    }

    var x = parseInt(match[2], 10);
    var y = parseInt(match[4], 10);

    /*
     * Screeps room coordinates cross through W0/E0 and N0/S0. Internally it is
     * easier to treat W0 as -1 and E0 as 0, then convert back when needed.
     */
    if(match[1] === 'W') {
        x = -x - 1;
    }

    if(match[3] === 'N') {
        y = -y - 1;
    }

    return {
        x: x,
        y: y
    };
}

function roomNameFromXY(x, y) {
    var horizontal;
    var vertical;

    if(x < 0) {
        horizontal = 'W' + ((-x) - 1);
    } else {
        horizontal = 'E' + x;
    }

    if(y < 0) {
        vertical = 'N' + ((-y) - 1);
    } else {
        vertical = 'S' + y;
    }

    return horizontal + vertical;
}

function addFallbackExploreCandidate(plan, roomName, ring, source) {
    if(!plan || !roomName || roomName === plan.homeRoom) {
        return;
    }

    if(!isPlainObject(plan.rooms[roomName])) {
        plan.rooms[roomName] = {
            roomName: roomName,
            homeRoom: plan.homeRoom,
            ring: ring,
            source: source || 'ring',
            created: Game.time,
            unreachableUntil: 0
        };
        return;
    }

    plan.rooms[roomName].roomName = roomName;
    plan.rooms[roomName].homeRoom = plan.homeRoom;

    if(
        typeof plan.rooms[roomName].ring !== 'number' ||
        ring < plan.rooms[roomName].ring
    ) {
        plan.rooms[roomName].ring = ring;
    }

    if(!plan.rooms[roomName].source || source === 'exit') {
        plan.rooms[roomName].source = source || 'ring';
    }

    if(!plan.rooms[roomName].unreachableUntil) {
        plan.rooms[roomName].unreachableUntil = 0;
    }
}

function describeRoomExits(roomName) {
    if(!Game.map || typeof Game.map.describeExits !== 'function') {
        return null;
    }

    try {
        return Game.map.describeExits(roomName);
    } catch(error) {
        return null;
    }
}

function buildFallbackExploreRooms(homeRoom) {
    /*
     * Fallback exploration exists even when no Scout plan is available. It uses
     * two sources of candidate rooms:
     * - coordinate rings around homeRoom, which always work from room names
     * - describeExits breadth-first rooms, which better reflect the actual map
     */
    var plan = {
        homeRoom: homeRoom,
        built: Game.time,
        maxRing: FALLBACK_EXPLORE_MAX_RING,
        rooms: {}
    };
    var homePosition = parseRoomName(homeRoom);

    if(homePosition) {
        for(var ring = 1; ring <= FALLBACK_EXPLORE_MAX_RING; ring++) {
            for(var dx = -ring; dx <= ring; dx++) {
                for(var dy = -ring; dy <= ring; dy++) {
                    if(Math.max(Math.abs(dx), Math.abs(dy)) !== ring) {
                        continue;
                    }

                    addFallbackExploreCandidate(
                        plan,
                        roomNameFromXY(homePosition.x + dx, homePosition.y + dy),
                        ring,
                        'ring'
                    );
                }
            }
        }
    }

    /*
     * Coordinate rings are a safe fallback, but describeExits knows the actual
     * room graph. When it is available, breadth-first exits give better nearby
     * candidates around portals, highway edges, and private-server quirks.
     */
    var queue = [{
        roomName: homeRoom,
        ring: 0
    }];
    var visited = {};
    var queueIndex = 0;

    visited[homeRoom] = true;

    while(queueIndex < queue.length) {
        var current = queue[queueIndex++];

        if(current.ring >= FALLBACK_EXPLORE_MAX_RING) {
            continue;
        }

        var exits = describeRoomExits(current.roomName);

        if(!exits) {
            continue;
        }

        for(var directionText in exits) {
            if(!exits.hasOwnProperty(directionText)) {
                continue;
            }

            var nextRoom = exits[directionText];

            if(!nextRoom || visited[nextRoom]) {
                continue;
            }

            visited[nextRoom] = true;
            addFallbackExploreCandidate(plan, nextRoom, current.ring + 1, 'exit');
            queue.push({
                roomName: nextRoom,
                ring: current.ring + 1
            });
        }
    }

    return plan;
}

function copyFallbackExploreState(oldPlan, newPlan) {
    if(!isPlainObject(oldPlan) || !isPlainObject(oldPlan.rooms) || !newPlan) {
        return;
    }

    for(var roomName in oldPlan.rooms) {
        if(!oldPlan.rooms.hasOwnProperty(roomName)) {
            continue;
        }

        var oldRecord = oldPlan.rooms[roomName];
        var newRecord = newPlan.rooms[roomName];

        if(!oldRecord || !newRecord) {
            continue;
        }

        newRecord.unreachableUntil = oldRecord.unreachableUntil || 0;
        newRecord.lastFailed = oldRecord.lastFailed || 0;
        newRecord.failCount = oldRecord.failCount || 0;
    }
}

function getFallbackExplorePlan(homeRoom) {
    if(!homeRoom) {
        return null;
    }

    var scoreMemory = ensureScoreMemory();
    var plan = scoreMemory.exploreRooms[homeRoom];
    var needsBuild = !isPlainObject(plan) ||
        !isPlainObject(plan.rooms) ||
        plan.maxRing !== FALLBACK_EXPLORE_MAX_RING ||
        !plan.built ||
        plan.built < Game.time - FALLBACK_EXPLORE_REBUILD_TTL;

    if(needsBuild) {
        var oldPlan = plan;
        plan = buildFallbackExploreRooms(homeRoom);
        copyFallbackExploreState(oldPlan, plan);
        scoreMemory.exploreRooms[homeRoom] = plan;
    }

    return plan;
}

function isFallbackCpuSafe() {
    /*
     * Known/visible Score collection is still allowed under CPU pressure. This
     * guard only skips fallback roaming because it can score many rooms and ask
     * Game.map.findRoute for finalists.
     */
    if(!Game.cpu) {
        return true;
    }

    if(typeof Game.cpu.bucket === 'number' && Game.cpu.bucket < FALLBACK_CPU_BUCKET_MIN) {
        return false;
    }

    if(
        typeof Game.cpu.getUsed === 'function' &&
        typeof Game.cpu.tickLimit === 'number' &&
        Game.cpu.getUsed() >= Game.cpu.tickLimit - FALLBACK_CPU_TICK_LIMIT_BUFFER
    ) {
        return false;
    }

    return true;
}

function getFallbackExploreUnreachableUntil(homeRoom, roomName) {
    if(!homeRoom || !roomName) {
        return 0;
    }

    var scoreMemory = ensureScoreMemory();
    var homePlan = scoreMemory.exploreRooms[homeRoom];

    if(!isPlainObject(homePlan) || !isPlainObject(homePlan.rooms)) {
        return 0;
    }

    var record = homePlan.rooms[roomName];

    if(!record || typeof record.unreachableUntil !== 'number') {
        return 0;
    }

    return record.unreachableUntil;
}

function getExploreRoomUnreachableUntil(creep, roomName, roomRecord) {
    var homeRoom = getHomeRoomName(creep);

    return Math.max(
        getScoutPlanUnreachableUntil(roomRecord),
        getFallbackExploreUnreachableUntil(homeRoom, roomName)
    );
}

function rememberExploreTarget(creep, roomName, source) {
    /*
     * Explore targets are sticky for a random-ish number of ticks. That
     * stickiness prevents a runner from recalculating every tick and turning
     * around because another room became barely cheaper.
     */
    if(!creep || !creep.memory || !roomName) {
        return;
    }

    creep.memory.scoreExploreRoom = roomName;
    creep.memory.scoreExploreUntil = Game.time + getExploreStickTicks(creep, roomName);
    creep.memory.scoreExploreSource = source || 'fallback';
    creep.memory.scoreExploreHome = getHomeRoomName(creep);
}

function getScoutPlanRoomName(roomKey, roomRecord) {
    if(typeof roomRecord === 'string') {
        return roomRecord;
    }

    if(roomRecord && roomRecord.roomName) {
        return roomRecord.roomName;
    }

    return roomKey;
}

function getScoutPlanLastScan(roomRecord) {
    if(roomRecord && typeof roomRecord.lastScanTick === 'number') {
        return roomRecord.lastScanTick;
    }

    return null;
}

function getScoutPlanUnreachableUntil(roomRecord) {
    if(roomRecord && typeof roomRecord.unreachableUntil === 'number') {
        return roomRecord.unreachableUntil;
    }

    return 0;
}

function hashString(value) {
    var hash = 0;

    if(!value) {
        return hash;
    }

    for(var i = 0; i < value.length; i++) {
        hash = ((hash << 5) - hash) + value.charCodeAt(i);
        hash = hash & hash;
    }

    return Math.abs(hash);
}

function getExploreStickTicks(creep, roomName) {
    var spread = EXPLORE_MAX_TTL - EXPLORE_MIN_TTL;
    var seed = (creep ? creep.name : '') + ':' + roomName + ':' + Game.time;

    return EXPLORE_MIN_TTL + (hashString(seed) % (spread + 1));
}

function isExploreRoomStillValid(creep, roomName) {
    if(!creep || !roomName) {
        return false;
    }

    if(roomName === creep.room.name) {
        return false;
    }

    if(!isRoomUsableForScore(roomName)) {
        return false;
    }

    return getRouteDistance(creep.room.name, roomName) < ROUTE_IMPOSSIBLE;
}

function scoreExploreRoom(creep, roomName, roomRecord, summary) {
    if(!isExploreRoomStillValid(creep, roomName)) {
        return ROUTE_IMPOSSIBLE;
    }

    if(getExploreRoomUnreachableUntil(creep, roomName, roomRecord) > Game.time) {
        return ROUTE_IMPOSSIBLE;
    }

    var routeDistance = getRouteDistance(creep.room.name, roomName);
    var scoreMemory = ensureScoreMemory();
    var scoreRoomRecord = scoreMemory.rooms[roomName];
    var lastScoreChecked = scoreRoomRecord && scoreRoomRecord.lastChecked ? scoreRoomRecord.lastChecked : null;
    var lastScoutScan = getScoutPlanLastScan(roomRecord);
    var lastKnownCheck = lastScoreChecked;

    if(lastKnownCheck === null || lastKnownCheck === undefined) {
        lastKnownCheck = lastScoutScan;
    } else if(lastScoutScan !== null && lastScoutScan !== undefined) {
        lastKnownCheck = Math.max(lastKnownCheck, lastScoutScan);
    }

    var checkAge = lastKnownCheck === null || lastKnownCheck === undefined ? 10000 : Math.max(0, Game.time - lastKnownCheck);
    var assignedCount = summary.roomCounts[roomName] || 0;
    var recentAssignedCount = summary.recentRoomCounts[roomName] || 0;
    var thisTickAssignedCount = summary.thisTickRoomCounts[roomName] || 0;
    var tieBreak = hashString(creep.name + ':' + roomName) % 25;

    /*
     * Lower is better. Old checks are attractive; current assignments are
     * expensive so a wave of ScoreRunners fans out across the scout plan.
     */
    return routeDistance * 100 +
        assignedCount * 2000 +
        recentAssignedCount * 500 +
        thisTickAssignedCount * 5000 +
        tieBreak -
        Math.min(1200, checkAge / 5);
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
        if(creep.memory.scoreExploreSource === 'scoutPlan') {
            clearCreepExploreTarget(creep);
        }
        return null;
    }

    if(
        creep.memory.scoreExploreRoom &&
        creep.memory.scoreExploreSource === 'scoutPlan' &&
        creep.memory.scoreExploreUntil > Game.time &&
        isExploreRoomStillValid(creep, creep.memory.scoreExploreRoom)
    ) {
        return creep.memory.scoreExploreRoom;
    }

    if(creep.memory.scoreExploreRoom === creep.room.name) {
        clearCreepExploreTarget(creep);
    }

    var planRooms = Memory.rooms[homeRoom].scoutPlan.rooms;
    var summary = getRunnerIntentSummary(creep.name);
    var bestRoom = null;
    var bestScore = ROUTE_IMPOSSIBLE;

    for(var roomKey in planRooms) {
        if(!planRooms.hasOwnProperty(roomKey)) {
            continue;
        }

        var roomRecord = planRooms[roomKey];
        var roomName = getScoutPlanRoomName(roomKey, roomRecord);

        if(!roomName || roomName === creep.room.name) {
            continue;
        }

        var candidateScore = scoreExploreRoom(creep, roomName, roomRecord, summary);

        if(candidateScore < bestScore) {
            bestRoom = roomName;
            bestScore = candidateScore;
        }
    }

    if(bestRoom) {
        rememberExploreTarget(creep, bestRoom, 'scoutPlan');
        return bestRoom;
    }

    if(creep.memory.scoreExploreSource === 'scoutPlan') {
        clearCreepExploreTarget(creep);
    }
    return null;
}

function scoreFallbackExploreRoom(creep, roomName, roomRecord, summary) {
    if(!creep || !creep.room || !roomName || roomName === creep.room.name) {
        return ROUTE_IMPOSSIBLE;
    }

    if(!isRoomUsableForScore(roomName)) {
        return ROUTE_IMPOSSIBLE;
    }

    if(roomRecord && roomRecord.unreachableUntil > Game.time) {
        return ROUTE_IMPOSSIBLE;
    }

    var routeDistance = getRouteDistance(creep.room.name, roomName);

    if(routeDistance >= ROUTE_IMPOSSIBLE) {
        return ROUTE_IMPOSSIBLE;
    }

    var scoreMemory = ensureScoreMemory();
    var scoreRoomRecord = scoreMemory.rooms[roomName];
    var lastChecked = scoreRoomRecord && scoreRoomRecord.lastChecked ? scoreRoomRecord.lastChecked : 0;
    var checkAge = lastChecked ? Math.max(0, Game.time - lastChecked) : 10000;
    var recentlyCheckedPenalty = lastChecked ?
        Math.max(0, FALLBACK_EXPLORE_RECENT_CHECK_TTL - checkAge) * 6 :
        0;
    var assignedCount = summary.roomCounts[roomName] || 0;
    var recentAssignedCount = summary.recentRoomCounts[roomName] || 0;
    var thisTickAssignedCount = summary.thisTickRoomCounts[roomName] || 0;
    var ring = roomRecord && typeof roomRecord.ring === 'number' ? roomRecord.ring : FALLBACK_EXPLORE_MAX_RING;
    var tieBreak = hashString(creep.name + ':fallback:' + roomName) % 100;

    /*
     * Lower is better. Recent checks are possible, but stale rooms win. Intent
     * penalties are intentionally large so simultaneous runners choose
     * different rooms before distance or tie-breaks matter.
     */
    return routeDistance * 120 +
        ring * 15 +
        assignedCount * 4500 +
        recentAssignedCount * 1200 +
        thisTickAssignedCount * 12000 +
        recentlyCheckedPenalty +
        tieBreak -
        Math.min(3000, checkAge * 2);
}

function scoreFallbackExploreRoomCheap(creep, roomName, roomRecord, summary) {
    /*
     * Cheap pre-score: no findRoute here. This keeps a large fallback plan from
     * doing hundreds of route searches every tick. Only the best few cheap
     * candidates become finalists for scoreFallbackExploreRoom().
     */
    if(!creep || !creep.room || !roomName || roomName === creep.room.name) {
        return ROUTE_IMPOSSIBLE;
    }

    if(!isRoomUsableForScore(roomName)) {
        return ROUTE_IMPOSSIBLE;
    }

    if(roomRecord && roomRecord.unreachableUntil > Game.time) {
        return ROUTE_IMPOSSIBLE;
    }

    var linearDistance = getLinearRoomDistance(creep.room.name, roomName);

    if(linearDistance >= ROUTE_IMPOSSIBLE) {
        return ROUTE_IMPOSSIBLE;
    }

    var scoreMemory = ensureScoreMemory();
    var scoreRoomRecord = scoreMemory.rooms[roomName];
    var lastChecked = scoreRoomRecord && scoreRoomRecord.lastChecked ? scoreRoomRecord.lastChecked : 0;
    var checkAge = lastChecked ? Math.max(0, Game.time - lastChecked) : 10000;
    var assignedCount = summary.roomCounts[roomName] || 0;
    var recentAssignedCount = summary.recentRoomCounts[roomName] || 0;
    var thisTickAssignedCount = summary.thisTickRoomCounts[roomName] || 0;
    var ring = roomRecord && typeof roomRecord.ring === 'number' ? roomRecord.ring : FALLBACK_EXPLORE_MAX_RING;
    var tieBreak = hashString(creep.name + ':fallbackCheap:' + roomName) % 100;

    return linearDistance * 90 +
        ring * 25 +
        assignedCount * 4500 +
        recentAssignedCount * 1200 +
        thisTickAssignedCount * 12000 +
        tieBreak -
        Math.min(3000, checkAge * 2);
}

function addFallbackFinalist(finalists, candidate) {
    finalists.push(candidate);
    finalists.sort(function(left, right) {
        return left.score - right.score;
    });

    if(finalists.length > FALLBACK_EXPLORE_FINALIST_COUNT) {
        finalists.pop();
    }
}

function getFallbackExploreRoom(creep) {
    if(!creep || !creep.room) {
        return null;
    }

    if(!isFallbackCpuSafe()) {
        clearCreepExploreTarget(creep);
        return null;
    }

    var homeRoom = getHomeRoomName(creep);
    var plan = getFallbackExplorePlan(homeRoom);

    if(!plan || !isPlainObject(plan.rooms)) {
        clearCreepExploreTarget(creep);
        return null;
    }

    if(
        creep.memory.scoreExploreRoom &&
        creep.memory.scoreExploreSource === 'fallback' &&
        creep.memory.scoreExploreHome === homeRoom &&
        creep.memory.scoreExploreUntil > Game.time &&
        isExploreRoomStillValid(creep, creep.memory.scoreExploreRoom) &&
        getFallbackExploreUnreachableUntil(homeRoom, creep.memory.scoreExploreRoom) <= Game.time
    ) {
        return creep.memory.scoreExploreRoom;
    }

    if(creep.memory.scoreExploreRoom === creep.room.name) {
        clearCreepExploreTarget(creep);
    }

    var summary = getRunnerIntentSummary(creep.name);
    var finalists = [];

    for(var roomName in plan.rooms) {
        if(!plan.rooms.hasOwnProperty(roomName)) {
            continue;
        }

        var cheapScore = scoreFallbackExploreRoomCheap(creep, roomName, plan.rooms[roomName], summary);

        if(cheapScore < ROUTE_IMPOSSIBLE) {
            addFallbackFinalist(finalists, {
                roomName: roomName,
                score: cheapScore
            });
        }
    }

    var bestRoom = null;
    var bestScore = ROUTE_IMPOSSIBLE;

    for(var i = 0; i < finalists.length; i++) {
        var finalistRoom = finalists[i].roomName;
        var candidateScore = scoreFallbackExploreRoom(creep, finalistRoom, plan.rooms[finalistRoom], summary);

        if(candidateScore < bestScore) {
            bestRoom = finalistRoom;
            bestScore = candidateScore;
        }
    }

    if(bestRoom) {
        rememberExploreTarget(creep, bestRoom, 'fallback');
        return bestRoom;
    }

    clearCreepExploreTarget(creep);
    return null;
}

function markScoutPlanRoomUnreachable(homeRoom, roomName, unreachableUntil) {
    if(
        !homeRoom ||
        !roomName ||
        !Memory.rooms ||
        !Memory.rooms[homeRoom] ||
        !Memory.rooms[homeRoom].scoutPlan ||
        !Memory.rooms[homeRoom].scoutPlan.rooms
    ) {
        return;
    }

    var planRooms = Memory.rooms[homeRoom].scoutPlan.rooms;

    for(var roomKey in planRooms) {
        if(!planRooms.hasOwnProperty(roomKey)) {
            continue;
        }

        var roomRecord = planRooms[roomKey];
        var scoutRoomName = getScoutPlanRoomName(roomKey, roomRecord);

        if(scoutRoomName !== roomName) {
            continue;
        }

        /*
         * Some scout plans store plain strings. Convert only the failed room to
         * an object so future selection can skip it until the cooldown expires.
         */
        if(!isPlainObject(roomRecord)) {
            planRooms[roomKey] = {
                roomName: scoutRoomName
            };
            roomRecord = planRooms[roomKey];
        }

        roomRecord.unreachableUntil = unreachableUntil;
        return;
    }
}

function markExploreRoomUnreachable(creep, roomName, ticks) {
    /*
     * A failed route should pause the room, not delete it forever. The cooldown
     * gives pathing, room status, or hostile-memory conditions time to change.
     */
    if(!roomName) {
        return;
    }

    var unreachableUntil = Game.time + (ticks || FALLBACK_EXPLORE_UNREACHABLE_TICKS);
    var homeRoom = getHomeRoomName(creep);
    var plan = getFallbackExplorePlan(homeRoom);

    if(plan) {
        if(!isPlainObject(plan.rooms[roomName])) {
            addFallbackExploreCandidate(plan, roomName, FALLBACK_EXPLORE_MAX_RING, 'failed');
        }

        plan.rooms[roomName].unreachableUntil = unreachableUntil;
        plan.rooms[roomName].lastFailed = Game.time;
        plan.rooms[roomName].failCount = (plan.rooms[roomName].failCount || 0) + 1;
    }

    markScoutPlanRoomUnreachable(homeRoom, roomName, unreachableUntil);
    clearCreepExploreTarget(creep);
    clearTravelMemory(creep);
}

function clearTravelMemory(creep) {
    if(!creep || !creep.memory) {
        return;
    }

    if(travel && typeof travel.clearTravelMemory === 'function') {
        travel.clearTravelMemory(creep);
        return;
    }

    delete creep.memory._trav;
    delete creep.memory._move;
    delete creep.memory._sushiRoute;
    delete creep.memory._sushiMoveTick;
}

function isTerrainWall(roomName, x, y) {
    if(
        typeof TERRAIN_MASK_WALL === 'undefined' ||
        !Game.map ||
        typeof Game.map.getRoomTerrain !== 'function'
    ) {
        return false;
    }

    try {
        return Game.map.getRoomTerrain(roomName).get(x, y) === TERRAIN_MASK_WALL;
    } catch(error) {
        return false;
    }
}

function getExploreTargetPosition(creep, roomName) {
    var seed = hashString((creep ? creep.name : '') + ':' + roomName);
    var preferredX = 20 + (seed % 11);
    var preferredY = 20 + (Math.floor(seed / 11) % 11);

    /*
     * The target is inside the room, not exactly at 25,25. Different creeps get
     * different inner points, which reduces exit pileups after they cross rooms.
     */
    for(var radius = 0; radius <= 5; radius++) {
        for(var dx = -radius; dx <= radius; dx++) {
            for(var dy = -radius; dy <= radius; dy++) {
                if(Math.max(Math.abs(dx), Math.abs(dy)) !== radius) {
                    continue;
                }

                var x = preferredX + dx;
                var y = preferredY + dy;

                if(x < 2 || x > 47 || y < 2 || y > 47) {
                    continue;
                }

                if(!isTerrainWall(roomName, x, y)) {
                    return new RoomPosition(x, y, roomName);
                }
            }
        }
    }

    return new RoomPosition(preferredX, preferredY, roomName);
}

function getExploreTargetRange(creep, roomName) {
    return 1 + (hashString((creep ? creep.name : '') + ':range:' + roomName) % 3);
}

function maybeLeaveCurrentRoomAfterScan(creep) {
    if(
        !creep ||
        !creep.room ||
        !creep.memory ||
        creep.memory.scoreExploreRoom !== creep.room.name
    ) {
        return;
    }

    if(findScoreObjects(creep.room).length > 0) {
        return;
    }

    /*
     * Reaching an explore room and seeing no Score is still useful intel. Mark
     * the room checked, clear the old target, and let the next selection pick a
     * different room instead of parking here.
     */
    var roomMemory = ensureScoreRoomMemory(creep.room.name);

    if(roomMemory) {
        roomMemory.lastSeen = Game.time;
        roomMemory.lastChecked = Game.time;
        roomMemory.lastCheckedBy = creep.name;
        roomMemory.scoreCountSeen = 0;

        if(!roomMemory.lastScoreSeen) {
            roomMemory.lastScoreSeen = 0;
        }
    }

    clearCreepExploreTarget(creep);
}

function moveToExploreRoom(creep, roomName, label, color) {
    /*
     * Exploration targets an inner room position instead of the exit tile. If a
     * creep only moves to the exit with range 1, it may stop beside the border
     * and never actually enter the room.
     */
    if(!creep || !creep.room || !roomName || roomName === creep.room.name) {
        return ERR_INVALID_TARGET;
    }

    var targetPosition = getExploreTargetPosition(creep, roomName);

    writeRunnerIntent(creep, 'explore', roomName, null, targetPosition);
    drawIntentVisual(creep, label + ' ' + roomName, color);

    var result = travel.move(creep, targetPosition, {
        range: getExploreTargetRange(creep, roomName),
        reusePath: 25,
        routeCallback: getAvoidanceRouteCallback(roomName, creep.room.name),
        visualizePathStyle: {
            stroke: color
        }
    });

    if(
        result === ERR_NO_PATH ||
        result === ERR_NOT_FOUND ||
        result === ERR_INVALID_TARGET ||
        result === ERR_INVALID_ARGS
    ) {
        markExploreRoomUnreachable(creep, roomName, FALLBACK_EXPLORE_UNREACHABLE_TICKS);
    }

    return result;
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

function getSafeAdjacentExit(creep) {
    /*
     * When a runner enters a blacklisted hostile room, it tries to leave through
     * the nearest adjacent room that is still usable for ScoreRunner travel.
     */
    if(
        !creep ||
        !creep.room ||
        !Game.map ||
        typeof Game.map.describeExits !== 'function'
    ) {
        return null;
    }

    var exitsByDirection;

    try {
        exitsByDirection = Game.map.describeExits(creep.room.name);
    } catch(error) {
        return null;
    }

    if(!exitsByDirection) {
        return null;
    }

    var best = null;

    for(var directionText in exitsByDirection) {
        if(!exitsByDirection.hasOwnProperty(directionText)) {
            continue;
        }

        var adjacentRoom = exitsByDirection[directionText];

        if(!isRoomUsableForScore(adjacentRoom)) {
            continue;
        }

        var direction = parseInt(directionText, 10);
        var exitPosition = null;

        try {
            exitPosition = creep.pos.findClosestByRange(direction);
        } catch(error) {
            exitPosition = null;
        }

        if(!exitPosition) {
            continue;
        }

        var range = creep.pos.getRangeTo(exitPosition);

        if(!best || range < best.range) {
            best = {
                roomName: adjacentRoom,
                position: exitPosition,
                range: range
            };
        }
    }

    return best;
}

function moveOutOfHostileRoom(creep) {
    if(!creep || !creep.room) {
        return ERR_INVALID_ARGS;
    }

    var safeExit = getSafeAdjacentExit(creep);

    drawIntentVisual(creep, 'avoid hostile', '#ff7777');

    if(safeExit) {
        writeRunnerIntent(creep, 'idle', safeExit.roomName, null, safeExit.position);
        return travel.move(creep, safeExit.position, {
            range: 0,
            reusePath: 5,
            visualizePathStyle: {
                stroke: '#ff7777'
            }
        });
    }

    var homeRoom = getHomeRoomName(creep);

    if(homeRoom && homeRoom !== creep.room.name && isRoomUsableForScore(homeRoom)) {
        writeRunnerIntent(creep, 'idle', homeRoom, null, new RoomPosition(25, 25, homeRoom));
        return travel.moveToRoom(creep, homeRoom, {
            range: 22,
            reusePath: 10,
            routeCallback: getAvoidanceRouteCallback(homeRoom, creep.room.name),
            visualizePathStyle: {
                stroke: '#ff7777'
            }
        });
    }

    writeRunnerIntent(creep, 'idle', creep.room.name, null, creep.pos);
    return ERR_NO_PATH;
}

function idleScoreRunner(creep, skipScoreSearch) {
    /*
     * Idle is still productive:
     * 1. collect a newly visible Score if one exists
     * 2. explore a Scout-plan room
     * 3. explore fallback rooms
     * 4. park on a remembered safe idle tile
     */
    if(!creep || !creep.room) {
        return;
    }

    if(isHostileRoomBlacklisted(creep.room.name)) {
        moveOutOfHostileRoom(creep);
        return;
    }

    if(!skipScoreSearch) {
        var target = getBestScoreTarget(creep);

        if(target) {
            moveToScore(creep, target);
            return;
        }
    }

    maybeLeaveCurrentRoomAfterScan(creep);

    var scoutRoom = getScoutRoomFromMemory(creep);

    if(scoutRoom && scoutRoom !== creep.room.name) {
        moveToExploreRoom(creep, scoutRoom, 'scan', '#bbbbbb');
        return;
    }

    var fallbackRoom = getFallbackExploreRoom(creep);

    if(fallbackRoom && fallbackRoom !== creep.room.name) {
        moveToExploreRoom(creep, fallbackRoom, 'roam', '#ffcc66');
        return;
    }

    var idlePosition = findIdlePosition(creep.room);

    writeRunnerIntent(creep, 'idle', creep.room.name, null, idlePosition || creep.pos);
    drawIntentVisual(creep, 'idle ' + creep.room.name, '#aaaaaa');

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

function getScoreMemoryStats() {
    /*
     * Console helper only; nothing calls this every tick. Example:
     * require('role.scorerunner').getScoreMemoryStats()
     */
    var scoreMemory = ensureScoreMemory();
    var fallbackRoomsByHome = {};

    for(var homeRoom in scoreMemory.exploreRooms) {
        if(!scoreMemory.exploreRooms.hasOwnProperty(homeRoom)) {
            continue;
        }

        var plan = scoreMemory.exploreRooms[homeRoom];
        fallbackRoomsByHome[homeRoom] = plan && isPlainObject(plan.rooms) ?
            countObjectKeys(plan.rooms) :
            0;
    }

    return {
        knownScores: countObjectKeys(scoreMemory.knownScores),
        rooms: countObjectKeys(scoreMemory.rooms),
        runnerIntents: countObjectKeys(scoreMemory.runnerIntents),
        hostileRooms: countObjectKeys(scoreMemory.hostileRooms),
        exploreHomes: countObjectKeys(scoreMemory.exploreRooms),
        fallbackRoomsByHome: fallbackRoomsByHome
    };
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
