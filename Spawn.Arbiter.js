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

function normalize(roomName, request, options = {}) {
    const now = Game.time;
    const producer = options.producer || request.producer || 'legacy';
    const normalized = { ...request, memory: { ...(request.memory || {}) } };
    normalized.role = normalized.role || normalized.memory.role;
    const profiles = require('BodyProfiles');
    const room = Game.rooms[roomName];
    if (room && normalized.role === 'Tech' && !normalized.memory.controllerEmergency) {
        const claimed = new Set(HiveMemory.getRoomSpawnMemory(roomName).queue.flatMap(q => q.replacementFor || []));
        const expiring = (require('HiveMind.Index').get().creepsByHomeRoom.get(roomName) || []).filter(c =>
            c.memory.role === 'Tech' && !c.spawning && c.ticksToLive <= 150 && c.ticksToLive > 0 && !claimed.has(c.name));
        const work = expiring.reduce((sum, c) => sum + profiles.metrics(c.body || []).WORK, 0);
        if (expiring.length && work >= profiles.metrics(normalized.body || []).WORK) {
            normalized.replacementFor = expiring.map(c => c.name);
            normalized.deadline = Game.time + Math.min(...expiring.map(c => c.ticksToLive));
        }
    }
    if (room && ['Tech', 'Artificer', 'Freighter', 'Extractor', 'ThoriumHauler', 'Annex', 'ReactorClaimer'].includes(normalized.role)) {
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
    normalized.requestedAt = normalized.requestedAt === undefined ? now : normalized.requestedAt;
    normalized.refreshTick = now;
    normalized.expiresAt = normalized.expiresAt || now +
        (options.ttl || HiveMemory.getConfig('memoryGC').queueRetention || 50);
    normalized.memory.requestId = normalized.requestId;
    return normalized;
}

function admit(roomName, request, options = {}) {
    const room = Game.rooms && Game.rooms[roomName];
    const normalized = normalize(roomName, request, options);
    if (!room || !normalized.role || !Array.isArray(normalized.body) || !normalized.body.length) {
        return { ok: false, requested: 0, role: normalized.role, reason: 'invalid normalized request' };
    }
    const context = Context.snapshot(roomName, options.replacementBuffer || 0);
    const spawnMemory = HiveMemory.getRoomSpawnMemory(roomName);
    if (!spawnMemory.governor) spawnMemory.governor = {};
    spawnMemory.governor.nextBody = { role: normalized.role, ...normalized.bodyMetrics,
        reason: normalized.bodyReason || 'existing capability-bounded role profile' };
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
    const decision = Policy.evaluate(room, normalized, evaluationContext, options);
    if (!decision.allowed) return { ok: false, requested: 0, role: normalized.role, reason: decision.reason };
    if (displaced) context.queue.splice(context.queue.indexOf(displaced), 1);
    context.queue.push(normalized);
    context.queue.sort((a, b) => (b.priority || 0) - (a.priority || 0) ||
        (a.requestedAt || 0) - (b.requestedAt || 0) || String(a.requestId).localeCompare(String(b.requestId)));
    return { ok: true, requested: 1, role: normalized.role, reason: decision.reason,
        mandatoryFloorBypass: decision.mandatoryFloorBypass === true, request: normalized };
}

function revalidate(room, request) {
    return Policy.evaluate(room, request, Context.snapshot(room.name), { revalidate: true });
}

function pruneRoom(roomName, decision) {
    const queue = HiveMemory.getRoomSpawnMemory(roomName).queue;
    let removed = 0;
    for (let i = queue.length - 1; i >= 0; i--) {
        let request = queue[i];
        if (request && !request.requestId) {
            request = normalize(roomName, request, { producer: request.producer || 'legacy-migrated', ttl: 25 });
            queue[i] = request;
        }
        const operation = request && request.operationId && HiveMemory.ensure().operations[request.operationId];
        if (!request || request.expiresAt && request.expiresAt < Game.time ||
            operation && ['COMPLETE', 'ABORTED'].includes(operation.state)) {
            if (decision && !decision.blocked) decision.blocked = {
                role: request && request.role || 'unknown',
                reason: !request ? 'invalid request' : request.expiresAt < Game.time ? 'request expired' : 'operation is terminal'
            };
            queue.splice(i, 1);
            removed++;
        }
    }
    return removed;
}

module.exports = { admit, normalize, revalidate, pruneRoom, fingerprint };
