const HiveMemory = require('HiveMind.Memory');

const TERMINAL = new Set(['COMPLETE', 'ABORTED']);

function protectedRooms(hive) {
    const names = new Set(hive.homeRooms && hive.homeRooms.names || []);
    for (const [name, record] of Object.entries(Memory.rooms || {})) {
        if (record && record.identity && ['HOME', 'OWNED_BOOTSTRAP', 'REMOTE'].includes(record.identity.type)) names.add(name);
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

function run(options = {}) {
    const hive = HiveMemory.ensure();
    const settings = HiveMemory.getConfig('memoryGC');
    const interval = Math.max(1, settings.interval || 101);
    if (!options.force && Game.time % interval !== 0) return { skipped: true };
    const budget = Math.max(1, settings.workBudget || 25);
    let work = 0;
    let removed = 0;
    let stale = 0;
    function sweep(object, predicate) {
        if (!object) return;
        for (const key of Object.keys(object).sort()) {
            if (work >= budget) break;
            work++;
            if (predicate(object[key], key)) { delete object[key]; removed++; }
            else if (predicate.stale && predicate.stale(object[key], key)) stale++;
        }
    }
    sweep(hive.squads, squad => squad && TERMINAL.has(squad.state) &&
        Game.time - (squad.completedTick || squad.abortedTick || oldTick(squad)) > settings.squadRetention);
    sweep(hive.operations, operation => operation && TERMINAL.has(operation.state) &&
        Game.time - (operation.completedTick || operation.abortedTick || oldTick(operation)) > settings.operationRetention);
    sweep(hive.demands, demand => !demand || demand.validUntil < Game.time ||
        demand.operationId && hive.operations[demand.operationId] && TERMINAL.has(hive.operations[demand.operationId].state));
    for (const room of Object.values(Memory.rooms || {})) {
        if (work >= budget) break;
        const queue = room && room.spawn && room.spawn.queue;
        if (!Array.isArray(queue)) continue;
        for (let i = queue.length - 1; i >= 0 && work < budget; i--) {
            work++;
            if (!queue[i] || queue[i].expiresAt && queue[i].expiresAt < Game.time) { queue.splice(i, 1); removed++; }
        }
    }
    sweep(hive.players, player => player && player.manual !== true &&
        (player.incidentScore || 0) <= 0 && Game.time - oldTick(player) > settings.playerRetention);
    const expansion = hive.expansion || {};
    const candidates = expansion.candidates || {};
    for (const [name, candidate] of Object.entries(candidates).sort()) {
        if (work >= budget) break;
        if (name === expansion.targetRoom) continue;
        work++;
        const routes = candidate && candidate.routes || {};
        const freshest = Object.values(routes).reduce((tick, route) => Math.max(tick, route && route.lastChecked || 0), 0);
        if (freshest && Game.time - freshest > settings.expansionRetention) {
            delete candidates[name];
            removed++;
        }
    }
    const resources = hive.resources || {};
    for (const domain of ['transfers', 'boosts', 'observers']) {
        const records = resources[domain];
        if (!records || typeof records !== 'object') continue;
        for (const key of Object.keys(records).sort()) {
            if (work >= budget) break;
            work++;
            const record = records[key];
            if (record && record.active !== true && Game.time - oldTick(record) > settings.debugRetention) {
                delete records[key];
                removed++;
            }
        }
    }
    const protectedSet = protectedRooms(hive);
    for (const [name, room] of Object.entries(Memory.rooms || {}).sort()) {
        if (work >= budget) break;
        if (protectedSet.has(name) || !room || room.identity && room.identity.type !== 'INTEL') continue;
        work++;
        const age = Game.time - (room.lastScanned || room.scoutIntel && oldTick(room.scoutIntel) || 0);
        if (age <= settings.intelRetention) continue;
        for (const key of ['scoutIntel', 'controller', 'sources', 'Mineral', 'defenseSummary']) {
            if (room[key] !== undefined) { delete room[key]; removed++; }
        }
        if (room.cache && room.cache.economyDistances) { delete room.cache.economyDistances; removed++; }
    }
    if (!hive.gc || typeof hive.gc !== 'object') hive.gc = {};
    hive.gc.lastReport = { tick: Game.time, work, removed, stale: Math.max(stale, removed) };
    return hive.gc.lastReport;
}

module.exports = { run, protectedRooms };
