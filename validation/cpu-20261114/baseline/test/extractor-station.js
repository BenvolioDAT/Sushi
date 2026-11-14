const assert = require('assert');
const mocks = require('./mock-screeps');
let passed = 0;
function test(name, fn) { if (require.main !== module) return; try { fn(); passed++; console.log('PASS ' + name); } catch (e) { process.exitCode = 1; console.error('FAIL ' + name, e.message); } }
function fixture() {
    mocks.installGlobals(); mocks.clearLocalModules();
    const pos = (x, y) => new RoomPosition(x, y, 'W39S47');
    const room = { name: 'W39S47', controller: { my: true }, find: type => type === FIND_STRUCTURES ? containers : [] };
    const source = { id: 'source', pos: pos(32, 24) };
    const container = (id, x, y) => ({ id, pos: pos(x, y), structureType: STRUCTURE_CONTAINER,
        store: { energy: 0, getFreeCapacity: () => 2000, getCapacity: () => 2000 } });
    const containers = [container('old', 33, 24), container('new', 31, 24)];
    const memory = { id: source.id, pos: source.pos, containerId: 'old', seats: [pos(31, 25), pos(31, 24), pos(33, 24)], assignedMiner: [] };
    Game.rooms[room.name] = room; Memory.rooms[room.name] = { sources: { source: memory } };
    Game.getObjectById = id => id === source.id ? source : containers.find(c => c.id === id) || Object.values(Game.creeps).find(c => c.id === id);
    const utility = require('utility'); utility.getValidSourceMiningSeats = () => memory.seats;
    utility.planSourceContainers = () => {};
    const C = require('utility.Creep'), travel = require('utility.Travel.Creep'), moves = [];
    travel.move = (c, target) => { moves.push({ creep: c.name, target: target.pos || target }); return OK; };
    const c = { id: 'miner', name: 'Extractor_005', my: true, room, pos: pos(31, 25), ticksToLive: 900,
        memory: { role: 'Extractor', homeRoom: room.name, sourceId: source.id,
            miningSeat: { sourceId: source.id, x: 31, y: 25, roomName: room.name, type: 'seat' } },
        body: [WORK, WORK, WORK, MOVE, CARRY].map(type => ({ type, hits: 100 })),
        getActiveBodyparts: type => type === WORK ? 3 : 1, fatigue: 0,
        store: { energy: 50, getFreeCapacity() { return 50 - this.energy; } },
        transfer(target) { this.transferred = target.id; return this.pos.getRangeTo(target) <= 1 ? OK : ERR_NOT_IN_RANGE; },
        drop() { this.dropped = true; return OK; }, harvest() { this.harvested = true; return OK; } };
    const incumbent = { name: 'Extractor_003', my: true, id: 'oldMiner', pos: containers[0].pos, room,
        memory: { role: 'Extractor', homeRoom: room.name, sourceId: source.id, miningSeatKey: 'W39S47:33:24',
            miningSeat: { sourceId: source.id, x: 33, y: 24, roomName: room.name, type: 'container' } },
        ticksToLive: 500, body: [WORK, WORK, MOVE].map(type => ({ type, hits: 100 })),
        getActiveBodyparts: type => type === WORK ? 2 : 1 };
    Game.creeps = { [c.name]: c, [incumbent.name]: incumbent };
    memory.assignedMiner = [c.id, incumbent.id];
    RoomPosition.prototype.lookFor = function(type) {
        if (type === LOOK_CREEPS) return Object.values(Game.creeps).filter(c => c.pos.isEqualTo(this));
        if (type === LOOK_STRUCTURES) return containers.filter(c => c.pos.isEqualTo(this));
        return [];
    };
    source.pos.findInRange = (type, range, options) => type === FIND_STRUCTURES ? containers.filter(s =>
        source.pos.getRangeTo(s) <= range && (!options?.filter || options.filter(s))) : [];
    const role = require('role.Extractor');
    function run() {
        C.getAssignedSource = () => source;
        role.run(c);
    }
    return { c, source, memory, containers, incumbent, C, moves, run, pos };
}
test('supplemental local miner chooses a second free source container', () => {
    const f = fixture(); const seat = f.C.getAssignedMiningSeat(f.c, f.source);
    assert.ok(seat.isEqualTo(f.containers[1].pos), JSON.stringify(seat));
    assert.strictEqual(f.c.memory.miningSeat.type, 'container');
    assert.strictEqual(f.incumbent.memory.miningSeatKey, 'W39S47:33:24');
});
test('a reachable offload wins over an earlier distant container without leaving the station', () => {
    const f = fixture(); f.C.getAssignedMiningSeat = () => f.c.pos;
    f.run(); assert.strictEqual(f.c.transferred, 'new'); assert.strictEqual(f.moves.length, 0);
});
test('a full stationary miner drops for haulers when no store can be reached in place', () => {
    const f = fixture(); f.containers.pop(); f.C.getAssignedMiningSeat = () => f.c.pos;
    f.run(); assert.strictEqual(f.moves.length, 0); assert.strictEqual(f.c.dropped, true);
});
test('a healthy full-strength incumbent still prevents speculative extra mining', () => {
    const f = fixture(); f.incumbent.body = Array(5).fill(WORK).map(type => ({ type, hits: 100 }));
    f.incumbent.getActiveBodyparts = type => type === WORK ? 5 : 1;
    const seat = f.C.getAssignedMiningSeat(f.c, f.source);
    assert.strictEqual(seat, null); assert.strictEqual(f.c.memory.extractorState, 'waitingForContainerSeat');
});
test('a reserved second container is not stolen from another miner', () => {
    const f = fixture();
    Game.creeps.other = { name: 'other', room: f.c.room, pos: f.pos(30, 24), memory: { role: 'Extractor',
        miningSeatKey: 'W39S47:31:24', miningSeat: { x: 31, y: 24, roomName: 'W39S47', sourceId: 'source' } } };
    const seat = f.C.getAssignedMiningSeat(f.c, f.source);
    assert.ok(seat.isEqualTo(f.c.pos));
});
test('spawning and staged full-source successors do not evict productive supplemental miners', () => {
    for (const stage of ['spawning', 'travelling', 'handoff']) {
        const f = fixture(); f.c.pos = f.containers[1].pos; f.c.store.energy = 0;
        const incoming = { id: 'incoming', name: 'incoming', my: true, room: f.c.room,
            pos: stage === 'handoff' ? f.pos(31, 25) : f.pos(22, 27), spawning: stage === 'spawning',
            ticksToLive: stage === 'spawning' ? undefined : 1490,
            memory: { role: 'Extractor', homeRoom: f.c.room.name, sourceId: f.source.id,
                extractorReplacementFor: f.incumbent.name }, getActiveBodyparts: type => type === WORK ? 5 : 1,
            body: [...Array(5).fill(WORK), MOVE].map(type => ({ type, hits: 100 })) };
        Game.creeps.incoming = incoming; f.memory.assignedMiner.push(incoming.id);
        const seat = f.C.getAssignedMiningSeat(f.c, f.source);
        assert.ok(seat?.isEqualTo(f.c.pos), stage + ' must preserve the active miner');
        f.run(); assert.strictEqual(f.c.harvested, true, stage); assert.strictEqual(f.moves.length, 0);
    }
});
if (require.main === module) console.log('Extractor station scenarios passed: ' + passed);
module.exports = { fixture };
