const assert = require('assert');
const mocks = require('./mock-screeps');
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log('PASS ' + name); } catch (e) { process.exitCode = 1; console.error('FAIL ' + name, e.stack); } }
function fixture() {
    mocks.installGlobals(); mocks.clearLocalModules();
    const room = { name: 'W1N1', controller: { pos: new RoomPosition(20, 20, 'W1N1') } }, byType = new Map(), objects = {};
    Game.rooms[room.name] = room;
    require('HiveMind.Index').get = () => ({ structuresByRoom: new Map([[room.name, byType]]) });
    require('Diagnostics').measureOperation = (name, fn) => fn();
    Game.getObjectById = id => objects[id] || null;
    function target(id, type, free, x = 20) {
        const item = { id, my: true, pos: new RoomPosition(x, 20, room.name), structureType: type,
            store: { getFreeCapacity: () => free } };
        objects[id] = item; if (!byType.has(type)) byType.set(type, []); byType.get(type).push(item);
        return item;
    }
    function worker(name, energy = 50) {
        const c = { name, room, pos: new RoomPosition(18, 20, room.name),
            memory: { role: 'Freighter', homeRoom: room.name, FreighterWorking: true },
            store: { energy, getFreeCapacity: () => 100 - energy } };
        Game.creeps[name] = c; return c;
    }
    return { room, byType, objects, target, worker, logistics: require('Logistics.Index') };
}
test('two loaded haulers reserve separate small deliveries', () => {
    const f = fixture(), a = f.target('a', STRUCTURE_EXTENSION, 50), b = f.target('b', STRUCTURE_EXTENSION, 50, 25);
    const x = f.worker('x'), y = f.worker('y');
    assert.strictEqual(f.logistics.deliveryTarget(x, f.room.name, false), a);
    assert.strictEqual(f.logistics.deliveryTarget(y, f.room.name, false), b);
});
test('a dead courier releases delivery capacity on the next tick', () => {
    const f = fixture(), a = f.target('a', STRUCTURE_EXTENSION, 50), x = f.worker('x'), y = f.worker('y');
    f.logistics.deliveryTarget(x, f.room.name, false); delete Game.creeps.x; Game.time++;
    assert.strictEqual(f.logistics.deliveryTarget(y, f.room.name, false), a);
});
test('a destroyed delivery target releases the stale claim', () => {
    const f = fixture(), a = f.target('a', STRUCTURE_EXTENSION, 50), x = f.worker('x');
    f.logistics.deliveryTarget(x, f.room.name, false);
    delete f.objects.a; f.byType.set(STRUCTURE_EXTENSION, []); Game.time++;
    const b = f.target('b', STRUCTURE_EXTENSION, 50, 25);
    assert.strictEqual(f.logistics.deliveryTarget(x, f.room.name, false), b);
    assert.strictEqual(f.logistics.snapshot().deliveryEnergy.a, undefined);
});
test('new spawn demand preempts a reserved controller delivery', () => {
    const f = fixture(), controller = f.target('controller', STRUCTURE_CONTAINER, 2000), x = f.worker('x');
    assert.strictEqual(f.logistics.deliveryTarget(x, f.room.name, false), controller);
    const spawn = f.target('spawn', STRUCTURE_SPAWN, 100);
    assert.strictEqual(f.logistics.deliveryTarget(x, f.room.name, false), spawn);
});
test('partially loaded haulers share a larger deficit without overreserving', () => {
    const f = fixture(), a = f.target('a', STRUCTURE_EXTENSION, 100), x = f.worker('x', 30), y = f.worker('y', 50);
    assert.strictEqual(f.logistics.deliveryTarget(x, f.room.name, false), a);
    assert.strictEqual(f.logistics.deliveryTarget(y, f.room.name, false), a);
    assert.strictEqual(f.logistics.snapshot().deliveryEnergy.a, 80);
});
console.log('Logistics reservation scenarios passed: ' + passed);
