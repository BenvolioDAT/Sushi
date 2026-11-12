// Room-local observations only. A predicted timer is never proof of safety.
const Index = require('HiveMind.Index');
const MathCombat = require('Combat.Math');
const range = MathCombat.rangeBetween;
const pos = p => ({ x: p.x, y: p.y, roomName: p.roomName });

function observe(room) {
    if (!room) return null;
    Memory.rooms = Memory.rooms || {};
    const memory = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
    if (memory.keeperIntel && memory.keeperIntel.observedAt === Game.time) return memory.keeperIntel;
    const index = Index.get(), byType = index.structuresByRoom.get(room.name);
    const lairs = byType && byType.get('keeperLair') || [];
    if (!lairs.length && !memory.keeperIntel) return null;
    const resources = Index.getSources(room).concat(Index.getMinerals(room));
    const hostiles = index.hostilesByRoom.get(room.name) || [];
    const keepers = hostiles.filter(c => c.owner && c.owner.username === 'Source Keeper');
    const intel = { version: 1, observedAt: Game.time, lairs: {}, resources: {},
        keepers: keepers.map(c => ({ id: c.id, name: c.name, pos: pos(c.pos), hits: c.hits })),
        otherHostiles: hostiles.some(c => !c.owner || c.owner.username !== 'Source Keeper'),
        core: !!(byType && (byType.get('invaderCore') || []).length) };
    for (const resource of resources) intel.resources[resource.id] = {
        id: resource.id, pos: pos(resource.pos), kind: resource.energyCapacity === undefined ? 'mineral' : 'source',
        capacity: resource.energyCapacity || 0
    };
    for (const lair of lairs) {
        // This server selects the first source/mineral within five tiles at spawn,
        // not necessarily the nearest. Retain every candidate when they overlap.
        const candidates = resources.filter(resource => range(lair, resource) <= 5);
        // The engine names each Keeper after its lair.
        const guards = keepers.filter(c => c.name === 'Keeper' + lair.id);
        intel.lairs[lair.id] = { id: lair.id, pos: pos(lair.pos),
            resourceIds: candidates.map(resource => resource.id), keeperIds: guards.map(c => c.id),
            nextSpawnAt: Number.isFinite(lair.ticksToSpawn) ? Game.time + Math.max(0, lair.ticksToSpawn) : null };
    }
    memory.keeperIntel = intel;
    return intel;
}

function get(roomName) {
    return Game.rooms[roomName] ? observe(Game.rooms[roomName]) :
        Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].keeperIntel || null;
}

function known(roomName) {
    const data = get(roomName);
    return !!(data && Object.keys(data.lairs).length);
}

function windowFor(roomName, resourceId, options = {}) {
    const data = get(roomName);
    const result = { safe: false, reason: 'KEEPER_NEEDS_VISION', safeTicks: 0 };
    if (!data || !Game.rooms[roomName] || data.observedAt !== Game.time) return result;
    if (data.core || data.otherHostiles) return { ...result, reason: data.core ? 'INVADER_CORE' : 'OTHER_HOSTILE' };
    const lairs = Object.values(data.lairs).filter(l => l.resourceIds.includes(resourceId));
    if (!lairs.length) return { ...result, reason: 'KEEPER_RESOURCE_UNMAPPED' };
    const resource = data.resources[resourceId];
    if (lairs.some(l => l.keeperIds.length) || resource && data.keepers.some(k => range(k.pos, resource.pos) <= 7)) return { ...result, reason: 'ACTIVE_KEEPER' };
    if (lairs.some(l => l.nextSpawnAt === null)) return { ...result, reason: 'KEEPER_TIMER_UNKNOWN' };
    const safeTicks = Math.max(0, Math.min(...lairs.map(l => l.nextSpawnAt - Game.time)));
    // Escape is mandatory: callers without validated route travel cannot enter.
    if (!Number.isFinite(options.escapeTicks) || options.escapeTicks < 0) return { ...result, reason: 'KEEPER_ESCAPE_UNKNOWN' };
    const needed = Math.max(0, options.approachTicks || 0) + Math.max(1, options.workTicks || 5) + options.escapeTicks + 10;
    return { safe: safeTicks > needed, safeTicks, neededTicks: needed,
        reason: safeTicks > needed ? 'KEEPER_WINDOW_OPEN' : 'KEEPER_SPAWN_SOON' };
}

function hazards(roomName) {
    const data = get(roomName);
    if (!data) return [];
    const fresh = !!Game.rooms[roomName] && data.observedAt === Game.time;
    const points = data.keepers.map(k => ({ pos: k.pos, range: 5 }));
    for (const lair of Object.values(data.lairs)) {
        if (!fresh || lair.nextSpawnAt === null || lair.nextSpawnAt - Game.time < 50 || lair.keeperIds.length) {
            points.push({ pos: lair.pos, range: 6 });
            for (const id of lair.resourceIds) if (data.resources[id]) points.push({ pos: data.resources[id].pos, range: 5 });
        }
    }
    return points;
}

function applyCosts(roomName, matrix, escape = false) {
    for (const hazard of hazards(roomName)) {
        for (let x = Math.max(0, hazard.pos.x - hazard.range); x <= Math.min(49, hazard.pos.x + hazard.range); x++) {
            for (let y = Math.max(0, hazard.pos.y - hazard.range); y <= Math.min(49, hazard.pos.y + hazard.range); y++) {
                if (matrix.get(x, y) < 255) matrix.set(x, y, escape ? 50 : 255);
            }
        }
    }
    return matrix;
}

// Recheck actual lane terrain/roads and loaded body weight. Unknown coordinates
// retain the conservative swamp estimate; destroyed MOVE reduces escape speed.
function escapeTicks(creep, path, roomName) {
    if (!path || !path.length) return Infinity;
    const steps = path.filter(p => p.roomName === roomName).length;
    if (!steps) return Infinity;
    const body = MathCombat.analyzeBody(creep);
    if (!(body.movePower > 0)) return Infinity;
    const weight = (creep.body || []).filter(p => p.type !== MOVE).length;
    const byType = Index.get().structuresByRoom.get(roomName);
    const roads = new Set((byType && byType.get('road') || []).map(r => r.pos.x * 50 + r.pos.y));
    const terrain = Game.map.getRoomTerrain(roomName);
    let ticks = Math.ceil((creep.fatigue || 0) / body.movePower);
    for (const p of path) if (p.roomName === roomName) {
        const knownPosition = Number.isInteger(p.x) && Number.isInteger(p.y);
        const cost = !knownPosition ? 10 : roads.has(p.x * 50 + p.y) ? 1 : terrain.get(p.x, p.y) === TERRAIN_MASK_SWAMP ? 10 : 2;
        ticks += Math.max(1, Math.ceil(weight * cost / body.movePower));
    }
    return ticks;
}

module.exports = { observe, get, known, windowFor, hazards, applyCosts, escapeTicks };
