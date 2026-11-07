/* Heap-only claims. Build once per tick; role/planner mutations update one row. */
function key(room, source, target) { return room + '|' + source + '|' + target; }

// Candidate geometry and resource observations are shared for the tick; claims
// remain mutable and are subtracted separately for each worker.
function localPickupOptions(room) {
    var index = require('HiveMind.Index').get();
    if (!index.localPickupOptions) index.localPickupOptions = new Map();
    if (index.localPickupOptions.has(room.name)) return index.localPickupOptions.get(room.name);
    var sources = require('HiveMind.Index').getSources(room);
    var nearbySource = function(target, range) {
        return sources.find(source => target.pos && target.pos.getRangeTo(source) <= range);
    };
    var result = [];
    for (var drop of index.droppedResourcesByRoom.get(room.name) || []) {
        if (drop.resourceType !== RESOURCE_ENERGY || drop.amount < 50) continue;
        var source = nearbySource(drop, 3);
        result.push({ target: drop, sourceId: source && source.id || null, type: 'dropped', amount: drop.amount });
    }
    var structures = index.structuresByRoom.get(room.name);
    for (var container of structures && structures.get(STRUCTURE_CONTAINER) || []) {
        var amount = container.store && (typeof container.store.getUsedCapacity === 'function' ?
            container.store.getUsedCapacity(RESOURCE_ENERGY) : container.store[RESOURCE_ENERGY]) || 0;
        if (amount < 50) continue;
        var source = nearbySource(container, 2);
        if (source) result.push({ target: container, sourceId: source.id, type: 'container', amount: amount });
    }
    index.localPickupOptions.set(room.name, result);
    return result;
}

function snapshot() {
    var cache = global.__sushiLogisticsIndex;
    if (cache && cache.tick === Game.time && cache.game === Game) return cache;
    cache = { tick: Game.time, game: Game, rows: {}, idleRows: {}, idleCounts: {}, deliveries: {}, deliveryEnergy: {}, remote: {}, local: {}, freighters: [], remoteTotals: { byTargetCount: {}, byTargetEnergy: {}, bySourceCount: {} }, localTotals: {}, claimTotals: {}, groupCounts: {}, homeTotals: {} };
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
    updateDelivery(creep, cache);
    var idle = cache.idleRows[creep.name];
    if (idle) { cache.idleCounts[idle]--; delete cache.idleRows[creep.name]; }
    var memory = creep.memory || {};
    if (!memory.freighterJob && !memory.FreighterWorking && memory.freighterIdleSourceId &&
        creep.store && !(creep.store[RESOURCE_ENERGY] > 0)) {
        idle = creep.room.name + '|' + memory.freighterIdleSourceId;
        cache.idleRows[creep.name] = idle;
        cache.idleCounts[idle] = (cache.idleCounts[idle] || 0) + 1;
    }
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

function updateDelivery(creep, cache) {
    var old = cache.deliveries[creep.name];
    if (old) {
        cache.deliveryEnergy[old.target] -= old.amount;
        delete cache.deliveries[creep.name];
    }
    var m = creep.memory || {};
    var target = m.freighterDeliveryTargetId && Game.getObjectById(m.freighterDeliveryTargetId);
    var amount = creep.store && creep.store[RESOURCE_ENERGY] || 0;
    if (!m.FreighterWorking || !target || !target.store || typeof target.store.getFreeCapacity !== 'function' || amount <= 0) return;
    amount = Math.min(amount, target.store.getFreeCapacity(RESOURCE_ENERGY));
    cache.deliveries[creep.name] = { target: target.id, amount: amount };
    cache.deliveryEnergy[target.id] = (cache.deliveryEnergy[target.id] || 0) + amount;
}

// Local and remote roles share delivery reservations. All values are heap-only
// for this tick; deaths and failed engine intents naturally expire next tick.
function deliveryTarget(creep, roomName, remote) {
    if (!creep || !creep.memory) return null;
    return require('Diagnostics').measureOperation('deliverySelection', function() { return selectDeliveryTarget(creep, roomName, remote); });
}

function selectDeliveryTarget(creep, roomName, remote) {
    var room = Game.rooms[roomName];
    if (!room) return null;
    var cache = snapshot(), m = creep.memory;
    var byType = require('HiveMind.Index').get().structuresByRoom.get(roomName) || new Map();
    var structures = function(type) { return byType.get(type) || []; };
    var supply = structures(STRUCTURE_SPAWN).concat(structures(STRUCTURE_EXTENSION)).filter(s => s.my !== false);
    var towers = structures(STRUCTURE_TOWER).filter(s => s.my !== false);
    var controller = structures(STRUCTURE_CONTAINER).filter(s => room.controller && s.pos.getRangeTo(room.controller) <= 3);
    var storage = room.storage ? [room.storage] : [];
    var tiers = remote ? [supply, storage, towers, room.terminal ? [room.terminal] : []] : [supply, towers, controller, storage];
    var own = cache.deliveries[creep.name];
    var selected = null;
    for (var tier of tiers) {
        var bestRange = Infinity;
        for (var target of tier) {
            if (!target.store || typeof target.store.getFreeCapacity !== 'function' ||
                m.freighterDeliveryBlockedId === target.id && m.freighterDeliveryBlockedUntil > Game.time) continue;
            var reserved = (cache.deliveryEnergy[target.id] || 0) - (own && own.target === target.id ? own.amount : 0);
            if (target.store.getFreeCapacity(RESOURCE_ENERGY) <= reserved) continue;
            var range = creep.pos ? creep.pos.getRangeTo(target) : 0;
            if (target.id === m.freighterDeliveryTargetId) { selected = target; break; }
            if (range < bestRange) { selected = target; bestRange = range; }
        }
        if (selected) break;
    }
    if (selected) m.freighterDeliveryTargetId = selected.id;
    else delete m.freighterDeliveryTargetId;
    updateDelivery(creep, cache);
    return selected;
}

function blockDelivery(creep) {
    var m = creep.memory;
    m.freighterDeliveryBlockedId = m.freighterDeliveryTargetId;
    m.freighterDeliveryBlockedUntil = Game.time + 10;
    delete m.freighterDeliveryTargetId;
    updateDelivery(creep, snapshot());
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

module.exports = { snapshot: snapshot, update: update, remove: remove, remoteClaim: remoteClaim, reservations: reservations,
    deliveryTarget: deliveryTarget, blockDelivery: blockDelivery, localPickupOptions: localPickupOptions,
    REVISION: 'logistics-2026-11-07' };
