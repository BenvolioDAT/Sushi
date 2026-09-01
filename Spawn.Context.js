const HiveMemory = require('HiveMind.Memory');
const TickIndex = require('HiveMind.Index');

function roleOf(item) {
    return item && (item.role || item.memory && item.memory.role) || null;
}

function increment(map, key) {
    if (key) map[key] = (map[key] || 0) + 1;
}

function healthy(creep, replacementBuffer) {
    if (!creep || creep.ticksToLive === undefined) return true;
    const spawnTime = Array.isArray(creep.body) ? creep.body.length * 3 : 0;
    return creep.ticksToLive > spawnTime + (replacementBuffer || 0);
}

function snapshot(roomName, replacementBuffer = 0) {
    const seen = new Set();
    const byRole = {};
    let living = 0;
    let spawning = 0;
    const index = TickIndex.get();
    for (const creep of index.creepsByHomeRoom.get(roomName) || []) {
        if (!healthy(creep, replacementBuffer)) continue;
        const key = creep.name || creep.id;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        living++;
        increment(byRole, roleOf(creep));
    }
    for (const spawn of index.ownedSpawnsByRoom.get(roomName) || []) {
        const name = spawn && spawn.spawning && spawn.spawning.name;
        if (!name || seen.has(name)) continue;
        const memory = Memory.creeps && Memory.creeps[name];
        seen.add(name);
        spawning++;
        increment(byRole, roleOf({ memory }));
    }
    const queue = HiveMemory.getRoomSpawnMemory(roomName).queue;
    const requestIds = new Set();
    let queued = 0;
    for (const request of queue) {
        if (!request) continue;
        queued++;
        increment(byRole, roleOf(request));
        if (request.requestId) requestIds.add(request.requestId);
    }
    return {
        roomName, living, spawning, queued,
        total: living + spawning + queued,
        byRole, requestIds, queue
    };
}

module.exports = { snapshot, roleOf, healthy };
