const HiveMemory = require('HiveMind.Memory');
const DEFAULTS = Object.freeze({ interval: 11, minimumStorageFreeCapacity: 100000,
    desiredStorageFreeCapacity: 150000, minimumTerminalFreeCapacity: 50000,
    terminalEnergyReserve: 20000, transferCooldown: 100, boostSafetyMargin: 0.25,
    diversityBonus: 8 });
function config() {
    const result = { ...DEFAULTS, ...(HiveMemory.getConfig('resources').policy || {}) };
    for (const key of Object.keys(DEFAULTS)) if (!Number.isFinite(result[key]) || result[key] < 0) result[key] = DEFAULTS[key];
    result.interval = Math.max(1, result.interval);
    return result;
}
function free(store) { return store && typeof store.getFreeCapacity === 'function' ? store.getFreeCapacity() || 0 : 0; }
function active(s) { return s && s.my !== false && (!s.isActive || s.isActive()); }
function capacity(room) {
    const c = config(), storageFree = free(room.storage && room.storage.store);
    const terminalFree = free(room.terminal && room.terminal.store);
    const pressure = !active(room.storage) || storageFree < c.minimumStorageFreeCapacity ||
        active(room.terminal) && terminalFree < c.minimumTerminalFreeCapacity;
    const energyType = typeof RESOURCE_ENERGY !== 'undefined' ? RESOURCE_ENERGY : 'energy';
    const energy = structure => structure && structure.store ? Number(structure.store[energyType]) || 0 : 0;
    const storedEnergy = energy(room.storage) + energy(room.terminal);
    const totalUsed = [room.storage, room.terminal].reduce((sum, structure) => sum +
        (structure && structure.store && typeof structure.store.getUsedCapacity === 'function' ?
            structure.store.getUsedCapacity() || 0 : 0), 0);
    const economy = Memory.rooms && Memory.rooms[room.name] && Memory.rooms[room.name].economy;
    const reserve = economy && economy.growth && economy.growth.reserveTarget || 0;
    const pressureType = !pressure ? 'NONE' : storedEnergy > reserve &&
        (storedEnergy >= totalUsed * 0.6 || storedEnergy - reserve >= c.minimumStorageFreeCapacity) ?
        'ENERGY' : 'RESOURCES';
    return { storageUsed: room.storage && room.storage.store && typeof room.storage.store.getUsedCapacity === 'function' ?
        room.storage.store.getUsedCapacity() || 0 : 0, storageFree, terminalFree,
    storedEnergy, pressureType,
    reservedFree: c.minimumStorageFreeCapacity, capacityPressure: pressure ? 'PRESSURE' : 'OK',
    extractionBlockedReason: pressure ? 'PAUSED_STORAGE_PRESSURE' : null };
}
module.exports = { DEFAULTS, config, capacity, free, active };
