const assert = require('assert');
const { setup } = require('./harvesting-capacity');
let passed = 0;
const originalLook = require('./mock-screeps').RoomPosition.prototype.lookFor;
const originalRange = require('./mock-screeps').RoomPosition.prototype.findInRange;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS ' + name); }
    finally { RoomPosition.prototype.lookFor = originalLook; RoomPosition.prototype.findInRange = originalRange; }
}
function layout() {
    const f = setup(700);
    global.TERRAIN_MASK_WALL = 1; global.TERRAIN_MASK_SWAMP = 2;
    global.OBSTACLE_OBJECT_TYPES = [STRUCTURE_SPAWN, STRUCTURE_EXTENSION, STRUCTURE_WALL, STRUCTURE_LINK];
    f.walls = new Set(); f.swamps = new Set(); f.minerals = [];
    f.scans = {}; f.lookups = 0; f.terrainReads = 0;
    Game.map.getRoomTerrain = () => ({ get(x, y) {
        f.terrainReads++;
        return f.walls.has(x + ':' + y) ? 1 : f.swamps.has(x + ':' + y) ? 2 : 0;
    } });
    const find = f.room.find;
    f.room.find = function(kind, options) {
        f.scans[kind] = (f.scans[kind] || 0) + 1;
        const values = kind === FIND_MINERALS ? f.minerals : find.call(this, kind);
        return options && options.filter ? values.filter(options.filter) : values;
    };
    RoomPosition.prototype.lookFor = function(kind) {
        f.lookups++;
        const values = kind === LOOK_STRUCTURES ? f.room.structures : kind === LOOK_CREEPS ? Object.values(Game.creeps) : [];
        return values.filter(value => value.pos && this.isEqualTo(value.pos));
    };
    RoomPosition.prototype.findInRange = function(kind, range, options) {
        return f.room.find(kind, options).filter(value => value.pos && this.getRangeTo(value.pos) <= range);
    };
    f.utility = require('utility');
    f.source = f.room.sources[0]; f.sm = f.memory.sources.A;
    f.sm.pos = { ...f.source.pos };
    f.seats = () => f.utility.getValidSourceMiningSeats(f.sm, f.source.pos);
    f.allSeats = () => { delete f.sm.seats; delete f.sm.seatCount; };
    f.block = (x, y, type = STRUCTURE_WALL, extra = {}) => f.room.structures.push({
        id: 'block' + x + ':' + y, structureType: type, pos: new RoomPosition(x, y, f.room.name), ...extra });
    return f;
}

test('source demand follows actual capacities, including keeper, neutral and empty sources', () => {
    for (const [capacity, required, income] of [[1500, 3, 5], [3000, 5, 10], [4000, 7, 4000 / 300], [0, 0, 0]]) {
        const f = layout(); f.source.energyCapacity = capacity;
        const profile = f.utility.getSourceHarvestProfile(f.source);
        assert.strictEqual(profile.requiredWork, required); assert.strictEqual(profile.income, income);
        const row = f.describe(); assert.strictEqual(row.workRequired, required);
        assert.ok(row.maxAchievableWork <= required);
    }
});

test('economy sums zero, one, two and three sources without a fixed room income', () => {
    for (const count of [0, 1, 2, 3]) {
        const f = layout();
        f.room.sources.push({ ...f.source, id: 'C', pos: new RoomPosition(40, 35, f.room.name), energyCapacity: 4000 });
        f.room.sources = f.room.sources.slice(0, count);
        f.memory.sources.C = { id: 'C', assignedMiner: [] };
        const snapshot = f.sample();
        assert.strictEqual(snapshot.harvest.sources.length, count);
        assert.strictEqual(snapshot.harvest.workRequired, count === 3 ? 17 : count * 5);
    }
});

test('scan repairs legacy geometry once, preserves assignments and accepts a durable zero', () => {
    const f = layout();
    f.sm.seats = [{ x: 25, y: 25 }]; f.sm.seatCount = 99;
    f.sm.assignedMiner = ['incumbent']; f.sm.haul = { amount: 321 };
    for (let x = 9; x <= 11; x++) for (let y = 9; y <= 11; y++) f.walls.add(x + ':' + y);
    f.utility.scanRoom({ room: f.room });
    assert.deepStrictEqual(f.sm.seats, []); assert.strictEqual(f.sm.seatCount, 0);
    assert.deepStrictEqual(f.sm.assignedMiner, ['incumbent']); assert.strictEqual(f.sm.haul.amount, 321);
    f.terrainReads = 0; Game.time++;
    f.utility.scanRoom({ room: f.room });
    assert.strictEqual(f.terrainReads, 0, 'unchanged static source geometry was rescanned');
    assert.strictEqual(f.seats().length, 0);
});

test('plain and swamp are seats; malformed, duplicate, source-center, wall and wrong-room entries are rejected', () => {
    const f = layout(); f.swamps.add('9:10'); f.walls.add('10:11');
    f.sm.seats = [null, {}, { x: -1, y: 10 }, { x: 9.5, y: 10 }, { x: 10, y: 10 },
        { x: 9, y: 10 }, { pos: { x: 9, y: 10 } }, { x: 11, y: 10 },
        { x: 10, y: 11 }, { x: 11, y: 11, roomName: 'W9N9' }];
    assert.deepStrictEqual(f.seats().map(p => [p.x, p.y]), [[9, 10], [11, 10]]);
});

test('source geometry at room boundaries stays in bounds', () => {
    const f = layout(); f.allSeats(); f.source.pos = new RoomPosition(0, 0, f.room.name);
    assert.deepStrictEqual(f.seats().map(p => [p.x, p.y]), [[0, 1], [1, 0], [1, 1]]);
});

test('natural obstacles and private hostile ramparts reduce seats; roads and containers remain usable', () => {
    const f = layout(); f.allSeats();
    f.room.sources[1].pos = new RoomPosition(9, 9, f.room.name);
    f.minerals.push({ pos: new RoomPosition(9, 10, f.room.name) });
    f.room.controller.pos = new RoomPosition(9, 11, f.room.name);
    f.block(10, 9); f.block(10, 11, STRUCTURE_RAMPART, { my: false, isPublic: false });
    f.block(11, 9, STRUCTURE_CONTAINER); f.block(11, 10, STRUCTURE_ROAD);
    f.block(11, 11, STRUCTURE_RAMPART, { my: false, isPublic: true });
    assert.deepStrictEqual(f.seats().map(p => [p.x, p.y]), [[11, 9], [11, 10], [11, 11]]);
});

test('temporary creep occupancy and construction sites do not erase physical capacity', () => {
    const f = layout(); f.miner('parked', 1); f.allSeats();
    f.room.sites.push({ structureType: STRUCTURE_EXTENSION, pos: new RoomPosition(9, 9, f.room.name) });
    assert.strictEqual(f.seats().length, 8);
});

test('shared seat cache checks each tile once per tick and refreshes structure changes', () => {
    const f = layout(); f.allSeats();
    for (let i = 0; i < 100; i++) assert.strictEqual(f.seats().length, 8);
    assert.strictEqual(f.lookups, 8); assert.strictEqual(f.scans[FIND_SOURCES], 1); assert.strictEqual(f.scans[FIND_MINERALS], 1);
    f.seats().pop(); assert.strictEqual(f.seats().length, 8, 'consumer mutated cached array');
    f.block(9, 9); Game.time++;
    assert.strictEqual(f.seats().length, 7);
    f.room.structures.pop(); Game.time++;
    assert.strictEqual(f.seats().length, 8);
});

test('same-tick coordinate repairs and container-station changes invalidate seat results', () => {
    const f = layout(); assert.strictEqual(f.seats()[0].x, 9);
    f.sm.seats[0].x = 11; assert.strictEqual(f.seats()[0].x, 11);
    f.sm.containerPlannedPos = { x: 10, y: 11, roomName: f.room.name };
    assert.strictEqual(f.seats().length, 2);
    f.sm.containerPlannedPos.y = 10; // Source center is never a station.
    assert.strictEqual(f.seats().length, 1);
});

test('loss of vision retains terrain knowledge and reacquisition checks current blockers', () => {
    const f = layout(); f.block(9, 9); assert.strictEqual(f.seats().length, 0);
    delete Game.rooms[f.room.name]; Game.time++; assert.strictEqual(f.seats().length, 1);
    Game.rooms[f.room.name] = f.room; Game.time++; assert.strictEqual(f.seats().length, 0);
});

test('zero physical seats never create Extractor demand', () => {
    const f = layout(); f.sm.seats = []; f.sm.seatCount = 0;
    f.miner('coveredB', 5, 'B');
    assert.strictEqual(f.describe().constraint, 'NO_HARVEST_SEAT');
    assert.strictEqual(f.plan().requested, 0); assert.strictEqual(f.queue.length, 0);
});

test('assignment releases a remembered seat when a structure blocks it', () => {
    const f = layout(); const creep = f.miner('miner', 1);
    f.sm.seats.push({ x: 11, y: 10, roomName: f.room.name }); f.block(9, 9);
    const seat = require('utility.Creep').getAssignedMiningSeat(creep, f.source);
    assert.deepStrictEqual([seat.x, seat.y], [11, 10]);
    assert.strictEqual(creep.memory.miningSeat.x, 11);
});

test('a container source admits a third small miner when seats and missing WORK allow it', () => {
    const f = layout();
    f.sm.seats = [{ x: 9, y: 9 }, { x: 9, y: 10 }, { x: 9, y: 11 }]; f.sm.seatCount = 3;
    f.block(9, 9, STRUCTURE_CONTAINER); f.sm.containerId = 'block9:9';
    f.miner('first', 1); f.miner('second', 1); f.miner('other', 5, 'B');
    const creep = f.miner('third', 1); delete creep.memory.sourceId;
    f.sm.assignedMiner = ['first', 'second'];
    const source = require('utility.Creep').getAssignedSource(creep);
    assert.strictEqual(source.id, 'A');
    assert.ok(f.sm.assignedMiner.includes('third'));
});

test('covered container under a hostile rampart is not assigned as a mining station', () => {
    const f = layout(); const creep = f.miner('miner', 1);
    f.sm.seats.push({ x: 11, y: 10 }); f.block(9, 9, STRUCTURE_CONTAINER); f.sm.containerId = 'block9:9';
    f.block(9, 9, STRUCTURE_RAMPART, { my: false, isPublic: false });
    const seat = require('utility.Creep').getAssignedMiningSeat(creep, f.source);
    assert.deepStrictEqual([seat.x, seat.y], [11, 10]);
});

test('distance cache expires, refreshes topology changes and removes replaced dropoff entries', () => {
    const f = layout(); let calls = 0, distance = 12;
    f.room.findPath = () => { calls++; return Array(distance).fill({ x: 20, y: 20 }); };
    assert.strictEqual(f.describe().distance, 12); assert.strictEqual(calls, 2);
    Game.time++; distance = 20; assert.strictEqual(f.describe().distance, 12); assert.strictEqual(calls, 2);
    Game.time += 500; assert.strictEqual(f.describe().distance, 20); assert.strictEqual(calls, 4);
    f.block(20, 21); Game.time++; distance = 25;
    assert.strictEqual(f.describe().distance, 25); assert.strictEqual(calls, 6);
    f.room.storage = { id: 'new-storage', pos: new RoomPosition(20, 30, f.room.name) }; Game.time++;
    f.describe();
    assert.strictEqual(Object.keys(f.memory.cache.economyDistances).length, 2);
});

test('one-source Scout floor admits one working miner; three-source floor requires all three assignments', () => {
    for (const count of [1, 3]) {
        const f = layout(); f.core(); f.miner('tech', 1).memory = { role: 'Tech', homeRoom: f.room.name };
        f.room.sources.push({ ...f.source, id: 'C', pos: new RoomPosition(40, 35, f.room.name) });
        f.room.sources = f.room.sources.slice(0, count);
        f.memory.sources.C = { seats: [{ x: 39, y: 35 }], assignedMiner: [] };
        f.miner('a', 5);
        const status = () => require('Scout.Economy').status(f.room);
        if (count === 1) assert.strictEqual(status().allowed, true);
        else {
            f.miner('b', 5, 'B'); f.miner('duplicateB', 5, 'B');
            assert.strictEqual(status().allowed, false);
            f.miner('c', 5, 'C'); assert.strictEqual(status().allowed, true);
        }
    }
});

test('Scout floor does not wait for an impossible miner at a sealed source', () => {
    const f = layout(); f.core(); f.miner('a', 5);
    f.miner('tech', 1).memory = { role: 'Tech', homeRoom: f.room.name };
    f.memory.sources.B.seats = [];
    assert.strictEqual(require('Scout.Economy').status(f.room).allowed, true);
});

test('Extractor admission cap uses each source capacity and valid seats', () => {
    const f = layout(); f.allSeats(); f.source.energyCapacity = 4000;
    const policy = { roleCaps: { Extractor: 0 } };
    const request = { body: [WORK, CARRY, MOVE] };
    const cap = () => require('Spawn.Policy').economyRoleCap(f.room, 'Extractor', request, policy);
    assert.strictEqual(cap(), 13); // 7 + 5 productive miners, plus one handoff.
    f.memory.sources.B.seats = [];
    assert.strictEqual(cap(), 8);
});

test('remote demand rejects newly blocked seats and recovers after access returns', () => {
    const f = require('./remote-container-bootstrap').setup();
    require('HiveMind.Economy').checkSpend = () => ({ allowed: true });
    f.info.distance = 10; f.info.risk = 0; f.info.score = 5;
    const planner = require('Planner.Remote');
    delete f.memory.containerPlannedPos; f.memory.seats = [];
    assert.strictEqual(planner.shouldUseRemoteSource('W1N1', 'remote'), false);
    assert.strictEqual(f.info.rejectReason, 'no open seats');
    f.memory.seats = [{ x: 11, y: 10 }]; f.memory.seatCount = 0;
    assert.strictEqual(planner.shouldUseRemoteSource('W1N1', 'remote'), true);
});

test('remote keeper income is not halved for an impossible reservation', () => {
    const f = require('./remote-container-bootstrap').setup();
    global.ENERGY_REGEN_TIME = 300; global.CARRY_CAPACITY = 50;
    global.SOURCE_ENERGY_CAPACITY = 3000; global.SOURCE_ENERGY_KEEPER_CAPACITY = 4000;
    global.BODYPART_COST = { work: 100, carry: 50, move: 50 };
    require('HiveMind.Economy').checkSpend = () => ({ allowed: true });
    const memory = Memory.rooms.W1N1.remotePlanner;
    memory.remotes[f.room.name] = { type: 'keeper' };
    Object.assign(f.info, { distance: 10, risk: 0, grossEnergyPerTick: 4000 / 300 });
    const planner = require('Planner.Remote');
    planner.scoreRemoteSource('W1N1', 'remote');
    assert.strictEqual(f.info.effectiveEnergyPerTick, 13.333); assert.strictEqual(f.info.requiredWork, 7);
    memory.remotes[f.room.name].type = 'normal'; f.info.grossEnergyPerTick = 10;
    planner.scoreRemoteSource('W1N1', 'remote');
    assert.strictEqual(f.info.effectiveEnergyPerTick, 5); assert.strictEqual(f.info.requiredWork, 3);
});

test('one- and three-source recovery create one targeted request per uncovered source', () => {
    for (const count of [1, 3]) {
        const f = layout();
        f.room.sources.push({ ...f.source, id: 'C', pos: new RoomPosition(40, 35, f.room.name) });
        f.room.sources = f.room.sources.slice(0, count);
        f.memory.sources.C = { id: 'C', assignedMiner: [] };
        for (let i = 0; i < 6; i++) { f.sample(); f.plan(); }
        assert.strictEqual(f.queue.length, count);
        assert.strictEqual(new Set(f.queue.map(q => q.memory.sourceId)).size, count);
        assert.ok(f.queue.every(q => q.requestedWorkParts === 5));
    }
});

test('global reset rebuilds volatile seat evidence without changing durable geometry', () => {
    const f = layout(); f.utility.scanRoom({ room: f.room });
    const saved = JSON.stringify(f.memory.sources);
    f.seats();
    require('./mock-screeps').clearLocalModules();
    f.utility = require('utility');
    Game.time++; f.utility.scanRoom({ room: f.room });
    const normalize = value => JSON.parse(value, (key, item) => key === 'lastScanned' ? undefined : item);
    assert.deepStrictEqual(normalize(JSON.stringify(f.memory.sources)), normalize(saved));
    assert.strictEqual(f.seats().length, 8);
});

test('remote access blocked at last sight stays blocked without vision until observation clears it', () => {
    const f = require('./remote-container-bootstrap').setup();
    require('HiveMind.Economy').checkSpend = () => ({ allowed: true });
    global.OBSTACLE_OBJECT_TYPES = [STRUCTURE_WALL];
    Object.assign(f.info, { distance: 10, risk: 0, score: 5, numOpen: 1 });
    delete f.memory.containerPlannedPos; f.memory.seats = [{ x: 11, y: 10 }];
    f.room.structures.push({ structureType: STRUCTURE_WALL, pos: new RoomPosition(11, 10, f.room.name) });
    const usable = () => require('Planner.Remote').shouldUseRemoteSource('W1N1', 'remote');
    assert.strictEqual(usable(), false); assert.strictEqual(f.info.numOpen, 0);
    delete Game.rooms[f.room.name]; Game.time++;
    assert.strictEqual(usable(), false);
    assert.strictEqual(Memory.rooms[f.room.name].intelRefreshReason, 'SOURCE_ACCESS_BLOCKED');
    Game.rooms[f.room.name] = f.room; f.room.structures = []; Game.time++;
    assert.strictEqual(usable(), true); assert.strictEqual(f.info.numOpen, 1);
});

console.log('Room intelligence scenarios passed: ' + passed);
