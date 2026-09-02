const SCHEMA_VERSION = 8;

const CONFIG_DEFAULTS = Object.freeze({
    general: { enabled: true, useTrafficManager: true },
    cpu: { telemetry: { persistInterval: 100, debug: false } },
    spawn: {
        enabled: true, maxQueueLengthPerRoom: 8, maxNewRequestsPerRoomPerTick: 2,
        combatSpawnShare: 0.5,
        roleCaps: { Foreman: 1, Scout: 1, Annex: 4, Ronin: 4, Volley: 4, Cleric: 3,
            Tech: 3, Artificer: 3, Extractor: 6, Freighter: 6, Pioneer: 2,
            SupplyRunner: 2, ThoriumMiner: 2, ThoriumHauler: 4, ReactorClaimer: 1 },
        maxCreepsPerRoomByRcl: { RCL1: 10, RCL2: 16, RCL3: 20, RCL4: 26,
            RCL5: 30, RCL6: 36, RCL7: 40, RCL8: 46 }
    },
    economy: {}, lifecycle: { hysteresisTicks: 5, milestoneTimeout: 1500 },
    memoryGC: {
        interval: 101, workBudget: 25, squadRetention: 250, operationRetention: 1000,
        demandRetention: 25, queueRetention: 50, playerRetention: 50000,
        intelRetention: 20000, expansionRetention: 10000, debugRetention: 5000
    },
    upgrade: {
        autoCpuUpgradeBoost: true, cpuUpgradeBoostMaximum: 1.75,
        cpuUpgradeMinimumBucket: 7000, cpuUpgradeMinimumStorage: 50000,
        upgradeRush: false
    },
    combat: {
        independentCombat: true, useWarRoom: false,
        diplomacy: { incidentHalfLife: 5000, hostileThreshold: 100 },
        towers: { energyReserve: 200, repairEnergyReserve: 700 },
        safeMode: { enabled: true, manualConfirmation: true },
        strategy: { enabled: true, scoreInterval: 17, maxCandidates: 12,
            maxActiveNonEmergency: 3, maxActivePerColony: 2, minimumUtility: -100 },
        squads: { enabled: true, autoDefenseDuos: true, quadsEnabled: true, autoDefenseQuads: true }
    },
    resources: {
        enabled: true, minerals: true, links: true,
        terminals: true, labs: true, observers: true, market: false
    },
    season11: {},
    visuals: {
        showDashboard: true, showRemoteRoomDashboard: true,
        dashboardShowRoleCounts: false, showStructurePlanner: false,
        showRoadPlanner: false, visualInterval: 1
    },
    pixels: { enabled: false, bucketThreshold: 10000, tickModulo: 10 }
});

function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (!isObject(value)) return value;
    const result = {};
    for (const [key, child] of Object.entries(value)) result[key] = clone(child);
    return result;
}

function mergeMissing(target, source) {
    if (!isObject(source)) return target;
    for (const [key, value] of Object.entries(source)) {
        if (target[key] === undefined) target[key] = clone(value);
        else if (isObject(target[key]) && isObject(value)) mergeMissing(target[key], value);
    }
    return target;
}

function overlay(target, source) {
    if (!isObject(source)) return target;
    for (const [key, value] of Object.entries(source)) {
        if (isObject(value)) overlay(ensureObject(target, key), value);
        else target[key] = clone(value);
    }
    return target;
}

function ensureObject(parent, key) {
    if (!isObject(parent[key])) parent[key] = {};
    return parent[key];
}

let cachedSchema = null;

function ensureNewSchema() {
    if (typeof Memory === 'undefined') return { hive: {}, config: {}, rooms: {}, cpu: {}, meta: {} };
    if (cachedSchema && cachedSchema.memory === Memory && cachedSchema.hive === Memory.hive &&
        cachedSchema.config === Memory.config && cachedSchema.rooms === Memory.rooms) return cachedSchema;
    const meta = ensureObject(Memory, 'meta');
    const config = ensureObject(Memory, 'config');
    const hive = ensureObject(Memory, 'hive');
    const cpu = ensureObject(Memory, 'cpu');
    ensureObject(Memory, 'rooms');
    ensureObject(Memory, 'creeps');
    for (const [domain, defaults] of Object.entries(CONFIG_DEFAULTS)) {
        mergeMissing(ensureObject(config, domain), defaults);
    }
    for (const key of ['operations', 'squads', 'players', 'threats', 'demands', 'counters']) {
        ensureObject(hive, key);
    }
    const resources = ensureObject(hive, 'resources');
    for (const key of ['rooms', 'labs', 'transfers', 'boosts', 'observers']) ensureObject(resources, key);
    const season = ensureObject(hive, 'season');
    if (!Array.isArray(season.activeOperationIds)) season.activeOperationIds = [];
    if (!Array.isArray(season.deliveryEvents)) season.deliveryEvents = [];
    ensureObject(season, 'stats');
    for (const key of ['expansion', 'warRoom', 'telemetry', 'identity']) ensureObject(hive, key);
    const homeRooms = ensureObject(hive, 'homeRooms');
    if (!Array.isArray(homeRooms.names)) homeRooms.names = [];
    if (typeof homeRooms.updatedAt !== 'number') homeRooms.updatedAt = 0;
    ensureObject(cpu, 'status');
    for (const squad of Object.values(hive.squads)) {
        if (!isObject(squad)) continue;
        if (!isObject(squad.members)) squad.members = { attacker: null, healer: null };
        if (!isObject(squad.stateTimeouts)) squad.stateTimeouts = {};
        if (!Array.isArray(squad.demandIds)) squad.demandIds = [];
    }
    cachedSchema = { memory: Memory, meta, config, hive, cpu, rooms: Memory.rooms };
    return cachedSchema;
}

function copySetting(config, legacy, key, domain, targetKey) {
    if (!isObject(legacy) || legacy[key] === undefined) return;
    const target = ensureObject(config, domain);
    const destination = targetKey || key;
    target[destination] = clone(legacy[key]);
}

function migrateLegacySettings(config, settings) {
    if (!isObject(settings)) return;
    if (isObject(settings.pixels)) overlay(ensureObject(config, 'pixels'), settings.pixels);
    else if (settings.pixels !== undefined) ensureObject(config, 'pixels').legacyValue = clone(settings.pixels);
    copySetting(config, settings, 'cpuTelemetry', 'cpu', 'telemetry');
    const upgrade = ['autoCpuUpgradeBoost', 'cpuUpgradeBoostMaximum',
        'cpuUpgradeMinimumBucket', 'cpuUpgradeMinimumStorage', 'upgradeRush'];
    for (const key of upgrade) copySetting(config, settings, key, 'upgrade');
    copySetting(config, settings, 'useWarRoom', 'combat');
    copySetting(config, settings, 'useTrafficManager', 'general');
    const visuals = ['showDashboard', 'showRemoteRoomDashboard', 'dashboardShowRoleCounts',
        'dashboardRoom', 'showStructurePlanner', 'showRoadPlanner', 'visualInterval'];
    for (const key of visuals) copySetting(config, settings, key, 'visuals');
    const recognized = new Set(['pixels', 'cpuTelemetry', ...upgrade, 'useWarRoom',
        'useTrafficManager', ...visuals]);
    const general = ensureObject(config, 'general');
    for (const [key, value] of Object.entries(settings)) {
        if (!recognized.has(key) && general[key] === undefined) general[key] = clone(value);
    }
}

function migrateHiveSettings(config, settings) {
    if (!isObject(settings)) return;
    copySetting(config, settings, 'enabled', 'general');
    copySetting(config, settings, 'independentCombat', 'combat');
    const combat = ['diplomacy', 'towers', 'safeMode', 'strategy', 'squads'];
    for (const key of combat) copySetting(config, settings, key, 'combat');
    if (isObject(settings.resources)) overlay(ensureObject(config, 'resources'), settings.resources);
    else if (settings.resources !== undefined) {
        ensureObject(config, 'resources').legacyValue = clone(settings.resources);
    }
    const known = new Set(['enabled', 'independentCombat', ...combat, 'resources']);
    const general = ensureObject(config, 'general');
    for (const [key, value] of Object.entries(settings)) {
        if (!known.has(key) && general[key] === undefined) general[key] = clone(value);
    }
}

function persistentEconomy(snapshot) {
    if (!isObject(snapshot)) return null;
    const result = {};
    const keys = ['state', 'rawState', 'stateSince', 'stateChangedAt', 'healthyTicks',
        'reason', 'sampleTick', 'liquidEnergy', 'energyTrend', 'protectedStockpileEnergy'];
    for (const key of keys) {
        if (snapshot[key] === undefined) continue;
        const destination = key === 'sampleTick' ? 'lastSampleTick' :
            key === 'liquidEnergy' ? 'lastLiquidEnergy' : key;
        result[destination] = clone(snapshot[key]);
    }
    return result;
}

function migrateRoomRecord(roomName, room, oldEconomyRooms, hive) {
    if (!isObject(room)) return;
    const spawn = ensureObject(room, 'spawn');
    if (room.spawnQueue !== undefined && spawn.queue === undefined) spawn.queue = clone(room.spawnQueue);
    if (room.spawnDemandCache !== undefined && spawn.demandCache === undefined) spawn.demandCache = clone(room.spawnDemandCache);
    if (room.spawnGovernor !== undefined && spawn.governor === undefined) spawn.governor = clone(room.spawnGovernor);
    const cache = ensureObject(room, 'cache');
    if (room.economyDistanceCache !== undefined && cache.economyDistances === undefined) {
        cache.economyDistances = clone(room.economyDistanceCache);
    }
    if (oldEconomyRooms && oldEconomyRooms[roomName] !== undefined) {
        const persistent = persistentEconomy(oldEconomyRooms[roomName]);
        if (persistent) mergeMissing(ensureObject(room, 'economy'), persistent);
        else {
            const legacy = ensureObject(ensureObject(hive, 'economy'), 'legacyRooms');
            if (legacy[roomName] === undefined) legacy[roomName] = clone(oldEconomyRooms[roomName]);
        }
    }
    delete room.spawnQueue;
    delete room.spawnDemandCache;
    delete room.spawnGovernor;
    delete room.economyDistanceCache;
}

function migrateSeason11(config, hive, legacy) {
    if (!isObject(legacy)) return;
    const seasonConfig = ensureObject(config, 'season11');
    if (legacy.mode !== undefined && seasonConfig.mode === undefined) seasonConfig.mode = legacy.mode;
    if (isObject(legacy.config)) mergeMissing(seasonConfig, legacy.config);
    const runtime = ensureObject(ensureObject(hive, 'season'), 'season11');
    for (const [key, value] of Object.entries(legacy)) {
        if (key !== 'config' && key !== 'mode' && runtime[key] === undefined) runtime[key] = clone(value);
    }
}

function migrate7To8() {
    cachedSchema = null;
    const originalConfig = Memory.config;
    const existingConfig = isObject(Memory.config) ? clone(Memory.config) : {};
    try {
        Memory.config = {};
        const schema = ensureNewSchema();
        const { config, hive, cpu } = schema;
        migrateLegacySettings(config, Memory.settings);
        migrateHiveSettings(config, hive.settings);
        if (isObject(Memory.cpuPolicy)) overlay(config.cpu, Memory.cpuPolicy);
        if (isObject(Memory.spawnPolicy)) overlay(config.spawn, Memory.spawnPolicy);
        if (isObject(Memory.cpuStatus)) mergeMissing(cpu.status, Memory.cpuStatus);
        migrateSeason11(config, hive, Memory.season11);
        overlay(config, existingConfig);
        if (isObject(Memory.expansion)) mergeMissing(hive.expansion, Memory.expansion);
        if (isObject(Memory.WarRoom)) mergeMissing(hive.warRoom, Memory.WarRoom);
        if (isObject(Memory.stats)) mergeMissing(hive.telemetry, Memory.stats);
        if (Memory.username !== undefined && hive.identity.username === undefined) hive.identity.username = Memory.username;
        if (Memory.firstSpawnRoom !== undefined && hive.identity.firstSpawnRoom === undefined) hive.identity.firstSpawnRoom = Memory.firstSpawnRoom;
        const oldEconomyRooms = hive.economy && isObject(hive.economy.rooms) ? hive.economy.rooms : null;
        for (const [roomName, room] of Object.entries(Memory.rooms || {})) {
            try { migrateRoomRecord(roomName, room, oldEconomyRooms, hive); }
            catch (error) {
                const failures = ensureObject(ensureObject(hive, 'migration'), 'roomFailures');
                failures[roomName] = String(error && error.message || error);
            }
        }
        if (oldEconomyRooms) {
            for (const roomName of Object.keys(oldEconomyRooms)) {
                try {
                    if (!isObject(Memory.rooms[roomName])) Memory.rooms[roomName] = {};
                    migrateRoomRecord(roomName, Memory.rooms[roomName], oldEconomyRooms, hive);
                    delete oldEconomyRooms[roomName];
                }
                catch (error) {
                    const failures = ensureObject(ensureObject(hive, 'migration'), 'roomFailures');
                    failures[roomName] = String(error && error.message || error);
                }
            }
            if (Object.keys(oldEconomyRooms).length === 0) delete hive.economy.rooms;
        }
        delete hive.settings;
        delete hive.schemaVersion;
        for (const key of ['settings', 'cpuPolicy', 'spawnPolicy', 'cpuStatus', 'season11',
            'expansion', 'WarRoom', 'stats', 'username', 'firstSpawnRoom']) delete Memory[key];
    }
    catch (error) {
        Memory.config = originalConfig;
        throw error;
    }
}

function migrate() {
    if (typeof Memory === 'undefined') return ensureNewSchema().hive;
    const oldVersion = Memory.meta && Number(Memory.meta.schemaVersion) ||
        Memory.hive && Number(Memory.hive.schemaVersion) || 7;
    if (oldVersion < 8) {
        migrate7To8();
        const meta = ensureObject(Memory, 'meta');
        meta.schemaVersion = 8;
        meta.migratedAt = typeof Game !== 'undefined' && typeof Game.time === 'number' ? Game.time : 0;
        meta.lastMigration = '7-to-8-memory-architecture';
    }
    cachedSchema = null;
    const schema = ensureNewSchema();
    if (!schema.meta.schemaVersion || schema.meta.schemaVersion < SCHEMA_VERSION) schema.meta.schemaVersion = SCHEMA_VERSION;
    return schema.hive;
}

function needsMigration() {
    if (typeof Memory === 'undefined') return false;
    const version = Memory.meta && Number(Memory.meta.schemaVersion);
    return !Number.isFinite(version) || version < SCHEMA_VERSION;
}

function ensure() {
    if (needsMigration()) migrate();
    return ensureNewSchema().hive;
}

function getConfig(domain) {
    if (needsMigration()) migrate();
    const schema = ensureNewSchema();
    return domain ? ensureObject(schema.config, domain) : schema.config;
}

function getRoomMemory(roomName) {
    if (!isObject(Memory.rooms)) Memory.rooms = {};
    if (!isObject(Memory.rooms[roomName])) Memory.rooms[roomName] = {};
    return Memory.rooms[roomName];
}

function getRoomSpawnMemory(roomName) {
    const spawn = ensureObject(getRoomMemory(roomName), 'spawn');
    if (!Array.isArray(spawn.queue)) spawn.queue = [];
    ensureObject(spawn, 'demandCache');
    return spawn;
}

function getRoomEconomyMemory(roomName) {
    return ensureObject(getRoomMemory(roomName), 'economy');
}

function getSeasonState() {
    return ensureObject(ensureObject(ensure(), 'season'), 'season11');
}

function remoteParents() {
    const parents = {};
    for (const [homeName, room] of Object.entries(Memory.rooms || {})) {
        const planner = room && room.remotePlanner;
        for (const [remoteName, remote] of Object.entries(planner && planner.remotes || {})) {
            if (remote && (remote.status === 'active' || remote.sourceIds && remote.sourceIds.length)) parents[remoteName] = homeName;
        }
    }
    return parents;
}

function syncHomeRooms(index) {
    const hive = ensure();
    const names = (index && index.ownedSpawnRooms || []).map(room => room.name).sort();
    hive.homeRooms = { updatedAt: Game.time, names };
    const homes = new Set(names);
    const parents = remoteParents();
    for (const [roomName, roomMemory] of Object.entries(Memory.rooms || {})) {
        if (!isObject(roomMemory)) continue;
        const visible = Game.rooms && Game.rooms[roomName];
        let identity;
        if (homes.has(roomName)) identity = { type: 'HOME' };
        else if (visible && visible.controller && visible.controller.my) {
            identity = { type: 'OWNED_BOOTSTRAP' };
            if (hive.expansion && hive.expansion.originRoom && hive.expansion.originRoom !== roomName) {
                identity.parentHome = hive.expansion.originRoom;
            }
        }
        else if (parents[roomName]) identity = { type: 'REMOTE', parentHome: parents[roomName] };
        else identity = { type: 'INTEL' };
        roomMemory.identity = identity;
    }
    return hive.homeRooms;
}

function memoryMap() {
    const meta = Memory.meta || {};
    const hive = Memory.hive || {};
    const lines = [`SUSHI MEMORY — schema ${meta.schemaVersion || 'unknown'}`, '', 'HOME ROOMS'];
    const homes = hive.homeRooms && hive.homeRooms.names || [];
    if (homes.length) for (const name of homes) lines.push(`  ${name}`);
    else lines.push('  (none)');
    lines.push('', 'ROOMS');
    for (const roomName of Object.keys(Memory.rooms || {}).sort()) {
        const room = Memory.rooms[roomName] || {};
        const identity = room.identity || { type: 'UNKNOWN' };
        const parent = identity.parentHome ? ` -> ${identity.parentHome}` : '';
        lines.push(`  ${roomName} [${identity.type}${parent}]`);
        if (room.economy && room.economy.state) lines.push(`    ECO: ${room.economy.state}`);
        const remotes = room.remotePlanner && room.remotePlanner.remotes ? Object.keys(room.remotePlanner.remotes).sort() : [];
        if (remotes.length) lines.push(`    Remotes: ${remotes.join(', ')}`);
    }
    lines.push('', 'CPU', `  Status: ${(Memory.cpu && Memory.cpu.status && Memory.cpu.status.mode || 'unknown').toUpperCase()}`);
    const stale = hive.gc && hive.gc.lastReport && hive.gc.lastReport.stale || 0;
    lines.push('', 'HIVE', `  Rooms: ${Object.keys(Memory.rooms || {}).length}`,
        `  Operations: ${Object.keys(hive.operations || {}).length}`,
        `  Squads: ${Object.keys(hive.squads || {}).length}`,
        `  Demands: ${Object.keys(hive.demands || {}).length}`,
        `  Threats: ${Object.keys(hive.threats || {}).length}`,
        `  Expansion candidates: ${Object.keys(hive.expansion && hive.expansion.candidates || {}).length}`,
        `  Stale records: ${stale}`);
    let size = 0;
    try { size = JSON.stringify(Memory).length; }
    catch (error) { /* Partially malformed Memory remains inspectable. */ }
    lines.push('', 'MEMORY', `  Approx size: ${(size / 1024).toFixed(1)} KB`);
    return lines.join('\n');
}

function installConsoleHelpers() {
    global.MemorySchema = Object.freeze({ map: memoryMap });
    return global.MemorySchema;
}

module.exports = {
    ensure, migrate, getConfig, getRoomMemory, getRoomSpawnMemory,
    getRoomEconomyMemory, getSeasonState, syncHomeRooms, memoryMap,
    installConsoleHelpers, mergeMissing, SCHEMA_VERSION
};
