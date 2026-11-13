const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const mocks = require('./mock-screeps');
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log('PASS ' + name); } catch (e) { process.exitCode = 1; console.error('FAIL ' + name, e.stack); } }
function fixture() {
    mocks.installGlobals(); mocks.clearLocalModules();
    const structures = [], sites = [], sources = [];
    const pos = (x, y) => new RoomPosition(x, y, 'W1N1');
    RoomPosition.prototype.findInRange = function(type, range, options) {
        return room.find(type).filter(x => this.getRangeTo(x) <= range && (!options?.filter || options.filter(x)));
    };
    const room = { name: 'W1N1', controller: { my: true, level: 4, pos: pos(30, 30) },
        find(type) { return type === FIND_STRUCTURES ? structures : type === FIND_CONSTRUCTION_SITES ? sites : type === FIND_SOURCES ? sources : []; },
        lookForAt(type, x, y) { return (type === LOOK_STRUCTURES ? structures : type === LOOK_CONSTRUCTION_SITES ? sites : []).filter(s => s.pos.x === x && s.pos.y === y); },
        getTerrain: () => ({ get: () => 0 }) };
    Game.rooms[room.name] = room; Memory.rooms[room.name] = { sources: {}, controller: {} };
    const source = { id: 'source', pos: pos(10, 10) }; sources.push(source);
    const container = (x, y, site = false) => {
        const item = { id: 'c' + x + ':' + y, pos: pos(x, y), my: true, structureType: STRUCTURE_CONTAINER };
        (site ? sites : structures).push(item); return item;
    };
    const file = path.join(mocks.root, 'Planner.Brain.js');
    const mod = new Module(file, module); mod.filename = file; mod.paths = module.paths;
    mod._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports.inspect = { findBestSourceSeat, findBestControllerPosition, canCreateSite, planSourceContainers, makeEmptyPlan };', file);
    return { room, source, pos, container, structures, sites, brain: mod.exports.inspect };
}
test('source replanning reuses an unfinished container instead of choosing another tile', () => {
    const f = fixture(), c = f.container(9, 10, true);
    assert.ok(f.brain.findBestSourceSeat(f.room, f.source, f.pos(25, 25), {}).isEqualTo(c.pos));
});
test('controller replanning reuses an unfinished container', () => {
    const f = fixture(), c = f.container(28, 30, true);
    assert.ok(f.brain.findBestControllerPosition(f.room, f.pos(25, 25), {}).isEqualTo(c.pos));
});
test('a stale source plan cannot build a second container after utility placed one', () => {
    const f = fixture(); f.container(9, 10);
    assert.strictEqual(f.brain.canCreateSite(f.room, f.pos(11, 10), STRUCTURE_CONTAINER, {}), false);
});
test('a stale controller plan cannot build a second container or site', () => {
    for (const site of [false, true]) {
        const f = fixture(); f.container(28, 30, site);
        assert.strictEqual(f.brain.canCreateSite(f.room, f.pos(29, 30), STRUCTURE_CONTAINER, {}), false);
    }
});
test('duplicate built containers remain untouched and selection keeps the saved station', () => {
    const f = fixture(), c = f.container(9, 10); f.container(11, 10);
    Memory.rooms[f.room.name].sources.source = { containerPlannedPos: c.pos };
    assert.ok(f.brain.findBestSourceSeat(f.room, f.source, f.pos(25, 25), {}).isEqualTo(c.pos));
    assert.strictEqual(f.structures.length, 2);
});
test('missing infrastructure can still be replaced and an unrelated container does not block it', () => {
    const f = fixture(); f.container(20, 20);
    assert.strictEqual(f.brain.canCreateSite(f.room, f.pos(11, 10), STRUCTURE_CONTAINER, {}), true);
});
test('source planning records the existing site as the canonical station', () => {
    const f = fixture(), c = f.container(9, 10, true), plan = f.brain.makeEmptyPlan();
    f.brain.planSourceContainers(f.room, plan, {}, f.pos(25, 25));
    assert.deepStrictEqual(plan.containers.sources.source, { x: c.pos.x, y: c.pos.y, roomName: f.room.name });
});
console.log('Container policy scenarios passed: ' + passed);
