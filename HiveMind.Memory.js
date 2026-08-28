const SCHEMA_VERSION = 2;

function setDefault(target, key, value) {
    if (target[key] === undefined) target[key] = value;
}

function ensure() {
    if (!Memory.hive || typeof Memory.hive !== 'object') Memory.hive = {};
    const hive = Memory.hive;
    setDefault(hive, 'schemaVersion', SCHEMA_VERSION);
    if (!hive.operations || typeof hive.operations !== 'object') hive.operations = {};
    if (!hive.squads || typeof hive.squads !== 'object') hive.squads = {};
    if (!hive.players || typeof hive.players !== 'object') hive.players = {};
    if (!hive.settings || typeof hive.settings !== 'object') hive.settings = {};
    if (!hive.season || typeof hive.season !== 'object') hive.season = {};
    if (!hive.threats || typeof hive.threats !== 'object') hive.threats = {};
    if (!hive.demands || typeof hive.demands !== 'object') hive.demands = {};
    if (!hive.counters || typeof hive.counters !== 'object') hive.counters = {};

    setDefault(hive.settings, 'enabled', true);
    setDefault(hive.settings, 'independentCombat', true);
    if (!hive.settings.diplomacy) {
        hive.settings.diplomacy = { incidentHalfLife: 5000, hostileThreshold: 100 };
    }
    if (!hive.settings.towers) {
        hive.settings.towers = { energyReserve: 200, repairEnergyReserve: 700 };
    }
    if (!hive.settings.safeMode) {
        hive.settings.safeMode = { enabled: true, manualConfirmation: true };
    }
    if (!hive.settings.strategy) {
        hive.settings.strategy = { enabled: true, scoreInterval: 17, maxCandidates: 12 };
    }
    return hive;
}

function migrate() {
    const hive = ensure();
    if (hive.schemaVersion < SCHEMA_VERSION) hive.schemaVersion = SCHEMA_VERSION;
    return hive;
}

module.exports = { ensure, migrate, SCHEMA_VERSION };
