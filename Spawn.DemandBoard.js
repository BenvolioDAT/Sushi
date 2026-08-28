const HiveMemory = require('HiveMind.Memory');
const TickIndex = require('HiveMind.Index');
const spawnManager = require('spawn.manager');
const bodyConfig = require('role.creepBodyConfig');

function tickState() {
    const hive = HiveMemory.ensure();
    if (!global.__sushiDemandBoard || global.__sushiDemandBoard.tick !== Game.time ||
        global.__sushiDemandBoard.hive !== hive) {
        global.__sushiDemandBoard = { tick: Game.time, hive, demands: new Map(), emitted: new Set() };
    }
    return global.__sushiDemandBoard;
}

function stableId(demand) {
    if (demand.id) return demand.id;
    return [
        'demand', demand.operationId || 'none', demand.role || 'capability',
        demand.originRoom || 'any', demand.targetRoom || 'none', demand.squadId || 'none'
    ].join(':');
}

function plainDemand(input) {
    const demand = {
        id: stableId(input),
        operationId: input.operationId || null,
        squadId: input.squadId || null,
        role: input.role || null,
        capabilities: input.capabilities ? { ...input.capabilities } : null,
        count: Math.max(0, Math.floor(input.count || 0)),
        priority: Number.isFinite(input.priority) ? input.priority : 50,
        deadline: Number.isFinite(input.deadline) ? input.deadline : null,
        originRoom: input.originRoom || null,
        targetRoom: input.targetRoom || null,
        preferredSpawnRoom: input.preferredSpawnRoom || null,
        bodyRequirements: input.bodyRequirements ? { ...input.bodyRequirements } : null,
        boostRequirements: input.boostRequirements ? { ...input.boostRequirements } : null,
        replacementBuffer: Number.isFinite(input.replacementBuffer) ? input.replacementBuffer : 50,
        validUntil: Number.isFinite(input.validUntil) ? input.validUntil : Game.time + 25,
        emergency: input.emergency === true,
        memory: input.memory ? { ...input.memory } : {},
        reason: input.reason || null,
        emittedTick: Game.time
    };
    return demand;
}

function beginTick() {
    const state = tickState();
    const hive = HiveMemory.ensure();
    for (const [id, saved] of Object.entries(hive.demands)) {
        const operation = saved.operationId && hive.operations[saved.operationId];
        const operationEnded = operation && (operation.state === 'COMPLETE' || operation.state === 'ABORTED');
        if (!saved || saved.validUntil < Game.time || operationEnded) {
            delete hive.demands[id];
            state.demands.delete(id);
            continue;
        }
        state.demands.set(id, saved);
    }
    return state;
}

function emit(input) {
    const state = beginTick();
    const incoming = plainDemand(input || {});
    if (!incoming.role && !incoming.capabilities) throw new Error('Spawn demand requires a role or capabilities');
    const existing = state.demands.get(incoming.id);
    const merged = existing ? {
        ...existing,
        ...incoming,
        count: Math.max(existing.count || 0, incoming.count || 0),
        priority: Math.max(existing.priority || 0, incoming.priority || 0),
        deadline: existing.deadline === null ? incoming.deadline :
            incoming.deadline === null ? existing.deadline : Math.min(existing.deadline, incoming.deadline),
        validUntil: Math.max(existing.validUntil || 0, incoming.validUntil || 0),
        emergency: existing.emergency || incoming.emergency
    } : incoming;
    state.demands.set(merged.id, merged);
    state.emitted.add(merged.id);
    HiveMemory.ensure().demands[merged.id] = merged;
    return merged;
}

function memoryMatches(demand, memory) {
    if (!memory) return false;
    if (memory.demandId === demand.id) return true;
    if (demand.squadId && memory.squadId !== demand.squadId) return false;
    if (demand.operationId && memory.operationId === demand.operationId && memory.role === demand.role) return true;
    if (demand.operationId && demand.operationId.startsWith('expand:') &&
        memory.expansionId === demand.targetRoom && memory.role === demand.role) return true;
    if (demand.memory && demand.memory.season11AssignmentKey &&
        memory.season11AssignmentKey === demand.memory.season11AssignmentKey &&
        memory.role === demand.role) return true;
    return false;
}

function cancel(id) {
    if (!id) return false;
    const state = beginTick();
    const existed = state.demands.delete(id) || !!HiveMemory.ensure().demands[id];
    state.emitted.delete(id);
    delete HiveMemory.ensure().demands[id];
    for (const roomMemory of Object.values(Memory.rooms || {})) {
        const queue = roomMemory && roomMemory.spawnQueue;
        if (!Array.isArray(queue)) continue;
        for (let index = queue.length - 1; index >= 0; index--) {
            const request = queue[index];
            if (request && request.memory && request.memory.demandId === id) queue.splice(index, 1);
        }
    }
    return existed;
}

function assignmentCount(demand) {
    const seen = new Set();
    let count = 0;
    for (const creep of TickIndex.get().allCreeps) {
        if (!creep || !memoryMatches(demand, creep.memory)) continue;
        const lead = (creep.body ? creep.body.length * 3 : 0) + demand.replacementBuffer;
        if (creep.ticksToLive !== undefined && creep.ticksToLive <= lead) continue;
        const key = creep.name || creep.id;
        if (!seen.has(key)) {
            seen.add(key);
            count++;
        }
    }
    for (const spawn of TickIndex.get().ownedSpawns) {
        const name = spawn && spawn.spawning && spawn.spawning.name;
        const memory = name && Memory.creeps && Memory.creeps[name];
        if (!name || seen.has(name) || !memoryMatches(demand, memory)) continue;
        seen.add(name);
        count++;
    }
    const rooms = Memory.rooms || {};
    for (const [roomName, roomMemory] of Object.entries(rooms)) {
        const queue = roomMemory && roomMemory.spawnQueue || [];
        for (let requestIndex = 0; requestIndex < queue.length; requestIndex++) {
            const request = queue[requestIndex];
            if (!memoryMatches(demand, request.memory)) continue;
            const key = `queued:${roomName}:${requestIndex}:${request.requestedAt || 0}`;
            if (!seen.has(key)) {
                seen.add(key);
                count++;
            }
        }
    }
    return count;
}

function roomSurvivalReady(room, demand) {
    if (demand.emergency) return true;
    const creeps = TickIndex.get().creepsByHomeRoom.get(room.name) || [];
    const roles = new Set(creeps.map(creep => creep.memory && creep.memory.role));
    return roles.has('Foreman') && roles.has('Extractor') && roles.has('Freighter');
}

function bodyForDemand(demand, room) {
    const specified = demand.bodyRequirements && demand.bodyRequirements.body;
    if (Array.isArray(specified) && specified.length) return specified.slice();
    return demand.role ? bodyConfig.getBody(demand.role, room) : null;
}

function spawnRoomScore(room, demand) {
    if (!room || !room.controller || !room.controller.my || !roomSurvivalReady(room, demand)) return -Infinity;
    const body = bodyForDemand(demand, room);
    if (!body || !body.length) return -Infinity;
    const cost = spawnManager.getBodyCost(body);
    if ((room.energyCapacityAvailable || 0) < cost) return -Infinity;
    const distance = demand.targetRoom && Game.map && typeof Game.map.getRoomLinearDistance === 'function' ?
        Game.map.getRoomLinearDistance(room.name, demand.targetRoom) : 0;
    let score = (room.energyAvailable || 0) - cost - distance * 100;
    if (demand.originRoom === room.name) score += 1000;
    if (demand.preferredSpawnRoom === room.name) score += 2000;
    return score;
}

function chooseSpawnRoom(demand) {
    const candidates = TickIndex.get().ownedSpawnRooms.slice();
    candidates.sort((a, b) => {
        const difference = spawnRoomScore(b, demand) - spawnRoomScore(a, demand);
        return difference || a.name.localeCompare(b.name);
    });
    return candidates.length && spawnRoomScore(candidates[0], demand) > -Infinity ? candidates[0] : null;
}

function queueDemand(demand, room, count) {
    const queue = spawnManager.getSpawnQueue(room.name);
    const body = bodyForDemand(demand, room);
    if (!queue || !body) return 0;
    let added = 0;
    const limit = Math.min(count, demand.emergency ? 3 : 1);
    for (let i = 0; i < limit; i++) {
        const memory = {
            role: demand.role,
            homeRoom: room.name,
            targetRoom: demand.targetRoom,
            operationId: demand.operationId,
            squadId: demand.squadId,
            demandId: demand.id,
            boostRequirements: demand.boostRequirements
        };
        Object.assign(memory, demand.memory || {});
        queue.push({
            role: demand.role,
            body,
            priority: demand.priority,
            deadline: demand.deadline,
            demandId: demand.id,
            operationId: demand.operationId,
            memory,
            requestedAt: Game.time,
            expiresAt: demand.validUntil
        });
        added++;
    }
    queue.sort((a, b) => (b.priority || 0) - (a.priority || 0) || (a.requestedAt || 0) - (b.requestedAt || 0));
    return added;
}

function cleanupQueues(activeIds) {
    for (const roomMemory of Object.values(Memory.rooms || {})) {
        const queue = roomMemory && roomMemory.spawnQueue;
        if (!Array.isArray(queue)) continue;
        for (let i = queue.length - 1; i >= 0; i--) {
            const demandId = queue[i] && queue[i].memory && queue[i].memory.demandId;
            if (demandId && !activeIds.has(demandId)) queue.splice(i, 1);
            else if (queue[i] && queue[i].expiresAt && queue[i].expiresAt < Game.time) queue.splice(i, 1);
        }
    }
}

function flush() {
    const state = beginTick();
    const demands = Array.from(state.demands.values())
        .filter(demand => demand.count > 0 && demand.validUntil >= Game.time)
        .sort((a, b) => b.priority - a.priority ||
            (a.deadline || Infinity) - (b.deadline || Infinity) || a.id.localeCompare(b.id));
    const activeIds = new Set(demands.map(demand => demand.id));
    cleanupQueues(activeIds);
    const report = { tick: Game.time, demands: {}, rooms: {} };
    for (const demand of demands) {
        const assigned = assignmentCount(demand);
        const missing = Math.max(0, demand.count - assigned);
        const room = missing > 0 ? chooseSpawnRoom(demand) : null;
        const queued = room ? queueDemand(demand, room, missing) : 0;
        report.demands[demand.id] = {
            role: demand.role, desired: demand.count, assigned, missing,
            queued, spawnRoom: room && room.name || null
        };
        if (room) report.rooms[room.name] = true;
    }
    return report;
}

function getDemands() {
    return Array.from(beginTick().demands.values());
}

module.exports = { beginTick, emit, cancel, flush, getDemands, assignmentCount, chooseSpawnRoom, memoryMatches };
