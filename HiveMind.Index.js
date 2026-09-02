/* Heap-only, automatically rebuilt empire snapshot. Never store this in Memory. */
let buildCount = 0;

function add(map, key, value) {
    const safeKey = key || 'unknown';
    if (!map.has(safeKey)) map.set(safeKey, []);
    map.get(safeKey).push(value);
}

function safeFind(room, constant) {
    if (!room || typeof room.find !== 'function' || constant === undefined) return [];
    try {
        return room.find(constant) || [];
    }
    catch (error) {
        return [];
    }
}

function activePartCount(creep, type) {
    if (!creep || !Array.isArray(creep.body)) return 0;
    let count = 0;
    for (const part of creep.body) {
        if (part && part.type === type && part.hits !== 0) count++;
    }
    return count;
}

function isCombatCapable(creep) {
    const capabilities = [
        typeof ATTACK !== 'undefined' ? ATTACK : 'attack',
        typeof RANGED_ATTACK !== 'undefined' ? RANGED_ATTACK : 'ranged_attack',
        typeof HEAL !== 'undefined' ? HEAL : 'heal',
        typeof WORK !== 'undefined' ? WORK : 'work',
        typeof CLAIM !== 'undefined' ? CLAIM : 'claim'
    ];
    return capabilities.some(type => activePartCount(creep, type) > 0);
}

function structuresByType(structures) {
    const result = new Map();
    for (const structure of structures) add(result, structure.structureType, structure);
    return result;
}

function build() {
    const tick = typeof Game !== 'undefined' && typeof Game.time === 'number' ? Game.time : -1;
    if (global.__sushiTickIndex && global.__sushiTickIndex.tick === tick) {
        return global.__sushiTickIndex;
    }

    buildCount++;
    const index = {
        tick,
        buildNumber: buildCount,
        allCreeps: [],
        creepsByRole: new Map(),
        creepsByHomeRoom: new Map(),
        creepsByCurrentRoom: new Map(),
        creepsByOperationId: new Map(),
        creepsBySquadId: new Map(),
        ownedRooms: [],
        visibleRooms: [],
        ownedSpawns: [],
        ownedSpawnsByRoom: new Map(),
        ownedSpawnRooms: [],
        structuresByRoom: new Map(),
        constructionSitesByRoom: new Map(),
        droppedResourcesByRoom: new Map(),
        hostilesByRoom: new Map(),
        combatHostilesByRoom: new Map(),
        powerCreepsByRoom: new Map(),
        spawnedAndSpawningNames: new Set(),
        spawnRequests: [],
        spawnRequestsByRoom: new Map(),
        movementIntentsByRoom: new Map(),
        activeThreatRooms: new Set()
    };

    const gameCreeps = typeof Game !== 'undefined' && Game.creeps ? Game.creeps : {};
    for (const creep of Object.values(gameCreeps)) {
        if (!creep) continue;
        index.allCreeps.push(creep);
        if (creep.name) index.spawnedAndSpawningNames.add(creep.name);
        const memory = creep.memory || {};
        const currentRoom = creep.room && creep.room.name;
        add(index.creepsByRole, memory.role, creep);
        add(index.creepsByHomeRoom, memory.homeRoom || currentRoom, creep);
        add(index.creepsByCurrentRoom, currentRoom, creep);
        if (memory.operationId) add(index.creepsByOperationId, memory.operationId, creep);
        if (memory.squadId) add(index.creepsBySquadId, memory.squadId, creep);
    }

    const gameRooms = typeof Game !== 'undefined' && Game.rooms ? Game.rooms : {};
    for (const room of Object.values(gameRooms)) {
        if (!room) continue;
        index.visibleRooms.push(room);
        if (room.controller && room.controller.my) index.ownedRooms.push(room);
        const structures = safeFind(room, typeof FIND_STRUCTURES !== 'undefined' ? FIND_STRUCTURES : undefined);
        index.structuresByRoom.set(room.name, structuresByType(structures));
        index.constructionSitesByRoom.set(
            room.name,
            safeFind(room, typeof FIND_CONSTRUCTION_SITES !== 'undefined' ? FIND_CONSTRUCTION_SITES : undefined)
        );
        index.droppedResourcesByRoom.set(
            room.name,
            safeFind(room, typeof FIND_DROPPED_RESOURCES !== 'undefined' ? FIND_DROPPED_RESOURCES : undefined)
        );
        const hostiles = safeFind(room, typeof FIND_HOSTILE_CREEPS !== 'undefined' ? FIND_HOSTILE_CREEPS : undefined);
        index.hostilesByRoom.set(room.name, hostiles);
        const combatHostiles = hostiles.filter(isCombatCapable);
        index.combatHostilesByRoom.set(room.name, combatHostiles);
        if (combatHostiles.length) index.activeThreatRooms.add(room.name);
        const hostilePower = safeFind(
            room,
            typeof FIND_HOSTILE_POWER_CREEPS !== 'undefined' ? FIND_HOSTILE_POWER_CREEPS : undefined
        );
        const myPower = safeFind(
            room,
            typeof FIND_MY_POWER_CREEPS !== 'undefined' ? FIND_MY_POWER_CREEPS : undefined
        );
        index.powerCreepsByRoom.set(room.name, hostilePower.concat(myPower));
    }

    const seenSpawnRooms = new Set();
    const gameSpawns = typeof Game !== 'undefined' && Game.spawns ? Game.spawns : {};
    for (const spawn of Object.values(gameSpawns)) {
        if (!spawn || !spawn.room || spawn.my === false) continue;
        index.ownedSpawns.push(spawn);
        add(index.ownedSpawnsByRoom, spawn.room.name, spawn);
        if (spawn.spawning && spawn.spawning.name) index.spawnedAndSpawningNames.add(spawn.spawning.name);
        if (spawn.room.controller && spawn.room.controller.my && !seenSpawnRooms.has(spawn.room.name)) {
            seenSpawnRooms.add(spawn.room.name);
            index.ownedSpawnRooms.push(spawn.room);
        }
    }

    const memoryRooms = typeof Memory !== 'undefined' && Memory.rooms ? Memory.rooms : {};
    for (const [roomName, roomMemory] of Object.entries(memoryRooms)) {
        const requests = roomMemory && roomMemory.spawn && Array.isArray(roomMemory.spawn.queue) ?
            roomMemory.spawn.queue : [];
        index.spawnRequestsByRoom.set(roomName, requests);
        for (const request of requests) index.spawnRequests.push(request);
    }

    global.__sushiTickIndex = index;
    return index;
}

function get() {
    return build();
}

function resetForTests() {
    delete global.__sushiTickIndex;
    buildCount = 0;
}

module.exports = { build, get, resetForTests, isCombatCapable, activePartCount };
