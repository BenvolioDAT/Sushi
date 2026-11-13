// Bounded operational accounting, not a planner. Event logs report resolved
// actions from the preceding tick; successful intents alone are not income.
const Index = require('HiveMind.Index');
const BUCKET_TICKS = 250, KEEP_BUCKETS = 8, MAX_ACTORS = 128;
function enabled() { return Memory.config?.remote?.accountingEnabled !== false; }
function ledger(parent, key) {
    let value = parent[key];
    if (!value || value.version !== 1 || value.since > Game.time) {
        value = parent[key] = { version: 1, since: Game.time, buckets: [] };
    }
    value.buckets = (value.buckets || []).filter(b => b.at <= Game.time && b.at >=
        Math.floor(Game.time / BUCKET_TICKS) * BUCKET_TICKS - (KEEP_BUCKETS - 1) * BUCKET_TICKS).slice(-KEEP_BUCKETS);
    return value;
}
function add(value, field, amount) {
    if (!(Number.isFinite(amount) && amount > 0)) return;
    const at = Math.floor(Game.time / BUCKET_TICKS) * BUCKET_TICKS;
    let bucket = value.buckets.find(b => b.at === at);
    if (!bucket) { bucket = { at }; value.buckets.push(bucket); }
    bucket[field] = Math.min(1e12, (bucket[field] || 0) + amount);
}
function sourceLedger(home, id) {
    const info = Memory.rooms?.[home]?.remotePlanner?.sourceInfos?.[id];
    return info && ledger(info, 'accounting');
}
function kind(memory) {
    if (memory.role === 'Extractor' && memory.remoteMining) return 'miner';
    if (memory.role === 'Freighter' && (memory.assignmentFunction === 'remoteHauling' ||
        memory.remoteDeliverySourceId || memory.freighterJob === 'remote')) return 'hauler';
    if (memory.role === 'Annex') return 'reservation';
    if (memory.keeperOperationId || memory.npcCoreOperationId) return 'defense';
    return null;
}
function sampleActors(home, value, creeps) {
    const actors = value.actors || (value.actors = {}), alive = new Set();
    for (const creep of creeps) {
        const type = kind(creep.memory || {});
        if (!type || creep.spawning) continue;
        alive.add(creep.id);
        const previous = actors[creep.id];
        if (!previous && Object.keys(actors).length >= MAX_ACTORS) continue;
        actors[creep.id] = { seen: Game.time, death: Game.time + (creep.ticksToLive || 0),
            cargo: creep.store && creep.store[RESOURCE_ENERGY] || 0, type,
            source: creep.memory.sourceId || creep.memory.remoteDeliverySourceId || creep.memory.pickupSourceId || null };
    }
    for (const [id, actor] of Object.entries(actors)) {
        if (alive.has(id)) continue;
        // A sampling gap/global reset cannot establish a loss tick or cause.
        if (actor.seen === Game.time - 1) {
            const field = actor.death > Game.time ? 'earlyLosses' : 'expiredWorkers';
            add(value, field, 1); add(value, 'lostCargo', actor.cargo);
            const source = actor.source && sourceLedger(home, actor.source);
            if (source) { add(source, field, 1); add(source, 'lostCargo', actor.cargo); }
        }
        delete actors[id];
    }
}
function run() {
    if (!enabled()) return;
    const index = Index.get(), homes = [];
    for (const [home, roomMemory] of Object.entries(Memory.rooms || {})) {
        if (!roomMemory.remotePlanner || !index.ownedRooms.some(r => r.name === home)) continue;
        const value = ledger(roomMemory, 'remoteAccounting');
        if (value.lastTick === Game.time) continue;
        value.lastTick = Game.time;
        homes.push(home);
        add(value, 'sampledTicks', 1);
        for (const info of Object.values(roomMemory.remotePlanner.sourceInfos || {})) {
            if (!info || !info.sourceId) continue;
            const source = info.accounting && ledger(info, 'accounting') ||
                info.active && sourceLedger(home, info.sourceId);
            if (source && info.active) {
                add(source, 'selectedTicks', 1);
                if (Game.rooms[info.roomName]) add(source, 'visibleTicks', 1);
            }
        }
        sampleActors(home, value, index.creepsByHomeRoom.get(home) || []);
    }
    if (!homes.length) return;
    for (const room of index.visibleRooms) {
        if (typeof room.getEventLog !== 'function') continue;
        for (const event of room.getEventLog()) {
            const data = event.data || {};
            const actor = Game.getObjectById(event.objectId);
            const home = actor?.my && actor.memory?.homeRoom;
            if (!home || !homes.includes(home)) continue;
            const value = Memory.rooms[home].remoteAccounting;
            if (typeof EVENT_HARVEST !== 'undefined' && event.event === EVENT_HARVEST) {
                const source = sourceLedger(home, data.targetId);
                if (source) { add(source, 'harvested', data.amount); add(value, 'harvested', data.amount); }
            }
            if (typeof EVENT_TRANSFER !== 'undefined' && event.event === EVENT_TRANSFER &&
                actor.memory.role === 'Freighter' && actor.memory.remoteDeliverySourceId &&
                room.name === home && data.resourceType === RESOURCE_ENERGY) {
                const target = Game.getObjectById(data.targetId);
                // A transfer into another creep is not yet a home infrastructure delivery.
                if (!target || !target.structureType || target.pos.roomName !== home) continue;
                const source = sourceLedger(home, actor.memory.remoteDeliverySourceId);
                if (source) {
                    add(source, 'delivered', data.amount); add(value, 'delivered', data.amount);
                    source.lastDelivery = Game.time - 1;
                }
            }
        }
    }
}
function recordSpawn(home, request, body) {
    if (!enabled()) return;
    const memory = request.memory || {}, type = kind({ ...memory, role: request.role || memory.role });
    const room = Memory.rooms?.[home];
    if (!type || !room?.remotePlanner) return;
    const value = ledger(room, 'remoteAccounting');
    const cost = (body || []).reduce((sum, part) => sum + (BODYPART_COST[part.type || part] || 0), 0);
    add(value, type + 'SpawnCost', cost); add(value, type + 'SpawnTicks', body.length * 3);
    const source = memory.sourceId && sourceLedger(home, memory.sourceId);
    if (source && type === 'miner') add(source, 'minerSpawnCost', cost);
}
function summary(value) {
    if (!value || value.version !== 1 || value.since > Game.time) return null;
    const buckets = (value.buckets || []).filter(b => b.at <= Game.time && b.at >=
        Math.floor(Game.time / BUCKET_TICKS) * BUCKET_TICKS - (KEEP_BUCKETS - 1) * BUCKET_TICKS);
    const start = Math.max(value.since, buckets.length ? buckets[0].at : Game.time);
    const ticks = Math.max(1, Game.time - start + 1), sums = {};
    for (const bucket of buckets) for (const [field, amount] of Object.entries(bucket)) {
        if (field !== 'at' && Number.isFinite(amount)) sums[field] = (sums[field] || 0) + amount;
    }
    return { start, end: Game.time, ticks, ...sums,
        deliveredEPT: (sums.delivered || 0) / ticks, harvestedEPT: (sums.harvested || 0) / ticks,
        lastDelivery: value.lastDelivery || null };
}
module.exports = { run, recordSpawn, summary, BUCKET_TICKS, KEEP_BUCKETS };
