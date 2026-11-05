const assert = require('assert');
const mocks = require('./mock-screeps');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function setup(options = {}) {
    mocks.installGlobals(); mocks.clearLocalModules(); delete global.Sushi;
    Memory.config = { diagnostics: { ...options } };
    const D = require('../Diagnostics'); return D;
}
function event(D, name = 'TEST_EVENT', data = {}) { return D.record('ECONOMY', 'WARN', name, 'W3S47', data); }
function reload() { delete require.cache[require.resolve('../Diagnostics')]; return require('../Diagnostics'); }
test('structured events retain only bounded primitives and never serialize game objects', () => {
    const D = setup(); let touched = 0;
    const gameObject = { toJSON() { touched++; throw Error('must never serialize'); } };
    const data = { value: 10, object: gameObject, huge: 'x'.repeat(5000) };
    Object.defineProperty(data, 'getter', { enumerable: true, get() { throw Error('getter'); } });
    assert.strictEqual(event(D, 'TEST_EVENT', data), true);
    const e = D.events(1)[0]; assert.strictEqual(e.tick, Game.time); assert.strictEqual(e.room, 'W3S47');
    assert.strictEqual(e.category, 'ECONOMY'); assert.strictEqual(e.severity, 'WARN');
    assert.deepStrictEqual(e.data, { value: 10, huge: 'x'.repeat(110) }); assert.strictEqual(touched, 0);
});
test('duplicates aggregate with last tick and count instead of growing the ring', () => {
    const D = setup(); event(D); Game.time++; assert.strictEqual(event(D), false);
    assert.strictEqual(D.events(100).length, 1); assert.strictEqual(D.events(1)[0].count, 2);
    assert.strictEqual(D.events(1)[0].lastTick, Game.time);
    Game.time += 51; event(D); assert.strictEqual(D.events(100).length, 2);
});
test('event count and strict serialized size evict oldest history', () => {
    const D = setup({ maxEvents: 10, maxChars: 2048 });
    for (let i = 0; i < 80; i++) { Game.time++; event(D, 'EVENT_' + i, { detail: 'x'.repeat(110) }); }
    assert.ok(D.events(1000).length <= 10); assert.ok(D.status().chars + 256 <= 2048);
    assert.strictEqual(D.events(1)[0].event, 'EVENT_79');
    assert.ok(JSON.stringify(Memory.hive.telemetry.blackbox).length <= 16000);
});
test('fallback remains bounded and survives a global reset', () => {
    let D = setup({ useSegments: false });
    for (let i = 0; i < 200; i++) { Game.time++; event(D, 'EVENT_' + i); }
    assert.ok(Memory.hive.telemetry.blackbox.recent.length <= 64);
    assert.ok(JSON.stringify(Memory.hive.telemetry.blackbox).length <= 16000);
    Memory = JSON.parse(JSON.stringify(Memory)); D = reload();
    assert.strictEqual(D.events(1)[0].event, 'EVENT_199');
    D.begin(); assert.strictEqual(typeof Sushi.debug.errors, 'function');
});
test('retention ages history out and cleans persisted fallback', () => {
    const D = setup({ retentionTicks: 10, useSegments: false }); event(D);
    Game.time += 11; D.begin(); assert.deepStrictEqual(D.events(), []);
    assert.deepStrictEqual(Memory.hive.telemetry.blackbox.recent, []);
});
test('segment activation is asynchronous and preserves currently active segment ids', () => {
    const D = setup(); let active;
    RawMemory.segments = { 4: 'foreign' }; RawMemory.setActiveSegments = ids => { active = ids; };
    event(D); D.begin(); assert.deepStrictEqual(active, [4, 98]);
    assert.strictEqual(RawMemory.segments[98], undefined); assert.strictEqual(D.status().storage, 'MEMORY');
    Game.time++; RawMemory.segments[98] = ''; D.begin(); D.finish({ total: 3 });
    const saved = JSON.parse(RawMemory.segments[98]); assert.strictEqual(saved.owner, 'sushi.blackbox.v1');
    assert.ok(saved.events.some(e => e.event === 'TEST_EVENT')); assert.strictEqual(RawMemory.segments[4], 'foreign');
});
test('registered segment ownership conflicts cause a safe bounded fallback', () => {
    const D = setup(); Memory.hive = { segmentOwners: { 98: 'other-system' } };
    RawMemory.segments[98] = 'keep'; event(D); D.begin(); D.finish();
    assert.strictEqual(RawMemory.segments[98], 'keep'); assert.strictEqual(D.status().storage, 'MEMORY');
    assert.match(D.status().storageReason, /ownership conflict/);
});
test('nonempty foreign, malformed, and oversize segments are never overwritten', () => {
    for (const raw of ['foreign', '{"owner":"other"}', 'x'.repeat(100001)]) {
        const D = setup(); RawMemory.segments[98] = raw; D.begin(); event(D); D.finish();
        assert.strictEqual(RawMemory.segments[98], raw); assert.strictEqual(D.status().storage, 'MEMORY');
    }
});
test('ten occupied activation slots are preserved without claiming a segment', () => {
    const D = setup(); RawMemory.segments = Object.fromEntries(Array.from({ length: 10 }, (_,i) => [i, 'other']));
    RawMemory.setActiveSegments = () => { throw Error('must not activate'); }; D.begin();
    assert.strictEqual(Memory.hive.segmentOwners[98], undefined); assert.match(D.status().storageReason, /slots occupied/);
});
test('segment API failures cannot interrupt recorder calls', () => {
    const D = setup(); RawMemory.setActiveSegments = () => { throw Error('offline'); };
    assert.doesNotThrow(() => D.begin()); assert.doesNotThrow(() => event(D)); assert.doesNotThrow(() => D.finish());
    assert.ok(D.events(100).some(e => e.event === 'TEST_EVENT'));
});
test('segment writes are periodic and include only bounded serialized history', () => {
    const D = setup({ flushInterval: 25, maxChars: 2048 }); let writes = 0, raw = '';
    Object.defineProperty(RawMemory.segments, '98', { enumerable: true, get: () => raw, set: v => { writes++; raw = v; } });
    D.begin(); event(D); D.finish(); assert.strictEqual(writes, 1);
    Game.time++; D.begin(); event(D, 'SECOND'); D.finish(); assert.strictEqual(writes, 1);
    Game.time += 25; D.begin(); D.finish(); assert.strictEqual(writes, 2); assert.ok(raw.length <= 2048);
});
test('write failures and last-moment foreign writes preserve the colony and foreign data', () => {
    const D = setup(); let raw = '';
    Object.defineProperty(RawMemory.segments, '98', { enumerable: true, get: () => raw, set() { throw Error('read only'); } });
    D.begin(); event(D); assert.doesNotThrow(() => D.finish()); assert.strictEqual(D.status().storage, 'MEMORY');
    raw = '{"owner":"foreign"}'; D.begin(); D.finish(); assert.strictEqual(raw, '{"owner":"foreign"}');
});
test('segment and fallback merge after reset without duplicate ids or lost recent events', () => {
    let D = setup(); RawMemory.segments[98] = ''; D.begin(); event(D, 'FIRST'); D.finish();
    Game.time++; event(D, 'UNFLUSHED'); const raw = RawMemory.segments[98];
    Memory = JSON.parse(JSON.stringify(Memory)); D = reload(); D.begin();
    assert.deepStrictEqual(D.events(100).map(e => e.event).filter(n => n !== 'HEALTH_SNAPSHOT'), ['FIRST', 'UNFLUSHED']);
    const ids = D.events(100).map(e => e.id); assert.strictEqual(new Set(ids).size, ids.length);
    assert.strictEqual(RawMemory.segments[98], raw);
});
test('clear survives reset before the asynchronous segment can be overwritten', () => {
    let D = setup(); RawMemory.segments[98] = ''; D.begin(); event(D, 'OLD'); D.finish();
    Game.time++; D.clear(); Memory = JSON.parse(JSON.stringify(Memory)); D = reload(); D.begin();
    assert.strictEqual(D.events(100).some(e => e.event === 'OLD'), false);
    event(D, 'NEW'); D.finish(); assert.strictEqual(JSON.parse(RawMemory.segments[98]).events.some(e => e.event === 'OLD'), false);
});
test('OFF does not initialize storage, serialize data, record, or sample CPU', () => {
    const D = setup({ mode: 'OFF' }); let reads = 0;
    Game.cpu.getUsed = () => { reads++; return 0; }; RawMemory.setActiveSegments = () => { throw Error('OFF storage'); };
    const data = { toJSON() { throw Error('OFF serialization'); } };
    D.begin(); assert.strictEqual(event(D, 'OFF', data), false); D.finish();
    assert.strictEqual(Memory.hive, undefined); assert.strictEqual(reads, 0);
});
test('severity and DEBUG controls retain important events only in NORMAL', () => {
    const D = setup({ level: 'WARN' }); D.record('JOBS', 'DEBUG', 'DETAIL', null);
    D.record('JOBS', 'INFO', 'ORDINARY', null); event(D); assert.strictEqual(D.events(100).length, 1);
    Memory.config.diagnostics.mode = 'DEBUG'; Memory.config.diagnostics.level = 'DEBUG';
    D.record('JOBS', 'DEBUG', 'DETAIL', null); assert.strictEqual(D.events(1)[0].event, 'DETAIL');
});
test('PROFILE automatically expires, is duration bounded, and accepts console controls', () => {
    const D = setup(); D.begin(); Sushi.debug.mode('PROFILE', 2); assert.strictEqual(D.config().mode, 'PROFILE');
    Game.time += 3; assert.strictEqual(D.config().mode, 'NORMAL');
    Sushi.debug.mode('OFF'); assert.strictEqual(D.config().mode, 'OFF');
    assert.match(Sushi.debug.mode('bad'), /Use OFF/);
});
test('zero-count retrieval is empty and export chunks reassemble exact compact JSON', () => {
    const D = setup(); event(D, 'UNICODE', { message: 'colony \u{1f680}' }); D.begin();
    assert.deepStrictEqual(Sushi.debug.events(0), []);
    const chunks = Sushi.debug.export(256); assert.ok(chunks.every(c => c.length <= 256));
    assert.strictEqual(JSON.parse(chunks.join('')).events[0].data.message, 'colony \u{1f680}');
    assert.strictEqual(Sushi.debug.exportChunk(0, 256), chunks[0]);
});
test('event bursts are bounded per tick and leave capacity for errors', () => {
    const D = setup(); for (let i = 0; i < 100; i++) event(D, 'BURST_' + i);
    assert.strictEqual(D.events(1000).length, 20);
    D.exception('SUBSYSTEM_EXCEPTION', null, Error('failed'), 'test');
    assert.strictEqual(D.events(1)[0].severity, 'ERROR');
});
test('a failed main phase still reaches traffic, diagnostics, and telemetry', () => {
    setup(); const Planning = require('../Tick.Planning'), Final = require('../Tick.Finalize');
    let traffic = false; Planning.runStrategy = () => { throw Error('planner'); };
    Final.resolveTraffic = () => { traffic = true; };
    assert.doesNotThrow(() => require('../main').loop()); assert.strictEqual(traffic, true);
    assert.strictEqual(Sushi.debug.errors(10)[0].data.subsystem, 'planning');
    assert.ok(Object.prototype.hasOwnProperty.call(Sushi.debug.cpu().phases, 'planning'));
    assert.ok(Object.prototype.hasOwnProperty.call(Sushi.debug.cpu().phases, 'diagnostics'));
});
test('bootstrap exception skips dependent work and still records the failure', () => {
    setup(); let ran = false;
    require('../Tick.Bootstrap').run = () => { throw Error('bootstrap'); };
    require('../Tick.Planning').runStrategy = () => { ran = true; };
    assert.doesNotThrow(() => require('../main').loop()); assert.strictEqual(ran, false);
    assert.strictEqual(Sushi.debug.errors(1)[0].data.subsystem, 'bootstrapIndex');
});
test('throwing console logger does not break role isolation', () => {
    setup(); const index = require('../HiveMind.Index').get(), C = require('../Tick.Creeps');
    let next = false; index.allCreeps = [
        { name: 'bad', room: { name: 'W3S47' }, memory: { role: 'Foreman' } },
        { name: 'good', room: { name: 'W3S47' }, memory: { role: 'Tech' } }
    ];
    C.roles.Foreman.run = () => { throw Error('bad role'); }; C.roles.Tech.run = () => { next = true; };
    const log = console.log; console.log = () => { throw Error('logger offline'); };
    try { assert.doesNotThrow(() => C.run()); } finally { console.log = log; }
    assert.strictEqual(next, true); assert.strictEqual(require('../Diagnostics').events(1)[0].event, 'ROLE_EXCEPTION');
});

test('movement emits only persistent failure, blockage, invalid destination and oscillation evidence', () => {
    const D = setup(); const creep = { name: 'mover', pos: { x: 1, y: 20, roomName: 'W3S47' }, memory: { role: 'Tech' }, fatigue: 0 };
    D.movement(creep, 0); assert.deepStrictEqual(D.events(100), []);
    for (let i = 0; i < 5; i++) { Game.time++; D.movement(creep, 0); }
    assert.ok(D.events(100).some(e => e.event === 'MOVEMENT_PERSISTENT_BLOCK'));
    for (let i = 0; i < 3; i++) { Game.time++; creep.pos.x++; D.movement(creep, -2); }
    assert.ok(D.events(100).some(e => e.event === 'MOVEMENT_REPEATED_FAILURE'));
    Game.time++; D.movement(creep, -7); assert.strictEqual(D.events(1)[0].event, 'MOVEMENT_INVALID_DESTINATION');
    const O = setup();
    for (const name of ['W3S47', 'W4S47', 'W3S47', 'W4S47']) { Game.time++; creep.pos.roomName = name; O.movement(creep, 0); }
    assert.ok(O.events(100).some(e => e.event === 'ROOM_EXIT_OSCILLATION'));
});
test('job warnings require sustained eligible idleness and distinguish death from repeated abandonment', () => {
    const D = setup(); const row = { id: 'haul', room: 'W3S47', idle: 1 };
    D.observeJobs([row]); Game.time += 25; D.observeJobs([row]); assert.deepStrictEqual(D.events(), []);
    Game.time += 25; D.observeJobs([row]); assert.strictEqual(D.events(1)[0].event, 'WORKER_IDLE_WITH_ELIGIBLE_JOB');
    Game.creeps.worker = {}; D.observeJobs([{ ...row, assigned: 'worker' }]);
    Game.time += 25; delete Game.creeps.worker; D.observeJobs([row]); Game.time += 50; D.observeJobs([row]);
    assert.ok(D.events(100).some(e => e.event === 'JOB_DEATH_REASSIGNMENT_FAILED'));
    const A = setup(); Game.creeps.worker = {};
    for (let i = 0; i < 3; i++) { Game.time++; A.observeJobs([{ ...row, assigned: 'worker' }]); Game.time++; A.observeJobs([row]); }
    assert.ok(A.events(100).some(e => e.event === 'JOB_REPEATEDLY_ABANDONED'));
});
test('economy transitions report recovery growth reserve and critical harvesting constraints', () => {
    const D = setup(); const s = { state: 'RECOVERY', energyAvailable: 100, storageEnergy: 0, terminalEnergy: 0,
        recoveryReason: 'LOCAL_HARVEST_SHORTAGE', growth: { mode: 'RECOVERY', energyAboveReserve: -100, blockedReason: 'LOCAL_HARVEST_SHORTAGE' },
        harvest: { workActive: 2, workRequired: 10, workSpawning: 3, workQueued: 5 } };
    D.observeEconomy('W3S47', s); D.observeEconomy('W3S47', s);
    assert.strictEqual(D.events(100).filter(e => e.event === 'CRITICAL_HARVEST_CAPACITY_MISSING').length, 1);
    Game.time++; s.state = 'STABLE'; s.energyAvailable = 550; s.harvest.workActive = 10;
    s.growth = { mode: 'GROWTH_NORMAL', energyAboveReserve: 100 }; D.observeEconomy('W3S47', s);
    for (const event of ['RECOVERY_COMPLETED', 'GROWTH_RESUMED', 'RESERVE_RESTORED', 'SPAWN_ENERGY_RESTORED']) {
        assert.ok(D.events(100).some(e => e.event === event), event);
    }
});
test('health snapshots honor the configured cadence and reuse registered room evidence', () => {
    const D = setup({ useSegments: false });
    D.install(() => ({ state: 'RECOVERY', activeWork: 2, requiredWork: 10, economyTick: Game.time }));
    D.observeEconomy('W3S47', { state: 'RECOVERY', growth: {}, harvest: {} });
    D.finish({ total: 3 }); assert.strictEqual(D.events(100).filter(e => e.event === 'ROOM_HEALTH_SNAPSHOT').length, 1);
    Game.time += 99; D.finish(); assert.strictEqual(D.events(100).filter(e => e.event === 'ROOM_HEALTH_SNAPSHOT').length, 1);
    Game.time++; D.finish(); assert.strictEqual(D.events(100).filter(e => e.event === 'ROOM_HEALTH_SNAPSHOT').length, 2);
});

test('ordinary per-tick Memory deserialization preserves heap history and flush cadence', () => {
    const D = setup({ flushInterval: 25 }); let writes = 0, raw = '';
    Object.defineProperty(RawMemory.segments, '98', { enumerable: true, get: () => raw, set: v => { writes++; raw = v; } });
    D.begin(); event(D, 'FIRST'); D.finish();
    for (let i = 0; i < 30; i++) {
        Game.time++; Memory = JSON.parse(JSON.stringify(Memory)); D.begin(); event(D, 'NEXT_' + i); D.finish();
    }
    assert.strictEqual(writes, 2, 'deserialization must not restart flush scheduling');
    assert.ok(D.events(100).some(e => e.event === 'FIRST'));
});
test('console export chunks remain a frozen snapshot while new ticks add events', () => {
    const D = setup(); event(D); D.begin(); const chunks = Sushi.debug.export(256);
    Game.time++; event(D, 'LATER');
    assert.strictEqual(Sushi.debug.exportChunk(1, 256), chunks[1]);
    const decoded = JSON.parse(chunks.map((_,i) => Sushi.debug.exportChunk(i)).join(''));
    assert.strictEqual(decoded.events.some(e => e.event === 'LATER'), false);
});
test('a frozen console namespace and hostile error object cannot break diagnostics', () => {
    const D = setup(); global.Sushi = Object.freeze({});
    assert.doesNotThrow(() => D.install()); assert.doesNotThrow(() => D.begin());
    assert.doesNotThrow(() => D.exception('ROLE_EXCEPTION', null, { get message() { throw Error('getter'); } }, 'test'));
});
test('dashboard summaries include global failures and exclude other rooms and old entries', () => {
    const D = setup(); event(D); D.exception('GLOBAL_FAILURE', null, Error('planner'), 'planning');
    D.record('ERRORS', 'ERROR', 'OTHER_ROOM_FAILURE', 'W9N9');
    const s = D.summary('W3S47'); assert.strictEqual(s.errors, 1); assert.strictEqual(s.warnings, 1);
    assert.strictEqual(s.last.event, 'GLOBAL_FAILURE');
    Game.time += 1001; assert.strictEqual(D.summary('W3S47').errors, 0);
});
console.log('Diagnostic cases passed: ' + passed);

