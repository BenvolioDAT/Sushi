/*
 * Season.Score.js
 *
 * Shared, lightweight Season score intelligence. Visible rooms are scanned at
 * most once per tick, and Memory stores only the fields needed to rank, claim,
 * travel to, and expire a target. Full Screeps objects never enter Memory.
 */

var cpuStatusUtility = require('CPU.Status');

var DEFAULT_MAXIMUM_ROOM_RANGE = 5;
var DEFAULT_DECAY_SAFETY_TICKS = 25;
var CLAIM_TICKS = 75;
var CLEANUP_INTERVAL = 17;
var HOSTILE_CREEP_TTL = 400;
var HOSTILE_ROOM_TTL = 2000;
var ROUTE_CANDIDATE_LIMIT = 3;
var ESTIMATED_TICKS_PER_ROOM = 50;
var scanCacheTick = -1;
var scanCache = {};
var routeCacheTick = -1;
var routeCache = {};
var maintenanceTick = -1;

function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function ensureSettings() {
    if (!Memory.settings) {
        Memory.settings = {};
    }

    if (Memory.settings.scoreSeasonEnabled === undefined) {
        Memory.settings.scoreSeasonEnabled = typeof FIND_SCORES !== 'undefined';
    }
    if (typeof Memory.settings.scoreRunnerMinimum !== 'number') {
        Memory.settings.scoreRunnerMinimum = 1;
    }
    if (typeof Memory.settings.scoreRunnerMaximumPerRoom !== 'number') {
        Memory.settings.scoreRunnerMaximumPerRoom = 5;
    }
    if (Memory.settings.scoreRunnerCpuScaling === undefined) {
        Memory.settings.scoreRunnerCpuScaling = true;
    }
    if (typeof Memory.settings.scoreRunnerMaximumRoomRange !== 'number') {
        Memory.settings.scoreRunnerMaximumRoomRange = DEFAULT_MAXIMUM_ROOM_RANGE;
    }
    if (typeof Memory.settings.scoreRunnerDecaySafetyTicks !== 'number') {
        Memory.settings.scoreRunnerDecaySafetyTicks = DEFAULT_DECAY_SAFETY_TICKS;
    }
    if (Memory.settings.scoreRunnerAllowSourceKeeperRooms === undefined) {
        Memory.settings.scoreRunnerAllowSourceKeeperRooms = false;
    }

    return Memory.settings;
}

function ensureMemory() {
    if (!isObject(Memory.scoreSeason)) {
        Memory.scoreSeason = {};
    }
    if (!isObject(Memory.scoreSeason.targets)) {
        Memory.scoreSeason.targets = {};
    }
    if (!isObject(Memory.scoreSeason.hostileRooms)) {
        Memory.scoreSeason.hostileRooms = {};
    }

    return Memory.scoreSeason;
}

function isRuntimeSupported() {
    return typeof FIND_SCORES !== 'undefined' || typeof LOOK_SCORE !== 'undefined';
}

function isEnabled() {
    var settings = ensureSettings();
    return settings.scoreSeasonEnabled !== false && isRuntimeSupported();
}

function safeFind(room, findType) {
    if (!room || typeof room.find !== 'function' || findType === undefined) {
        return [];
    }

    try {
        return room.find(findType) || [];
    }
    catch (error) {
        ensureMemory().lastError = {
            tick: Game.time,
            roomName: room.name,
            operation: 'room.find',
            message: error && error.message ? error.message : String(error)
        };
        return [];
    }
}

function getScoresUncached(room) {
    if (!room || !isEnabled()) {
        return [];
    }

    if (typeof FIND_SCORES !== 'undefined') {
        return safeFind(room, FIND_SCORES);
    }

    /*
     * LOOK_SCORE is only a compatibility fallback for runtimes without
     * FIND_SCORES. It is cached for the tick and skipped under critical CPU,
     * so a full-room look can never repeat for every runner.
     */
    if (
        typeof LOOK_SCORE !== 'undefined' &&
        typeof room.lookForAtArea === 'function' &&
        cpuStatusUtility.getCpuStatus().mode !== 'critical'
    ) {
        try {
            return room.lookForAtArea(LOOK_SCORE, 0, 0, 49, 49, true) || [];
        }
        catch (error) {
            ensureMemory().lastError = {
                tick: Game.time,
                roomName: room.name,
                operation: 'LOOK_SCORE fallback',
                message: error && error.message ? error.message : String(error)
            };
            return [];
        }
    }

    return [];
}

function getVisibleScores(room, forceEssentialScan) {
    if (scanCacheTick !== Game.time) {
        scanCacheTick = Game.time;
        scanCache = {};
    }

    if (scanCache.hasOwnProperty(room.name)) {
        return scanCache[room.name];
    }

    if (
        !forceEssentialScan &&
        cpuStatusUtility.getCpuStatus().mode === 'critical'
    ) {
        scanCache[room.name] = [];
        return scanCache[room.name];
    }

    scanCache[room.name] = getScoresUncached(room);
    return scanCache[room.name];
}

function unwrapScore(entry) {
    if (!entry) {
        return null;
    }
    if (entry.pos) {
        return entry;
    }
    if (entry.score && entry.score.pos) {
        return entry.score;
    }
    if (typeof LOOK_SCORE !== 'undefined' && entry[LOOK_SCORE]) {
        return entry[LOOK_SCORE];
    }
    return null;
}

function getScoreValue(score) {
    if (typeof score.score === 'number') {
        return score.score;
    }
    if (typeof score.value === 'number') {
        return score.value;
    }
    if (typeof score.points === 'number') {
        return score.points;
    }
    return 1;
}

function getDecayTime(score) {
    if (typeof score.decayTime === 'number') {
        return score.decayTime;
    }
    if (typeof score.ticksToDecay === 'number') {
        return Game.time + score.ticksToDecay;
    }
    return Game.time + 100;
}

function sameTargetRecord(oldRecord, newRecord) {
    return oldRecord &&
        oldRecord.roomName === newRecord.roomName &&
        oldRecord.x === newRecord.x &&
        oldRecord.y === newRecord.y &&
        oldRecord.score === newRecord.score &&
        oldRecord.decayTime === newRecord.decayTime;
}

function reportVisibleRoom(room, scannerName, forceEssentialScan) {
    maintain();

    if (!room || !isEnabled()) {
        return [];
    }

    /* A skipped optional scan must not turn "not observed" into "missing". */
    if (
        !forceEssentialScan &&
        cpuStatusUtility.getCpuStatus().mode === 'critical'
    ) {
        return [];
    }

    var scoreMemory = ensureMemory();
    var rawScores = getVisibleScores(room, forceEssentialScan === true);
    var visibleIds = {};
    var records = [];

    for (var i = 0; i < rawScores.length; i++) {
        var score = unwrapScore(rawScores[i]);

        if (!score || !score.id || !score.pos) {
            continue;
        }

        visibleIds[score.id] = true;
        var record = {
            id: score.id,
            roomName: score.pos.roomName || room.name,
            x: score.pos.x,
            y: score.pos.y,
            score: getScoreValue(score),
            decayTime: getDecayTime(score),
            seenAt: Game.time
        };
        var oldRecord = scoreMemory.targets[score.id];

        if (oldRecord && oldRecord.claimedBy && oldRecord.claimUntil > Game.time) {
            record.claimedBy = oldRecord.claimedBy;
            record.claimUntil = oldRecord.claimUntil;
        }

        /* Avoid rewriting stable fields solely because another role scanned. */
        if (sameTargetRecord(oldRecord, record)) {
            if (Game.time - oldRecord.seenAt >= 5) {
                oldRecord.seenAt = Game.time;
            }
            record = oldRecord;
        }
        else {
            scoreMemory.targets[score.id] = record;
        }
        records.push(record);
    }

    /* Visible truth is authoritative: a missing object was collected/expired. */
    for (var targetId in scoreMemory.targets) {
        if (!scoreMemory.targets.hasOwnProperty(targetId)) {
            continue;
        }
        var target = scoreMemory.targets[targetId];
        if (target && target.roomName === room.name && !visibleIds[targetId]) {
            delete scoreMemory.targets[targetId];
        }
    }

    scoreMemory.lastScan = {
        roomName: room.name,
        tick: Game.time,
        scanner: scannerName || 'unknown',
        count: records.length
    };

    return records;
}

function cleanClaimsAndTargets() {
    var targets = ensureMemory().targets;

    for (var targetId in targets) {
        if (!targets.hasOwnProperty(targetId)) {
            continue;
        }

        var target = targets[targetId];
        if (!target || !target.decayTime || target.decayTime <= Game.time) {
            delete targets[targetId];
            continue;
        }

        if (
            target.claimedBy &&
            (
                !target.claimUntil ||
                target.claimUntil <= Game.time ||
                !Game.creeps[target.claimedBy]
            )
        ) {
            delete target.claimedBy;
            delete target.claimUntil;
        }
    }
}

function cleanHostileRooms() {
    var hostileRooms = ensureMemory().hostileRooms;

    for (var roomName in hostileRooms) {
        if (
            hostileRooms.hasOwnProperty(roomName) &&
            (!hostileRooms[roomName] || hostileRooms[roomName].until <= Game.time)
        ) {
            delete hostileRooms[roomName];
        }
    }
}

function maintain() {
    if (maintenanceTick === Game.time) {
        return;
    }

    ensureSettings();
    ensureMemory();

    /* Claims are cheap and important enough to validate every tick. */
    cleanClaimsAndTargets();
    if (Game.time % CLEANUP_INTERVAL === 0) {
        cleanHostileRooms();
    }
    maintenanceTick = Game.time;
}

function markHostileRoom(roomName, reason, ttl) {
    if (!roomName) {
        return;
    }

    ensureMemory().hostileRooms[roomName] = {
        reason: reason || 'threat',
        until: Game.time + (ttl || HOSTILE_CREEP_TTL)
    };
}

function getVisibleThreat(room) {
    if (!room) {
        return null;
    }
    if (room.controller && room.controller.owner && !room.controller.my) {
        return { reason: 'enemyController', ttl: HOSTILE_ROOM_TTL };
    }

    if (typeof FIND_HOSTILE_CREEPS !== 'undefined') {
        var hostiles = safeFind(room, FIND_HOSTILE_CREEPS);
        for (var i = 0; i < hostiles.length; i++) {
            if (
                typeof hostiles[i].getActiveBodyparts === 'function' &&
                (
                    hostiles[i].getActiveBodyparts(ATTACK) > 0 ||
                    hostiles[i].getActiveBodyparts(RANGED_ATTACK) > 0 ||
                    hostiles[i].getActiveBodyparts(HEAL) > 0
                )
            ) {
                return { reason: 'armedHostileCreeps', ttl: HOSTILE_CREEP_TTL };
            }
        }
    }

    if (
        typeof STRUCTURE_INVADER_CORE !== 'undefined' &&
        typeof FIND_HOSTILE_STRUCTURES !== 'undefined'
    ) {
        var cores = safeFind(room, FIND_HOSTILE_STRUCTURES);
        for (var j = 0; j < cores.length; j++) {
            if (cores[j].structureType === STRUCTURE_INVADER_CORE) {
                return { reason: 'invaderCore', ttl: HOSTILE_ROOM_TTL };
            }
        }
    }

    return null;
}

function isSourceKeeperRoom(roomName) {
    var match = /^[WE](\d+)[NS](\d+)$/.exec(roomName || '');
    if (!match) {
        return false;
    }
    var x = parseInt(match[1], 10) % 10;
    var y = parseInt(match[2], 10) % 10;
    return x >= 4 && x <= 6 && y >= 4 && y <= 6 && !(x === 5 && y === 5);
}

function isRoomUnsafe(roomName) {
    maintain();
    var settings = ensureSettings();
    if (!settings.scoreRunnerAllowSourceKeeperRooms && isSourceKeeperRoom(roomName)) {
        return true;
    }

    var visibleRoom = Game.rooms[roomName];
    var threat = getVisibleThreat(visibleRoom);
    if (threat) {
        markHostileRoom(roomName, threat.reason, threat.ttl);
        return true;
    }
    if (visibleRoom) {
        /* Fresh safe vision clears an old temporary threat immediately. */
        delete ensureMemory().hostileRooms[roomName];
        return false;
    }

    var hostile = ensureMemory().hostileRooms[roomName];
    if (hostile && hostile.until > Game.time) {
        return true;
    }

    var roomMemory = Memory.rooms && Memory.rooms[roomName];
    if (roomMemory && roomMemory.scoutIntel) {
        var intel = roomMemory.scoutIntel;
        var myUsername = Memory.username || null;
        if (!myUsername) {
            for (var spawnName in Game.spawns) {
                if (
                    Game.spawns.hasOwnProperty(spawnName) &&
                    Game.spawns[spawnName].owner
                ) {
                    myUsername = Game.spawns[spawnName].owner.username;
                    break;
                }
            }
        }
        if (intel.controllerOwner && intel.controllerOwner !== myUsername) {
            return true;
        }
        if (
            (intel.invaderCore && intel.lastScanTick >= Game.time - HOSTILE_ROOM_TTL) ||
            (intel.hostileCreepCount > 0 && intel.lastScanTick >= Game.time - HOSTILE_CREEP_TTL)
        ) {
            return true;
        }
    }

    return false;
}

function getRoomDistance(fromRoom, toRoom) {
    if (fromRoom === toRoom) {
        return 0;
    }
    if (Game.map && typeof Game.map.getRoomLinearDistance === 'function') {
        return Game.map.getRoomLinearDistance(fromRoom, toRoom);
    }
    return 99;
}

function getEstimatedTravelTicks(creep, target, roomDistance) {
    if (roomDistance === 0 && creep.pos && typeof creep.pos.getRangeTo === 'function') {
        return creep.pos.getRangeTo(target.x, target.y);
    }
    return roomDistance * ESTIMATED_TICKS_PER_ROOM + 25;
}

function getRouteLength(fromRoom, toRoom) {
    if (fromRoom === toRoom) {
        return 0;
    }
    if (routeCacheTick !== Game.time) {
        routeCacheTick = Game.time;
        routeCache = {};
    }

    var key = fromRoom + '>' + toRoom;
    if (routeCache.hasOwnProperty(key)) {
        return routeCache[key];
    }

    if (!Game.map || typeof Game.map.findRoute !== 'function') {
        return getRoomDistance(fromRoom, toRoom);
    }

    var route = Game.map.findRoute(fromRoom, toRoom, {
        routeCallback: function(roomName) {
            return isRoomUnsafe(roomName) ? Infinity : 1;
        }
    });
    routeCache[key] = Array.isArray(route) ? route.length : -1;
    return routeCache[key];
}

function rankTarget(creep, target, options) {
    var settings = ensureSettings();
    var maximumRange = options && typeof options.maximumRoomRange === 'number' ?
        options.maximumRoomRange : settings.scoreRunnerMaximumRoomRange;
    var roomDistance = getRoomDistance(creep.room.name, target.roomName);

    if (options && options.excludedTargetId === target.id) {
        return null;
    }

    if (roomDistance > maximumRange || isRoomUnsafe(target.roomName)) {
        return null;
    }
    if (options && options.currentRoomOnly && roomDistance !== 0) {
        return null;
    }
    if (
        target.claimedBy &&
        target.claimedBy !== creep.name &&
        target.claimUntil > Game.time &&
        Game.creeps[target.claimedBy]
    ) {
        return null;
    }

    var travelTicks = getEstimatedTravelTicks(creep, target, roomDistance);
    var safety = settings.scoreRunnerDecaySafetyTicks;
    var remainingLife = target.decayTime - Game.time;

    if (travelTicks + safety >= remainingLife) {
        return null;
    }
    if (options && options.maxTravelTicks && travelTicks > options.maxTravelTicks) {
        return null;
    }

    return {
        target: target,
        roomDistance: roomDistance,
        travelTicks: travelTicks,
        remainingLife: remainingLife,
        rank: target.score / Math.max(1, travelTicks + 5)
    };
}

function getBestTarget(creep, options) {
    maintain();
    if (!creep || !creep.room || !isEnabled()) {
        return null;
    }

    var ranked = [];
    var targets = ensureMemory().targets;
    for (var targetId in targets) {
        if (!targets.hasOwnProperty(targetId)) {
            continue;
        }
        var candidate = rankTarget(creep, targets[targetId], options || {});
        if (candidate) {
            ranked.push(candidate);
        }
    }

    ranked.sort(function(a, b) {
        return b.rank - a.rank;
    });

    /* Only the best few cheap candidates justify a room-route calculation. */
    var viable = [];
    for (var i = 0; i < ranked.length && i < ROUTE_CANDIDATE_LIMIT; i++) {
        var routeLength = getRouteLength(creep.room.name, ranked[i].target.roomName);
        if (routeLength < 0) {
            continue;
        }

        var refinedTicks = routeLength === 0 ? ranked[i].travelTicks :
            routeLength * ESTIMATED_TICKS_PER_ROOM + 25;
        if (
            refinedTicks + ensureSettings().scoreRunnerDecaySafetyTicks >=
            ranked[i].remainingLife
        ) {
            continue;
        }
        ranked[i].travelTicks = refinedTicks;
        ranked[i].rank = ranked[i].target.score / Math.max(1, refinedTicks + 5);
        viable.push(ranked[i]);
    }

    viable.sort(function(a, b) {
        return b.rank - a.rank;
    });
    return viable.length > 0 ? viable[0] : null;
}

function claimTarget(targetId, creepName, ttl) {
    var target = ensureMemory().targets[targetId];
    if (!target || !creepName) {
        return false;
    }
    if (
        target.claimedBy &&
        target.claimedBy !== creepName &&
        target.claimUntil > Game.time &&
        Game.creeps[target.claimedBy]
    ) {
        return false;
    }
    if (
        target.claimedBy === creepName &&
        target.claimUntil > Game.time + 25
    ) {
        return true;
    }
    target.claimedBy = creepName;
    target.claimUntil = Math.min(
        target.decayTime,
        Game.time + (ttl || CLAIM_TICKS)
    );
    return true;
}

function releaseTarget(targetId, creepName, removeTarget) {
    var targets = ensureMemory().targets;
    var target = targets[targetId];
    if (!target) {
        return;
    }
    if (removeTarget) {
        delete targets[targetId];
        return;
    }
    if (!creepName || target.claimedBy === creepName) {
        delete target.claimedBy;
        delete target.claimUntil;
    }
}

function getTarget(targetId) {
    maintain();
    return ensureMemory().targets[targetId] || null;
}

function getStats() {
    maintain();
    var targets = ensureMemory().targets;
    var live = 0;
    var claimed = 0;
    var totalScore = 0;
    var highestScore = 0;

    for (var targetId in targets) {
        if (!targets.hasOwnProperty(targetId)) {
            continue;
        }
        live++;
        totalScore += targets[targetId].score || 0;
        highestScore = Math.max(highestScore, targets[targetId].score || 0);
        if (targets[targetId].claimedBy && targets[targetId].claimUntil > Game.time) {
            claimed++;
        }
    }

    return {
        enabled: isEnabled(),
        liveTargets: live,
        claimedTargets: claimed,
        unclaimedTargets: Math.max(0, live - claimed),
        totalKnownScore: totalScore,
        highestScore: highestScore
    };
}

module.exports = {
    ensureSettings: ensureSettings,
    isRuntimeSupported: isRuntimeSupported,
    isEnabled: isEnabled,
    maintain: maintain,
    reportVisibleRoom: reportVisibleRoom,
    getVisibleScores: getVisibleScores,
    getBestTarget: getBestTarget,
    getTarget: getTarget,
    claimTarget: claimTarget,
    releaseTarget: releaseTarget,
    getVisibleThreat: getVisibleThreat,
    markHostileRoom: markHostileRoom,
    isRoomUnsafe: isRoomUnsafe,
    getStats: getStats
};
