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

function pruneRoom(roomName) {
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
            queue.splice(i, 1);
            removed++;
        }
    }
    return removed;
}

module.exports = { admit, normalize, revalidate, pruneRoom, fingerprint };
