const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mocks = require('./mock-screeps');

function fresh(file) {
    const resolved = path.join(mocks.root, file);
    delete require.cache[require.resolve(resolved)];
    return require(resolved);
}

function test(name, fn) {
    fn();
    console.log('PASS ' + name);
}

function oldMemoryFixture() {
    const sourceRows = Array.from({ length: 24 }, (_, index) => ({
        id: 'source-' + index,
        energy: 3000,
        workActive: 5,
        workRequired: 5,
        distance: 27,
        transport: { mode: 'CREEP_HAUL', creepIncome: 10, linkServedIncome: 0 },
        backlog: 0
    }));
    return {
        creeps: { Worker1: { role: 'Extractor', homeRoom: 'W1N1' } },
        settings: {
            pixels: { enabled: true, tickModulo: 3 },
            upgradeRush: true,
            useWarRoom: true,
            showDashboard: false,
            customUserSetting: 'preserve-me'
        },
        cpuPolicy: {
            normalBucket: 7300,
            telemetry: { persistInterval: 37, debug: true },
            customCpuPolicy: 'cpu-custom'
        },
        cpuStatus: { mode: 'low', modeSince: 91, customStatus: true },
        spawnPolicy: { enabled: false, emergencyPriority: 777, customSpawnPolicy: true },
        season11: {
            schemaVersion: 3,
            mode: 'observe',
            config: { startupReserve: 777, customSeasonConfig: true },
            rooms: { W8N8: { lastObserved: 80, thorium: 12 } },
            reactors: { reactor1: { roomName: 'W8N8' } },
            assignments: { a1: { role: 'ThoriumMiner' } },
            alerts: [{ tick: 99, message: 'preserve' }],
            stats: { delivered: 4 }
        },
        expansion: { originRoom: 'W1N1', targetRoom: 'W2N2' },
        WarRoom: { activeRoom: 'W9N9', lastRun: 95 },
        stats: { cpu: [{ tick: 90, used: 8 }] },
        username: 'SushiPlayer',
        firstSpawnRoom: 'W1N1',
        customRoot: { owner: 'user', untouched: true },
        hive: {
            schemaVersion: 7,
            settings: {
                independentCombat: false,
                towers: { energyReserve: 321 },
                resources: { enabled: false, market: true, customResourceSetting: 42 },
                customHiveSetting: 'hive-custom'
            },
            operations: { op1: { type: 'DEFEND', roomName: 'W1N1' } },
            squads: { squad1: { state: 'ASSEMBLING', customSquadData: true } },
            players: { Ally: { classification: 'ally' } },
            customHiveState: { remains: true },
            economy: {
                rooms: {
                    W1N1: {
                        roomName: 'W1N1', sampleTick: 99, state: 'RECOVERY', rawState: 'STABLE',
                        stateSince: 70, stateChangedAt: 70, healthyTicks: 5,
                        reason: 'holding for confirmation', liquidEnergy: 42000, energyTrend: 4.2,
                        energyAvailable: 800, storageEnergy: 40000, terminalEnergy: 1200,
                        harvest: { workActive: 10, workRequired: 10, sources: sourceRows },
                        haul: { activeCarry: 20, requiredCarry: 18, backlog: 0 },
                        spawnPressure: { queued: 2, busy: 1 }
                    }
                }
            }
        },
        rooms: {
            W1N1: {
                roomName: 'W1N1',
                sources: { sourceA: { id: 'sourceA', x: 10, y: 20 } },
                structurePlanner: { version: 4, anchor: { x: 25, y: 25 } },
                remotePlanner: { remotes: { W1N2: { status: 'active', sourceIds: ['remoteSource'] } } },
                spawnQueue: [{ id: 'request-1', role: 'Extractor', priority: 120 }],
                spawnDemandCache: { tick: 98, demands: { Extractor: 1 } },
                spawnGovernor: { lastEmergencyTick: 90 },
                economyDistanceCache: { 'sourceA:spawn1': { version: 1, distance: 21, tick: 80 } },
                customRoomData: { untouched: true }
            },
            W7N7: 'malformed-but-isolated'
        },
        config: {
            pixels: { enabled: false, userNewValue: true },
            cpu: { normalBucket: 8800 },
            general: { validNewSetting: 'wins' }
        }
    };
}

function productionJavaScriptFiles(directory) {
    const result = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'test' || entry.name === '.git') continue;
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) result.push(...productionJavaScriptFiles(fullPath));
        else if (entry.name.endsWith('.js') && !entry.name.startsWith('test.')) result.push(fullPath);
    }
    return result;
}

mocks.installGlobals();
mocks.clearLocalModules();
let HiveMemory = fresh('HiveMind.Memory.js');

let representativeBefore = 0;
let representativeAfter = 0;

test('1-13 representative schema-7 Memory migrates safely and idempotently', function() {
    Memory = oldMemoryFixture();
    Game.time = 100;
    representativeBefore = JSON.stringify(Memory).length;
    const oldQueue = JSON.parse(JSON.stringify(Memory.rooms.W1N1.spawnQueue));
    const oldSources = JSON.parse(JSON.stringify(Memory.rooms.W1N1.sources));
    const oldPlanner = JSON.parse(JSON.stringify(Memory.rooms.W1N1.structurePlanner));

    HiveMemory.migrate();

    assert.strictEqual(Memory.meta.schemaVersion, 8, 'old schema did not advance');
    assert.strictEqual(Memory.meta.migratedAt, 100);
    assert.strictEqual(Memory.meta.lastMigration, '7-to-8-memory-architecture');
    assert.strictEqual(Memory.config.general.customUserSetting, 'preserve-me');
    assert.strictEqual(Memory.config.upgrade.upgradeRush, true);
    assert.strictEqual(Memory.config.combat.useWarRoom, true);
    assert.strictEqual(Memory.config.visuals.showDashboard, false);
    assert.strictEqual(Memory.config.pixels.enabled, false, 'valid new-schema value was overwritten');
    assert.strictEqual(Memory.config.pixels.tickModulo, 3, 'legacy pixel subfield was lost');
    assert.strictEqual(Memory.config.pixels.userNewValue, true);
    assert.strictEqual(Memory.config.general.validNewSetting, 'wins');
    assert.strictEqual(Memory.config.combat.independentCombat, false);
    assert.strictEqual(Memory.config.combat.towers.energyReserve, 321);
    assert.strictEqual(Memory.config.resources.enabled, false);
    assert.strictEqual(Memory.config.resources.market, true);
    assert.strictEqual(Memory.config.resources.customResourceSetting, 42);
    assert.strictEqual(Memory.config.general.customHiveSetting, 'hive-custom');
    assert.strictEqual(Memory.config.cpu.normalBucket, 8800, 'new CPU policy did not win');
    assert.strictEqual(Memory.config.cpu.telemetry.persistInterval, 37);
    assert.strictEqual(Memory.config.cpu.customCpuPolicy, 'cpu-custom');
    assert.strictEqual(Memory.config.spawn.enabled, false);
    assert.strictEqual(Memory.config.spawn.emergencyPriority, 777);
    assert.strictEqual(Memory.cpu.status.mode, 'low');
    assert.strictEqual(Memory.cpu.status.customStatus, true);
    assert.deepStrictEqual(Memory.rooms.W1N1.sources, oldSources);
    assert.deepStrictEqual(Memory.rooms.W1N1.structurePlanner, oldPlanner);
    assert.deepStrictEqual(Memory.rooms.W1N1.spawn.queue, oldQueue);
    assert.strictEqual(Memory.rooms.W1N1.spawn.demandCache.tick, 98);
    assert.strictEqual(Memory.rooms.W1N1.spawn.governor.lastEmergencyTick, 90);
    assert.strictEqual(Memory.rooms.W1N1.cache.economyDistances['sourceA:spawn1'].distance, 21);
    assert.strictEqual(Memory.rooms.W1N1.economy.state, 'RECOVERY');
    assert.strictEqual(Memory.rooms.W1N1.economy.stateSince, 70);
    assert.strictEqual(Memory.rooms.W1N1.economy.lastLiquidEnergy, 42000);
    assert.strictEqual(Memory.rooms.W1N1.economy.lastSampleTick, 99);
    assert.strictEqual(Memory.rooms.W1N1.economy.energyTrend, 4.2);
    assert.strictEqual(Memory.rooms.W1N1.economy.harvest, undefined, 'live snapshot remained persistent');
    assert.strictEqual(Memory.config.season11.mode, 'observe');
    assert.strictEqual(Memory.config.season11.startupReserve, 777);
    assert.strictEqual(Memory.hive.season.season11.rooms.W8N8.thorium, 12);
    assert.strictEqual(Memory.hive.season.season11.reactors.reactor1.roomName, 'W8N8');
    assert.strictEqual(Memory.hive.season.season11.stats.delivered, 4);
    assert.strictEqual(Memory.hive.operations.op1.type, 'DEFEND');
    assert.strictEqual(Memory.hive.squads.squad1.customSquadData, true);
    assert.strictEqual(Memory.hive.identity.username, 'SushiPlayer');
    assert.strictEqual(Memory.hive.identity.firstSpawnRoom, 'W1N1');
    assert.strictEqual(Memory.hive.expansion.targetRoom, 'W2N2');
    assert.strictEqual(Memory.hive.warRoom.activeRoom, 'W9N9');
    assert.deepStrictEqual(Memory.hive.telemetry.cpu, [{ tick: 90, used: 8 }]);
    assert.deepStrictEqual(Memory.customRoot, { owner: 'user', untouched: true });
    assert.deepStrictEqual(Memory.rooms.W1N1.customRoomData, { untouched: true });
    assert.deepStrictEqual(Memory.hive.customHiveState, { remains: true });

    for (const key of ['settings', 'cpuPolicy', 'cpuStatus', 'spawnPolicy', 'season11',
        'expansion', 'WarRoom', 'stats', 'username', 'firstSpawnRoom']) {
        assert.strictEqual(Memory[key], undefined, 'legacy root remains: ' + key);
    }
    assert.strictEqual(Memory.hive.settings, undefined);
    assert.strictEqual(Memory.hive.schemaVersion, undefined);
    assert.strictEqual(Memory.hive.economy.rooms, undefined);

    representativeAfter = JSON.stringify(Memory).length;
    assert.ok(representativeAfter < representativeBefore, 'representative Memory did not shrink');
    const once = JSON.stringify(Memory);
    HiveMemory.migrate();
    assert.strictEqual(JSON.stringify(Memory), once, 'second migration changed Memory');
});

test('legacy roots are retained when migration cannot complete', function() {
    Memory = oldMemoryFixture();
    const validConfig = Memory.config;
    Object.defineProperty(Memory.settings, 'brokenSetting', {
        enumerable: true,
        get() { throw new Error('malformed setting'); }
    });
    assert.throws(() => HiveMemory.migrate(), /malformed setting/);
    assert.ok(Memory.settings, 'legacy data was deleted after a failed migration');
    assert.strictEqual(Memory.config, validConfig, 'valid config was not restored after migration failure');
    assert.notStrictEqual(Memory.meta && Memory.meta.schemaVersion, 8, 'failed migration was marked complete');
});

test('14 empty Memory initializes cleanly', function() {
    Memory = { meta: {} };
    Game.time = 200;
    assert.doesNotThrow(() => HiveMemory.ensure());
    assert.strictEqual(Memory.meta.schemaVersion, 8);
    for (const key of ['config', 'hive', 'cpu', 'rooms', 'creeps']) assert.ok(Memory[key]);
    assert.ok(Array.isArray(Memory.hive.homeRooms.names));
});

test('Home registry and centralized room identities track current TickIndex truth', function() {
    Memory.rooms = {
        W1N1: { remotePlanner: { remotes: { W1N2: { status: 'active', sourceIds: ['remote1'] } } } },
        W1N2: {},
        W2N2: {},
        W9N9: {}
    };
    Memory.hive.expansion = { originRoom: 'W1N1' };
    const home = { name: 'W1N1', controller: { my: true }, find: () => [] };
    const bootstrap = { name: 'W2N2', controller: { my: true }, find: () => [] };
    Game.rooms = { W1N1: home, W2N2: bootstrap };
    Game.spawns = { Spawn1: { name: 'Spawn1', my: true, room: home, spawning: null } };
    const TickIndex = fresh('HiveMind.Index.js');
    TickIndex.resetForTests();
    HiveMemory.syncHomeRooms(TickIndex.build());
    assert.deepStrictEqual(Memory.hive.homeRooms.names, ['W1N1']);
    assert.deepStrictEqual(Memory.rooms.W1N1.identity, { type: 'HOME' });
    assert.deepStrictEqual(Memory.rooms.W1N2.identity, { type: 'REMOTE', parentHome: 'W1N1' });
    assert.deepStrictEqual(Memory.rooms.W2N2.identity, { type: 'OWNED_BOOTSTRAP', parentHome: 'W1N1' });
    assert.deepStrictEqual(Memory.rooms.W9N9.identity, { type: 'INTEL' });

    Game.time++;
    Game.spawns = {};
    TickIndex.resetForTests();
    HiveMemory.syncHomeRooms(TickIndex.build());
    assert.deepStrictEqual(Memory.hive.homeRooms.names, [], 'destroyed Spawn remained authoritative');
    assert.deepStrictEqual(Memory.rooms.W1N1.identity, { type: 'OWNED_BOOTSTRAP' });
});

test('read-only console map handles the canonical schema without writes', function() {
    const before = JSON.stringify(Memory);
    const output = HiveMemory.memoryMap();
    assert.strictEqual(JSON.stringify(Memory), before);
    assert.match(output, /SUSHI MEMORY — schema 8/);
    assert.match(output, /W1N1 \[OWNED_BOOTSTRAP\]/);
    assert.match(output, /Approx size:/);
});

test('15 global-reset economy rebuild restores history but keeps current detail in heap', function() {
    mocks.installGlobals();
    mocks.clearLocalModules();
    HiveMemory = fresh('HiveMind.Memory.js');
    HiveMemory.migrate();
    const source = {
        id: 'sourceA', energy: 3000, energyCapacity: 3000,
        pos: new RoomPosition(10, 10, 'W1N1')
    };
    const room = {
        name: 'W1N1', controller: { my: true },
        energyAvailable: 300, energyCapacityAvailable: 300,
        find(type) { return type === FIND_SOURCES ? [source] : []; },
        findPath() { return Array.from({ length: 10 }, () => ({})); }
    };
    const spawn = {
        id: 'spawn1', name: 'Spawn1', my: true, room,
        pos: new RoomPosition(25, 25, 'W1N1'), spawning: null
    };
    const miner = {
        name: 'Miner1', room, ticksToLive: 1000, spawning: false,
        pos: new RoomPosition(10, 11, 'W1N1'),
        body: [WORK, WORK, WORK, WORK, WORK, CARRY, MOVE],
        memory: { role: 'Extractor', homeRoom: 'W1N1', sourceRoom: 'W1N1', sourceId: 'sourceA' }
    };
    Game.rooms = { W1N1: room };
    Game.spawns = { Spawn1: spawn };
    Game.creeps = { Miner1: miner };

    let Economy = fresh('HiveMind.Economy.js');
    let TickIndex = fresh('HiveMind.Index.js');
    TickIndex.resetForTests();
    const first = Economy.updateRoom(room);
    assert.strictEqual(first.harvest.sources.length, 1);
    assert.ok(first.haul, 'current economy detail was not built');
    assert.strictEqual(Memory.rooms.W1N1.economy.harvest, undefined);
    assert.strictEqual(Memory.rooms.W1N1.economy.haul, undefined);
    assert.strictEqual(Memory.rooms.W1N1.economy.spawnPressure, undefined);
    const stateBeforeReset = first.state;

    delete global.__sushiEconomy;
    delete global.__sushiTickIndex;
    Game.time++;
    mocks.clearLocalModules();
    Economy = fresh('HiveMind.Economy.js');
    TickIndex = fresh('HiveMind.Index.js');
    TickIndex.resetForTests();
    const rebuilt = Economy.updateRoom(room);
    assert.strictEqual(rebuilt.harvest.sources.length, 1);
    assert.strictEqual(rebuilt.state, stateBeforeReset, 'persistent hysteresis was not recovered');
    assert.strictEqual(Memory.rooms.W1N1.economy.lastSampleTick, Game.time);
    assert.strictEqual(Economy.get('W1N1'), rebuilt, 'dashboard-facing getter did not use rebuilt heap detail');
});

test('obsolete Sushi root paths are confined to the migration layer', function() {
    const forbidden = [
        /Memory\.settings\b/, /Memory\.cpuPolicy\b/, /Memory\.spawnPolicy\b/,
        /Memory\.cpuStatus\b/, /Memory\.season11\b/, /Memory\.hive\.settings\b/,
        /Memory\.expansion\b/, /Memory\.WarRoom\b/, /Memory\.stats\b/,
        /Memory\.username\b/, /Memory\.firstSpawnRoom\b/
    ];
    const violations = [];
    for (const file of productionJavaScriptFiles(mocks.root)) {
        if (path.basename(file) === 'HiveMind.Memory.js') continue;
        const source = fs.readFileSync(file, 'utf8');
        for (const pattern of forbidden) {
            if (pattern.test(source)) violations.push(path.relative(mocks.root, file) + ': ' + pattern);
        }
    }
    assert.deepStrictEqual(violations, []);
});

console.log(`Memory schema representative size: before ${representativeBefore} bytes, ` +
    `after ${representativeAfter} bytes, saved ${representativeBefore - representativeAfter} bytes`);
console.log('Memory schema tests passed.');
