const HiveMemory = require('HiveMind.Memory');
const TickIndex = require('HiveMind.Index');
const { isCombatRole } = require('Combat.Roles');

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
    let nonCombatLiving = 0;
    let nonCombatSpawning = 0;
    const index = TickIndex.get();
    for (const creep of index.creepsByHomeRoom.get(roomName) || []) {
        if (!healthy(creep, replacementBuffer)) continue;
        const key = creep.name || creep.id;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        if (creep.spawning) spawning++;
        else living++;
        const role = roleOf(creep);
        increment(byRole, role);
        if (!isCombatRole(role)) {
            if (creep.spawning) nonCombatSpawning++;
            else nonCombatLiving++;
        }
    }
    for (const spawn of (index.ownedSpawnsByRoom.get(roomName) || []).concat(
        require('Spawn.Intents').get().spawns.filter(s => s.room.name === roomName))) {
        const name = spawn && spawn.spawning && spawn.spawning.name;
        if (!name || seen.has(name)) continue;
        const memory = spawn.request && spawn.request.memory || Memory.creeps && Memory.creeps[name];
        seen.add(name);
        spawning++;
        const role = roleOf({ memory });
        increment(byRole, role);
        if (!isCombatRole(role)) nonCombatSpawning++;
    }
    const queue = HiveMemory.getRoomSpawnMemory(roomName).queue;
    const requestIds = new Set();
    let queued = 0;
    let nonCombatQueued = 0;
    for (const request of queue) {
        if (!request) continue;
        queued++;
        const role = roleOf(request);
        increment(byRole, role);
        if (!isCombatRole(role)) nonCombatQueued++;
        if (request.requestId) requestIds.add(request.requestId);
    }
    return {
        roomName, living, spawning, queued,
        total: living + spawning + queued,
        nonCombatLiving, nonCombatSpawning, nonCombatQueued,
        nonCombatTotal: nonCombatLiving + nonCombatSpawning + nonCombatQueued,
        byRole, requestIds, queue
    };
}

function capability(roomName, role, partType) {
    const result = { active: 0, spawning: 0, queued: 0 }, seen = new Set();
    const index = TickIndex.get();
    for (const creep of index.creepsByHomeRoom.get(roomName) || []) {
        seen.add(creep.name);
        if (roleOf(creep) !== role || !healthy(creep, 40)) continue;
        result[creep.spawning ? 'spawning' : 'active'] += (creep.body || []).filter(p =>
            (p.type || p) === partType && p.hits !== 0).length;
    }
    for (const spawn of (index.ownedSpawnsByRoom.get(roomName) || []).concat(
        require('Spawn.Intents').get().spawns.filter(s => s.room.name === roomName))) {
        const name = spawn.spawning && spawn.spawning.name;
        const memory = spawn.request && spawn.request.memory || name && Memory.creeps && Memory.creeps[name];
        if (name && !seen.has(name) && memory && memory.role === role) {
            result.spawning += memory.spawnCapability && memory.spawnCapability[partType] || 0;
            seen.add(name);
        }
    }
    for (const request of HiveMemory.getRoomSpawnMemory(roomName).queue) if (roleOf(request) === role) {
        result.queued += (request.body || []).filter(p => (p.type || p) === partType).length;
    }
    return result;
}
function replacementClaims(roomName, role, excludeRequest) {
    const claimed = new Set(), seen = new Set(), index = TickIndex.get();
    if (!['Tech', 'Artificer'].includes(role)) return claimed;
    const predecessor = name => {
        const c = Game.creeps[name];
        return c && roleOf(c) === role && c.memory.homeRoom === roomName &&
            c.ticksToLive > 0 && c.ticksToLive <= 150 ? c : null;
    };
    const add = (memory, work) => {
        if (!memory || memory.role !== role || memory.homeRoom !== roomName ||
            !(memory.workerReplacementWork > 0) || work < memory.workerReplacementWork) return;
        for (const entry of (Array.isArray(memory.workerPredecessors) ? memory.workerPredecessors : []).slice(0,50)) {
            const old = predecessor(entry?.name);
            if (old && entry.deathAt === Game.time + old.ticksToLive &&
                (role !== 'Artificer' || old.memory.artificerWorkCategory === memory.artificerWorkCategory)) claimed.add(old.name);
        }
    };
    for (const c of index.creepsByHomeRoom.get(roomName) || []) {
        seen.add(c.name);
        add(c.memory, (c.body || []).filter(p => (p.type || p) === WORK && p.hits !== 0).length);
    }
    for (const spawn of (index.ownedSpawnsByRoom.get(roomName) || []).concat(require('Spawn.Intents').get().spawns)) {
        const name = spawn.spawning?.name;
        if (spawn.room.name !== roomName || !name || seen.has(name)) continue;
        const memory = spawn.request?.memory || Memory.creeps?.[name];
        add(memory, memory?.spawnCapability?.work || 0); seen.add(name);
    }
    for (const q of HiveMemory.getRoomSpawnMemory(roomName).queue) {
        if (q === excludeRequest || q.expiresAt < Game.time || roleOf(q) !== role) continue;
        for (const name of (Array.isArray(q.replacementFor) ? q.replacementFor : []).slice(0,50)) if (predecessor(name)) claimed.add(name);
    }
    return claimed;
}
module.exports = { snapshot, capability, replacementClaims, roleOf, healthy, isCombatRole };
