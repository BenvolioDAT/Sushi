/* Bounded recorder. No dependency on managers: callers supply scalar evidence. */
const OWNER = 'sushi.blackbox.v1';
const DEFAULTS = Object.freeze({ mode: 'NORMAL', level: 'INFO', maxEvents: 1000, maxChars: 90000,
    fallbackEvents: 64, fallbackChars: 16000, snapshotInterval: 100, flushInterval: 25,
    duplicateWindow: 50, retentionTicks: 50000, segment: 98, useSegments: true, profileTicks: 100 });
const LEVEL = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const CATEGORIES = new Set(['ECONOMY', 'SPAWNING', 'MOVEMENT', 'JOBS', 'ERRORS']);
let heap, configCache, operationSample;
const tick = () => typeof Game === 'undefined' ? 0 : Game.time;
const bounded = (v, d, lo, hi) => Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.floor(v))) : d;
function config() {
    const raw = typeof Memory !== 'undefined' && Memory.config && Memory.config.diagnostics || {};
    if (configCache && configCache.raw === raw && configCache.tick === tick() &&
        configCache.mode === raw.mode && configCache.level === raw.level) return configCache.value;
    const c = { ...DEFAULTS, ...raw };
    c.mode = ['OFF', 'NORMAL', 'DEBUG', 'PROFILE'].includes(c.mode) ? c.mode : 'NORMAL';
    if (c.mode === 'PROFILE' && Number.isFinite(c.profileUntil) && tick() > c.profileUntil) {
        raw.mode = c.mode = 'NORMAL'; delete raw.profileUntil;
    }
    for (const [key, lo, hi] of [['maxEvents', 1, 1000], ['maxChars', 2048, 90000],
        ['fallbackEvents', 1, 64], ['fallbackChars', 2048, 16000], ['snapshotInterval', 10, 10000],
        ['flushInterval', 1, 1000], ['duplicateWindow', 1, 10000], ['retentionTicks', 1, 1000000]]) {
        c[key] = bounded(c[key], DEFAULTS[key], lo, hi);
    }
    c.segment = bounded(c.segment, 98, 0, 99);
    configCache = { raw, tick: tick(), mode: raw.mode, level: raw.level, value: c };
    return c;
}
// Escaping Unicode makes character limits strict byte limits too, including export chunks.
function encode(value) { return JSON.stringify(value).replace(/[\u007f-\uffff]/g,
    c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')); }
function state() {
    if (!Memory.hive) Memory.hive = {};
    if (!Memory.hive.telemetry) Memory.hive.telemetry = {};
    const t = Memory.hive.telemetry;
    if (!t.blackbox || typeof t.blackbox !== 'object') t.blackbox = { nextId: 1, recent: [], chars: 0 };
    if (!Array.isArray(t.blackbox.recent)) t.blackbox.recent = [];
    if (typeof t.blackbox.epoch !== 'string') t.blackbox.epoch = tick() + ':' + Math.random().toString(36).slice(2, 10);
    return t.blackbox;
}
function current() {
    const s = state();
    // Memory may be parsed into a new object each tick. A persisted namespace id
    // preserves the heap ring without reparsing or rewriting the segment.
    if (heap && heap.epoch === s.epoch && heap.lastTick <= tick()) {
        heap.memory = Memory; heap.lastTick = tick(); return heap;
    }
    heap = { memory: Memory, epoch: s.epoch, lastTick: tick(), rows: [], chars: 0, dedup: new Map(), rooms: new Map(),
        actors: new Map(), jobs: new Map(), dirty: false, loaded: null, storage: 'MEMORY', storageReason: 'segment pending',
        lastFlush: -Infinity, lastSnapshot: -Infinity, dropped: 0 };
    for (const json of s.recent.slice(-64)) {
        try {
            if (typeof json !== 'string' || json.length > 1400) continue;
            const e = JSON.parse(json); if (valid(e)) insert(heap, e);
        } catch (error) { /* Skip damaged owned records. */ }
    }
    trim(heap, config());
    s.nextId = Math.max(bounded(s.nextId, 1, 1, Number.MAX_SAFE_INTEGER - 1),
        heap.rows.reduce((max, row) => Math.max(max, row.e.id + 1), 1));
    fallback(heap, config());
    return heap;
}
function valid(e) { return e && Number.isSafeInteger(e.id) && Number.isFinite(e.tick) &&
    CATEGORIES.has(e.category) && LEVEL[e.severity] !== undefined && typeof e.event === 'string'; }
function insert(h, e) {
    const json = encode(e);
    if (json.length > 1400) return;
    const old = h.rows.findIndex(r => r.e.id === e.id);
    if (old >= 0) { h.chars -= h.rows[old].json.length + 1; h.rows.splice(old, 1); }
    h.rows.push({ e, json, memorySize: encode(json).length + 1 }); h.chars += json.length + 1;
}
function trim(h, c) {
    // Include envelope allowance. Oldest records always leave first.
    while (h.rows.length && (h.rows.length > c.maxEvents || h.chars + 256 > c.maxChars ||
        (h.rows[0].e.lastTick || h.rows[0].e.tick) < tick() - c.retentionTicks)) {
        h.chars -= h.rows.shift().json.length + 1; h.dropped++; h.dirty = true;
    }
}
function fallback(h, c) {
    const s = state(); let chars = 256; const rows = [];
    for (let i = h.rows.length - 1; i >= 0 && rows.length < c.fallbackEvents; i--) {
        const json = h.rows[i].json;
        // Memory stores JSON strings, so account for their quoting/escaping too.
        const size = h.rows[i].memorySize;
        if (chars + size > c.fallbackChars) break;
        chars += size; rows.unshift(json);
    }
    s.recent = rows; s.chars = chars;
}
function scalarData(data) {
    // Only top-level primitive fields are accepted. Never traverse or invoke toJSON on objects.
    const clean = {};
    if (!data || typeof data !== 'object') return clean;
    for (const key of Object.keys(data).slice(0, 12)) {
        const descriptor = Object.getOwnPropertyDescriptor(data, key);
        if (!descriptor || !('value' in descriptor)) continue;
        const v = descriptor.value;
        if (typeof v === 'string') clean[key.slice(0, 40)] = v.slice(0, 110);
        else if (typeof v === 'boolean' || v === null || typeof v === 'number' && Number.isFinite(v)) clean[key.slice(0, 40)] = v;
        if (encode(clean).length > 650) { delete clean[key.slice(0, 40)]; break; }
    }
    return clean;
}
function record(category, severity, event, room, data = {}) {
    try {
        if (Memory.config && Memory.config.diagnostics && Memory.config.diagnostics.mode === 'OFF') return false;
        const c = config();
        if (c.mode === 'OFF' || !CATEGORIES.has(category) || LEVEL[severity] === undefined ||
            LEVEL[severity] < LEVEL[c.level || 'INFO'] || severity === 'DEBUG' && c.mode === 'NORMAL') return false;
        const h = current();
        if (h.eventTick !== tick()) { h.eventTick = tick(); h.eventCount = 0; }
        if (h.eventCount >= (severity === 'ERROR' ? 30 : 20)) { h.dropped++; return false; }
        h.eventCount++;
        const clean = scalarData(data);
        const name = String(event).replace(/[^A-Z0-9_]/g, '_').slice(0, 64);
        const roomName = typeof room === 'string' ? room.slice(0, 24) : null;
        const key = category + ':' + severity + ':' + name + ':' + roomName + ':' + encode(clean);
        const previous = h.dedup.get(key);
        if (previous && tick() - previous.lastTick <= c.duplicateWindow && h.rows.some(r => r.e === previous)) {
            previous.count = Math.min(1e9, previous.count + 1); previous.lastTick = tick();
            insert(h, previous); h.dirty = true; trim(h, c); fallback(h, c); return false;
        }
        const s = state();
        const e = { id: s.nextId = bounded(s.nextId, 1, 1, Number.MAX_SAFE_INTEGER - 1), tick: tick(),
            room: roomName, category, severity, event: name, data: clean, count: 1, lastTick: tick() };
        s.nextId++;
        insert(h, e); h.dedup.set(key, e);
        if (h.dedup.size > 128) h.dedup.delete(h.dedup.keys().next().value);
        h.dirty = true; trim(h, c); fallback(h, c); return true;
    } catch (error) { return false; }
}
function storage(h, c) {
    if (!c.useSegments || typeof RawMemory === 'undefined' || !RawMemory.segments ||
        typeof RawMemory.setActiveSegments !== 'function') {
        h.storage = 'MEMORY'; h.storageReason = 'segments disabled or unavailable'; return false;
    }
    const owners = Memory.hive.segmentOwners || (Memory.hive.segmentOwners = {}), id = c.segment;
    if (owners[id] && owners[id] !== OWNER) { h.storage = 'MEMORY'; h.storageReason = 'segment ownership conflict'; return false; }
    const raw = RawMemory.segments[id];
    if (raw === undefined) {
        const active = Object.keys(RawMemory.segments).map(Number).filter(n => n >= 0 && n <= 99);
        if (active.length >= 10) { h.storageReason = 'all active segment slots occupied'; h.storage = 'MEMORY'; return false; }
        RawMemory.setActiveSegments(active.concat(id));
        h.storage = 'MEMORY'; h.storageReason = 'awaiting next-tick segment'; return false;
    }
    const signature = String(id);
    if (h.loaded !== signature) {
        let saved;
        if (raw) {
            if (raw.length > 100000) { h.storageReason = 'oversize segment refused'; return false; }
            try { saved = JSON.parse(raw); } catch (error) { h.storageReason = 'nonempty unrecognized segment refused'; return false; }
            if (!saved || saved.owner !== OWNER || saved.version !== 1 || !Array.isArray(saved.events)) {
                h.storageReason = 'nonempty foreign segment refused'; return false;
            }
        }
        owners[id] = OWNER;
        const recent = h.rows.map(r => r.e); h.rows = []; h.chars = 0;
        for (const e of (saved && saved.events || []).slice(-1000).concat(recent)) {
            const s = state();
            if (valid(e) && (!Number.isFinite(s.clearedAt) || e.tick > s.clearedAt ||
                e.tick === s.clearedAt && e.id >= s.clearNextId)) insert(h, e);
        }
        h.rows.sort((a, b) => (a.e.lastTick || a.e.tick) - (b.e.lastTick || b.e.tick) || a.e.id - b.e.id);
        const maxId = h.rows.reduce((n, row) => Math.max(n, row.e.id), 0);
        state().nextId = Math.max(state().nextId || 1, maxId + 1);
        h.loaded = signature; trim(h, c); h.dirty = true;
    }
    // Never request fewer segments than currently available; no other Sushi segment user exists.
    const active = Object.keys(RawMemory.segments).map(Number);
    if (active.length <= 10) RawMemory.setActiveSegments(active);
    h.storage = 'SEGMENT'; h.storageReason = null; return true;
}
function begin() {
    try {
        install(); const c = config();
        if (c.mode === 'PROFILE' && !Number.isFinite(c.profileUntil)) {
            Memory.config.diagnostics.profileUntil = tick() + bounded(c.profileTicks, 100, 1, 1000);
        }
        if (c.mode === 'OFF') return;
        const h = current(), dropped = h.dropped; trim(h, c);
        if (h.dropped !== dropped) fallback(h, c);
        storage(h, c);
        if (tick() % 101 === 0) for (const [name, a] of h.actors) if (tick() - a.tick > 100) h.actors.delete(name);
    } catch (error) { if (heap) { heap.storage = 'MEMORY'; heap.storageReason = 'storage unavailable'; } }
}
function finish(cpu) {
    try {
        const c = config(); if (c.mode === 'OFF') return;
        const h = current();
        if (c.mode === 'PROFILE' && tick() % 5 === 0) {
            const phases = global.__sushiTelemetry && global.__sushiTelemetry.phases || {};
            record('ERRORS', 'INFO', 'PROFILE_CPU_SAMPLE', null, { cpu: cpu && cpu.total,
                spawn: phases.spawnPlanning, movement: phases.traffic, roles: phases.creepExecution,
                planning: phases.planning, visuals: phases.visuals, diagnostics: phases.diagnostics });
        }
        if (tick() - h.lastSnapshot >= c.snapshotInterval) {
            h.lastSnapshot = tick();
            record('ERRORS', 'INFO', 'HEALTH_SNAPSHOT', null, { cpu: cpu && cpu.total || 0,
                bucket: Game.cpu && Game.cpu.bucket, creeps: Object.keys(Game.creeps || {}).length,
                rooms: Object.keys(Game.rooms || {}).length });
            for (const name of h.rooms.keys()) {
                const view = roomReader(name);
                if (view) record('ECONOMY', 'INFO', 'ROOM_HEALTH_SNAPSHOT', name, {
                    state: view.state, activeWork: view.activeWork, requiredWork: view.requiredWork,
                    spawningWork: view.spawningWork, queuedWork: view.queuedWork, energy: view.energy,
                    stored: view.stored, spawn: view.spawn && view.spawn.status,
                    spawnReason: view.spawn && view.spawn.reason, sampleTick: view.economyTick });
            }
        }
        if (h.dirty && h.storage === 'SEGMENT' && tick() - h.lastFlush >= c.flushInterval) {
            // Recheck ownership AND content immediately before writing.
            if (storage(h, c)) {
                const raw = RawMemory.segments[c.segment];
                if (raw && JSON.parse(raw).owner !== OWNER) throw Error('segment changed owner');
                const json = '{"owner":"' + OWNER + '","version":1,"events":[' + h.rows.map(r => r.json).join(',') + ']}';
                if (json.length > c.maxChars) throw Error('segment limit');
                RawMemory.segments[c.segment] = json; h.dirty = false; h.lastFlush = tick();
                state().lastFlush = tick();
            }
        }
    } catch (error) { if (heap) { heap.storage = 'MEMORY'; heap.storageReason = 'flush unavailable'; } }
}
function events(count = 20, filter = {}) {
    try {
        const h = current(); trim(h, config());
        if (count === 0) return [];
        return h.rows.filter(r => (!filter.room || r.e.room === filter.room) &&
            (!filter.severity || r.e.severity === filter.severity)).slice(-bounded(count, 20, 0, 1000)).map(r => JSON.parse(r.json));
    } catch (error) { return []; }
}
function summary(room) {
    try {
        const h = current(); let warnings = 0, errors = 0, last = null, examined = 0;
        for (let i = h.rows.length - 1; i >= 0 && examined < 200; i--, examined++) {
            const e = h.rows[i].e;
            if (e.room && e.room !== room || tick() - e.lastTick > 1000) continue;
            if (e.severity === 'WARN') warnings++;
            if (e.severity === 'ERROR') errors++;
            if (!last && !e.event.endsWith('_SNAPSHOT') && e.severity !== 'DEBUG')
                last = { event: e.event, tick: e.lastTick, severity: e.severity };
        }
        return { warnings, errors, last };
    } catch (error) { return { warnings: 0, errors: 0, last: null }; }
}
function status() {
    try { const h = current(), c = config(); return { tick: tick(), mode: c.mode, storage: h.storage,
        storageReason: h.storageReason, events: h.rows.length, chars: h.chars, dropped: h.dropped,
        maxEvents: c.maxEvents, maxChars: c.maxChars, fallbackEvents: state().recent.length,
        lastFlush: state().lastFlush || null, segment: c.segment }; } catch (error) { return { unavailable: true }; }
}
function exception(event, room, error, subsystem) {
    try { return record('ERRORS', 'ERROR', event, room, { subsystem, message: String(error && error.message || error).slice(0, 110),
        stack: String(error && error.stack || '').split('\n').slice(1, 3).join(' ').slice(0, 110) }); } catch (reportingError) { return false; }
}
function observeEconomy(room, snapshot) {
    try {
        if (config().mode === 'OFF') return;
        const h = current(), old = h.rooms.get(room), growth = snapshot.growth || {};
        const signature = [snapshot.state, snapshot.recoveryReason, growth.mode, growth.blockedReason,
            (growth.energyAboveReserve || 0) > 0].join(':');
        if (!old || old.signature !== signature) {
            record('ECONOMY', snapshot.state === 'SURVIVAL' || snapshot.state === 'RECOVERY' ? 'WARN' : 'INFO',
                !old ? 'ECONOMY_OBSERVED' : old.state !== snapshot.state ? 'ECONOMY_STATE_CHANGED' : 'ECONOMY_CONSTRAINT_CHANGED',
                room, { from: old && old.state || null, to: snapshot.state, reason: snapshot.recoveryReason || snapshot.reason,
                    growth: growth.mode, blocked: growth.blockedReason, stored: snapshot.storageEnergy + snapshot.terminalEnergy,
                    workActive: snapshot.harvest.workActive, workRequired: snapshot.harvest.workRequired,
                    workSpawning: snapshot.harvest.workSpawning, workQueued: snapshot.harvest.workQueued });
        }
        const recovering = ['SURVIVAL', 'RECOVERY'].includes(snapshot.state);
        const paused = growth.mode === 'RECOVERY';
        const belowReserve = (growth.energyAboveReserve || 0) <= 0;
        const missing = snapshot.harvest.workActive < snapshot.harvest.workRequired * 0.9;
        const sourceSignature = (snapshot.harvest.sources || []).map(s =>
            [s.id, s.constraint, s.planningReason, s.replacementStatus, s.maxAchievableWork, s.seatCount].join(':')).join('|');
        if (!old || old.sourceSignature !== sourceSignature) {
            for (const source of snapshot.harvest.sources || []) record('SPAWNING',
                source.constraint === 'COVERED' ? 'INFO' : 'WARN', 'HARVEST_PLAN_CHANGED', room,
                { source: source.id, required: source.workRequired, active: source.workActive,
                    stationed: source.stationedWork, maximum: source.maxAchievableWork, seats: source.seatCount,
                    replacement: source.replacementStatus, constraint: source.constraint,
                    reason: source.planningReason, next: source.recommendedAction });
        }
        const starving = snapshot.energyAvailable < 200;
        const transitions = [
            [recovering, old && old.recovering, 'RECOVERY_ACTIVATED', 'RECOVERY_COMPLETED'],
            [paused, old && old.paused, 'GROWTH_PAUSED', 'GROWTH_RESUMED'],
            [belowReserve, old && old.belowReserve, 'RESERVE_BELOW_TARGET', 'RESERVE_RESTORED'],
            [starving, old && old.starving, 'SPAWN_ENERGY_STARVATION', 'SPAWN_ENERGY_RESTORED']
        ];
        for (const [value, before, on, off] of transitions) if (old && value !== before) {
            record('ECONOMY', value ? 'WARN' : 'INFO', value ? on : off, room,
                { reason: growth.blockedReason || snapshot.reason, available: snapshot.energyAvailable, stored: growth.storedEnergy });
        }
        if (missing && (!old || !old.missing)) record('SPAWNING', 'WARN', 'CRITICAL_HARVEST_CAPACITY_MISSING', room,
            { activeWork: snapshot.harvest.workActive, requiredWork: snapshot.harvest.workRequired,
                spawningWork: snapshot.harvest.workSpawning, queuedWork: snapshot.harvest.workQueued });
        h.rooms.set(room, { signature, sourceSignature, state: snapshot.state, recovering, paused, belowReserve, missing, starving });
    } catch (error) { /* Observation must not affect policy. */ }
}
function movement(creep, result, destination) {
    try {
        if (!creep || !creep.pos || config().mode === 'OFF') return;
        const h = current(), key = 'move:' + creep.name, old = h.actors.get(key);
        const pos = creep.pos.roomName + ':' + creep.pos.x + ':' + creep.pos.y;
        const consecutive = old && old.tick === tick() - 1;
        if (old && old.tick === tick()) return;
        const failed = ![0, -11, -4].includes(result);
        const stuck = consecutive && old.pos === pos && !creep.fatigue ? old.stuck + 1 : 0;
        const failures = failed ? consecutive ? old.failures + 1 : 1 : 0;
        const rooms = consecutive ? old.rooms.slice(-3) : [];
        if (!rooms.length || rooms[rooms.length - 1] !== creep.pos.roomName) rooms.push(creep.pos.roomName);
        const oscillating = rooms.length === 4 && rooms[0] === rooms[2] && rooms[1] === rooms[3];
        if (result === -12) record('MOVEMENT', 'ERROR', 'MOVEMENT_UNRECOVERABLE', creep.pos.roomName,
            { creep: creep.name, result, reason: 'No active MOVE body part' });
        if (failures >= 3 && creep.memory && creep.memory.resourceJobId) record('JOBS', 'WARN',
            'JOB_TARGET_UNREACHABLE', creep.pos.roomName, { creep: creep.name, job: creep.memory.resourceJobId, result });
        if (result === -7 || result === -10 || failures >= 3 || stuck >= 5 || oscillating) {
            record('MOVEMENT', 'WARN', oscillating ? 'ROOM_EXIT_OSCILLATION' : result === -7 || result === -10 ?
                'MOVEMENT_INVALID_DESTINATION' : failures >= 3 ? 'MOVEMENT_REPEATED_FAILURE' : 'MOVEMENT_PERSISTENT_BLOCK',
                creep.pos.roomName, { creep: creep.name, role: creep.memory && creep.memory.role, result,
                    destination: destination && destination.roomName, x: creep.pos.x, y: creep.pos.y });
        }
        h.actors.set(key, { tick: tick(), pos, stuck, failures, rooms });
        if (h.actors.size > 600) h.actors.delete(h.actors.keys().next().value);
    } catch (error) { /* No movement side effects. */ }
}

// Sample nested costs without changing phase totals. Keep this recorder free
// of manager dependencies so movement and logistics can both use it.
function measureOperation(name, fn) {
    const enabled = Game.time % 25 === 0 || config().mode === 'PROFILE';
    if (!enabled || !Game.cpu || typeof Game.cpu.getUsed !== 'function') return fn();
    if (!operationSample || operationSample.tick !== Game.time || operationSample.game !== Game) {
        operationSample = { tick: Game.time, game: Game, costs: {} };
    }
    const sample = operationSample;
    const row = sample.costs[name] || (sample.costs[name] = { calls: 0, cpu: 0, ops: 0, incomplete: 0 });
    const before = Game.cpu.getUsed();
    row.calls++;
    try {
        const result = fn();
        if (result && typeof result.ops === 'number') row.ops += result.ops;
        if (result && result.incomplete) row.incomplete++;
        return result;
    } finally { row.cpu += Math.max(0, Game.cpu.getUsed() - before); }
}

function operationProfile() {
    return operationSample && operationSample.tick === Game.time && operationSample.game === Game ?
        { tick: operationSample.tick, costs: operationSample.costs } : null;
}

function observeJobs(rows) {
    try {
        if (config().mode === 'OFF') return;
        const h = current(), seen = new Set();
        for (const row of rows.slice(0, 128)) {
            seen.add(row.id);
            const old = h.jobs.get(row.id);
            const pending = !row.assigned;
            const deadWorker = old && old.worker && !Game.creeps[old.worker];
            const since = pending && old && old.pending ? old.since : tick();
            if (pending && tick() - since >= 50 && (row.idle > 0 || deadWorker)) {
                record('JOBS', 'WARN', deadWorker ? 'JOB_DEATH_REASSIGNMENT_FAILED' : 'WORKER_IDLE_WITH_ELIGIBLE_JOB',
                    row.room, { job: row.id, idleWorkers: row.idle, previousWorker: old && old.worker || null });
            }
            const releases = old && !old.pending && old.worker && !row.assigned && !deadWorker ? (old.releases || 0) + 1 : old && old.releases || 0;
            if (releases >= 3) record('JOBS', 'WARN', 'JOB_REPEATEDLY_ABANDONED', row.room, { job: row.id, releases });
            h.jobs.set(row.id, { pending, since, worker: row.assigned || old && old.worker, releases });
        }
        for (const id of h.jobs.keys()) if (!seen.has(id)) h.jobs.delete(id);
    } catch (error) { /* Jobs remain independent from recording. */ }
}

function exportHistory(chunkSize = 3000) {
    const json = encode({ version: 1, status: status(), events: events(1000) });
    const size = bounded(chunkSize, 3000, 256, 10000), chunks = [];
    for (let i = 0; i < json.length; i += size) chunks.push(json.slice(i, i + size));
    current().exportChunks = chunks;
    return chunks;
}
function clear() {
    try {
        const h = current(); h.rows = []; h.chars = 0; h.dedup.clear(); h.rooms.clear(); h.actors.clear(); h.jobs.clear(); delete h.exportChunks;
        h.dirty = true; h.lastFlush = -Infinity;
        const s = state(); s.clearedAt = tick(); s.clearNextId = s.nextId;
        fallback(h, config());
        return { cleared: true, segmentClearsOnNextFlush: h.storage === 'SEGMENT' };
    } catch (error) { return { cleared: false }; }
}
let roomReader = () => null, cpuReader = () => ({}), pixelReader = () => null;
function install(readRoom, readCpu, readPixels) {
    try {
    if (readRoom) roomReader = readRoom;
    if (readCpu) cpuReader = readCpu;
    if (readPixels) pixelReader = readPixels;
    if (!global.Sushi || typeof global.Sushi !== 'object') global.Sushi = {};
    global.Sushi.debug = { status, build: () => require('Runtime.Build'),
        pixels: () => ({ current: pixelReader(), last: Memory.hive?.telemetry?.pixels || null }),
        events, errors: (n = 20) => events(n, { severity: 'ERROR' }),
        room: name => ({ tick: tick(), current: roomReader(name), events: events(30, { room: name }) }), cpu: () => ({ ...cpuReader(), rolling: global.__sushiCpuRolling || Memory.hive?.telemetry?.cpu || null,
            roles: Memory.hive?.telemetry?.populationRoles || {}, roleRooms: Memory.hive?.telemetry?.populationRooms || {} }),
        export: exportHistory, exportChunk: (i = 0, size = 3000) => (current().exportChunks || exportHistory(size))[i] || '', clear,
        mode: (mode, duration = 100) => {
            if (!['OFF', 'NORMAL', 'DEBUG', 'PROFILE'].includes(mode)) return 'Use OFF, NORMAL, DEBUG or PROFILE';
            if (!Memory.config) Memory.config = {};
            const c = Memory.config.diagnostics || (Memory.config.diagnostics = {}); c.mode = mode;
            c.level = mode === 'DEBUG' || mode === 'PROFILE' ? 'DEBUG' : 'INFO';
            if (mode === 'PROFILE') c.profileUntil = tick() + bounded(duration, 100, 1, 1000);
            return { mode, until: c.profileUntil };
        } };
    } catch (error) { /* A conflicting console global cannot affect colony work. */ }
}
module.exports = { DEFAULTS, config, record, begin, finish, events, status, exception, observeEconomy,
    movement, observeJobs, summary, install, clear, exportHistory, measureOperation, operationProfile };
