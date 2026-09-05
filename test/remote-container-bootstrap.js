const assert = require('assert');
const mocks = require('./mock-screeps');

function setup(local = false) {
    mocks.installGlobals();
    mocks.clearLocalModules();
    global.TERRAIN_MASK_WALL = 1;
    global.HARVEST_POWER = 2;
    global.CREEP_LIFE_TIME = 1500;
    Memory.config = { remote: { maxRoomRange: 2, routeValidationInterval: 251 } };
    const calls = [];
    const objects = {};
    const room = { name: 'W1N2', controller: null, structures: [], sites: [], drops: [], creeps: [],
        find(kind, options) {
            const values = kind === FIND_STRUCTURES ? this.structures :
                kind === FIND_CONSTRUCTION_SITES ? this.sites : kind === FIND_DROPPED_RESOURCES ? this.drops :
                kind === FIND_MY_CREEPS || kind === FIND_CREEPS ? this.creeps : [];
            return options && options.filter ? values.filter(options.filter) : values;
        }, getTerrain: () => ({ get: () => 0 }) };
    Game.rooms[room.name] = room;
    Game.rooms.W1N1 = { name: 'W1N1', find: () => [] };
    RoomPosition.prototype.lookFor = function(kind) {
        const values = kind === LOOK_STRUCTURES ? room.structures :
            kind === LOOK_CONSTRUCTION_SITES ? room.sites : kind === LOOK_CREEPS ? room.creeps : [];
        return values.filter(value => this.isEqualTo(value.pos));
    };
    RoomPosition.prototype.findInRange = function(kind, range, options) {
        return room.find(kind, options).filter(value => this.getRangeTo(value.pos) <= range);
    };
    RoomPosition.prototype.createConstructionSite = function() {
        calls.push(['plan', this.x, this.y]);
        return ERR_FULL; // Simulate temporary global site limit; retry must be bounded.
    };
    const station = new RoomPosition(11, 10, room.name);
    const source = { id: 'remote', pos: new RoomPosition(12, 10, room.name) };
    const memory = { id: source.id, pos: source.pos, containerPlannedPos: { ...station },
        seats: [{ x: 12, y: 11, roomName: room.name }], assignedCreeps: [] };
    Memory.rooms[room.name] = { sources: { remote: memory } };
    const info = { sourceId: 'remote', roomName: room.name, parentRoomName: 'W1N1', parentHome: 'W1N1',
        active: true, state: 'ACTIVE', containerCoord: 511,
        roadCoords: { W1N1: [1275, 1276], W1N2: [510, 511] },
        route: { version: 1, valid: true, length: 4, targetCoord: 511, calculatedAt: Game.time,
            segments: [{ room: 'W1N1', coords: [1275, 1276] }, { room: room.name, coords: [510, 511] }],
            roomSequence: ['W1N1', room.name] } };
    Memory.rooms.W1N1 = { remotePlanner: { pathVersion: 1, activeSourceIds: ['remote'],
        remotes: {}, sourceInfos: { remote: info } } };
    const store = { energy: 50, getFreeCapacity: () => 50 - store.energy, getCapacity: () => 50 };
    const creep = { id: 'miner', name: 'miner', room, pos: station, store,
        memory: { role: 'Extractor', homeRoom: local ? room.name : 'W1N1', sourceId: 'remote',
            remoteMining: !local, miningSeat: { sourceId: 'remote', ...memory.seats[0], type: 'seat' },
            miningSeatKey: 'W1N2:12:11' },
        harvest(target) { calls.push(['harvest', target.id]); return OK; },
        build(target) { calls.push(['build', target.id]); return OK; },
        drop() { calls.push(['drop']); return OK; },
        transfer(target) { calls.push(['transfer', target.id]); return this.pos.getRangeTo(target.pos) > 1 ? ERR_NOT_IN_RANGE : OK; },
        move() { calls.push(['move']); return OK; },
        setWorkingArea(pos, range) { this._workingPos = pos; this._workingRange = range; },
        body: [{ type: WORK, hits: 100 }], ticksToLive: 1000 };
    room.creeps.push(creep);
    Game.creeps.miner = creep;
    objects.remote = source;
    objects.miner = creep;
    Game.getObjectById = id => objects[id] || room.structures.concat(room.sites, room.drops).find(v => v.id === id) || null;
    const utility = require('utility');
    const seats = require('utility.Creep');
    const actualGetAssignedSource = seats.getAssignedSource;
    seats.getAssignedSource = () => source; // Assignment is fixed; seat and routing logic remain real.
    require('HiveMind.Economy').shouldBootstrapSelfDeliver = () => false;
    require('utility.Travel.Creep').move = (unit, target) => { calls.push(['move', target.x, target.y]); return OK; };
    const role = require('role.Extractor');
    function addSite(id = 'site', pos = station) {
        const site = { id, pos, my: true, structureType: STRUCTURE_CONTAINER, progress: 600, progressTotal: 5000 };
        room.sites.push(site);
        return site;
    }
    function addArtificer(target = 'site', currentRoom = room) {
        const unit = { name: 'builder', room: currentRoom, pos: new RoomPosition(10, 9, currentRoom.name),
            memory: { role: 'Artificer', remoteWorkTargetId: target, remoteWorkType: 'buildRemoteContainer' } };
        Game.creeps.builder = unit;
        if (currentRoom === room) room.creeps.push(unit);
        return unit;
    }
    function addContainer(id = 'container', pos = station) {
        const energy = { energy: 100, getFreeCapacity: () => 1900, getUsedCapacity: () => energy.energy, getCapacity: () => 2000 };
        const value = { id, pos, structureType: STRUCTURE_CONTAINER, store: energy };
        room.structures.push(value);
        return value;
    }
    function tick() { calls.length = 0; Game.time++; role.run(creep); }
    function stationary() { assert.ok(!calls.some(call => call[0] === 'move'), JSON.stringify(calls)); }
    return { creep, source, memory, room, station, info, calls, seats, utility, addSite, addArtificer, addContainer, tick, stationary, actualGetAssignedSource };
}
function test(name, fn) { fn(); console.log('PASS ' + name); }

if (require.main === module) {
test('1 planned tile overrides stale generic seat before container completion', () => {
    const f = setup(); f.addSite();
    assert.deepStrictEqual(f.seats.getAssignedMiningSeat(f.creep, f.source), f.station);
    assert.strictEqual(f.memory.containerId, undefined);
    assert.strictEqual(f.creep.memory.miningSeatKey, 'W1N2:11:10');
});
test('2 real route endpoint and mining seat agree across repeated unfinished ticks', () => {
    const f = setup(); f.addSite(); f.creep.store.energy = 0;
    for (let i = 0; i < 8; i++) {
        f.tick(); f.stationary();
        assert.deepStrictEqual(f.calls, [['harvest', 'remote']]);
        assert.strictEqual(f.creep.memory.miningSeat.x + 50 * f.creep.memory.miningSeat.y, f.info.route.targetCoord);
        assert.strictEqual(f.creep._workingRange, 0);
    }
});
test('3 full miner self-builds the exact station site', () => {
    const f = setup(); f.addSite(); f.tick(); f.stationary();
    assert.deepStrictEqual(f.calls, [['build', 'site']]);
    assert.strictEqual(f.creep.memory.extractorState, 'remoteContainerSelfBuild');
});
test('4 physically present targeting Artificer receives dropped supply', () => {
    const f = setup(); f.addSite(); f.addArtificer(); f.tick(); f.stationary();
    assert.deepStrictEqual(f.calls, [['drop']]);
    assert.strictEqual(f.creep.memory.extractorState, 'remoteContainerSupplyingArtificer');
});
test('5 stale Artificer memory outside the room does not suppress self-build', () => {
    const f = setup(); f.addSite(); f.addArtificer('site', Game.rooms.W1N1); f.tick(); f.stationary();
    assert.deepStrictEqual(f.calls, [['build', 'site']]);
});
test('6 Artificer death immediately resumes self-build', () => {
    const f = setup(); f.addSite(); f.addArtificer(); f.tick();
    delete Game.creeps.builder; f.room.creeps = [f.creep]; f.tick(); f.stationary();
    assert.deepStrictEqual(f.calls, [['build', 'site']]);
});
test('7 completed container repairs id and clears bootstrap memory without reseating', () => {
    const f = setup(); f.addSite(); f.tick();
    f.room.sites = []; f.addContainer(); f.tick(); f.stationary();
    assert.deepStrictEqual(f.calls, [['transfer', 'container']]);
    assert.strictEqual(f.memory.containerId, 'container');
    assert.strictEqual(f.creep.memory.remoteContainerSiteId, undefined);
    assert.strictEqual(f.creep.memory.extractorState, 'remoteContainerOperational');
    assert.strictEqual(f.creep.memory.miningSeatKey, 'W1N2:11:10');
});
test('8 missing site keeps station, drops buffer and retries planning with backoff', () => {
    const f = setup(); f.tick(); f.stationary();
    assert.deepStrictEqual(f.calls, [['plan', 11, 10], ['drop']]);
    for (let i = 0; i < 24; i++) { f.tick(); f.stationary(); assert.deepStrictEqual(f.calls, [['drop']]); }
    f.tick(); assert.deepStrictEqual(f.calls, [['plan', 11, 10], ['drop']]);
});
test('9 resolved drop is advertised then naturally transitions to a completed container', () => {
    const f = setup(); f.addSite(); f.addArtificer(); f.tick();
    // Screeps applies the drop intent after the role tick, visible on the following tick.
    f.room.drops.push({ id: 'pile', pos: f.station, resourceType: RESOURCE_ENERGY, amount: 50 });
    f.creep.store.energy = 0; f.tick();
    assert.strictEqual(f.memory.haul.targetId, 'pile');
    assert.strictEqual(f.memory.haul.targetType, 'dropped');
    f.room.drops = []; f.room.sites = []; f.addContainer(); f.tick(); f.stationary();
    assert.strictEqual(f.memory.haul.targetId, 'container');
    assert.strictEqual(f.memory.haul.targetType, 'container');
});
test('10 remote offload ignores unrelated nearby containers and sites', () => {
    const f = setup(); f.addSite();
    f.addContainer('unrelated', new RoomPosition(13, 11, f.room.name));
    f.addSite('wrongSite', new RoomPosition(12, 11, f.room.name));
    f.memory.containerId = 'unrelated'; f.tick(); f.stationary();
    assert.deepStrictEqual(f.calls, [['build', 'site']]);
    assert.deepStrictEqual(f.memory.containerPlannedPos, { ...f.station });
});
test('11 local miner retains generic seat and offload movement', () => {
    const f = setup(true); f.utility.planSourceContainers = () => {};
    f.creep.pos = new RoomPosition(12, 11, f.room.name);
    f.addContainer('localStore', new RoomPosition(14, 10, f.room.name));
    f.tick();
    assert.deepStrictEqual(f.calls, [['transfer', 'localStore'], ['move', undefined, undefined]]);
    assert.strictEqual(f.creep.memory.miningSeatKey, 'W1N2:12:11');
    assert.strictEqual(f.creep._workingRange, 1);
});
test('Artificer arrival preserves partial progress, departure and target changes resume building', () => {
    const f = setup(); const site = f.addSite(); f.tick();
    const builder = f.addArtificer(); f.tick(); f.stationary();
    assert.deepStrictEqual(f.calls, [['drop']]);
    assert.strictEqual(site.progress, 600);
    builder.memory.remoteWorkTargetId = 'elsewhere'; f.tick();
    assert.deepStrictEqual(f.calls, [['build', 'site']]);
    builder.memory.remoteWorkTargetId = 'site'; builder.room = Game.rooms.W1N1; f.tick();
    assert.deepStrictEqual(f.calls, [['build', 'site']]);
});
test('invalid planned coordinates are rejected consistently', () => {
    const f = setup();
    for (const pos of [{ x: 12, y: 10, roomName: 'W1N2' }, { x: 11, y: 10, roomName: 'W1N1' },
        { x: 20, y: 20, roomName: 'W1N2' }, { x: -1, y: 10, roomName: 'W1N2' }]) {
        f.memory.containerPlannedPos = pos;
        assert.strictEqual(f.utility.getPlannedSourceContainerPosition(f.memory), null);
    }
});
test('traffic preserves station but accepts explicit emergency movement', () => {
    const f = setup(); f.addSite(); f.tick();
    const traffic = require('traffic_manager');
    assert.deepStrictEqual(traffic.getPossibleMoves(f.creep), []);
    delete f.creep._cachedMoveOptions;
    f.creep._trafficIntent = { packedTarget: traffic.packCoordinates({ x: 10, y: 10 }) };
    assert.deepStrictEqual(traffic.getPossibleMoves(f.creep), [{ x: 10, y: 10 }]);
});
test('travel owns the tick before stationary bootstrap can issue another move or work intent', () => {
    const f = setup(); f.addSite(); f.creep.pos = new RoomPosition(10, 10, f.room.name);
    f.tick();
    assert.deepStrictEqual(f.calls, [['move', 11, 10]]);
    assert.strictEqual(f.creep.memory.extractorState, 'movingToRemoteSource');
});
test('intentional station replan replaces remembered seat and invalidates the old route', () => {
    const f = setup(); f.addSite(); f.tick();
    f.memory.containerPlannedPos = { x: 12, y: 11, roomName: f.room.name };
    assert.deepStrictEqual(f.seats.getAssignedMiningSeat(f.creep, f.source), new RoomPosition(12, 11, f.room.name));
    const validation = require('Planner.Remote').validateRemoteRoute('W1N1', 'remote', true);
    assert.strictEqual(validation.valid, false);
    f.tick();
    assert.ok(!f.calls.some(call => call[0] === 'build' || call[0] === 'transfer'));
});
test('missing station site is not replaced by another nearby site or container', () => {
    const f = setup();
    f.addSite('unrelatedSite', new RoomPosition(12, 11, f.room.name));
    f.addContainer('unrelatedContainer', new RoomPosition(13, 10, f.room.name));
    f.tick(); f.stationary();
    assert.deepStrictEqual(f.calls, [['plan', 11, 10], ['drop']]);
    assert.deepStrictEqual(f.memory.containerPlannedPos, { ...f.station });
});
}
module.exports = { setup };
