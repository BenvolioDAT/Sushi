/* Local source capability planning, shared by Economy and the spawn pipeline.
 * No creep actions, queue writes or persistent controller live here. */
const Bodies = require('BodyProfiles');
const sourceId = m => m && (m.sourceId || m.targetSourceId || m.assignedSource);
const parts = (creep, type) => typeof creep.getActiveBodyparts === 'function' ?
    creep.getActiveBodyparts(type) : (creep.body || []).filter(p => (p.type || p) === type && p.hits !== 0).length;
function energyCapacity(room) {
    const declared = Math.max(0, room.energyCapacityAvailable || 0);
    const structures = require('HiveMind.Index').get().structuresByRoom.get(room.name);
    const stores = structures && [...(structures.get(STRUCTURE_SPAWN) || []), ...(structures.get(STRUCTURE_EXTENSION) || [])];
    // In live rooms the structure index is complete. Legacy fixtures may omit it.
    if (!stores || !stores.length) return declared;
    const active = stores.filter(s => s.my !== false && s.hits !== 0 &&
        (typeof s.isActive !== 'function' || s.isActive()));
    const capacity = active.reduce((sum, s) => sum + (s.store && typeof s.store.getCapacity === 'function' ?
        s.store.getCapacity(RESOURCE_ENERGY) || 0 : s.energyCapacity || (s.structureType === STRUCTURE_SPAWN ? 300 : 50)), 0);
    return Math.min(declared, capacity);
}
function seats(source, memory = {}) {
    return require('utility').getValidSourceMiningSeats(memory, source.pos);
}
function body(room, work, energy = energyCapacity(room)) {
    return Bodies.build('Extractor', { energyCapacity: energy, desiredWork: work, maxWork: work });
}
// A successor remains incoming until the physical handoff completes. Retiring
// incumbents still consume population, but no longer cover future source work.
function activeMiner(creep) {
    return !creep.spawning && !creep.memory.extractorRetiring && !creep.memory.extractorReplacementFor;
}
function replacementLead(room, work, distance = 30, preferred = body(room, work)) {
    return Math.max(100, (preferred?.spawnTime || 12) + distance * 2 + 10);
}
function describe(room, source, assigned, queue = [], distance = 30) {
    assigned = assigned.slice();
    for (const spawn of [...Object.values(Game.spawns), ...require('Spawn.Intents').get().spawns]) {
        const name = spawn.spawning?.name, m = spawn.request?.memory || name && Memory.creeps?.[name];
        if (name && m?.role === 'Extractor' && !m.remoteMining && sourceId(m) === source.id &&
            (!m.homeRoom || m.homeRoom === room.name) && !assigned.some(c => c.name === name)) {
            assigned.push({ name, memory: m, spawning: true,
                body: Array(m.extractorSpawnWorkParts || m.spawnCapability?.work || 0).fill(WORK) });
        }
    }
    const memory = (Memory.rooms[room.name].sources || {})[source.id] || {};
    const required = require('utility').getSourceHarvestProfile(source).requiredWork;
    const positions = seats(source, memory), maximum = body(room, required);
    const atAvailable = body(room, required, Math.min(room.energyAvailable, energyCapacity(room)));
    const active = assigned.filter(activeMiner);
    const incoming = assigned.filter(c => !c.memory.extractorRetiring && (c.spawning || c.memory.extractorReplacementFor));
    const pending = queue.filter(q => q && q.role === 'Extractor' && !q.memory?.remoteMining &&
        sourceId(q.memory) === source.id && !(q.expiresAt < Game.time));
    const replacement = pending.find(q => q.memory.extractorReplacementFor) ||
        assigned.find(c => c.memory.extractorReplacementFor && !c.memory.extractorRetiring);
    const replaced = new Set([...pending, ...assigned].flatMap(c => c.memory?.extractorReplacementFor || []));
    const lead = replacementLead(room, required, distance, maximum);
    const healthy = active.filter(c => c.ticksToLive === undefined || c.ticksToLive > lead);
    const healthyWork = healthy.reduce((n, c) => n + parts(c, WORK), 0);
    const maximumWork = Math.min(required, positions.length * (maximum?.WORK || 0));
    const plannedWork = Math.min(required, active.filter(c => !replaced.has(c.name))
        .reduce((n, c) => n + parts(c, WORK), 0) + incoming.reduce((n, c) => n + Bodies.metrics(c.body).WORK, 0) +
        pending.reduce((n, q) => n + Bodies.metrics(q.body).WORK, 0));
    let constraint = !positions.length ? 'NO_HARVEST_SEAT' : maximumWork < required ? 'SPAWN_CAPACITY' :
        healthyWork < required ? 'WORKFORCE' : 'COVERED';
    let action = null, reason = 'no outstanding demand';
    if (pending.length || incoming.length || replacement) reason = 'replacement or source worker pending';
    else if (!positions.length) reason = 'no available harvesting seat';
    else if (!maximum) reason = 'no valid body within maximum spawning capacity';
    else if (healthyWork >= required) reason = 'existing workers already cover source';
    else if (active.length < positions.length) {
        action = { work: Math.min(required - healthyWork, maximum.WORK), replacementFor: null };
        reason = 'uncovered source WORK and available seat';
    } else {
        const weakest = active.slice().sort((a, b) => Number(b.ticksToLive <= lead) - Number(a.ticksToLive <= lead) ||
            parts(a, WORK) - parts(b, WORK) ||
            (a.ticksToLive || 1500) - (b.ticksToLive || 1500) || a.name.localeCompare(b.name))[0];
        const oldWork = weakest && parts(weakest, WORK);
        const dying = weakest && weakest.ticksToLive <= lead;
        const desired = Math.min(maximum.WORK, required - Math.max(0, healthyWork - (healthy.includes(weakest) ? oldWork : 0)));
        const selected = body(room, desired);
        const gain = selected ? selected.WORK - oldWork : 0;
        // Conservative payback includes offloading duty and travel. Death handoffs
        // also run when upgrading would not repay the early retirement cost.
        const repays = gain > 0 && parts(weakest, MOVE) > 0 &&
            weakest.ticksToLive > lead + selected.cost / (gain * 2 * 0.7);
        const blockedUpgrade = weakest && memory.upgradeBlockedFor === weakest.name &&
            memory.upgradeBlockedCapacity === energyCapacity(room) && memory.upgradeBlockedSeatCount === positions.length;
        if (selected && weakest && (dying || repays && !blockedUpgrade && !(memory.upgradeRetryAt > Game.time))) {
            action = { work: desired, replacementFor: weakest.name, minWork: dying ? 1 : oldWork + 1,
                upgrade: !dying };
            reason = dying ? 'miner lifetime replacement' : 'productive miner upgrade';
        } else reason = blockedUpgrade ? 'upgrade handoff blocked; preserve incumbent until lifetime replacement' :
            maximumWork < required ? 'insufficient maximum spawning capacity at occupied seats' :
            memory.upgradeRetryAt > Game.time ? 'miner upgrade cooldown' : 'existing worker assigned; upgrade does not repay';
    }
    return { seatCount: positions.length, availableSeats: Math.max(0, positions.length - active.length - incoming.length),
        workStaging: incoming.filter(c => !c.spawning).reduce((sum, c) => sum + parts(c, WORK), 0),
        maxAchievableWork: maximumWork, maxWorkPerMiner: maximum?.WORK || 0,
        availableBodyWork: atAvailable?.WORK || 0, spawnEnergyCapacity: energyCapacity(room),
        preferredBody: maximum?.body || [], preferredCost: maximum?.cost || 0,
        healthyWork, plannedWork, constraint, planningReason: reason,
        replacementStatus: replacement ? 'PENDING' : action?.replacementFor ? 'NEEDED' : 'NONE',
        miners: assigned.map(c => ({ name: c.name, activeWork: c.spawning ? 0 : parts(c, WORK),
            body: Bodies.metrics(c.body || []), ttl: c.ticksToLive, spawning: !!c.spawning,
            retiring: !!c.memory.extractorRetiring, replaces: c.memory.extractorReplacementFor || null,
            state: c.memory.extractorState || null })),
        recommendedAction: constraint === 'NO_HARVEST_SEAT' ? 'restore source access' :
            action ? reason : replacement ? 'complete miner handoff' : constraint === 'SPAWN_CAPACITY' ?
                'build and fill active extensions' : 'maintain harvesting and logistics', action };
}
module.exports = { energyCapacity, seats, body, describe, parts, sourceId, activeMiner, replacementLead };
