/* Forecast natural expiries; this module never retires or redirects a worker.
 * Economy supplies the assignment predicate and its production-based target. */
const Bodies = require('BodyProfiles');
const Index = require('HiveMind.Index');
const Intents = require('Spawn.Intents');
const ARRIVAL_MARGIN = 10;
const REFILL_WAIT = 20;
const parts = (item, type) => (item.body || []).filter(p => (p.type || p) === type && p.hits !== 0).length;
const sameRequest = (a, b) => a === b || !!(a && b && a.requestId && a.requestId === b.requestId);
const validPredecessor = (entry, creep) => entry && creep && Number.isFinite(creep.ticksToLive) &&
    entry.deathAt === Game.time + creep.ticksToLive;

function roster(input, own) {
    const { room, matches } = input;
    const workers = [], carryByName = new Map(), claims = new Set(), seen = new Set();
    let incoming = 0;
    const claim = item => {
        const entries = item.memory?.freighterPredecessors;
        for (const entry of Array.isArray(entries) ? entries.slice(0, 50) : []) {
            if (validPredecessor(entry, Game.creeps[entry?.name])) claims.add(entry.name);
        }
    };
    for (const creep of Index.get().creepsByHomeRoom.get(room.name) || []) {
        if (!matches(creep)) continue;
        seen.add(creep.name);
        const carry = parts(creep, CARRY);
        if (creep.spawning) { incoming += carry; claim(creep); }
        else if (parts(creep, MOVE) > 0 && carry > 0) {
            workers.push(creep); carryByName.set(creep.name, carry);
            if (carry === Bodies.metrics(creep.body).CARRY) claim(creep);
        }
    }
    const spawns = new Map((Index.get().ownedSpawnsByRoom.get(room.name) || []).map(s => [s.name, s]));
    for (const intent of Intents.get().spawns) if (intent.room.name === room.name) spawns.set(intent.name, intent);
    for (const spawn of spawns.values()) {
        const name = spawn.spawning?.name;
        const memory = spawn.request?.memory || name && Memory.creeps?.[name];
        if (!name || seen.has(name) || !memory || !matches({ memory })) continue;
        incoming += Number(memory.freighterSpawnCarryParts) || parts(spawn.request || { body: memory.body }, CARRY);
        claim({ memory }); seen.add(name);
    }
    let pending = 0, queueWait = 0, queueCost = 0;
    for (const q of input.queue || []) {
        if (!q || q.expiresAt < Game.time || sameRequest(q, own)) continue;
        // Follow actual spawn ordering. Without a supplied priority retain the
        // conservative estimate; equal/earlier requests and busy spawns count.
        if (!Number.isFinite(input.priority) || (q.priority || 0) >= input.priority) queueWait += (q.body || []).length * 3;
        queueCost += Bodies.cost(q.body);
        if (matches(q)) { incoming += parts(q, CARRY); pending++; claim(q); }
    }
    const busy = Math.min(...Array.from(spawns.values(), s => s.spawning?.remainingTime || 0));
    const spent = Intents.get().spawns.filter(s => s.room.name === room.name).reduce((sum, s) => sum + Bodies.cost(s.request.body), 0);
    return { workers, carryByName, claims, incoming, pending, wait: busy + queueWait,
        budget: Math.min(Intents.available(room), Math.max(0, input.spendable - queueCost - spent)) };
}

function shortfallAt(input, fleet) {
    let carry = fleet.workers.reduce((sum, c) => sum + fleet.carryByName.get(c.name), 0);
    if (carry < input.required) return Game.time;
    const dying = fleet.workers.filter(c => Number.isFinite(c.ticksToLive)).sort((a, b) => a.ticksToLive - b.ticksToLive);
    for (const creep of dying) {
        carry -= fleet.carryByName.get(creep.name);
        if (carry < input.required) return Game.time + creep.ticksToLive;
    }
    return Infinity;
}

function futureMissing(input, fleet, through) {
    const carry = fleet.workers.reduce((sum, c) => sum +
        (!Number.isFinite(c.ticksToLive) || Game.time + c.ticksToLive > through ? fleet.carryByName.get(c.name) : 0), 0);
    return Math.max(0, input.required - carry - fleet.incoming);
}

function body(input, carry, energy) {
    return Bodies.build('Freighter', { energyCapacity: Math.min(input.capacity, energy), desiredCarry: carry });
}

function plan(input) {
    if (!(input.required > 0) || !(input.travel > 0) || !input.healthy) return null;
    const fleet = roster(input);
    // One incoming successor per assignment. Existing queues/intents are the
    // authority; do not reserve the same forecast behind an unfinished body.
    if (fleet.incoming > 0 || fleet.pending || !Number.isFinite(fleet.wait)) return null;
    const ideal = body(input, input.required, input.capacity);
    if (!ideal) return null;
    const horizon = ideal.spawnTime + input.travel * 2 + REFILL_WAIT;
    const needBy = shortfallAt(input, fleet);
    // Only start when an actual shortfall is approaching. Younger peers may
    // join that already-needed replacement if the existing cost/lifetime
    // payback checks justify it; a narrow peer-age cutoff strands fragments.
    if (needBy - Game.time > horizon) return null;
    // Excess capacity may already cover early expiries, for example after an
    // ordinary successor is born. Those workers cannot count as another saving
    // or claim a later peer away from its real consolidation cohort.
    const candidates = fleet.workers.filter(c => !fleet.claims.has(c.name) && c.ticksToLive > 0 &&
        Game.time + c.ticksToLive >= needBy)
        .sort((a, b) => a.ticksToLive - b.ticksToLive || a.name.localeCompare(b.name));
    let selected = null;
    for (let i = 1; i < Math.min(50, candidates.length); i++) {
        const predecessors = candidates.slice(0, i + 1);
        const through = Game.time + candidates[i].ticksToLive;
        const missing = futureMissing(input, fleet, through);
        const profile = body(input, missing, fleet.budget);
        if (!profile || profile.CARRY !== missing || profile.CARRY < 2) continue;
        if (fleet.wait + profile.spawnTime + input.travel + ARRIVAL_MARGIN > needBy - Game.time) continue;
        // Consolidation must save workers and not cost more replacement energy
        // than the predecessors it supersedes. Avoid spending most of the new
        // lifetime in an overlapping fleet on exceptionally long routes.
        const saved = predecessors.length - 1;
        const usefulAfter = 1500 - Math.max(0, through - Game.time - profile.spawnTime);
        const replacementLead = Math.max(100, profile.spawnTime + input.travel + ARRIVAL_MARGIN);
        if (usefulAfter <= replacementLead || usefulAfter * saved <= Math.max(0, needBy - Game.time - profile.spawnTime) ||
            profile.cost > predecessors.reduce((sum, c) => sum + Bodies.cost(c.body), 0)) continue;
        selected = { body: profile.body, carry: profile.CARRY,
            predecessors: predecessors.map(c => ({ name: c.name, deathAt: Game.time + c.ticksToLive })),
            plannedAt: Game.time, assignment: input.assignment, needBy, through };
    }
    return selected;
}

function evaluate(input, request) {
    const renewal = request.freighterRenewal;
    if (!renewal) return null;
    const fallback = reason => ({ active: false, reason });
    if (request.bodyRequirements?.fixed || renewal.assignment !== input.assignment ||
        !Number.isSafeInteger(renewal.plannedAt) || renewal.plannedAt > Game.time || !input.healthy ||
        !Array.isArray(renewal.predecessors) || renewal.predecessors.length > 50) return fallback('renewal no longer applicable');
    const fleet = roster(input, request);
    const needBy = shortfallAt(input, fleet);
    const entries = renewal.predecessors.filter(e => validPredecessor(e, Game.creeps[e?.name]) &&
        input.matches(Game.creeps[e.name]) && !fleet.claims.has(e.name) && e.deathAt >= needBy);
    if (entries.length < 2) return fallback('renewal cohort expired or changed assignment');
    const through = Math.max(...entries.map(e => e.deathAt));
    const missing = futureMissing(input, fleet, through);
    if (missing === 0 || fleet.incoming > 0) return { active: true, obsolete: true, missing: 0, reason: 'future hauling already covered' };
    const carry = Math.min(missing, request.requestedCarryParts || parts(request, CARRY));
    const profile = body(input, carry, input.capacity);
    if (!profile || profile.CARRY !== carry || carry < 2 || !Number.isFinite(fleet.wait)) return fallback('efficient renewal body no longer viable');
    const ready = fleet.wait + profile.spawnTime + input.travel + ARRIVAL_MARGIN;
    const funded = profile.cost <= fleet.budget;
    if (ready > needBy - Game.time || !funded && ready + REFILL_WAIT >= needBy - Game.time) {
        return fallback('renewal deadline requires ordinary hauling recovery');
    }
    return { active: true, missing: carry, minimumCarryParts: carry, body: profile.body, needBy, predecessors: entries,
        replacementCount: entries.length, reason: 'consolidate aging hauling capacity before natural expiry' };
}

function prune(creep) {
    const entries = creep.memory.freighterPredecessors;
    if (!Array.isArray(entries)) return;
    if (!parts(creep, MOVE) || parts(creep, CARRY) !== Bodies.metrics(creep.body).CARRY) {
        delete creep.memory.freighterPredecessors;
        return;
    }
    const alive = entries.slice(0, 50).filter(entry => validPredecessor(entry, Game.creeps[entry?.name]));
    if (alive.length) creep.memory.freighterPredecessors = alive;
    else delete creep.memory.freighterPredecessors;
}

module.exports = { plan, evaluate, prune };
