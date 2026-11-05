const assert = require('assert');
const path = require('path');
const mocks = require('./mock-screeps');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
function fresh(file) {
    const resolved = path.join(mocks.root, file);
    delete require.cache[require.resolve(resolved)];
    return require(resolved);
}
function reset() {
    mocks.installGlobals({ limit: 100, tickLimit: 500, bucket: 10000, getUsed: () => 0 });
    Game.gcl = { level: 2, progress: 0, progressTotal: 1000 };
    Game.gpl = { level: 0, progress: 0, progressTotal: 1000 };
    global.RESOURCE_POWER = 'power';
    global.STRUCTURE_POWER_BANK = 'powerBank';
    global.STRUCTURE_POWER_SPAWN = 'powerSpawn';
    mocks.clearLocalModules();
}
function homeRoom() {
    const room = {
        name: 'W1N1', controller: { my: true, owner: { username: 'Sushi' }, level: 8 },
        energyAvailable: 3000, energyCapacityAvailable: 3000,
        find: constant => constant === FIND_STRUCTURES ? [] : []
    };
    Game.rooms[room.name] = room;
    Game.spawns.Spawn1 = { my: true, room };
    Memory.rooms[room.name] = { scoutIntel: { sourceCount: 2 } };
    return room;
}
test('Power Bank intel persists and expires as plain data', () => {
    reset(); homeRoom(); const bank = { id: 'PB1', structureType: STRUCTURE_POWER_BANK,
        power: 4000, hits: 2000000, hitsMax: 2000000, ticksToDecay: 1000,
        pos: new RoomPosition(20, 20, 'W2N2') };
    const room = { name: 'W2N2', find: constant => constant === FIND_STRUCTURES ? [bank] : [] };
    Game.rooms.W2N2 = room;
    const Intel = fresh('Power.Intel.js'); Intel.observeRoom(room);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(Intel.state().banks.PB1)).id, 'PB1');
    Game.time = 1101; assert.strictEqual(Intel.cleanup(true), 1);
});

test('impossible Power Bank raid is rejected', () => {
    reset(); const Operations = fresh('Power.Operations.js');
    const result = Operations.evaluate({ hits: 2000000, ticksToDecay: 200,
        power: 5000, homeRoom: 'W1N1', routeDistance: 5, threat: { hostileCreeps: 0 } });
    assert.strictEqual(result.viable, false);
    assert.strictEqual(result.reason, 'CANNOT_KILL_BEFORE_DECAY');
});

test('viable Power Bank computes attack heal and haul capacity', () => {
    reset(); const Operations = fresh('Power.Operations.js');
    const result = Operations.evaluate({ hits: 500000, ticksToDecay: 5000,
        power: 4000, homeRoom: 'W1N1', routeDistance: 2, threat: { hostileCreeps: 0 } });
    assert.strictEqual(result.viable, true);
    assert.ok(result.attackers >= 1 && result.healers >= 1 && result.haulers >= 1);
    assert.ok(result.haulCapacity >= 4000);
});

test('Power Spawn processes when supplied and policy permits', () => {
    reset(); const room = homeRoom(); let calls = 0;
    const spawn = { id: 'PS1', structureType: STRUCTURE_POWER_SPAWN, my: true,
        isActive: () => true, processPower: () => { calls++; return OK; },
        store: { getUsedCapacity: type => type === RESOURCE_POWER ? 1 : 50 } };
    room.find = constant => constant === FIND_STRUCTURES ? [spawn] : [];
    const Economy = fresh('HiveMind.Economy.js'); Economy.canSpend = () => true;
    const Manager = fresh('Power.Manager.js');
    assert.strictEqual(Manager.processRoom(room), OK);
    assert.strictEqual(calls, 1);
});

test('Power Spawn obeys economy processing gate', () => {
    reset(); const room = homeRoom(); let calls = 0;
    const spawn = { id: 'PS1', structureType: STRUCTURE_POWER_SPAWN, isActive: () => true,
        processPower: () => { calls++; return OK; }, store: { getUsedCapacity: () => 100 } };
    room.find = constant => constant === FIND_STRUCTURES ? [spawn] : [];
    const Economy = fresh('HiveMind.Economy.js'); Economy.canSpend = () => false;
    const Manager = fresh('Power.Manager.js'); Manager.processRoom(room);
    assert.strictEqual(calls, 0);
});

test('Power Creep auto-create defaults off', () => {
    reset(); const Manager = fresh('Power.Manager.js');
    assert.strictEqual(Manager.managePowerCreep().state, 'AUTO_CREATE_DISABLED');
});

test('configured Power Creep creation requires free GPL', () => {
    reset(); let creates = 0; homeRoom();
    POWER_CLASS = { OPERATOR: 'operator' };
    PowerCreep.create = () => { creates++; return OK; };
    const MemoryApi = fresh('HiveMind.Memory.js');
    MemoryApi.getConfig('power').powerCreeps.autoCreate = true;
    const Manager = fresh('Power.Manager.js');
    Game.gpl.level = 0; Manager.managePowerCreep(); assert.strictEqual(creates, 0);
    Game.gpl.level = 1; Manager.managePowerCreep(); assert.strictEqual(creates, 1);
});

test('unspawned configured Power Creep selects owned active Power Spawn', () => {
    reset(); const room = homeRoom(); let selected = null;
    const spawn = { id: 'PS1', structureType: STRUCTURE_POWER_SPAWN, isActive: () => true,
        store: { getUsedCapacity: () => 0, getFreeCapacity: () => 2000 } };
    room.find = constant => constant === FIND_STRUCTURES ? [spawn] : [];
    Game.powerCreeps.SushiOperator = { ticksToLive: 0, spawn: target => { selected = target; return OK; } };
    const Economy = fresh('HiveMind.Economy.js'); Economy.canSpend = () => true;
    const MemoryApi = fresh('HiveMind.Memory.js'); MemoryApi.getConfig('power').powerCreeps.autoCreate = true;
    const Manager = fresh('Power.Manager.js'); Manager.managePowerCreep();
    assert.strictEqual(selected, spawn);
});

test('normal shards remain safe without seasonal and Power APIs', () => {
    reset(); delete global.RESOURCE_THORIUM; delete global.FIND_REACTORS;
    delete global.RESOURCE_POWER; delete global.STRUCTURE_POWER_BANK; delete global.STRUCTURE_POWER_SPAWN;
    assert.doesNotThrow(() => fresh('Power.Intel.js').scanVisible());
    assert.doesNotThrow(() => fresh('Power.Manager.js').plan());
});

console.log(`Standard Power pipeline tests passed: ${passed}`);
