const assert = require('assert');
const mocks = require('./mock-screeps');
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log('PASS ' + name); } catch (e) { process.exitCode = 1; console.error('FAIL ' + name, e.message); } }
function fixture(incomplete = false) {
    mocks.installGlobals(); mocks.clearLocalModules();
    Object.assign(global, { CREEP_LIFE_TIME: 1500, SOURCE_ENERGY_CAPACITY: 3000, ENERGY_REGEN_TIME: 300,
        CARRY_CAPACITY: 50, HARVEST_POWER: 2, BODYPART_COST: { work: 100, carry: 50, move: 50, claim: 600 } });
    const home = { name: 'W39S47', energyAvailable: 800, energyCapacityAvailable: 800,
        controller: { my: true, owner: { username: 'me' }, level: 3, pos: new RoomPosition(49, 25, 'W39S47') }, find: () => [], getTerrain: () => ({ get: () => 0 }) };
    const source = { id: 'source', pos: new RoomPosition(2, 25, 'W38S47') };
    const remote = { name: 'W38S47', controller: { id: 'controller', level: 0, pos: new RoomPosition(20, 20, 'W38S47') },
        find: type => type === FIND_SOURCES ? [source] : [], getTerrain: () => ({ get: () => 0 }) };
    Game.rooms = { [home.name]: home, [remote.name]: remote };
    Game.spawns.Spawn1 = { name: 'Spawn1', my: true, room: home, pos: new RoomPosition(49, 25, home.name) };
    Game.map.describeExits = name => name === home.name ? { 3: remote.name } : { 7: home.name };
    Memory.rooms[home.name] = {};
    Memory.rooms[remote.name] = { sources: { source: { id: 'source', pos: source.pos,
        seats: [{ x: 1, y: 25, roomName: remote.name }], seatCount: 1 } } };
    require('HiveMind.Economy').checkSpend = () => ({ allowed: false, reason: 'test optional spending deferred' });
    let searches = 0;
    PathFinder.search = () => { searches++; return { incomplete, path: incomplete ? [] :
        [new RoomPosition(0, 25, remote.name), new RoomPosition(1, 25, remote.name)], ops: 2 }; };
    const planner = require('Planner.Remote');
    return { home, remote, planner, searches: () => searches, plan: () => planner.scanVisibleRoom(home.name, remote) };
}
test('100 Scout observations reuse route planning instead of searching every tick', () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) { f.plan(); Game.time++; }
    console.log('MEASURE 100 observations: ' + f.searches() + ' remote route searches');
    assert.ok(f.searches() <= 2, 'expected at most two route searches, got ' + f.searches());
    assert.strictEqual(Memory.rooms[f.remote.name].controller.lastObservedAt, Game.time - 1);
});
test('incomplete routes back off while live controller intel remains current', () => {
    const f = fixture(true);
    for (let i = 0; i < 50; i++) { f.plan(); Game.time++; }
    assert.strictEqual(f.searches(), 1);
    assert.strictEqual(Memory.rooms[f.remote.name].controller.lastObservedAt, Game.time - 1);
});
test('CPU pressure defers heavy planning without hiding new enemy ownership', () => {
    const f = fixture(); global.__sushiCpuRolling = { total: 21 };
    f.plan(); assert.strictEqual(f.searches(), 0);
    f.remote.controller.owner = { username: 'enemy' }; Game.time++; f.plan();
    assert.strictEqual(Memory.rooms[f.remote.name].controller.owner, 'enemy');
    assert.strictEqual(Memory.rooms[f.home.name].remotePlanner.remotes[f.remote.name].status, 'blocked');
    assert.strictEqual(f.searches(), 0);
});
test('danger updates immediately during the planning cooldown', () => {
    const f = fixture(); f.plan();
    const searches = f.searches(); Game.time++;
    require('HiveMind.Memory').ensure().threats[f.remote.name] = { lastSeen: Game.time, harmfulHostileCount: 1 };
    f.plan();
    assert.strictEqual(Memory.rooms[f.home.name].remotePlanner.remotes[f.remote.name].status, 'danger');
    assert.strictEqual(f.searches(), searches);
});
test('cooldown survives a module reset and handles tick rollback', () => {
    const f = fixture(); f.plan(); const first = f.searches();
    mocks.clearLocalModules(); Game.time++;
    require('HiveMind.Economy').checkSpend = () => ({ allowed: false });
    require('Planner.Remote').scanVisibleRoom(f.home.name, f.remote);
    assert.strictEqual(f.searches(), first);
    Game.time -= 5;
    require('Planner.Remote').scanVisibleRoom(f.home.name, f.remote);
    assert.ok(f.searches() > first);
});
test('different homes keep independent planning attempts', () => {
    const f = fixture(true); f.plan();
    const other = { ...f.home, name: 'W38S48' };
    Game.rooms[other.name] = other; Memory.rooms[other.name] = {};
    f.planner.scanVisibleRoom(other.name, f.remote);
    assert.strictEqual(f.searches(), 2);
});
test('scheduled and Scout callers share the same successful planning cooldown', () => {
    const f = fixture(); f.plan(); assert.strictEqual(f.searches(), 1);
    const before = Memory.rooms[f.home.name].remotePlanner.sourceInfos.source.route;
    Game.time++;
    f.planner.generateRemotePlan(f.home.name, f.remote);
    assert.strictEqual(f.searches(), 1);
    assert.strictEqual(Memory.rooms[f.home.name].remotePlanner.sourceInfos.source.route, before);
});
console.log('Remote planning scenarios passed: ' + passed);
