/* Heap-only claims. Build once per tick; role/planner mutations update one row. */
function key(room, source, target) { return room + '|' + source + '|' + target; }

function snapshot() {
    var cache = global.__sushiLogisticsIndex;
    if (cache && cache.tick === Game.time && cache.game === Game) return cache;
    cache = { tick: Game.time, game: Game, rows: {}, remote: {}, local: {}, freighters: [], remoteTotals: { byTargetCount: {}, byTargetEnergy: {}, bySourceCount: {} }, localTotals: {}, claimTotals: {}, groupCounts: {}, homeTotals: {} };
    global.__sushiLogisticsIndex = cache;
    for (var name in Game.creeps) {
        var creep = Game.creeps[name];
        if (!creep || !creep.memory || creep.memory.role !== 'Freighter') continue;
        cache.freighters.push(creep);
        update(creep);
    }
    return cache;
}

function remove(creep) {
    var cache = snapshot();
    var row = cache.rows[creep.name];
    if (!row) return;
    var groups = row.remote ? cache.remote : cache.local;
    adjust(cache, row, -1);
    delete groups[row.key][creep.name];
    var groupKey = (row.remote ? "remote:" : "local:") + row.key;
    cache.groupCounts[groupKey]--;
    if (!cache.groupCounts[groupKey]) delete groups[row.key];
    delete cache.rows[creep.name];
}

function update(creep) {
    var cache = snapshot();
    remove(creep);
    var m = creep.memory || {};
    if (m.role !== 'Freighter' || m.FreighterWorking || !m.pickupTargetId) return;
    var remote = m.freighterJob === 'remote';
    if (!remote && m.freighterJob !== 'local') return;
    if (remote && (m.freighterReservedUntil || 0) < Game.time) return;
    var energy = remote ? m.freighterReservedCarry || creep.store.getFreeCapacity(RESOURCE_ENERGY) :
        creep.store.getFreeCapacity(RESOURCE_ENERGY);
    if (energy <= 0) return;
    var row = { remote: remote, key: remote ? key(m.pickupRoom, m.pickupSourceId, m.pickupTargetId) : m.pickupRoom,
        target: m.pickupTargetId, source: m.pickupSourceId, home: m.homeRoom,
        energy: energy, until: m.freighterReservedUntil || 0 };
    cache.rows[creep.name] = row;
    var groups = remote ? cache.remote : cache.local;
    if (!groups[row.key]) groups[row.key] = {};
    groups[row.key][creep.name] = row;
    var groupKey = (remote ? "remote:" : "local:") + row.key;
    cache.groupCounts[groupKey] = (cache.groupCounts[groupKey] || 0) + 1;
    adjust(cache, row, 1);
    if (remote && !cache.claimTotals[row.key].name) cache.claimTotals[row.key].name = creep.name;
}

function remoteClaim(room, source, target, skip) {
    var cache = snapshot(), group = key(room, source, target);
    var total = cache.claimTotals[group] || { count: 0, energy: 0, until: 0, name: null };
    var own = cache.rows[skip];
    var exclude = own && own.remote && own.key === group;
    return { count: total.count - (exclude ? 1 : 0), energy: total.energy - (exclude ? own.energy : 0),
        until: total.until, name: total.name === skip ? null : total.name };
}

function adjust(cache, row, sign) {
    var home = cache.homeTotals[row.home] || (cache.homeTotals[row.home] = { remoteCount: 0, reservedCarry: 0, localCount: 0 });
    if (row.remote) { home.remoteCount += sign; home.reservedCarry += sign * row.energy; }
    else home.localCount += sign;
    if (row.remote) {
        var claim = cache.claimTotals[row.key] || (cache.claimTotals[row.key] = { count: 0, energy: 0, until: 0, name: null });
        claim.count += sign;
        claim.energy += sign * row.energy;
        claim.until = claim.count > 0 ? Math.max(claim.until, row.until) : 0;
        // Owner is diagnostic; capacity/count are authoritative for shared reservations.
        claim.name = claim.count > 0 ? claim.name : null;
    }
    if (!row.remote && !cache.localTotals[row.key]) cache.localTotals[row.key] = { byTargetCount: {}, byTargetEnergy: {}, bySourceCount: {} };
    var totals = row.remote ? cache.remoteTotals : cache.localTotals[row.key];
    var target = row.remote ? row.key : row.target;
    totals.byTargetCount[target] = (totals.byTargetCount[target] || 0) + sign;
    totals.byTargetEnergy[target] = (totals.byTargetEnergy[target] || 0) + sign * row.energy;
    if (row.source) totals.bySourceCount[row.source] = (totals.bySourceCount[row.source] || 0) + sign;
}

function reservations(creep, remote) {
    var cache = snapshot();
    var totals = remote ? cache.remoteTotals : cache.localTotals[creep.room.name] || {};
    // Read-through tables exclude this creep in O(1), without copying every claim.
    var result = { byTargetCount: Object.create(totals.byTargetCount || null),
        byTargetEnergy: Object.create(totals.byTargetEnergy || null), bySourceCount: Object.create(totals.bySourceCount || null) };
    var own = cache.rows[creep.name];
    if (own && own.remote === remote && (remote || own.key === creep.room.name)) {
        var target = remote ? own.key : own.target;
        result.byTargetCount[target]--;
        result.byTargetEnergy[target] -= own.energy;
        if (own.source) result.bySourceCount[own.source]--;
    }
    return result;
}

module.exports = { snapshot: snapshot, update: update, remove: remove, remoteClaim: remoteClaim, reservations: reservations };
