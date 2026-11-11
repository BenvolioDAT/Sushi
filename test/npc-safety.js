const assert = require('assert');
const mocks = require('./mock-screeps');
const fs = require('fs');
const path = require('path');
const Module = require('module');
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log('PASS ' + name); } catch (e) { process.exitCode = 1; console.error('FAIL ' + name, e.stack); } }
function fixture(level = 1) {
    mocks.installGlobals(); mocks.clearLocalModules();
    const core = { id: 'core', structureType: STRUCTURE_INVADER_CORE, owner: { username: 'Invader' },
        my: false, level, hits: 100000, effects: [], pos: new RoomPosition(25, 25, 'W1N1') };
    const structures = [core], hostiles = [];
    const room = { name: 'W1N1', find(type, options) {
        const list = type === FIND_STRUCTURES || type === FIND_HOSTILE_STRUCTURES ? structures : type === FIND_HOSTILE_CREEPS ? hostiles : [];
        return options?.filter ? list.filter(options.filter) : list;
    } };
    Game.rooms[room.name] = room;
    Memory.rooms.HOME = { remotePlanner: { remotes: { [room.name]: { active: true } } } };
    const operations = require('Combat.Operations'), hive = require('HiveMind.Memory').ensure();
    const op = operations.createStronghold({ originRoom: 'HOME', targetRoom: room.name, strongholdRelevant: true }).operation;
    return { core, room, structures, hostiles, operations, hive, op };
}
test('levels 1 through 5 and unknown levels cannot approve imaginary siege capability', () => {
    for (const level of [1, 2, 3, 4, 5, undefined]) {
        const f = fixture(level); f.core.level = level;
        f.op.desiredCapabilities = { damage: 1000000, healing: 1000000 };
        assert.strictEqual(f.operations.evaluate(f.op).allowed, false);
        assert.strictEqual(f.operations.assessStronghold(f.op).viable, false);
    }
});
test('lesser cores are distinguished but cannot spawn an unvalidated WORK breacher', () => {
    const f = fixture(0), result = require('Combat.Stronghold').discover(f.room);
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /Lesser core/);
    f.operations.run(); assert.deepStrictEqual(f.op.spawnDemands, []);
    assert.strictEqual(f.op.state, 'ABORTED'); assert.strictEqual(f.op.policyApproved, false);
});
test('deploy timer and invulnerability effect both prevent engagement', () => {
    for (const mode of ['timer', 'effect']) {
        const f = fixture(0);
        if (mode === 'timer') f.core.ticksToDeploy = 20;
        else f.core.effects = [{ effect: EFFECT_INVULNERABILITY, ticksRemaining: 20 }];
        assert.strictEqual(f.operations.assessStronghold(f.op).status, 'NEEDS_INTEL');
        assert.strictEqual(f.operations.evaluate(f.op).allowed, false);
    }
});
test('legacy active clearing orders lose approval and use the existing abort/retreat lifecycle', () => {
    const f = fixture(3); f.op.state = 'ACTIVE'; f.op.policyApproved = true;
    f.operations.run(); assert.strictEqual(f.op.state, 'ABORTED');
    assert.strictEqual(f.op.policyApproved, false); assert.deepStrictEqual(f.op.spawnDemands, []);
});
test('lost vision cannot complete an operation or throw while reading absent hostiles', () => {
    const f = fixture(0); f.op.state = 'ACTIVE'; delete Game.rooms[f.room.name];
    assert.doesNotThrow(() => f.operations.run());
    assert.notStrictEqual(f.op.state, 'COMPLETE'); assert.strictEqual(f.op.policyApproved, false);
});
test('visible disappearance of core and defenders completes a legacy operation', () => {
    const f = fixture(0); f.structures.length = 0; f.op.state = 'ACTIVE';
    f.operations.run(); assert.strictEqual(f.op.state, 'COMPLETE');
});
test('disabled CoreBreaker returns home instead of idling in the hostile room', () => {
    const f = fixture(3); f.op.policyApproved = false;
    const moves = []; require('utility.Travel.Creep').moveToRoom = (creep, room) => moves.push(room);
    require('role.CoreBreaker').run({ room: f.room, memory: { operationId: f.op.id, homeRoom: 'HOME' } });
    assert.deepStrictEqual(moves, ['HOME']);
});
test('repeated detection creates no clearing operations or spawn demands', () => {
    const f = fixture(4); delete f.hive.operations[f.op.id];
    for (let i = 0; i < 10; i++) { require('Combat.Stronghold').run(); Game.time++; }
    assert.deepStrictEqual(Object.keys(f.hive.operations), []);
});
test('observed cores remain blocked without vision across resets and reopen only after a clear observation', () => {
    const f = fixture(0);
    function loadSafety() {
        const file = path.join(mocks.root, 'Planner.Remote.js'), mod = new Module(file, module);
        mod.filename = file; mod.paths = module.paths;
        mod._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports.safety = { hasInvaderCore, isBlockedRoomForPath };', file);
        return mod.exports.safety;
    }
    let safety = loadSafety(); assert.strictEqual(safety.hasInvaderCore(f.room), true);
    assert.strictEqual(Memory.rooms[f.room.name].invaderCore.level, 0);
    delete Game.rooms[f.room.name]; Game.time += 2000; mocks.clearLocalModules(); safety = loadSafety();
    assert.strictEqual(safety.isBlockedRoomForPath('HOME', f.room.name), true);
    assert.strictEqual(Memory.rooms[f.room.name].intelRefreshReason, 'INVADER_CORE_NEEDS_VISION');
    f.structures.length = 0; Game.rooms[f.room.name] = f.room; Game.time++;
    assert.strictEqual(safety.isBlockedRoomForPath('HOME', f.room.name), false);
    assert.strictEqual(Memory.rooms[f.room.name].invaderCore, undefined);
});
test('stronghold defenders cannot bypass avoidance through ordinary remote defense', () => {
    const f = fixture(3), ledger = require('Combat.ThreatLedger');
    const id = 'defend:' + f.room.name;
    f.hive.operations[id] = { id, type: 'DEFEND_REMOTE', state: 'ACTIVE', spawnDemands: [{ role: 'Volley' }] };
    const snapshot = { roomName: f.room.name, owned: false, invaderCore: { id: f.core.id, level: 3 },
        actionableHostileCount: 2, respondingColony: 'HOME' };
    assert.strictEqual(ledger.ensureDefenseOperation(snapshot), null);
    assert.strictEqual(f.hive.operations[id].state, 'ABORTED');
    assert.deepStrictEqual(f.hive.operations[id].spawnDemands, []);
    snapshot.invaderCore = null; snapshot.actionableHealing = 0; snapshot.actionableEffectiveHits = 1000;
    snapshot.actionableMelee = 30; snapshot.actionableRanged = 0; snapshot.totalThreat = 50;
    const resumed = ledger.ensureDefenseOperation(snapshot);
    assert.strictEqual(resumed.state, 'ACTIVE', 'ordinary remote defense remains available after core removal');
});
test('combat observation persists a core even before a civilian requests the route', () => {
    const f = fixture(2), ledger = require('Combat.ThreatLedger');
    const snapshot = ledger.observeRoom(f.room);
    assert.strictEqual(snapshot.invaderCore.level, 2);
    assert.strictEqual(Memory.rooms[f.room.name].invaderCore.id, f.core.id);
    f.structures.length = 0; Game.time++;
    assert.strictEqual(ledger.observeRoom(f.room).invaderCore, null);
    assert.strictEqual(Memory.rooms[f.room.name].invaderCore, undefined);
});
console.log('NPC safety scenarios passed: ' + passed);
