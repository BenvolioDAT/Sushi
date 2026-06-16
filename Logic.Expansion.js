/*
 * Logic.Expansion.js
 *
 * Sushi expansion controller.
 *
 * State meanings:
 * - selectTarget: choose a safe scouted room while GCL allows another room.
 * - claiming: send one Annex in expand mode to claim the target controller.
 * - placeSpawn: claimed room is visible; choose and place the first spawn site.
 * - buildSpawn: first spawn site exists; import workers and energy until done.
 * - bootstrap: reserved for spawnless recovery support after claiming.
 * - online: target has a completed spawn and normal multi-room spawning takes over.
 * - blocked: target was proven unsafe or impossible; user should inspect Memory.expansion.
 * - idle/complete: no active target; waiting for autoSelect/manual target or room limits.
 *
 * Expansion is enabled by default. Console controls:
 * - disable: Memory.expansion.enabled = false
 * - re-enable: Memory.expansion.enabled = true
 */
var spawnManager = require('spawn.manager');
var creepBodyConfig = require('role.creepBodyConfig');

var DEFAULT_MAX_ROUTE_DISTANCE = 8;
var DEFAULT_MIN_RANGE_BETWEEN_BASES = 3;
var ROUTE_CACHE_TTL = 5000;
var MAX_ROUTE_CALCS_PER_RUN = 3;

var EXPANSION_ANNEX_PRIORITY = 95;
var PIONEER_PRIORITY = 55;
var SUPPLY_RUNNER_PRIORITY = 54;

var DESIRED_PIONEERS = 2;
var DESIRED_SUPPLY_RUNNERS = 2;

var DEFAULT_SPAWN_POLICY = {
    enabled: true,
    maxQueueLengthPerRoom: 8,
    maxNewRequestsPerRoomPerTick: 2,
    roleCaps: {
        Foreman: 1,
        Scout: 1,
        Annex: 4,
        Ronin: 1,
        Volley: 1,
        Cleric: 1,
        ScoreRunner: 0,
        Tech: 3,
        Artificer: 3,
        Extractor: 6,
        Freighter: 6,
        Pioneer: 2,
        SupplyRunner: 2
    },
    maxCreepsPerRoomByRcl: {
        RCL1: 6,
        RCL2: 9,
        RCL3: 12,
        RCL4: 16,
        RCL5: 20,
        RCL6: 24,
        RCL7: 30,
        RCL8: 35
    }
};

var EXPANSION_REPLACEMENT_BUFFER_TICKS = {
    Annex: 150,
    Pioneer: 150,
    SupplyRunner: 200
};

var ACTIVE_EXPANSION_STATES = {
    claiming: true,
    placeSpawn: true,
    buildSpawn: true,
    bootstrap: true
};

function run() {
    var expansion = ensureExpansionMemory();

    if (expansion.enabled === false) {
        return {
            ok: true,
            enabled: false,
            reason: 'Memory.expansion.enabled is false'
        };
    }

    expansion.lastUpdated = Game.time;

    var ownedSpawnRooms = getOwnedSpawnRooms();

    if (ownedSpawnRooms.length === 0) {
        expansion.state = 'blocked';
        expansion.blockReason = 'No visible owned spawn room is available as expansion origin';
        return makeReport(expansion, false, expansion.blockReason);
    }

    refreshVisibleTargetStatus(expansion);

    if (expansion.state === 'online') {
        return runOnline(expansion, ownedSpawnRooms);
    }

    if (expansion.state === 'blocked') {
        return makeReport(expansion, false, expansion.blockReason || 'Expansion is blocked');
    }

    if (hasActiveExpansionTarget(expansion)) {
        var activeOriginRoom = getActiveOriginRoom(expansion, ownedSpawnRooms);

        if (!activeOriginRoom) {
            expansion.state = 'blocked';
            expansion.blockReason = 'No valid origin room for active expansion';
            return makeReport(expansion, false, expansion.blockReason);
        }

        if (expansion.state === 'claiming') {
            return runClaiming(expansion, activeOriginRoom);
        }

        if (expansion.state === 'placeSpawn') {
            return runPlaceSpawn(expansion, activeOriginRoom);
        }

        if (expansion.state === 'buildSpawn' || expansion.state === 'bootstrap') {
            return runBuildSpawn(expansion, activeOriginRoom);
        }
    }

    if (!canStartExpansion(expansion)) {
        expansion.state = 'complete';
        return makeReport(expansion, true, 'Expansion room limit or GCL limit reached');
    }

    if (
        expansion.targetRoom &&
        (
            !expansion.state ||
            expansion.state === 'selectTarget' ||
            expansion.state === 'idle' ||
            expansion.state === 'complete'
        )
    ) {
        expansion.state = 'selectTarget';
        return runSelectTarget(expansion, ownedSpawnRooms);
    }

    if (!isAutoSelectEnabled(expansion)) {
        expansion.state = 'idle';
        return makeReport(expansion, true, 'Expansion autoSelect is disabled');
    }

    expansion.state = 'selectTarget';
    return runSelectTarget(expansion, ownedSpawnRooms);
}

function ensureExpansionMemory() {
    if (!Memory.expansion) {
        Memory.expansion = {};
    }

    var expansion = Memory.expansion;

    if (expansion.enabled === undefined) {
        expansion.enabled = true;
    }

    if (expansion.autoSelect === undefined) {
        expansion.autoSelect = true;
    }

    if (typeof expansion.maxOwnedRooms !== 'number') {
        expansion.maxOwnedRooms = getGclLevel();
    }

    if (typeof expansion.minRangeBetweenBases !== 'number') {
        expansion.minRangeBetweenBases = DEFAULT_MIN_RANGE_BETWEEN_BASES;
    }

    if (typeof expansion.maxRouteDistance !== 'number') {
        expansion.maxRouteDistance = DEFAULT_MAX_ROUTE_DISTANCE;
    }

    if (expansion.originRoom === undefined) {
        expansion.originRoom = null;
    }

    if (expansion.targetRoom === undefined) {
        expansion.targetRoom = null;
    }

    if (!expansion.state) {
        expansion.state = 'selectTarget';
    }

    if (expansion.spawnSiteId === undefined) {
        expansion.spawnSiteId = null;
    }

    if (expansion.claimedAt === undefined) {
        expansion.claimedAt = null;
    }

    if (expansion.lastUpdated === undefined) {
        expansion.lastUpdated = Game.time;
    }

    if (!expansion.candidates) {
        expansion.candidates = {};
    }

    if (
        !expansion.completedRooms ||
        typeof expansion.completedRooms !== 'object' ||
        Array.isArray(expansion.completedRooms)
    ) {
        expansion.completedRooms = {};
    }

    return expansion;
}

function makeReport(expansion, ok, reason) {
    var ownedRooms = countOwnedRooms();
    var maxOwnedRooms = getMaxOwnedRooms(expansion);
    var gcl = getGclLevel();
    var selectedTarget = expansion.targetRoom || null;
    var selectedOrigin = expansion.originRoom || null;
    var decisionReason = reason || null;

    expansion.lastDecision = {
        tick: Game.time,
        state: expansion.state,
        ownedRooms: ownedRooms,
        maxOwnedRooms: maxOwnedRooms,
        gcl: gcl,
        selectedTarget: selectedTarget,
        selectedOrigin: selectedOrigin,
        reason: decisionReason
    };

    return {
        ok: ok,
        state: expansion.state,
        originRoom: selectedOrigin,
        targetRoom: selectedTarget,
        ownedRooms: ownedRooms,
        maxOwnedRooms: maxOwnedRooms,
        gcl: gcl,
        reason: decisionReason
    };
}

function getOwnedSpawnRooms() {
    var rooms = [];
    var seenRooms = {};

    for (var spawnName in Game.spawns) {
        if (!Game.spawns.hasOwnProperty(spawnName)) {
            continue;
        }

        var spawn = Game.spawns[spawnName];

        if (!spawn || !spawn.room || !isOwnedSpawnRoom(spawn.room)) {
            continue;
        }

        if (seenRooms[spawn.room.name]) {
            continue;
        }

        seenRooms[spawn.room.name] = true;
        rooms.push(spawn.room);
    }

    return rooms;
}

function getActiveOriginRoom(expansion, ownedSpawnRooms) {
    if (expansion.originRoom) {
        var configuredRoom = Game.rooms[expansion.originRoom];

        if (isOwnedSpawnRoom(configuredRoom)) {
            return configuredRoom;
        }
    }

    if (ownedSpawnRooms && ownedSpawnRooms.length > 0) {
        expansion.originRoom = ownedSpawnRooms[0].name;
        return ownedSpawnRooms[0];
    }

    return null;
}

function isOwnedSpawnRoom(room) {
    if (!room || !room.controller || !room.controller.my) {
        return false;
    }

    var spawns = room.find(FIND_MY_SPAWNS);
    return spawns && spawns.length > 0;
}

function canStartExpansion(expansion) {
    var ownedRooms = countOwnedRooms();

    return ownedRooms < getMaxOwnedRooms(expansion) &&
        ownedRooms < getGclLevel();
}

function getGclLevel() {
    if (!Game.gcl || typeof Game.gcl.level !== 'number') {
        return 0;
    }

    return Game.gcl.level;
}

function getMaxOwnedRooms(expansion) {
    if (expansion && typeof expansion.maxOwnedRooms === 'number') {
        return expansion.maxOwnedRooms;
    }

    return getGclLevel();
}

function getMinRangeBetweenBases(expansion) {
    if (expansion && typeof expansion.minRangeBetweenBases === 'number') {
        return expansion.minRangeBetweenBases;
    }

    return DEFAULT_MIN_RANGE_BETWEEN_BASES;
}

function isAutoSelectEnabled(expansion) {
    return expansion.autoSelect !== false;
}

function hasActiveExpansionTarget(expansion) {
    return !!(
        expansion &&
        expansion.targetRoom &&
        ACTIVE_EXPANSION_STATES[expansion.state]
    );
}

function countOwnedRooms() {
    var count = 0;

    for (var roomName in Game.rooms) {
        if (!Game.rooms.hasOwnProperty(roomName)) {
            continue;
        }

        var room = Game.rooms[roomName];

        if (room && room.controller && room.controller.my) {
            count++;
        }
    }

    return count;
}

function refreshVisibleTargetStatus(expansion) {
    var targetRoom = expansion.targetRoom ? Game.rooms[expansion.targetRoom] : null;

    if (!targetRoom) {
        return;
    }

    saveVisibleCandidateIntel(expansion, targetRoom);

    if (hasCompletedSpawn(targetRoom)) {
        expansion.state = 'online';
        expansion.spawnSiteId = null;
        return;
    }

    if (targetRoom.controller && targetRoom.controller.my) {
        if (!expansion.claimedAt) {
            expansion.claimedAt = Game.time;
        }

        if (expansion.state === 'claiming') {
            expansion.state = 'placeSpawn';
        }
    }
}

function saveVisibleCandidateIntel(expansion, room) {
    if (!room) {
        return;
    }

    var candidate = ensureCandidateMemory(expansion, room.name);
    var controller = room.controller;
    var reservation = controller && controller.reservation ? controller.reservation : null;

    candidate.visibleAt = Game.time;
    candidate.sourceCount = room.find(FIND_SOURCES).length;
    candidate.owner = controller && controller.owner ? controller.owner.username : null;
    candidate.reservation = reservation ? reservation.username : null;
    candidate.reservationTicks = reservation ? reservation.ticksToEnd : 0;
    candidate.invaderCore = hasInvaderCore(room);
    candidate.keeperRoom = isKeeperRoom(room.name, room);
}

function runSelectTarget(expansion, ownedSpawnRooms) {
    var selected = chooseExpansionTarget(expansion, ownedSpawnRooms);

    if (!selected) {
        if (expansion.state !== 'manualTargetRejected') {
            expansion.state = 'selectTarget';
        }
        return makeReport(expansion, true, 'No safe expansion target available yet');
    }

    expansion.targetRoom = selected.roomName;
    expansion.originRoom = selected.originRoom;
    expansion.state = 'claiming';
    expansion.blockReason = null;

    var originRoom = Game.rooms[selected.originRoom];

    if (!originRoom) {
        expansion.state = 'blocked';
        expansion.blockReason = 'Selected expansion origin room is not visible';
        return makeReport(expansion, false, expansion.blockReason);
    }

    return runClaiming(expansion, originRoom);
}

function runClaiming(expansion, originRoom) {
    var targetRoom = Game.rooms[expansion.targetRoom];

    if (targetRoom && isVisibleTargetBlocked(targetRoom)) {
        expansion.state = 'blocked';
        expansion.blockReason = 'Target room is owned, hostile reserved, or blocked by an invader core';
        return makeReport(expansion, false, expansion.blockReason);
    }

    if (targetRoom && targetRoom.controller && targetRoom.controller.my) {
        expansion.state = 'placeSpawn';
        expansion.claimedAt = expansion.claimedAt || Game.time;
        return runPlaceSpawn(expansion, originRoom);
    }

    requestExpansionAnnex(expansion, originRoom);

    return makeReport(expansion, true, 'Claiming target room');
}

function runPlaceSpawn(expansion, originRoom) {
    var targetRoom = Game.rooms[expansion.targetRoom];

    if (!targetRoom) {
        expansion.state = 'bootstrap';
        requestBootstrapCreeps(expansion, originRoom);
        return makeReport(expansion, true, 'Waiting for target room vision before placing spawn');
    }

    if (!targetRoom.controller || !targetRoom.controller.my) {
        expansion.state = 'claiming';
        return runClaiming(expansion, originRoom);
    }

    if (hasCompletedSpawn(targetRoom)) {
        expansion.state = 'online';
        expansion.spawnSiteId = null;
        return runOnline(expansion, getOwnedSpawnRooms());
    }

    var existingSite = findSpawnConstructionSite(targetRoom);

    if (existingSite) {
        expansion.spawnSiteId = existingSite.id;
        expansion.state = 'buildSpawn';
        requestBootstrapCreeps(expansion, originRoom);
        return makeReport(expansion, true, 'Spawn construction site already exists');
    }

    var position = chooseSpawnSitePosition(targetRoom);

    if (!position) {
        expansion.state = 'blocked';
        expansion.blockReason = 'No safe spawn placement tile found';
        return makeReport(expansion, false, expansion.blockReason);
    }

    var result = targetRoom.createConstructionSite(position, STRUCTURE_SPAWN);

    if (result !== OK) {
        expansion.state = 'blocked';
        expansion.blockReason = 'Failed to place spawn construction site: ' + result;
        return makeReport(expansion, false, expansion.blockReason);
    }

    var site = findSpawnConstructionSite(targetRoom);
    expansion.spawnSiteId = site ? site.id : null;
    expansion.spawnSitePos = {
        x: position.x,
        y: position.y,
        roomName: position.roomName
    };
    expansion.state = 'buildSpawn';

    requestBootstrapCreeps(expansion, originRoom);
    return makeReport(expansion, true, 'Placed spawn construction site');
}

function runBuildSpawn(expansion, originRoom) {
    var targetRoom = Game.rooms[expansion.targetRoom];

    if (targetRoom && hasCompletedSpawn(targetRoom)) {
        expansion.state = 'online';
        expansion.spawnSiteId = null;
        return runOnline(expansion, getOwnedSpawnRooms());
    }

    if (targetRoom && targetRoom.controller && targetRoom.controller.my) {
        var site = findSpawnConstructionSite(targetRoom);

        if (!site) {
            expansion.state = 'placeSpawn';
            return runPlaceSpawn(expansion, originRoom);
        }

        expansion.spawnSiteId = site.id;
    }

    requestBootstrapCreeps(expansion, originRoom);
    return makeReport(expansion, true, 'Building target room spawn');
}

function runOnline(expansion, ownedSpawnRooms) {
    var targetRoom = expansion.targetRoom ? Game.rooms[expansion.targetRoom] : null;

    if (targetRoom && targetRoom.controller && targetRoom.controller.my && !hasCompletedSpawn(targetRoom)) {
        expansion.state = 'placeSpawn';
        return makeReport(expansion, true, 'Online room lost its spawn; returning to placement');
    }

    completeOnlineTarget(expansion);

    if (!canStartExpansion(expansion)) {
        expansion.state = 'complete';
        return makeReport(expansion, true, 'Expansion target is online and room limit reached');
    }

    if (!isAutoSelectEnabled(expansion)) {
        expansion.state = 'idle';
        return makeReport(expansion, true, 'Expansion target is online and autoSelect is disabled');
    }

    expansion.state = 'selectTarget';
    return runSelectTarget(expansion, ownedSpawnRooms);
}

function completeOnlineTarget(expansion) {
    var completedRoomName = expansion.targetRoom;

    if (completedRoomName) {
        expansion.completedRooms[completedRoomName] = {
            roomName: completedRoomName,
            originRoom: expansion.originRoom || null,
            completedAt: Game.time
        };
    }

    expansion.targetRoom = null;
    expansion.originRoom = null;
    expansion.spawnSiteId = null;
    expansion.spawnSitePos = null;
    expansion.claimedAt = null;
    expansion.blockReason = null;
}

function chooseExpansionTarget(expansion, ownedSpawnRooms) {
    if (expansion.targetRoom) {
        var manualTargetRoomName = expansion.targetRoom;
        var manualTarget = validateManualTarget(expansion, ownedSpawnRooms);

        if (manualTarget) {
            return manualTarget;
        }

        var manualRejectReason = getCandidateRejectReason(
            expansion,
            manualTargetRoomName
        ) || 'manual target failed validation';

        recordRejectedManualTarget(
            expansion,
            manualTargetRoomName,
            manualRejectReason
        );
        clearInactiveTarget(expansion, manualRejectReason);

        if (!isAutoSelectEnabled(expansion)) {
            expansion.state = 'manualTargetRejected';
            return null;
        }
    }

    if (!isAutoSelectEnabled(expansion)) {
        return null;
    }

    var candidates = getScoutedCandidates(expansion, ownedSpawnRooms);

    if (candidates.length === 0) {
        return null;
    }

    candidates.sort(function(a, b) {
        if (b.sourceCount !== a.sourceCount) {
            return b.sourceCount - a.sourceCount;
        }

        return b.spacingDistance - a.spacingDistance;
    });

    refreshCandidateRoutes(expansion, ownedSpawnRooms, candidates);

    var best = null;
    var maxRouteDistance = getMaxRouteDistance(expansion);

    for (var i = 0; i < candidates.length; i++) {
        var candidate = candidates[i];
        var routeDistance = candidate.routeDistance;

        if (typeof routeDistance !== 'number') {
            continue;
        }

        if (routeDistance > maxRouteDistance) {
            candidate.rejectReason = 'route too far';
            ensureCandidateMemory(expansion, candidate.roomName).rejectReason = candidate.rejectReason;
            continue;
        }

        candidate.score = (candidate.sourceCount * 100) -
            (routeDistance * 12) -
            candidate.linearDistance +
            (candidate.spacingDistance * 4);

        ensureCandidateMemory(expansion, candidate.roomName).score = candidate.score;

        if (!best || candidate.score > best.score) {
            best = candidate;
        }
    }

    return best;
}

function clearInactiveTarget(expansion, reason) {
    expansion.targetRoom = null;
    expansion.originRoom = null;
    expansion.spawnSiteId = null;
    expansion.spawnSitePos = null;
    expansion.claimedAt = null;
    expansion.blockReason = reason || null;
}

function recordRejectedManualTarget(expansion, roomName, reason) {
    if (roomName) {
        ensureCandidateMemory(expansion, roomName).rejectReason = reason;
    }

    expansion.lastRejectedManualTarget = {
        roomName: roomName || null,
        reason: reason || 'manual target rejected',
        tick: Game.time
    };
}

function getCandidateRejectReason(expansion, roomName) {
    var candidate = expansion.candidates && expansion.candidates[roomName];

    return candidate ? candidate.rejectReason : null;
}

function validateManualTarget(expansion, ownedSpawnRooms) {
    var roomName = expansion.targetRoom;
    var roomMemory = Memory.rooms && Memory.rooms[roomName];
    var candidate = buildCandidate(expansion, roomName, roomMemory);

    if (!candidate || !candidate.ok) {
        if (!getCandidateRejectReason(expansion, roomName)) {
            ensureCandidateMemory(expansion, roomName).rejectReason = 'manual target failed candidate validation';
        }
        return null;
    }

    refreshCandidateRoutes(expansion, ownedSpawnRooms, [candidate]);

    if (typeof candidate.routeDistance !== 'number') {
        ensureCandidateMemory(expansion, roomName).rejectReason =
            'no valid route from owned spawn rooms';
        return null;
    }

    if (candidate.routeDistance > getMaxRouteDistance(expansion)) {
        ensureCandidateMemory(expansion, roomName).rejectReason = 'route too far';
        return null;
    }

    candidate.score = (candidate.sourceCount * 100) -
        (candidate.routeDistance * 12) +
        (candidate.spacingDistance * 4);

    return candidate;
}

function getScoutedCandidates(expansion, ownedSpawnRooms) {
    var candidates = [];

    if (!Memory.rooms) {
        return candidates;
    }

    for (var roomName in Memory.rooms) {
        if (!Memory.rooms.hasOwnProperty(roomName)) {
            continue;
        }

        var candidate = buildCandidate(expansion, roomName, Memory.rooms[roomName]);

        if (candidate && candidate.ok) {
            candidates.push(candidate);
        }
    }

    return candidates;
}

function buildCandidate(expansion, roomName, roomMemory) {
    if (!roomMemory) {
        ensureCandidateMemory(expansion, roomName).rejectReason = 'no room intel';
        return null;
    }

    var candidateMemory = ensureCandidateMemory(expansion, roomName);
    var sourceCount = getRememberedSourceCount(roomMemory);
    var owner = getRememberedOwner(roomMemory);
    var reservation = getRememberedReservation(roomMemory);
    var reservationUsername = reservation ? reservation.username : null;
    var myUsername = getMyUsername();
    var scoutIntel = roomMemory.scoutIntel || {};
    var spacingDistance = getNearestBaseDistance(expansion, roomName);

    candidateMemory.sourceCount = sourceCount;
    candidateMemory.owner = owner;
    candidateMemory.reservation = reservationUsername;
    candidateMemory.spacingDistance = spacingDistance;
    candidateMemory.lastEvaluated = Game.time;

    if (sourceCount <= 0) {
        candidateMemory.rejectReason = 'no source intel';
        return null;
    }

    if (owner && owner !== myUsername) {
        candidateMemory.rejectReason = 'enemy owned';
        return null;
    }

    if (owner === myUsername || isOwnedRoomName(roomName)) {
        candidateMemory.rejectReason = 'already owned';
        return null;
    }

    if (reservationUsername && reservationUsername !== myUsername) {
        candidateMemory.rejectReason = 'hostile reservation';
        return null;
    }

    if (scoutIntel.invaderCore === true || candidateMemory.invaderCore === true) {
        candidateMemory.rejectReason = 'invader core';
        return null;
    }

    if (
        typeof spacingDistance === 'number' &&
        spacingDistance < getMinRangeBetweenBases(expansion)
    ) {
        candidateMemory.rejectReason = 'too close to existing base';
        return null;
    }

    if (isKeeperRoom(roomName, Game.rooms[roomName])) {
        candidateMemory.rejectReason = 'keeper room';
        return null;
    }

    candidateMemory.rejectReason = null;

    return {
        ok: true,
        roomName: roomName,
        sourceCount: sourceCount,
        linearDistance: typeof spacingDistance === 'number' ? spacingDistance : 99,
        spacingDistance: typeof spacingDistance === 'number' ? spacingDistance : 99,
        originRoom: candidateMemory.originRoom || null,
        routeDistance: candidateMemory.routeDistance,
        routeLastChecked: candidateMemory.routeLastChecked || 0
    };
}

function refreshCandidateRoutes(expansion, ownedSpawnRooms, candidates) {
    var routeCalcs = 0;

    for (var i = 0; i < candidates.length; i++) {
        var candidate = candidates[i];
        var candidateMemory = ensureCandidateMemory(expansion, candidate.roomName);
        var bestOriginRoom = null;
        var bestRouteDistance = null;

        if (!candidateMemory.routes) {
            candidateMemory.routes = {};
        }

        for (var originIndex = 0; originIndex < ownedSpawnRooms.length; originIndex++) {
            var originRoom = ownedSpawnRooms[originIndex];

            if (!originRoom || !originRoom.name) {
                continue;
            }

            var routeMemory = candidateMemory.routes[originRoom.name];

            if (!routeMemory) {
                routeMemory = {};
                candidateMemory.routes[originRoom.name] = routeMemory;
            }

            var stale = !routeMemory.lastChecked ||
                Game.time - routeMemory.lastChecked > ROUTE_CACHE_TTL;

            if (stale && routeCalcs < MAX_ROUTE_CALCS_PER_RUN) {
                routeMemory.distance = calculateRouteDistance(
                    originRoom.name,
                    candidate.roomName
                );
                routeMemory.lastChecked = Game.time;
                routeCalcs++;
            }

            if (
                typeof routeMemory.distance === 'number' &&
                (
                    bestRouteDistance === null ||
                    routeMemory.distance < bestRouteDistance
                )
            ) {
                bestRouteDistance = routeMemory.distance;
                bestOriginRoom = originRoom.name;
            }
        }

        candidateMemory.originRoom = bestOriginRoom;
        candidateMemory.routeDistance = bestRouteDistance;
        candidateMemory.routeLastChecked = Game.time;
        candidate.originRoom = bestOriginRoom;
        candidate.routeDistance = bestRouteDistance;
    }
}

function calculateRouteDistance(originRoomName, targetRoomName) {
    if (!Game.map || typeof Game.map.findRoute !== 'function') {
        return null;
    }

    var route = Game.map.findRoute(originRoomName, targetRoomName, {
        routeCallback: function(roomName) {
            var status = getRoomStatus(roomName);

            if (
                status === 'closed' ||
                status === 'out of borders'
            ) {
                return Infinity;
            }

            return 1;
        }
    });

    if (!route || route === ERR_NO_PATH || route < 0) {
        return null;
    }

    return route.length;
}

function getMaxRouteDistance(expansion) {
    if (typeof expansion.maxRouteDistance === 'number') {
        return expansion.maxRouteDistance;
    }

    return DEFAULT_MAX_ROUTE_DISTANCE;
}

function getRememberedSourceCount(roomMemory) {
    if (roomMemory.scoutIntel && typeof roomMemory.scoutIntel.sourceCount === 'number') {
        return roomMemory.scoutIntel.sourceCount;
    }

    if (!roomMemory.sources) {
        return 0;
    }

    var count = 0;

    for (var sourceId in roomMemory.sources) {
        if (roomMemory.sources.hasOwnProperty(sourceId)) {
            count++;
        }
    }

    return count;
}

function getRememberedOwner(roomMemory) {
    if (roomMemory.controller) {
        if (typeof roomMemory.controller.owner === 'string') {
            return roomMemory.controller.owner;
        }

        if (roomMemory.controller.owner && roomMemory.controller.owner.username) {
            return roomMemory.controller.owner.username;
        }
    }

    if (roomMemory.scoutIntel && roomMemory.scoutIntel.controllerOwner) {
        return roomMemory.scoutIntel.controllerOwner;
    }

    return null;
}

function getRememberedReservation(roomMemory) {
    if (roomMemory.controller && roomMemory.controller.reservation) {
        if (typeof roomMemory.controller.reservation === 'string') {
            return {
                username: roomMemory.controller.reservation,
                ticksToEnd: roomMemory.controller.ticksToEnd || 0
            };
        }

        return {
            username: roomMemory.controller.reservation.username || null,
            ticksToEnd: roomMemory.controller.reservation.ticksToEnd || 0
        };
    }

    if (roomMemory.scoutIntel && roomMemory.scoutIntel.controllerReservation) {
        return {
            username: roomMemory.scoutIntel.controllerReservation,
            ticksToEnd: 0
        };
    }

    return null;
}

function ensureCandidateMemory(expansion, roomName) {
    if (!expansion.candidates) {
        expansion.candidates = {};
    }

    if (!expansion.candidates[roomName]) {
        expansion.candidates[roomName] = {};
    }

    return expansion.candidates[roomName];
}

function isOwnedRoomName(roomName) {
    var room = Game.rooms[roomName];
    return !!(room && room.controller && room.controller.my);
}

function getMyUsername() {
    if (Memory.username) {
        return Memory.username;
    }

    for (var spawnName in Game.spawns) {
        if (
            Game.spawns.hasOwnProperty(spawnName) &&
            Game.spawns[spawnName].owner
        ) {
            Memory.username = Game.spawns[spawnName].owner.username;
            return Memory.username;
        }
    }

    return null;
}

function isVisibleTargetBlocked(room) {
    if (!room) {
        return false;
    }

    if (room.controller && room.controller.owner && !room.controller.my) {
        return true;
    }

    if (
        room.controller &&
        room.controller.reservation &&
        room.controller.reservation.username !== getMyUsername()
    ) {
        return true;
    }

    return hasInvaderCore(room);
}

function hasInvaderCore(room) {
    if (!room || typeof STRUCTURE_INVADER_CORE === 'undefined') {
        return false;
    }

    var cores = room.find(FIND_HOSTILE_STRUCTURES, {
        filter: function(structure) {
            return structure.structureType === STRUCTURE_INVADER_CORE;
        }
    });

    return cores.length > 0;
}

function isKeeperRoom(roomName, room) {
    if (room && typeof STRUCTURE_KEEPER_LAIR !== 'undefined') {
        var lairs = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: function(structure) {
                return structure.structureType === STRUCTURE_KEEPER_LAIR;
            }
        });

        if (lairs.length > 0) {
            return true;
        }
    }

    var match = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);

    if (!match) {
        return false;
    }

    var x = parseInt(match[2], 10) % 10;
    var y = parseInt(match[4], 10) % 10;

    return x >= 4 && x <= 6 && y >= 4 && y <= 6;
}

function getRoomStatus(roomName) {
    if (!Game.map || typeof Game.map.getRoomStatus !== 'function') {
        return 'normal';
    }

    var result = Game.map.getRoomStatus(roomName);

    if (!result || !result.status) {
        return 'normal';
    }

    return result.status;
}

function parseRoomName(roomName) {
    if (typeof roomName !== 'string') {
        return null;
    }

    var match = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);

    if (!match) {
        return null;
    }

    return {
        x: match[1] === 'E' ? parseInt(match[2], 10) : -parseInt(match[2], 10) - 1,
        y: match[3] === 'S' ? parseInt(match[4], 10) : -parseInt(match[4], 10) - 1
    };
}

function getLinearRoomDistance(originRoomName, targetRoomName) {
    var origin = parseRoomName(originRoomName);
    var target = parseRoomName(targetRoomName);

    if (!origin || !target) {
        return null;
    }

    return Math.max(Math.abs(origin.x - target.x), Math.abs(origin.y - target.y));
}

function getNearestBaseDistance(expansion, roomName) {
    var baseRooms = getBaseRoomNamesForSpacing(expansion);
    var nearestDistance = null;

    for (var i = 0; i < baseRooms.length; i++) {
        if (baseRooms[i] === roomName) {
            nearestDistance = 0;
            continue;
        }

        var distance = getLinearRoomDistance(baseRooms[i], roomName);

        if (typeof distance !== 'number') {
            continue;
        }

        if (nearestDistance === null || distance < nearestDistance) {
            nearestDistance = distance;
        }
    }

    return nearestDistance;
}

function getBaseRoomNamesForSpacing(expansion) {
    var names = {};
    var result = [];

    for (var roomName in Game.rooms) {
        if (!Game.rooms.hasOwnProperty(roomName)) {
            continue;
        }

        var room = Game.rooms[roomName];

        if (room && room.controller && room.controller.my) {
            names[roomName] = true;
        }
    }

    if (expansion.completedRooms) {
        for (var completedRoomName in expansion.completedRooms) {
            if (expansion.completedRooms.hasOwnProperty(completedRoomName)) {
                names[completedRoomName] = true;
            }
        }
    }

    for (var name in names) {
        if (names.hasOwnProperty(name)) {
            result.push(name);
        }
    }

    return result;
}

function hasCompletedSpawn(room) {
    if (!room) {
        return false;
    }

    var spawns = room.find(FIND_MY_SPAWNS);
    return spawns && spawns.length > 0;
}

function findSpawnConstructionSite(room) {
    if (!room) {
        return null;
    }

    var sites = room.find(FIND_MY_CONSTRUCTION_SITES, {
        filter: function(site) {
            return site.structureType === STRUCTURE_SPAWN;
        }
    });

    return sites.length > 0 ? sites[0] : null;
}

function chooseSpawnSitePosition(room) {
    if (!room || !room.controller) {
        return null;
    }

    var terrain = room.getTerrain();
    var sources = room.find(FIND_SOURCES);
    var minerals = room.find(FIND_MINERALS);
    var bestPosition = null;
    var bestScore = Infinity;

    for (var x = 3; x <= 46; x++) {
        for (var y = 3; y <= 46; y++) {
            if (!isBuildableSpawnTile(room, terrain, x, y, sources, minerals)) {
                continue;
            }

            var position = new RoomPosition(x, y, room.name);
            var controllerRange = position.getRangeTo(room.controller);

            if (controllerRange < 3 || controllerRange > 9) {
                continue;
            }

            var sourceRange = getNearestRange(position, sources);

            if (sourceRange < 3 || sourceRange > 14) {
                continue;
            }

            var score = Math.abs(controllerRange - 5) * 5 +
                sourceRange +
                getExitPenalty(x, y);

            if (score < bestScore) {
                bestScore = score;
                bestPosition = position;
            }
        }
    }

    return bestPosition;
}

function isBuildableSpawnTile(room, terrain, x, y, sources, minerals) {
    if (terrain.get(x, y) === TERRAIN_MASK_WALL) {
        return false;
    }

    var position = new RoomPosition(x, y, room.name);

    if (isOnExitOrEdge(position)) {
        return false;
    }

    if (position.isEqualTo(room.controller.pos) || position.getRangeTo(room.controller) <= 2) {
        return false;
    }

    if (isNearAny(position, sources, 2) || isNearAny(position, minerals, 1)) {
        return false;
    }

    if (room.lookForAt(LOOK_STRUCTURES, x, y).length > 0) {
        return false;
    }

    if (room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length > 0) {
        return false;
    }

    return countPassableNeighbors(room, terrain, x, y) >= 5;
}

function isOnExitOrEdge(position) {
    return position.x <= 1 ||
        position.x >= 48 ||
        position.y <= 1 ||
        position.y >= 48;
}

function isNearAny(position, targets, range) {
    for (var i = 0; i < targets.length; i++) {
        if (position.getRangeTo(targets[i]) <= range) {
            return true;
        }
    }

    return false;
}

function getNearestRange(position, targets) {
    var best = 99;

    for (var i = 0; i < targets.length; i++) {
        best = Math.min(best, position.getRangeTo(targets[i]));
    }

    return best;
}

function getExitPenalty(x, y) {
    return Math.max(0, 8 - Math.min(x, y, 49 - x, 49 - y));
}

function countPassableNeighbors(room, terrain, x, y) {
    var count = 0;

    for (var dx = -1; dx <= 1; dx++) {
        for (var dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) {
                continue;
            }

            var nx = x + dx;
            var ny = y + dy;

            if (nx <= 0 || nx >= 49 || ny <= 0 || ny >= 49) {
                continue;
            }

            if (terrain.get(nx, ny) === TERRAIN_MASK_WALL) {
                continue;
            }

            if (room.lookForAt(LOOK_STRUCTURES, nx, ny).length > 0) {
                continue;
            }

            count++;
        }
    }

    return count;
}

function requestExpansionAnnex(expansion, originRoom) {
    var body = creepBodyConfig.getAnnexBody(originRoom);

    if (!body) {
        return false;
    }

    return ensureExpansionCreepCount(
        originRoom.name,
        expansion.targetRoom,
        'Annex',
        1,
        body,
        EXPANSION_ANNEX_PRIORITY,
        {
            annexMode: 'expand'
        }
    );
}

function requestBootstrapCreeps(expansion, originRoom) {
    ensureExpansionCreepCount(
        originRoom.name,
        expansion.targetRoom,
        'Pioneer',
        DESIRED_PIONEERS,
        creepBodyConfig.getBody('Pioneer', originRoom),
        PIONEER_PRIORITY,
        {}
    );

    ensureExpansionCreepCount(
        originRoom.name,
        expansion.targetRoom,
        'SupplyRunner',
        DESIRED_SUPPLY_RUNNERS,
        creepBodyConfig.getBody('SupplyRunner', originRoom),
        SUPPLY_RUNNER_PRIORITY,
        {}
    );
}

function ensureExpansionSpawnPolicyMemory() {
    if (!Memory.spawnPolicy) {
        Memory.spawnPolicy = {};
    }

    var policy = Memory.spawnPolicy;

    if (policy.enabled === undefined) {
        policy.enabled = DEFAULT_SPAWN_POLICY.enabled;
    }

    if (typeof policy.maxQueueLengthPerRoom !== 'number') {
        policy.maxQueueLengthPerRoom = DEFAULT_SPAWN_POLICY.maxQueueLengthPerRoom;
    }

    if (typeof policy.maxNewRequestsPerRoomPerTick !== 'number') {
        policy.maxNewRequestsPerRoomPerTick =
            DEFAULT_SPAWN_POLICY.maxNewRequestsPerRoomPerTick;
    }

    if (!policy.roleCaps) {
        policy.roleCaps = {};
    }

    for (var role in DEFAULT_SPAWN_POLICY.roleCaps) {
        if (
            DEFAULT_SPAWN_POLICY.roleCaps.hasOwnProperty(role) &&
            typeof policy.roleCaps[role] !== 'number'
        ) {
            policy.roleCaps[role] = DEFAULT_SPAWN_POLICY.roleCaps[role];
        }
    }

    if (!policy.maxCreepsPerRoomByRcl) {
        policy.maxCreepsPerRoomByRcl = {};
    }

    for (var rclKey in DEFAULT_SPAWN_POLICY.maxCreepsPerRoomByRcl) {
        if (
            DEFAULT_SPAWN_POLICY.maxCreepsPerRoomByRcl.hasOwnProperty(rclKey) &&
            typeof policy.maxCreepsPerRoomByRcl[rclKey] !== 'number'
        ) {
            policy.maxCreepsPerRoomByRcl[rclKey] =
                DEFAULT_SPAWN_POLICY.maxCreepsPerRoomByRcl[rclKey];
        }
    }

    return policy;
}

function getExpansionHomeCounts(originRoomName, queue) {
    var counts = {
        totalLiving: 0,
        totalQueued: 0,
        roleLiving: {},
        roleQueued: {},
        newRequestsThisTick: 0
    };

    for (var creepName in Game.creeps) {
        if (!Game.creeps.hasOwnProperty(creepName)) {
            continue;
        }

        var creep = Game.creeps[creepName];
        var memory = creep && creep.memory;
        var homeRoom = memory ? (memory.homeRoom || (creep.room && creep.room.name)) : null;

        if (homeRoom !== originRoomName) {
            continue;
        }

        counts.totalLiving++;

        if (memory && memory.role) {
            counts.roleLiving[memory.role] = (counts.roleLiving[memory.role] || 0) + 1;
        }
    }

    if (!queue) {
        return counts;
    }

    for (var i = 0; i < queue.length; i++) {
        var request = queue[i];
        var requestMemory = request && request.memory;
        var requestHomeRoom = requestMemory ? requestMemory.homeRoom : originRoomName;

        if (requestHomeRoom !== originRoomName) {
            continue;
        }

        var role = request.role || (requestMemory && requestMemory.role);

        counts.totalQueued++;

        if (role) {
            counts.roleQueued[role] = (counts.roleQueued[role] || 0) + 1;
        }

        if (request.requestedAt === Game.time) {
            counts.newRequestsThisTick++;
        }
    }

    return counts;
}

function getExpansionMaxCreeps(originRoomName, policy) {
    var room = Game.rooms[originRoomName];
    var level = room && room.controller ? (room.controller.level || 1) : 1;
    var key = 'RCL' + level;

    return policy.maxCreepsPerRoomByRcl[key] ||
        DEFAULT_SPAWN_POLICY.maxCreepsPerRoomByRcl[key] ||
        DEFAULT_SPAWN_POLICY.maxCreepsPerRoomByRcl.RCL1;
}

function canQueueExpansionRequest(originRoomName, role, queue, counts, allowStallBypass) {
    var policy = ensureExpansionSpawnPolicyMemory();

    if (policy.enabled === false) {
        return {
            ok: true
        };
    }

    var plannedRole = (counts.roleLiving[role] || 0) +
        (counts.roleQueued[role] || 0);
    var plannedTotal = counts.totalLiving + counts.totalQueued;
    var roleCap = policy.roleCaps ? policy.roleCaps[role] : null;

    if (
        typeof roleCap === 'number' &&
        plannedRole >= roleCap &&
        !allowStallBypass
    ) {
        return {
            ok: false,
            reason: 'role cap reached'
        };
    }

    if (
        plannedTotal >= getExpansionMaxCreeps(originRoomName, policy) &&
        !allowStallBypass
    ) {
        return {
            ok: false,
            reason: 'room creep cap reached'
        };
    }

    if (
        queue &&
        queue.length >= policy.maxQueueLengthPerRoom &&
        !allowStallBypass
    ) {
        return {
            ok: false,
            reason: 'spawn queue full'
        };
    }

    if (
        counts.newRequestsThisTick >= policy.maxNewRequestsPerRoomPerTick &&
        !allowStallBypass
    ) {
        return {
            ok: false,
            reason: 'new request cap reached'
        };
    }

    return {
        ok: true
    };
}

function rememberExpansionSpawnDenial(originRoomName, role, reason) {
    if (!Memory.rooms) {
        Memory.rooms = {};
    }

    if (!Memory.rooms[originRoomName]) {
        Memory.rooms[originRoomName] = {};
    }

    Memory.rooms[originRoomName].expansionSpawnGovernor = {
        tick: Game.time,
        role: role,
        denied: reason
    };
}

function ensureExpansionCreepCount(
    originRoomName,
    targetRoomName,
    role,
    desiredCount,
    body,
    priority,
    extraMemory
) {
    var queue = spawnManager.getSpawnQueue(originRoomName);

    if (!queue || !body || desiredCount <= 0) {
        return false;
    }

    var replacementLeadTicks = getExpansionReplacementLeadTicks(role, body);
    var planned = countLivingExpansionCreeps(
        originRoomName,
        targetRoomName,
        role,
        replacementLeadTicks
    ) +
        countQueuedExpansionCreeps(queue, originRoomName, targetRoomName, role);

    if (planned >= desiredCount) {
        return true;
    }

    var homeCounts = getExpansionHomeCounts(originRoomName, queue);
    var added = 0;

    for (var i = planned; i < desiredCount; i++) {
        var allowStallBypass = planned + added <= 0;
        var allowed = canQueueExpansionRequest(
            originRoomName,
            role,
            queue,
            homeCounts,
            allowStallBypass
        );

        if (!allowed.ok) {
            rememberExpansionSpawnDenial(originRoomName, role, allowed.reason);
            break;
        }

        var memory = {
            role: role,
            homeRoom: originRoomName,
            targetRoom: targetRoomName,
            expansionId: targetRoomName
        };

        for (var key in extraMemory) {
            if (extraMemory.hasOwnProperty(key)) {
                memory[key] = extraMemory[key];
            }
        }

        queue.push({
            role: role,
            body: body,
            priority: priority,
            memory: memory,
            requestedAt: Game.time
        });

        added++;
        homeCounts.totalQueued++;
        homeCounts.roleQueued[role] = (homeCounts.roleQueued[role] || 0) + 1;
        homeCounts.newRequestsThisTick++;
    }

    if (added > 0) {
        sortSpawnQueue(queue);
    }

    return planned + added >= desiredCount || added > 0;
}

function getExpansionReplacementLeadTicks(role, body) {
    var bodyLength = body ? body.length : 0;
    var buffer = EXPANSION_REPLACEMENT_BUFFER_TICKS[role] || 150;

    return (bodyLength * 3) + buffer;
}

function countLivingExpansionCreeps(originRoomName, targetRoomName, role, replacementLeadTicks) {
    var count = 0;

    for (var creepName in Game.creeps) {
        if (!Game.creeps.hasOwnProperty(creepName)) {
            continue;
        }

        var creep = Game.creeps[creepName];

        if (!isExpansionCreepMemory(creep && creep.memory, originRoomName, targetRoomName, role)) {
            continue;
        }

        if (
            creep.ticksToLive !== undefined &&
            creep.ticksToLive <= replacementLeadTicks
        ) {
            continue;
        }

        count++;
    }

    return count;
}

function countQueuedExpansionCreeps(queue, originRoomName, targetRoomName, role) {
    var count = 0;

    for (var i = 0; i < queue.length; i++) {
        var request = queue[i];
        var memory = request && request.memory;

        if (isExpansionCreepMemory(memory, originRoomName, targetRoomName, role)) {
            count++;
        }
    }

    return count;
}

function isExpansionCreepMemory(memory, originRoomName, targetRoomName, role) {
    if (!memory) {
        return false;
    }

    if (memory.role !== role) {
        return false;
    }

    if (memory.homeRoom !== originRoomName || memory.targetRoom !== targetRoomName) {
        return false;
    }

    if (memory.expansionId !== targetRoomName) {
        return false;
    }

    if (role === 'Annex' && memory.annexMode !== 'expand') {
        return false;
    }

    return true;
}

function sortSpawnQueue(queue) {
    queue.sort(function(a, b) {
        if (b.priority !== a.priority) {
            return b.priority - a.priority;
        }

        return a.requestedAt - b.requestedAt;
    });
}

module.exports = {
    run: run,
    ensureExpansionMemory: ensureExpansionMemory,
    chooseExpansionTarget: chooseExpansionTarget,
    chooseSpawnSitePosition: chooseSpawnSitePosition
};
