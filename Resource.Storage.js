const HiveMemory = require('HiveMind.Memory');
const DEFAULTS = Object.freeze({ interval: 11, minimumStorageFreeCapacity: 100000,
    desiredStorageFreeCapacity: 150000, minimumTerminalFreeCapacity: 50000,
    terminalEnergyReserve: 20000, transferCooldown: 100, boostSafetyMargin: 0.25,
    diversityBonus: 8, desiredReactorThorium: 900, thoriumStagingDesired: 200,
    thoriumStagingUrgent: 450 });
function config() {
    const result = { ...DEFAULTS, ...(HiveMemory.getConfig('resources').policy || {}) };
    for (const key of Object.keys(DEFAULTS)) if (!Number.isFinite(result[key]) || result[key] < 0) result[key] = DEFAULTS[key];
    result.interval = Math.max(1, result.interval);
    result.desiredReactorThorium = Math.min(1000, Math.max(1, result.desiredReactorThorium));
    return result;
}
function free(store) { return store && typeof store.getFreeCapacity === 'function' ? store.getFreeCapacity() || 0 : 0; }
function active(s) { return s && s.my !== false && (!s.isActive || s.isActive()); }
function capacity(room) {
    const c = config(), storageFree = free(room.storage && room.storage.store);
    const terminalFree = free(room.terminal && room.terminal.store);
    const pressure = !active(room.storage) || storageFree < c.minimumStorageFreeCapacity ||
        active(room.terminal) && terminalFree < c.minimumTerminalFreeCapacity;
    return { storageUsed: room.storage && room.storage.store && typeof room.storage.store.getUsedCapacity === 'function' ?
        room.storage.store.getUsedCapacity() || 0 : 0, storageFree, terminalFree,
    reservedFree: c.minimumStorageFreeCapacity, capacityPressure: pressure ? 'PRESSURE' : 'OK',
    extractionBlockedReason: pressure ? 'PAUSED_STORAGE_PRESSURE' : null };
}
module.exports = { DEFAULTS, config, capacity, free, active };
