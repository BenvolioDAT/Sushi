const SCHEMA_VERSION = 4;

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
    if (!hive.resources || typeof hive.resources !== 'object') hive.resources = {};
    if (!hive.resources.rooms) hive.resources.rooms = {};
    if (!hive.resources.labs) hive.resources.labs = {};
    if (!hive.resources.transfers) hive.resources.transfers = {};
    if (!hive.resources.boosts) hive.resources.boosts = {};
    if (!hive.resources.observers) hive.resources.observers = {};

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
    if (!hive.settings.squads) {
        hive.settings.squads = { enabled: true, autoDefenseDuos: true };
    }
    if (!hive.settings.resources) {
        hive.settings.resources = {
            enabled: true, minerals: true, links: true,
            terminals: true, labs: true, observers: true, market: false
        };
    }
    for (const squad of Object.values(hive.squads)) {
        if (!squad || typeof squad !== 'object') continue;
        if (!squad.members || typeof squad.members !== 'object') squad.members = { attacker: null, healer: null };
        if (!squad.stateTimeouts) squad.stateTimeouts = {};
        if (!squad.demandIds) squad.demandIds = [];
    }
    return hive;
}

function migrate() {
    const hive = ensure();
    if (hive.schemaVersion < SCHEMA_VERSION) hive.schemaVersion = SCHEMA_VERSION;
    return hive;
}

module.exports = { ensure, migrate, SCHEMA_VERSION };
