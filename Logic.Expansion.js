/*
 * Logic.Expansion.js
 *
 * Season 10 expansion controller.
 *
 * State meanings:
 * - selectTarget: choose a safe scouted room while GCL allows another room.
 * - claiming: send one Annex in expand mode to claim the target controller.
 * - placeSpawn: claimed room is visible; choose and place the first spawn site.
 * - buildSpawn: first spawn site exists; import workers and energy until done.
 * - bootstrap: reserved for spawnless recovery support after claiming.
 * - online: target has a completed spawn and normal multi-room spawning takes over.
 * - blocked: target was proven unsafe or impossible; user should inspect Memory.expansion.
 */
var spawnManager = require('spawn.manager');
var creepBodyConfig = require('role.creepBodyConfig');

var DEFAULT_MAX_ROUTE_DISTANCE = 8;
var ROUTE_CACHE_TTL = 5000;
var MAX_ROUTE_CALCS_PER_RUN = 3;

var EXPANSION_ANNEX_PRIORITY = 95;
var PIONEER_PRIORITY = 55;
var SUPPLY_RUNNER_PRIORITY = 54;

var DESIRED_PIONEERS = 2;
var DESIRED_SUPPLY_RUNNERS = 2;

function run() {
    if (!isExpansionModeEnabled()) {
        return {
            ok: true,
            enabled: false
        };
    }

    var expansion = ensureExpansionMemory();

    if (expansion.enabled === false) {
        return {
            ok: true,
            enabled: false,
            reason: 'Memory.expansion.enabled is false'
        };
    }

    expansion.lastUpdated = Game.time;

    var originRoom = getOriginRoom(expansion);

    if (!originRoom) {
        expansion.state = 'blocked';
        expansion.blockReason = 'No visible owned spawn room is available as expansion origin';
        return makeReport(expansion, false, expansion.blockReason);
    }

    if (!isExpansionTargetClaimed(expansion) && !canStartExpansion()) {
        if (!expansion.targetRoom) {
            expansion.state = 'selectTarget';
        }
        expansion.blockReason = 'Waiting for GCL capacity';
        return makeReport(expansion, true, expansion.blockReason);
    }

    if (expansion.targetRoom && expansion.state === 'selectTarget') {
        expansion.state = 'claiming';
    }

    refreshVisibleTargetStatus(expansion);

    if (expansion.state === 'online') {
        return runOnline(expansion);
    }

    if (expansion.state === 'blocked') {
        return makeReport(expansion, false, expansion.blockReason || 'Expansion is blocked');
    }

    if (!expansion.targetRoom) {
        return runSelectTarget(expansion, originRoom);
    }

    if (expansion.state === 'claiming') {
        return runClaiming(expansion, originRoom);
    }

    if (expansion.state === 'placeSpawn') {
        return runPlaceSpawn(expansion, originRoom);
    }

    if (expansion.state === 'buildSpawn' || expansion.state === 'bootstrap') {
        return runBuildSpawn(expansion, originRoom);
    }

    expansion.state = 'selectTarget';
    return makeReport(expansion, true, 'Reset unknown expansion state to selectTarget');
}

function isExpansionModeEnabled() {
    return !!(
        Memory.settings &&
        Memory.settings.season10ExpansionMode === true
    );
}

function ensureExpansionMemory() {
    if (!Memory.expansion) {
        Memory.expansion = {};
    }

    var expansion = Memory.expansion;

    if (expansion.enabled === undefined) {
        expansion.enabled = true;
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

    return expansion;
}

function makeReport(expansion, ok, reason) {
    return {
        ok: ok,
        state: expansion.state,
        originRoom: expansion.originRoom,
        targetRoom: expansion.targetRoom,
        reason: reason || null
    };
}

function getOriginRoom(expansion) {
    if (expansion.originRoom) {
        var configuredRoom = Game.rooms[expansion.originRoom];

        if (isOwnedSpawnRoom(configuredRoom)) {
            return configuredRoom;
        }
    }

    for (var spawnName in Game.spawns) {
        if (!Game.spawns.hasOwnProperty(spawnName)) {
            continue;
        }

        var spawn = Game.spawns[spawnName];

        if (!spawn || !spawn.room) {
            continue;
        }

        if (!isOwnedSpawnRoom(spawn.room)) {
            continue;
        }

        expansion.originRoom = spawn.room.name;
        return spawn.room;
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

function canStartExpansion() {
    if (!Game.gcl || typeof Game.gcl.level !== 'number') {
        return false;
    }

    return Game.gcl.level > countOwnedRooms();
}

function isExpansionTargetClaimed(expansion) {
    if (!expansion || !expansion.targetRoom) {
        return false;
    }

    var targetRoom = Game.rooms[expansion.targetRoom];

    if (targetRoom && targetRoom.controller && targetRoom.controller.my) {
        return true;
    }

    return !!(
        expansion.claimedAt &&
        (
            expansion.state === 'placeSpawn' ||
            expansion.state === 'buildSpawn' ||
            expansion.state === 'bootstrap' ||
            expansion.state === 'online'
        )
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

function runSelectTarget(expansion, originRoom) {
    var targetRoomName = chooseExpansionTarget(expansion, originRoom.name);

    if (!targetRoomName) {
        expansion.state = 'selectTarget';
        return makeReport(expansion, true, 'No safe expansion target available yet');
    }

    expansion.targetRoom = targetRoomName;
    expansion.state = 'claiming';
    expansion.blockReason = null;

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
        return makeReport(expansion, true, 'Target room has completed spawn');
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
        return makeReport(expansion, true, 'Target room is online');
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

function runOnline(expansion) {
    var targetRoom = expansion.targetRoom ? Game.rooms[expansion.targetRoom] : null;

    if (targetRoom && targetRoom.controller && targetRoom.controller.my && !hasCompletedSpawn(targetRoom)) {
        expansion.state = 'placeSpawn';
        return makeReport(expansion, true, 'Online room lost its spawn; returning to placement');
    }

    return makeReport(expansion, true, 'Expansion target is online');
}

function chooseExpansionTarget(expansion, originRoomName) {
    if (expansion.targetRoom) {
        return expansion.targetRoom;
    }

    var candidates = getScoutedCandidates(expansion, originRoomName);

    if (candidates.length === 0) {
        return null;
    }

    candidates.sort(function(a, b) {
        if (b.sourceCount !== a.sourceCount) {
            return b.sourceCount - a.sourceCount;
        }

        return a.linearDistance - b.linearDistance;
    });

    refreshCandidateRoutes(expansion, originRoomName, candidates);

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
            continue;
        }

        candidate.score = (candidate.sourceCount * 100) -
            (routeDistance * 12) -
            candidate.linearDistance;

        if (!best || candidate.score > best.score) {
            best = candidate;
        }
    }

    return best ? best.roomName : null;
}

function getScoutedCandidates(expansion, originRoomName) {
    var candidates = [];

    if (!Memory.rooms) {
        return candidates;
    }

    for (var roomName in Memory.rooms) {
        if (!Memory.rooms.hasOwnProperty(roomName)) {
            continue;
        }

        if (roomName === originRoomName) {
            continue;
        }

        var candidate = buildCandidate(expansion, originRoomName, roomName, Memory.rooms[roomName]);

        if (candidate && candidate.ok) {
            candidates.push(candidate);
        }
    }

    return candidates;
}

function buildCandidate(expansion, originRoomName, roomName, roomMemory) {
    if (!roomMemory) {
        return null;
    }

    var candidateMemory = ensureCandidateMemory(expansion, roomName);
    var sourceCount = getRememberedSourceCount(roomMemory);
    var owner = getRememberedOwner(roomMemory);
    var reservation = getRememberedReservation(roomMemory);
    var reservationUsername = reservation ? reservation.username : null;
    var myUsername = getMyUsername();
    var scoutIntel = roomMemory.scoutIntel || {};
    var linearDistance = getLinearRoomDistance(originRoomName, roomName);

    candidateMemory.sourceCount = sourceCount;
    candidateMemory.owner = owner;
    candidateMemory.reservation = reservationUsername;
    candidateMemory.linearDistance = linearDistance;
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

    if (isKeeperRoom(roomName, Game.rooms[roomName])) {
        candidateMemory.rejectReason = 'keeper room';
        return null;
    }

    if (typeof linearDistance === 'number' && linearDistance > getMaxRouteDistance(expansion) + 2) {
        candidateMemory.rejectReason = 'linear distance too far';
        return null;
    }

    candidateMemory.rejectReason = null;

    return {
        ok: true,
        roomName: roomName,
        sourceCount: sourceCount,
        linearDistance: typeof linearDistance === 'number' ? linearDistance : 99,
        routeDistance: candidateMemory.routeDistance,
        routeLastChecked: candidateMemory.routeLastChecked || 0
    };
}

function refreshCandidateRoutes(expansion, originRoomName, candidates) {
    var routeCalcs = 0;

    for (var i = 0; i < candidates.length; i++) {
        if (routeCalcs >= MAX_ROUTE_CALCS_PER_RUN) {
            break;
        }

        var candidate = candidates[i];
        var candidateMemory = ensureCandidateMemory(expansion, candidate.roomName);
        var stale = !candidateMemory.routeLastChecked ||
            Game.time - candidateMemory.routeLastChecked > ROUTE_CACHE_TTL;

        if (!stale) {
            candidate.routeDistance = candidateMemory.routeDistance;
            continue;
        }

        var routeDistance = calculateRouteDistance(originRoomName, candidate.roomName);
        routeCalcs++;

        candidateMemory.routeLastChecked = Game.time;
        candidateMemory.routeDistance = routeDistance;
        candidate.routeDistance = routeDistance;
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

    var planned = countLivingExpansionCreeps(originRoomName, targetRoomName, role) +
        countQueuedExpansionCreeps(queue, originRoomName, targetRoomName, role);

    if (planned >= desiredCount) {
        return true;
    }

    for (var i = planned; i < desiredCount; i++) {
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
    }

    sortSpawnQueue(queue);
    return true;
}

function countLivingExpansionCreeps(originRoomName, targetRoomName, role) {
    var count = 0;

    for (var creepName in Game.creeps) {
        if (!Game.creeps.hasOwnProperty(creepName)) {
            continue;
        }

        var creep = Game.creeps[creepName];

        if (!isExpansionCreepMemory(creep && creep.memory, originRoomName, targetRoomName, role)) {
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
