const assert = require('assert');
const { fixture } = require('./extractor-station');
const { world } = require('./freighter-renewal');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function setup() {
    const f = fixture(); f.c.room.energyAvailable = f.c.room.energyCapacityAvailable = 800;
    Memory.rooms.W39S47.economy = { growth: { energyAboveReserve: 4000 } };
    f.c.body = [WORK, WORK, WORK, MOVE, MOVE, CARRY].map(type => ({ type, hits: 100 }));
    f.incumbent.body = [WORK, WORK, MOVE, CARRY].map(type => ({ type, hits: 100 }));
    f.incumbent.ticksToLive = 90; f.c.ticksToLive = 450;
    return { ...f, H: require('Harvest.Planning'), assigned: [f.c, f.incumbent] };
}
test('a funded aging two-WORK miner plus a three-WORK peer proposes one full-source successor', () => {
    const f = setup(); const p = f.H.describe(f.c.room, f.source, f.assigned, [], 10);
    assert.strictEqual(p.action.work, 5); assert.strictEqual(p.action.minWork, 5);
    assert.strictEqual(p.action.replacementFor, f.incumbent.name); assert.strictEqual(p.action.consolidation, true);
    assert.strictEqual(f.c.ticksToLive, 450, 'the younger miner is not retired by forecasting');
});
test('a staggered young supplemental miner does not trap the source in small replacement bodies', () => {
    const f = setup();
    f.c.ticksToLive = 90; f.incumbent.ticksToLive = 1132;
    const p = f.H.describe(f.c.room, f.source, f.assigned, [], 10);
    assert.strictEqual(p.action.work, 5);
    assert.strictEqual(p.action.replacementFor, f.c.name);
    assert.strictEqual(p.action.consolidation, true);
    assert.strictEqual(f.incumbent.ticksToLive, 1132);
});
test('young cohorts, negligible useful savings, insufficient funding and imminent deadlines preserve ordinary planning', () => {
    for (const change of [f => f.incumbent.ticksToLive = 900, f => f.c.ticksToLive = 1450,
        f => f.c.room.energyAvailable = 300, f => Memory.rooms.W39S47.economy.growth.energyAboveReserve = 300,
        f => f.incumbent.ticksToLive = 20]) {
        const f = setup(); change(f); assert.strictEqual(f.H.agingConsolidation(f.c.room, f.source, f.assigned, 10), null);
    }
});
test('a peer already covering the whole source or a different source cannot justify consolidation', () => {
    let f = setup(); f.c.getActiveBodyparts = type => type === WORK ? 5 : 1;
    assert.strictEqual(f.H.agingConsolidation(f.c.room, f.source, f.assigned, 10), null);
    f = setup(); f.c.memory.sourceId = 'different';
    assert.strictEqual(f.H.agingConsolidation(f.c.room, f.source, f.assigned, 10), null);
});
function pipeline() {
    const f = world(6, 800, 34); const originalFind = f.room.find;
    const source = { id: 'source', pos: new RoomPosition(32, 24, f.room.name), energyCapacity: 3000 };
    f.room.find = type => type === FIND_SOURCES ? [source] : originalFind.call(f.room, type);
    const oldGet = Game.getObjectById; Game.getObjectById = id => id === source.id ? source : oldGet(id) || Game.creeps[id];
    delete Game.creeps.miner; delete Memory.creeps.miner;
    function miner(name, work, ttl, x) {
        const c = f.unit(name, 1, ttl); c.id = name;
        c.memory = { role: 'Extractor', homeRoom: f.room.name, sourceRoom: f.room.name, targetRoom: f.room.name, sourceId: source.id };
        c.pos = new RoomPosition(x, 24, f.room.name);
        c.body = require('BodyProfiles').build('Extractor', { energyCapacity: 800, desiredWork: work }).body.map(type => ({ type, hits: 100 }));
        Memory.creeps[name] = c.memory; return c;
    }
    miner('old', 2, 90, 31); miner('peer', 3, 450, 33);
    Memory.rooms[f.room.name].sources = { source: { id: source.id, pos: source.pos,
        seats: [new RoomPosition(31, 24, f.room.name), new RoomPosition(33, 24, f.room.name)], seatVersion: 1, seatCount: 2 } };
    f.snapshot.harvest = { actualOrEstimatedIncome: 10, workActive: 5, workRequired: 5,
        sources: [{ id: 'source', workRequired: 5, healthyWork: 3, workActive: 5, seatCount: 2, distance: 10 }] };
    f.refresh();
    const result = f.manager.requestDynamicExtractorsForRoom(f.room, 116,
        { desiredWork: 5, livingWork: 5, queuedWork: 0 }, { localOnly: true });
    assert.strictEqual(result.requested, 1, result.reason);
    assert.ok(f.queue[0].minerConsolidation); return f;
}
test('consolidation retains a five-WORK guarantee through real admission and spawn execution', () => {
    const f = pipeline(); assert.strictEqual(require('spawn.manager').runRoom(f.room.name).result, OK);
    assert.strictEqual(f.calls[0].body.filter(p => p === WORK).length, 5);
});
test('lost funding switches the queued consolidation to affordable source recovery', () => {
    const f = pipeline(); f.room.energyAvailable = 300;
    assert.strictEqual(require('spawn.manager').runRoom(f.room.name).result, OK);
    assert.ok(f.calls[0].body.filter(p => p === WORK).length <= 2);
    assert.strictEqual(f.queue.length, 0);
});
console.log('Extractor consolidation scenarios passed: ' + passed);
