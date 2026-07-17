/*
 * Tick.Cache.js
 *
 * Small heap-only indexes shared by systems that otherwise enumerate the same
 * Screeps collections. Everything is invalidated when Game.time changes, so no
 * cache data is serialized into Memory and global resets are naturally safe.
 */

var cacheTick = null;
var cache = null;
var buildCount = 0;

function currentTick() {
    if (typeof Game === 'undefined' || typeof Game.time !== 'number') {
        return -1;
    }
    return Game.time;
}

function addIndexedValue(index, key, value) {
    key = key || 'unknown';
    if (!index[key]) {
        index[key] = [];
    }
    index[key].push(value);
}

function addPartCount(index, role, partType) {
    role = role || 'unknown';
    if (!index[role]) {
        index[role] = {};
    }
    index[role][partType] = (index[role][partType] || 0) + 1;
}

function build() {
    var tick = currentTick();
    if (cache && cacheTick === tick) {
        return cache;
    }

    cacheTick = tick;
    buildCount++;
    cache = {
        tick: tick,
        allCreeps: [],
        visibleRooms: [],
        ownedRooms: [],
        creepsByRole: {},
        creepsByHomeRoom: {},
        creepsByHomeRoomAndRole: {},
        bodyPartsByHomeRoomAndRole: {},
        ownedSpawnRooms: [],
        ownedSpawnsByRoom: {},
        roomFinds: {},
        buildNumber: buildCount
    };

    var gameRooms = typeof Game !== 'undefined' && Game.rooms ? Game.rooms : {};
    for (var roomName in gameRooms) {
        if (!gameRooms.hasOwnProperty(roomName)) {
            continue;
        }
        var room = gameRooms[roomName];
        cache.visibleRooms.push(room);
        if (room && room.controller && room.controller.my) {
            cache.ownedRooms.push(room);
        }
    }

    var seenSpawnRooms = {};
    var gameSpawns = typeof Game !== 'undefined' && Game.spawns ? Game.spawns : {};
    for (var spawnName in gameSpawns) {
        if (!gameSpawns.hasOwnProperty(spawnName)) {
            continue;
        }
        var spawn = gameSpawns[spawnName];
        if (!spawn || !spawn.room || spawn.my === false) {
            continue;
        }
        addIndexedValue(cache.ownedSpawnsByRoom, spawn.room.name, spawn);
        if (
            !seenSpawnRooms[spawn.room.name] &&
            spawn.room.controller &&
            spawn.room.controller.my
        ) {
            seenSpawnRooms[spawn.room.name] = true;
            cache.ownedSpawnRooms.push(spawn.room);
        }
    }

    var gameCreeps = typeof Game !== 'undefined' && Game.creeps ? Game.creeps : {};
    for (var creepName in gameCreeps) {
        if (!gameCreeps.hasOwnProperty(creepName)) {
            continue;
        }

        var creep = gameCreeps[creepName];
        if (!creep) {
            continue;
        }

        cache.allCreeps.push(creep);
        var memory = creep.memory || {};
        var role = memory.role || 'unknown';
        var homeRoom = memory.homeRoom ||
            (creep.room && creep.room.name) || 'unknown';
        addIndexedValue(cache.creepsByRole, role, creep);
        addIndexedValue(cache.creepsByHomeRoom, homeRoom, creep);

        if (!cache.creepsByHomeRoomAndRole[homeRoom]) {
            cache.creepsByHomeRoomAndRole[homeRoom] = {};
        }
        addIndexedValue(cache.creepsByHomeRoomAndRole[homeRoom], role, creep);

        if (!cache.bodyPartsByHomeRoomAndRole[homeRoom]) {
            cache.bodyPartsByHomeRoomAndRole[homeRoom] = {};
        }
        var body = creep.body || [];
        for (var bodyIndex = 0; bodyIndex < body.length; bodyIndex++) {
            var part = body[bodyIndex];
            if (part && part.type && part.hits !== 0) {
                addPartCount(
                    cache.bodyPartsByHomeRoomAndRole[homeRoom],
                    role,
                    part.type
                );
            }
        }
    }

    return cache;
}

function emptyArray() {
    return [];
}

function getAllCreeps() {
    return build().allCreeps;
}

function getVisibleRooms() {
    return build().visibleRooms;
}

function getOwnedRooms() {
    return build().ownedRooms;
}

function getCreepsByRole(role) {
    return build().creepsByRole[role] || emptyArray();
}

function getCreepsByHomeRoom(roomName) {
    return build().creepsByHomeRoom[roomName] || emptyArray();
}

function getCreepsByHomeRoomAndRole(roomName, role) {
    var roomIndex = build().creepsByHomeRoomAndRole[roomName];
    return roomIndex && roomIndex[role] ? roomIndex[role] : emptyArray();
}

function getOwnedSpawnRooms() {
    return build().ownedSpawnRooms;
}

function getOwnedSpawnsInRoom(roomName) {
    return build().ownedSpawnsByRoom[roomName] || emptyArray();
}

function getBodyPartsByHomeRoomAndRole(roomName) {
    return build().bodyPartsByHomeRoomAndRole[roomName] || {};
}

function getRoomFind(room, key, findType, options) {
    if (!room || !room.name || typeof room.find !== 'function') {
        return emptyArray();
    }

    var data = build();
    if (!data.roomFinds[room.name]) {
        data.roomFinds[room.name] = {};
    }
    if (!data.roomFinds[room.name].hasOwnProperty(key)) {
        data.roomFinds[room.name][key] = room.find(findType, options) || [];
    }
    return data.roomFinds[room.name][key];
}

function getRoomStructures(room) {
    if (typeof FIND_STRUCTURES === 'undefined') {
        return emptyArray();
    }
    return getRoomFind(room, 'structures', FIND_STRUCTURES);
}

function getRoomConstructionSites(room) {
    if (typeof FIND_CONSTRUCTION_SITES === 'undefined') {
        return emptyArray();
    }
    return getRoomFind(room, 'constructionSites', FIND_CONSTRUCTION_SITES);
}

function getHostileCreeps(room) {
    if (typeof FIND_HOSTILE_CREEPS === 'undefined') {
        return emptyArray();
    }
    return getRoomFind(room, 'hostileCreeps', FIND_HOSTILE_CREEPS);
}

function getHostileStructures(room) {
    if (typeof FIND_HOSTILE_STRUCTURES === 'undefined') {
        return emptyArray();
    }
    return getRoomFind(room, 'hostileStructures', FIND_HOSTILE_STRUCTURES);
}

function getSources(room) {
    if (typeof FIND_SOURCES === 'undefined') {
        return emptyArray();
    }
    return getRoomFind(room, 'sources', FIND_SOURCES);
}

function getMyCreepsInRoom(room) {
    if (typeof FIND_MY_CREEPS === 'undefined') {
        return emptyArray();
    }
    return getRoomFind(room, 'myCreeps', FIND_MY_CREEPS);
}

function getMyStructures(room) {
    if (typeof FIND_MY_STRUCTURES === 'undefined') {
        return emptyArray();
    }
    return getRoomFind(room, 'myStructures', FIND_MY_STRUCTURES);
}

function getDebugStats() {
    var data = build();
    return {
        tick: data.tick,
        buildsThisGlobal: buildCount,
        currentBuildNumber: data.buildNumber,
        creeps: data.allCreeps.length,
        visibleRooms: data.visibleRooms.length,
        ownedRooms: data.ownedRooms.length
    };
}

module.exports = {
    build: build,
    getAllCreeps: getAllCreeps,
    getVisibleRooms: getVisibleRooms,
    getOwnedRooms: getOwnedRooms,
    getCreepsByRole: getCreepsByRole,
    getCreepsByHomeRoom: getCreepsByHomeRoom,
    getCreepsByHomeRoomAndRole: getCreepsByHomeRoomAndRole,
    getOwnedSpawnRooms: getOwnedSpawnRooms,
    getOwnedSpawnsInRoom: getOwnedSpawnsInRoom,
    getBodyPartsByHomeRoomAndRole: getBodyPartsByHomeRoomAndRole,
    getRoomStructures: getRoomStructures,
    getRoomConstructionSites: getRoomConstructionSites,
    getHostileCreeps: getHostileCreeps,
    getHostileStructures: getHostileStructures,
    getSources: getSources,
    getMyCreepsInRoom: getMyCreepsInRoom,
    getMyStructures: getMyStructures,
    getDebugStats: getDebugStats
};
