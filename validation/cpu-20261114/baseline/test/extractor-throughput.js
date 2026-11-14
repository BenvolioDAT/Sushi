const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const mocks = require('./mock-screeps');
const { fixture } = require('./extractor-station');
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log('PASS ' + name); } catch (e) { process.exitCode = 1; console.error('FAIL ' + name, e.stack); } }
function simulate(remote, oldPolicy, blocked = false) {
    const f = fixture(); f.c.pos = f.containers[1].pos; f.c.store.energy = 0;
    f.C.getAssignedMiningSeat = () => f.c.pos;
    const work = remote ? 3 : 5, power = work * 2;
    f.c.getActiveBodyparts = type => type === WORK ? work : 1;
    let harvestIntent = 0, transferIntent = 0, dropIntent = 0, total = 0, transfers = 0;
    f.c.harvest = () => { harvestIntent = Math.min(power, f.c.store.getFreeCapacity(RESOURCE_ENERGY)); return harvestIntent ? OK : ERR_FULL; };
    f.c.transfer = target => {
        if (blocked || target.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) return ERR_FULL;
        transferIntent = f.c.store.energy; return OK;
    };
    f.c.drop = () => { dropIntent = f.c.store.energy; return OK; };
    if (blocked) for (const c of f.containers) c.store.getFreeCapacity = () => 0;
    const filename = path.join(mocks.root, 'role.Extractor.js'), mod = new Module(filename, module);
    mod.filename = filename; mod.paths = module.paths;
    mod._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.remoteStation = runRemoteStation;', filename);
    for (let i = 0; i < 300; i++) {
        harvestIntent = transferIntent = dropIntent = 0;
        if (oldPolicy) {
            if (f.c.store.getFreeCapacity(RESOURCE_ENERGY) > 0) f.c.harvest();
            else f.c.transfer(f.containers[1]);
        } else if (remote) mod.exports.remoteStation(f.c, f.source, f.c.pos);
        else f.run();
        // Engine-style intents use start-of-tick cargo/capacity; API calls do
        // not mutate the store inline. Assume a continually available sink.
        total += harvestIntent; if (transferIntent) transfers++;
        f.c.store.energy += harvestIntent - transferIntent - dropIntent;
        assert.ok(f.c.store.energy >= 0 && f.c.store.energy <= 50);
        Game.time++;
    }
    return { total, transfers, moves: f.moves.length };
}
test('five-WORK local miner avoids periodic full-store harvest gaps', () => {
    const before = simulate(false, true), after = simulate(false, false);
    assert.strictEqual(before.total, 2500); assert.strictEqual(after.total, 3000);
    assert.strictEqual(after.moves, 0);
    console.log('MEASURE 300 idealized local ticks: ' + before.total + ' -> ' + after.total + ' harvested');
});
test('remote station combines transfer and harvest using existing cargo', () => {
    const before = simulate(true, true), after = simulate(true, false);
    assert.ok(after.total > before.total); assert.strictEqual(after.total, 1800); assert.strictEqual(after.moves, 0);
    console.log('MEASURE 300 idealized remote ticks: ' + before.total + ' -> ' + after.total + ' harvested');
});
test('a full sink preserves the existing drop fallback and stationary movement contract', () => {
    for (const remote of [false, true]) {
        const after = simulate(remote, false, true);
        assert.strictEqual(after.moves, 0); assert.ok(after.total > 0); assert.strictEqual(after.transfers, 0);
    }
});
console.log('Extractor throughput scenarios passed: ' + passed);
