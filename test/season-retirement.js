const assert = require('assert');
const fs = require('fs');
const mocks = require('./mock-screeps');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function reset() { mocks.installGlobals(); mocks.clearLocalModules(); return require('../Season.Retirement'); }
test('only confirmed seasonal records are removed; ordinary resources and unknown fields survive', () => {
    const R = reset();
    Memory.hive = { operations: { season: { season11: true }, power: { type: 'RAID_POWER_BANK' }, normal: { type: 'DEFEND_REMOTE' } },
        demands: { mine: { operationId: 'season' }, standard: { role: 'ResourceCourier' } },
        squads: { escort: { operationId: 'season' }, normal: { operationId: 'normal' } },
        season: { season11: { thoriumReservations: { stores: {} } }, custom: 7, stats: { keep: true } },
        resources: { rooms: { W3S47: { inventory: { energy: 30000, power: 4000, U: 5000 } } } },
        power: { operations: { raid: { active: true } } } };
    Memory.config = { season11: { mode: 'active' }, power: { enabled: true } };
    Memory.rooms = { W3S47: { season11MiningColony: { active: true }, season11UserNote: 'keep',
        strategyObjectives: { SEASON11_THORIUM: {}, STANDARD: { active: true } }, economy: { state: 'RECOVERY' } } };
    R.run();
    assert.deepStrictEqual(Object.keys(Memory.hive.operations), ['power', 'normal']);
    assert.deepStrictEqual(Object.keys(Memory.hive.demands), ['standard']);
    assert.deepStrictEqual(Object.keys(Memory.hive.squads), ['normal']);
    assert.deepStrictEqual(Memory.hive.season, { custom: 7, stats: { keep: true } });
    assert.strictEqual(Memory.rooms.W3S47.season11UserNote, 'keep');
    assert.strictEqual(Memory.rooms.W3S47.strategyObjectives.SEASON11_THORIUM, undefined);
    assert.strictEqual(Memory.rooms.W3S47.strategyObjectives.STANDARD.active, true);
    assert.strictEqual(Memory.hive.resources.rooms.W3S47.inventory.power, 4000);
    assert.strictEqual(Memory.hive.power.operations.raid.active, true);
    assert.strictEqual(Memory.config.power.enabled, true);
});
test('queue cleanup preserves array identity and all standard requests', () => {
    const R = reset(); const queue = [{ role: 'ThoriumMiner' }, { role: 'Extractor', memory: { sourceId: 'energy' } },
        { role: 'Volley', memory: { season11ReactorGuard: 'reactor' } }];
    Memory.rooms = { W3S47: { spawn: { queue } } }; R.run();
    assert.strictEqual(Memory.rooms.W3S47.spawn.queue, queue); assert.strictEqual(queue.length, 1);
    assert.strictEqual(queue[0].role, 'Extractor');
});
test('living and spawning former seasonal actors gain standard roles and lose invalid claims', () => {
    const R = reset(); Memory.creeps = {
        miner: { role: 'ThoriumMiner', homeRoom: 'W3S47', season11MineralId: 'old', operationId: 'season11:mine' },
        hauler: { role: 'ThoriumHauler', homeRoom: 'W3S47', resourceDelivery: { targetId: 'reactor' } },
        claim: { role: 'ReactorClaimer', season11ReactorId: 'old' },
        worker: { role: 'Artificer', season11Maintenance: true, remoteWorkTargetId: 'old' },
        normal: { role: 'Freighter', pickupTargetId: 'energy', custom: true }
    }; R.run();
    assert.strictEqual(Memory.creeps.miner.role, 'ResourceCourier');
    assert.strictEqual(Memory.creeps.hauler.returnHomeAfterRetirement, true);
    assert.strictEqual(Memory.creeps.claim.role, 'Scout');
    assert.strictEqual(Memory.creeps.worker.remoteWorkTargetId, undefined);
    assert.strictEqual(Memory.creeps.miner.operationId, undefined);
    assert.strictEqual(Memory.creeps.hauler.resourceDelivery, undefined);
    assert.strictEqual(Memory.creeps.normal.pickupTargetId, 'energy');
});
test('retirement is idempotent across global resets and leaves standard expansion committed', () => {
    const R = reset(); Memory.hive = { expansion: { state: 'bootstrap', targetRoom: 'W4S47',
        strategyNomination: { provider: 'SEASON11' }, custom: true } };
    assert.strictEqual(R.run(), true); const before = JSON.stringify(Memory);
    Game.time++; assert.strictEqual(R.run(), false); assert.strictEqual(JSON.stringify(Memory), before);
    Memory = JSON.parse(before); delete require.cache[require.resolve('../Season.Retirement')];
    assert.strictEqual(require('../Season.Retirement').run(), false);
    assert.strictEqual(Memory.hive.expansion.targetRoom, 'W4S47');
});
test('old schema migration retires its season fields and preserves unrelated colony memory', () => {
    reset(); Memory.season11 = { reactors: { r: {} } }; Memory.hive = { schemaVersion: 7 };
    const M = require('../HiveMind.Memory'); M.migrate();
    assert.strictEqual(Memory.config.season11, undefined); assert.strictEqual(Memory.hive.season, undefined);
    assert.strictEqual(Memory.meta.season11Retired, 1); assert.doesNotThrow(() => M.migrate());
});
test('retired courier returns home through normal travel before selecting jobs', () => {
    reset(); const travel = require('../utility.Travel.Creep'); let destination;
    travel.moveToRoom = (creep, home) => { destination = home; return OK; };
    const creep = { room: { name: 'W4S47' }, memory: { role: 'ResourceCourier', homeRoom: 'W3S47', returnHomeAfterRetirement: true } };
    require('../role.ResourceCourier').run(creep); assert.strictEqual(destination, 'W3S47');
});
test('permanent code cannot import a deleted season module even when seasonal APIs exist', () => {
    reset(); global.RESOURCE_THORIUM = 'T'; global.FIND_REACTORS = 'reactors';
    assert.deepStrictEqual(require('../Strategy.Provider').active(), []);
    const files = fs.readdirSync(mocks.root).filter(f => f.endsWith('.js'));
    for (const file of files) assert.doesNotMatch(fs.readFileSync(mocks.root + '/' + file, 'utf8'), /require\(['"](?:Logic\.Season11|Season11\.|role\.(?:Thorium|Reactor))/);
    assert.ok(require('../Tick.Creeps').roles.ResourceCourier);
    assert.ok(require('../Power.Manager').processRoom);
});
console.log('Retirement cases passed: ' + passed);
