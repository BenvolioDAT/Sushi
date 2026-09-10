const HiveMemory = require('HiveMind.Memory');
const Context = require('Spawn.Context');
const Policy = require('Spawn.Policy');

function fingerprint(roomName, request, producer) {
    const memory = request.memory || {};
    return request.requestId || [
        producer || request.producer || 'legacy', roomName,
        request.demandId || memory.demandId || request.role || memory.role || 'unknown',
        memory.sourceId || memory.sourceTargetId || memory.remoteSourceId || '',
        memory.targetRoom || request.targetRoom || '', memory.squadId || '', memory.operationId || ''
    ].join(':');
}

const validTick = value => Number.isSafeInteger(value) && value >= 0;
function repairLifetime(request, ttl) {
    const rollback = [request.requestedAt, request.refreshTick].some(value => validTick(value) && value > Game.time);
    const invalidExpiry = !validTick(request.expiresAt);
    const anchors = [request.requestedAt, request.refreshTick].filter(value => validTick(value) && value <= Game.time);
    const base = anchors.length ? Math.max(...anchors) : Game.time;
    if (rollback || !validTick(request.requestedAt)) request.requestedAt = rollback ? Game.time : base;
    if (rollback || !validTick(request.refreshTick)) request.refreshTick = rollback ? Game.time : base;
    if (invalidExpiry || rollback && request.expiresAt >= Game.time)
        request.expiresAt = (rollback ? Game.time : base) + ttl;
    return rollback ? 'queue timestamps rebased after tick rollback' : invalidExpiry ? 'missing or invalid queue expiry repaired' : null;
}

function recordDecision(roomName, request, decision) {
    const memory = HiveMemory.getRoomSpawnMemory(roomName);
    memory.admissionDecision = { tick: Game.time, role: request.role, requestId: request.requestId, ...decision };
    if (!decision.allowed) memory.lastAdmissionBlock = { ...memory.admissionDecision };
    return decision;
}

function normalize(roomName, request, options = {}) {
    const now = Game.time;
    const producer = options.producer || request.producer || 'legacy';
    const normalized = { ...request, memory: { ...(request.memory || {}) } };
    normalized.role = normalized.role || normalized.memory.role;
    const profiles = require('BodyProfiles');
    const room = Game.rooms[roomName];
    if (room && ['Tech', 'Artificer'].includes(normalized.role) && !normalized.memory.controllerEmergency) {
        const claimed = new Set(HiveMemory.getRoomSpawnMemory(roomName).queue.flatMap(q => q.replacementFor || []));
        const expiring = (require('HiveMind.Index').get().creepsByHomeRoom.get(roomName) || []).filter(c =>
            c.memory.role === normalized.role && !c.spawning && c.ticksToLive <= 150 && c.ticksToLive > 0 && !claimed.has(c.name) &&
            (normalized.role === 'Tech' || c.memory.artificerWorkCategory === normalized.economyCategory));
        const work = expiring.reduce((sum, c) => sum + profiles.metrics(c.body || []).WORK, 0);
        if (expiring.length && work >= profiles.metrics(normalized.body || []).WORK) {
            normalized.replacementFor = expiring.map(c => c.name);
            normalized.deadline = Game.time + Math.min(...expiring.map(c => c.ticksToLive));
        }
    }
    if (room && !(normalized.bodyRequirements && normalized.bodyRequirements.fixed) && ['Tech', 'Artificer', 'Freighter', 'Extractor', 'ThoriumHauler', 'Annex', 'ReactorClaimer'].includes(normalized.role)) {
        const bodyOptions = profiles.requestOptions(room, normalized);
        // Keep established small-body recovery shapes; scale only meaningful capability.
        const scale = normalized.replacementFor || normalized.role === 'Extractor' || normalized.role === 'Annex' ||
            normalized.role === 'Tech' && bodyOptions.desiredWork > 12 ||
            normalized.role === 'Artificer' && bodyOptions.desiredWork > 6 ||
            normalized.role === 'Freighter' && bodyOptions.provenRoads;
        const selected = scale && profiles.build(normalized.role, bodyOptions);
        if (selected) {
            normalized.body = selected.body;
            normalized.bodyProfile = bodyOptions;
            normalized.bodyReason = selected.reason;
        }
    }
    normalized.bodyMetrics = profiles.metrics(normalized.body || [], normalized.memory);
    normalized.priority = (normalized.priority || 0) + require('HiveMind.Surplus').requestBias(roomName, normalized);
    normalized.requestId = fingerprint(roomName, normalized, producer);
    normalized.producer = producer;
    normalized.category = normalized.category || normalized.economyCategory || 'unspecified';
    const ttl = Number.isSafeInteger(options.ttl) && options.ttl > 0 ? options.ttl :
        HiveMemory.getConfig('memoryGC').queueRetention;
    repairLifetime(normalized, ttl);
    normalized.refreshTick = now;
    normalized.memory.requestId = normalized.requestId;
    return normalized;
}

function admit(roomName, request, options = {}) {
    const room = Game.rooms && Game.rooms[roomName];
    pruneRoom(roomName);
    const normalized = normalize(roomName, request, options);
    if (!room || !normalized.role || !Array.isArray(normalized.body) || !normalized.body.length) {
        return { ok: false, requested: 0, role: normalized.role, reason: 'invalid normalized request' };
    }
    const context = Context.snapshot(roomName, options.replacementBuffer || 0);
    const spawnMemory = HiveMemory.getRoomSpawnMemory(roomName);
    if (!spawnMemory.governor) spawnMemory.governor = {};
    spawnMemory.governor.nextBody = { role: normalized.role, ...normalized.bodyMetrics,
        reason: normalized.bodyReason || 'existing capability-bounded role profile' };
    const accepted = require('Spawn.Intents').get().spawns.find(spawn => spawn.room.name === roomName &&
        spawn.request.requestId === normalized.requestId);
    if (accepted) return { ok: true, requested: 0, role: normalized.role,
        reason: 'stable request already spawning', request: accepted.request };
    const existing = context.queue.find(item => item && item.requestId === normalized.requestId);
    if (existing) {
        const promoteToGrowthFloor = normalized.memory.controllerGrowthFloor === true &&
            !(existing.memory && existing.memory.controllerGrowthFloor === true);
        if (promoteToGrowthFloor) {
            const promotion = Policy.evaluate(room, normalized, context, { ...options, revalidate: true });
            if (!promotion.allowed) {
                return { ok: false, requested: 0, role: normalized.role, reason: promotion.reason };
            }
            existing.economyCategory = normalized.economyCategory;
            existing.category = normalized.economyCategory;
            existing.body = normalized.body;
            existing.maxWorkParts = normalized.maxWorkParts;
            existing.priority = Math.max(existing.priority || 0, normalized.priority || 0);
            existing.memory = { ...existing.memory, ...normalized.memory };
        }
        existing.refreshTick = Game.time;
        existing.expiresAt = Math.max(existing.expiresAt || 0, normalized.expiresAt);
        return { ok: true, requested: 0, role: normalized.role,
            reason: promoteToGrowthFloor ? 'existing Tech request promoted to growth floor' : 'stable request already queued',
            mandatoryFloorBypass: promoteToGrowthFloor && context.nonCombatTotal > Policy.maxCreeps(room, HiveMemory.getConfig('spawn')),
            request: existing };
    }
    // Reserve visibility under optional queue pressure, without evicting core work.
    let displaced = null;
    if (require('HiveMind.Economy').categoryForRequest(normalized) === 'remoteIntel' &&
        context.queue.length >= HiveMemory.getConfig('spawn').maxQueueLengthPerRoom) {
        const optional = new Set(['upgradeSurplus', 'construction', 'expansion', 'special', 'resources', 'discretionary']);
        displaced = context.queue.filter(item => optional.has(require('HiveMind.Economy').categoryForRequest(item)) &&
            !item.emergency && (item.priority || 0) < (normalized.priority || 0))
            .sort((a, b) => (a.priority || 0) - (b.priority || 0))[0];
    }
    const evaluationContext = displaced ? Context.snapshot(roomName, options.replacementBuffer || 0) : context;
    if (displaced) {
        evaluationContext.queue = context.queue.filter(item => item !== displaced);
        evaluationContext.byRole[displaced.role]--;
        evaluationContext.nonCombatTotal--;
    }
    const decision = recordDecision(roomName, normalized, Policy.evaluate(room, normalized, evaluationContext, options));
    if (!decision.allowed) return { ...decision, ok: false, requested: 0, role: normalized.role };
    if (displaced) context.queue.splice(context.queue.indexOf(displaced), 1);
    context.queue.push(normalized);
    context.queue.sort((a, b) => (b.priority || 0) - (a.priority || 0) ||
        (a.requestedAt || 0) - (b.requestedAt || 0) || String(a.requestId).localeCompare(String(b.requestId)));
    return { ok: true, requested: 1, role: normalized.role, reason: decision.reason,
        mandatoryFloorBypass: decision.mandatoryFloorBypass === true, request: normalized };
}

function revalidate(room, request) {
    return recordDecision(room.name, request,
        Policy.evaluate(room, request, Context.snapshot(room.name), { revalidate: true }));
}

function pruneRoom(roomName, decision) {
    const memory = HiveMemory.getRoomSpawnMemory(roomName);
    const queue = memory.queue;
    const ttl = HiveMemory.getConfig('memoryGC').queueRetention;
    let removed = 0, repaired = 0, lastReason = null;
    for (let i = queue.length - 1; i >= 0; i--) {
        const request = queue[i];
        const valid = request && typeof request === 'object' && !Array.isArray(request);
        if (valid) {
            // Truly legacy requests get the existing one-time migration grace.
            if (!request.requestId && !validTick(request.expiresAt)) request.refreshTick = Game.time;
            const repair = repairLifetime(request, request.requestId ? ttl : Math.min(25, ttl));
            if (repair) { repaired++; lastReason = repair; }
            if (!request.requestId) {
                request.requestId = fingerprint(roomName, request, request.producer || 'legacy-migrated');
                if (request.memory) request.memory.requestId = request.requestId;
            }
        }
        const operation = valid && request.operationId && HiveMemory.ensure().operations[request.operationId];
        const reason = !valid ? 'invalid request' : request.expiresAt < Game.time ? 'request expired' :
            operation && ['COMPLETE', 'ABORTED'].includes(operation.state) ? 'operation is terminal' : null;
        if (reason) {
            if (decision && !decision.blocked) {
                decision.blockSource = 'staleQueue';
                decision.blocked = { role: request && request.role || 'unknown', reason, blockSource: 'staleQueue' };
            }
            queue.splice(i, 1);
            removed++;
            lastReason = reason;
        }
    }
    if (removed || repaired) memory.queueMaintenance = {
        tick: Game.time, blockSource: 'staleQueue', removed, repaired, reason: lastReason, remaining: queue.length
    };
    return removed;
}

module.exports = { admit, normalize, revalidate, pruneRoom, fingerprint };
