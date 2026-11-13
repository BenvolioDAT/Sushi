const HiveMemory = require('HiveMind.Memory');

const TERMINAL = new Set(['COMPLETE', 'ABORTED']);

function protectedRooms(hive) {
    const names = new Set(hive.homeRooms && hive.homeRooms.names || []);
    for (const [name, record] of Object.entries(Memory.rooms || {})) {
        if (record && record.identity && ['HOME', 'OWNED_BOOTSTRAP', 'REMOTE'].includes(record.identity.type)) names.add(name);
        for (const mission of [record && record.keeperOperation, record && record.npcCoreOperation]) {
            if (mission && ['ASSEMBLE', 'CLEAR', 'GUARD', 'MINE', 'HAUL', 'SUSPENDED'].includes(mission.phase)) {
                names.add(name); if (mission.originRoom) names.add(mission.originRoom);
                for (const transit of mission.routeRooms || []) names.add(transit);
            }
        }
        // A selected remote and its transit rooms remain strategic references
        // even when their last observation is old or civilians are suspended.
        const planner = record && record.remotePlanner;
        if (!names.has(name) && !['HOME', 'OWNED_BOOTSTRAP'].includes(record?.identity?.type) &&
            !Game.rooms[name]?.controller?.my) continue;
        const selected = new Set(planner && planner.activeSourceIds || []);
        for (const [id, source] of Object.entries(planner && planner.sourceInfos || {})) {
            if (!source || !(selected.has(id) || source.active || source.established)) continue;
            if (source.roomName) names.add(source.roomName);
            for (const roomName of source.route && source.route.roomSequence || []) names.add(roomName);
        }
    }
    for (const operation of Object.values(hive.operations || {})) {
        if (!operation || TERMINAL.has(operation.state)) continue;
        if (operation.targetRoom) names.add(operation.targetRoom);
        if (operation.originRoom) names.add(operation.originRoom);
    }
    const expansion = hive.expansion || {};
    if (expansion.targetRoom) names.add(expansion.targetRoom);
    return names;
}

function oldTick(record) {
    return record && (record.updatedTick || record.lastIncidentTick || record.lastSeen || record.lastScanned || record.tick || 0) || 0;
}

// Regenerate from current Memory on every run. Only a scalar cursor survives:
// Screeps may deserialize Memory again or reset globals between GC passes.
function* records(hive) {
    const domains = ['squads', 'operations', 'demands'];
    for (let i = 0; i < domains.length; i++) {
        const kind = domains[i];
        for (const key of Object.keys(hive[kind] || {}).sort()) yield { kind, object: hive[kind], key, cursor: i + ':' + key };
    }
    for (const name of Object.keys(Memory.rooms || {}).sort()) {
        const room = Memory.rooms[name];
        const queue = room && room.spawn && room.spawn.queue;
        if (!Array.isArray(queue)) continue;
        for (let key = queue.length - 1; key >= 0; key--) yield { kind: 'queue', object: queue, key,
            cursor: '3:' + name + ':' + String(0xffffffff - key).padStart(10, '0') };
    }
    for (const key of Object.keys(hive.players || {}).sort()) yield { kind: 'players', object: hive.players, key, cursor: '4:' + key };
    const candidates = hive.expansion && hive.expansion.candidates || {};
    for (const key of Object.keys(candidates).sort()) yield { kind: 'candidates', object: candidates, key, cursor: '5:' + key };
    const resources = ['transfers', 'boosts', 'observers'];
    for (let i = 0; i < resources.length; i++) {
        const kind = resources[i];
        const object = hive.resources && hive.resources[kind];
        for (const key of Object.keys(object || {}).sort()) yield { kind: 'resources', object, key, cursor: (6 + i) + ':' + key };
    }
    const rooms = Memory.rooms || {};
    for (const key of Object.keys(rooms).sort()) yield { kind: 'intel', object: rooms, key, cursor: '9:' + key };
}

function run(options = {}) {
    const hive = HiveMemory.ensure();
    const settings = HiveMemory.getConfig('memoryGC');
    const interval = Math.max(1, settings.interval || 101);
    if (!options.force && Game.time % interval !== 0) return { skipped: true };
    const budget = Math.max(1, settings.workBudget || 25);
    let work = 0;
    let removed = 0;
    let protectedSet = null;
    if (!hive.gc || typeof hive.gc !== 'object') hive.gc = {};
    const gc = hive.gc;
    const after = gc.lastReport && gc.lastReport.tick > Game.time ? null : gc.cursor;
    const iterator = records(hive);
    let pending = true;
    while (work < budget) {
        const next = iterator.next();
        if (next.done) { gc.cursor = null; pending = false; break; }
        if (typeof after === 'string' && next.value.cursor <= after) continue;
        const { kind, object, key } = next.value;
        gc.cursor = next.value.cursor;
        const record = object[key];
        work++;
        let discard = false;
        if (kind === 'squads' || kind === 'operations') {
            const retention = kind === 'squads' ? settings.squadRetention : settings.operationRetention;
            discard = record && TERMINAL.has(record.state) &&
                Game.time - (record.completedTick || record.abortedTick || oldTick(record)) > retention;
        } else if (kind === 'demands') {
            const operation = record && record.operationId && hive.operations[record.operationId];
            discard = !record || record.validUntil < Game.time || operation && TERMINAL.has(operation.state);
        } else if (kind === 'queue') {
            discard = !record || record.expiresAt && record.expiresAt < Game.time;
        } else if (kind === 'players') {
            discard = record && record.manual !== true && (record.incidentScore || 0) <= 0 &&
                Game.time - oldTick(record) > settings.playerRetention;
        } else if (kind === 'candidates') {
            const freshest = Object.values(record && record.routes || {}).reduce((tick, route) =>
                Math.max(tick, route && route.lastChecked || 0), 0);
            discard = key !== (hive.expansion || {}).targetRoom && freshest > 0 &&
                Game.time - freshest > settings.expansionRetention;
        } else if (kind === 'resources') {
            discard = record && record.active !== true && Game.time - oldTick(record) > settings.debugRetention;
        } else if (kind === 'intel') {
            // Protection is evaluated at execution, since an operation may have
            // acquired a target while this sweep was suspended between runs.
            if (!protectedSet) protectedSet = protectedRooms(hive);
            if (protectedSet.has(key) || !record || record.identity && record.identity.type !== 'INTEL') continue;
            const age = Game.time - (record.lastScanned || record.scoutIntel && oldTick(record.scoutIntel) || 0);
            if (age <= settings.intelRetention) continue;
            for (const field of ['scoutIntel', 'controller', 'sources', 'Mineral', 'defenseSummary']) {
                if (record[field] !== undefined) { delete record[field]; removed++; }
            }
            if (record.cache && record.cache.economyDistances) { delete record.cache.economyDistances; removed++; }
        }
        if (discard) {
            if (kind === 'queue') object.splice(key, 1);
            else delete object[key];
            removed++;
        }
    }
    hive.gc.lastReport = { tick: Game.time, work, removed, stale: removed, sweepPending: pending };
    return hive.gc.lastReport;
}

module.exports = { run, protectedRooms };
