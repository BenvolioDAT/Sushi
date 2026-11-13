const assert = require('assert');
const mocks = require('./mock-screeps');
let passed = 0;
function fixture() {
    mocks.installGlobals(); mocks.clearLocalModules();
    const room = { name: 'home', controller: { my: true, level: 8, ticksToDowngrade: 100000 } };
    Game.rooms.home = room;
    const H = require('HiveMind.Memory'); H.ensure();
    const E = require('HiveMind.Economy');
    let healthy = false;
    const economy = { state: 'RECOVERY', bootstrap: { floorReachable: true },
        haul: { localCarryRequired: 1, localCarryLiving: 1, localCarryQueued: 0, localCarrySpawning: 0 } };
    E.get = () => economy;
    E.localHarvestCoverage = () => ({ status: healthy ? 'HEALTHY' : 'MISSING' });
    const foreman = { memory: { role: 'Foreman', homeRoom: 'home' }, body: [], ticksToLive: 1000 };
    require('HiveMind.Index').get = () => ({ ownedRooms: [room],
        ownedSpawnsByRoom: new Map([['home', [{}]]]), creepsByHomeRoom: new Map([['home', [foreman]]]),
        spawnRequestsByRoom: new Map(), structuresByRoom: new Map() });
    const C = require('HiveMind.ColonyState');
    Memory.rooms.home = { colony: { lifecycle: 'MATURE', state: 'MATURE', phase: 'MATURE', lifecycleSince: 1 } };
    return { C, room, setHealthy() { healthy = true; economy.state = 'STABLE'; } };
}
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
test('a mature colony immediately enters bootstrap when its core harvest disappears', () => {
    const f = fixture();
    const decision = f.C.update(f.room);
    assert.equal(decision.lifecycle, 'BOOTSTRAP');
    assert.equal(decision.nextMandatoryRole, 'Extractor');
    assert.equal(decision.lifecycleSince, Game.time);
    assert.equal(decision.pendingLifecycle, undefined);
});
test('a mature colony without a spawn still enters the owned-no-spawn state', () => {
    const f = fixture();
    const index = require('HiveMind.Index').get(); index.ownedSpawnsByRoom.clear();
    require('HiveMind.Index').get = () => index;
    assert.equal(f.C.update(f.room).lifecycle, 'OWNED_NO_SPAWN');
});
test('restored mature economy advances through normal lifecycle steps and hysteresis', () => {
    const f = fixture(); f.C.update(f.room); f.setHealthy();
    assert.equal(f.C.update(f.room).lifecycle, 'BOOTSTRAP');
    Game.time += 5;
    assert.equal(f.C.update(f.room).lifecycle, 'GROWTH');
    Game.time++;
    assert.equal(f.C.update(f.room).lifecycle, 'DEVELOPMENT');
    Game.time++;
    assert.equal(f.C.update(f.room).lifecycle, 'MATURE');
});
console.log('Colony lifecycle recovery scenarios passed: ' + passed);
