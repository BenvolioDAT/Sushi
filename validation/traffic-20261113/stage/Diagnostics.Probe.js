// Opt-in, expiring evidence only. No manager dependencies or gameplay intents.
const cap = (n, fallback, min, max) => Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
function options() { return Memory.config?.diagnostics?.probe; }
function enabled() {
    const c = options();
    return !!(c?.enabled === true && Memory.config?.diagnostics?.mode !== 'OFF' &&
        Number.isFinite(c.startedAt) && c.startedAt <= Game.time && Number.isFinite(c.until) && Game.time < c.until);
}
function state() {
    const hive = Memory.hive || (Memory.hive = {}), telemetry = hive.telemetry || (hive.telemetry = {});
    return telemetry.probe || (telemetry.probe = { samples: [], errors: [], count: 0 });
}
function bound(s) {
    if (!Array.isArray(s.samples)) s.samples = [];
    if (!Array.isArray(s.errors)) s.errors = [];
    s.samples = s.samples.slice(-20); s.errors = s.errors.slice(-8);
    while (JSON.stringify(s).length > 30000 && s.samples.length) s.samples.shift();
}
function status() {
    const c = options(), s = Memory.hive?.telemetry?.probe;
    return { enabled: enabled(), tick: Game.time, room: c?.room || null, until: c?.until || null,
        interval: c?.interval || 25, retained: s?.samples?.length || 0, count: s?.count || 0,
        lastTick: s?.lastTick ?? null, errorCount: s?.errors?.length || 0, skipped: s?.skipped || 0,
        stopReason: s?.stopReason || null };
}
function toggle(on, input = {}) {
    if (on === undefined) return status();
    if (typeof on !== 'boolean') return { error: 'Use probe(true, {room, duration, interval}) or probe(false)' };
    if (!Memory.config) Memory.config = {};
    const diagnostics = Memory.config.diagnostics || (Memory.config.diagnostics = {});
    if (on && input.room !== undefined && (typeof input.room !== 'string' || !/^[WE]\d+[NS]\d+$/.test(input.room)))
        return { error: 'room must be a Screeps room name' };
    if (on && diagnostics.mode === 'OFF') return { error: 'Diagnostics mode is OFF; enable NORMAL before probing' };
    if (!on) {
        if (diagnostics.probe) diagnostics.probe.enabled = false;
        const saved = Memory.hive?.telemetry?.probe; if (saved) saved.stopReason = 'MANUAL';
        return status();
    }
    diagnostics.probe = { enabled: true, room: input.room || null, startedAt: Game.time,
        until: Game.time + cap(input.duration, 500, 1, 2000), interval: cap(input.interval, 25, 10, 500) };
    const s = state(); bound(s); s.startedAt = Game.time; s.stopReason = null;
    return status();
}
function report() {
    const s = Memory.hive?.telemetry?.probe;
    return { ...status(), samples: s?.samples || [], errors: (s?.errors || []).map(e => ({ ...e, age: Math.max(0, Game.time - e.tick) })) };
}
function exception(event, room, error, subsystem) {
    if (!enabled()) return;
    const s = state(); bound(s);
    const message = String(error?.message || error).slice(0, 200), last = s.errors.at(-1);
    if (last && last.event === event && last.subsystem === subsystem && last.message === message && last.room === room) {
        last.count = Math.min(1e9, last.count + 1); last.tick = Game.time; return;
    }
    if (s.errors.filter(e => e.tick === Game.time).length >= 3) return;
    s.errors.push({ tick: Game.time, event, room, subsystem, message, stack: String(error?.stack || '').slice(0, 1600), count: 1 });
    bound(s);
}
function sample(readRoom) {
    const c = options();
    if (c?.enabled !== true) return; // Disabled: no scans, CPU reads or Memory writes.
    if (!enabled()) {
        c.enabled = false;
        const s = Memory.hive?.telemetry?.probe;
        if (s) s.stopReason = c.startedAt > Game.time ? 'TICK_ROLLBACK' : Memory.config.diagnostics.mode === 'OFF' ? 'DIAGNOSTICS_OFF' : 'EXPIRED';
        return;
    }
    const s = state(), interval = cap(c.interval, 25, 10, 500);
    if (s.lastTick <= Game.time && Game.time - s.lastTick < interval) return;
    s.lastTick = Game.time;
    const before = Game.cpu?.getUsed?.() || 0;
    if (before > (Game.cpu?.limit || 20) * 0.8) { s.skipped = (s.skipped || 0) + 1; return; }
    bound(s);
    const names = c.room ? [c.room] : Object.keys(Game.rooms).filter(n => Game.rooms[n].controller?.my).sort().slice(0, 3);
    const name = names[(s.count || 0) % Math.max(1, names.length)], v = name && readRoom(name);
    if (!v) return;
    const row = { tick: Game.time, room: name, economyTick: v.economyTick, state: v.state, reason: v.reason,
        blocked: v.blockedReason, healthyTicks: v.healthyTicks, energy: v.energy, capacity: v.energyCapacity,
        stored: v.stored, work: [v.activeWork, v.requiredWork], haul: v.hauling, spawn: v.spawn,
        sources: (v.sources || []).slice(0, 3).map(r => ({ id: r.id, work: r.activeWork, stationed: r.stationedWork,
            backlog: r.backlog, carry: r.haulCarry, trip: r.haulRoundTrip, constraint: r.constraint })),
        freighters: (v.freighters || []).slice(0, 12).map(r => ({ name: r.name, room: r.room, x: r.x, y: r.y,
            carry: r.carryParts, cargo: r.cargo, job: r.job, assignment: r.assignmentClass,
            pickup: r.pickup, delivery: r.delivery, ttl: r.ttl, picked: r.flow?.picked, delivered: r.flow?.delivered })),
        roleErrors: Object.entries(Memory.hive?.telemetry?.creepErrors || {}).slice(0, 16).map(([role, e]) =>
            ({ role, tick: e.tick, age: Math.max(0, Game.time - e.tick), count: e.count, message: e.message })),
        cpu: { used: before, rolling: global.__sushiCpuRolling?.total || null } };
    row.cpu.sampleCost = Math.max(0, (Game.cpu?.getUsed?.() || before) - before);
    s.samples.push(row); s.count = Math.min(1e9, (s.count || 0) + 1); bound(s);
}
module.exports = { enabled, toggle, status, report, sample, exception };
