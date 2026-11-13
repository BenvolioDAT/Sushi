const HiveMemory = require('HiveMind.Memory');
const TickIndex = require('HiveMind.Index');

function state() {
    const hive = HiveMemory.ensure();
    if (!hive.power || typeof hive.power !== 'object') hive.power = {};
    if (!hive.power.banks || typeof hive.power.banks !== 'object') hive.power.banks = {};
    if (!hive.power.operations || typeof hive.power.operations !== 'object') hive.power.operations = {};
    if (!hive.power.stats || typeof hive.power.stats !== 'object') hive.power.stats = {};
    if (!hive.power.lifecycle || typeof hive.power.lifecycle !== 'object') hive.power.lifecycle = {};
    return hive.power;
}

function amount(store, type) {
    if (!store) return 0;
    return typeof store.getUsedCapacity === 'function' ? store.getUsedCapacity(type) || 0 : store[type] || 0;
}

function routeFromHomes(roomName) {
    let best = null;
    for (const home of TickIndex.get().ownedSpawnRooms || []) {
        let distance = null;
        if (Game.map && typeof Game.map.findRoute === 'function') {
            const route = Game.map.findRoute(home.name, roomName);
            if (Array.isArray(route)) distance = route.length;
        }
        if (distance === null && Game.map && typeof Game.map.getRoomLinearDistance === 'function') {
            distance = Game.map.getRoomLinearDistance(home.name, roomName);
        }
        if (typeof distance === 'number' && (!best || distance < best.distance)) {
            best = { roomName: home.name, distance };
        }
    }
    return best;
}

function observeRoom(room, snapshot) {
    if (!room || typeof room.find !== 'function' || typeof STRUCTURE_POWER_BANK === 'undefined' ||
        typeof FIND_STRUCTURES === 'undefined') return [];
    const now = Game.time;
    const power = state();
    let structures = snapshot && snapshot.structures;
    if (!structures) try { structures = room.find(FIND_STRUCTURES) || []; } catch (error) { return []; }
    let hostiles = snapshot && snapshot.hostiles;
    if (!hostiles && typeof FIND_HOSTILE_CREEPS !== 'undefined') {
        try { hostiles = room.find(FIND_HOSTILE_CREEPS) || []; } catch (error) { hostiles = []; }
    }
    hostiles = hostiles || [];
    const seen = [];
    for (const bank of structures.filter(item => item && item.structureType === STRUCTURE_POWER_BANK)) {
        const record = power.banks[bank.id] || {};
        const route = record.homeRoom && now - (record.routeCheckedAt || 0) <= 2500 ?
            { roomName: record.homeRoom, distance: record.routeDistance } : routeFromHomes(room.name);
        Object.assign(record, {
            id: bank.id,
            roomName: room.name,
            x: bank.pos && bank.pos.x,
            y: bank.pos && bank.pos.y,
            power: Math.max(0, Number(bank.power) || amount(bank.store, typeof RESOURCE_POWER !== 'undefined' ? RESOURCE_POWER : 'power')),
            hits: Math.max(0, Number(bank.hits) || 0),
            hitsMax: Math.max(0, Number(bank.hitsMax) || 0),
            ticksToDecay: Math.max(0, Number(bank.ticksToDecay) || 0),
            lastSeen: now,
            decayAt: now + Math.max(0, Number(bank.ticksToDecay) || 0),
            homeRoom: route && route.roomName || null,
            routeDistance: route && route.distance,
            routeCheckedAt: route === null ? now : record.routeCheckedAt &&
                record.homeRoom === route.roomName && record.routeDistance === route.distance ? record.routeCheckedAt : now,
            threat: { hostileCreeps: hostiles.length, lastSeen: now }
        });
        power.banks[bank.id] = record;
        seen.push(record);
    }
    return seen;
}

function cleanup(force) {
    const power = state();
    if (!force && Game.time % 101 !== 0) return 0;
    let removed = 0;
    for (const [id, bank] of Object.entries(power.banks)) {
        const expired = !bank || bank.decayAt <= Game.time || Game.time - (bank.lastSeen || 0) > 5000;
        if (!expired) continue;
        const operation = power.operations[id];
        if (operation && operation.state !== 'COMPLETE') {
            operation.state = 'ABORTED';
            operation.reason = 'POWER_BANK_INTEL_EXPIRED';
            operation.updatedAt = Game.time;
        }
        delete power.banks[id];
        removed++;
    }
    return removed;
}

function scanVisible() {
    const found = [];
    if (typeof STRUCTURE_POWER_BANK === 'undefined') {
        cleanup(false);
        return found;
    }
    const index = TickIndex.get();
    for (const room of index.visibleRooms || []) {
        const byType = index.structuresByRoom.get(room.name);
        found.push(...observeRoom(room, {
            structures: byType && byType.get(STRUCTURE_POWER_BANK) || [],
            hostiles: index.hostilesByRoom.get(room.name) || []
        }));
    }
    cleanup(false);
    return found;
}

module.exports = { state, observeRoom, scanVisible, cleanup, routeFromHomes };
