const assert = require('assert');
const { setup } = require('./remote-container-bootstrap');
function test(name, fn) { fn(); console.log('PASS ' + name); }
function fixture() {
    const f = setup();
    f.memory.seats = [f.station, new RoomPosition(12, 11, f.room.name), new RoomPosition(13, 10, f.room.name)];
    f.memory.seatCount = 3;
    f.memory.assignedMiner = ['miner'];
    f.info.effectiveEnergyPerTick = 10; f.info.grossEnergyPerTick = 10; f.info.numOpen = 3;
    require('HiveMind.Economy').canSpend = () => true;
    const planner = require('Planner.Remote');
    function miner(name, work, pos = new RoomPosition(12, 11, f.room.name), ttl = 1400) {
        const creep = { ...f.creep, id: name, name, my: true, pos, ticksToLive: ttl,
            memory: { role: 'Extractor', homeRoom: 'W1N1', sourceRoom: f.room.name,
                targetRoom: f.room.name, sourceId: 'remote', targetSourceId: 'remote', remoteMining: true },
            body: Array.from({ length: work }, () => ({ type: WORK, hits: 100 })).concat([{ type: CARRY, hits: 100 }, { type: MOVE, hits: 100 }]),
            store: { energy: 0, getFreeCapacity() { return 50 - this.energy; }, getCapacity: () => 50 } };
        Game.creeps[name] = creep; f.room.creeps.push(creep); return creep;
    }
    Object.assign(f.creep, { my: true });
    Object.assign(f.creep.memory, { sourceRoom: f.room.name, targetRoom: f.room.name, targetSourceId: 'remote' });
    f.creep.body = [{ type: WORK, hits: 100 }];
    f.creep.memory.miningSeat = { ...f.station, type: 'container', sourceId: 'remote' };
    f.creep.memory.miningSeatKey = 'W1N2:11:10';
    function run(creep) { Game.time++; f.calls.length = 0; require('role.Extractor').run(creep); }
    function demand(queue = []) { return planner.getRemoteExtractorDemand('W1N1', [WORK, CARRY, MOVE], queue); }
    function remove(creep) { delete Game.creeps[creep.name]; f.room.creeps = f.room.creeps.filter(c => c !== creep); }
    function body(creep, count) { creep.body = Array.from({ length: count }, () => ({ type: WORK, hits: 100 })); }
    return { ...f, miner, planner, run, demand, remove, body };
}
test('1 two remote Extractors receive unique station and side seats', () => {
    const f = fixture(); const second = f.miner('second', 2);
    assert.deepStrictEqual(f.seats.getAssignedMiningSeat(f.creep, f.source), f.station);
    const seat = f.seats.getAssignedMiningSeat(second, f.source);
    assert.ok(!seat.isEqualTo(f.station));
    assert.strictEqual(seat.getRangeTo(f.station), 1);
    for (let i = 0; i < 3; i++) assert.deepStrictEqual(f.seats.getAssignedMiningSeat(second, f.source), seat);
});
test('2 supplemental miner harvests across real routing ticks without chasing primary', () => {
    const f = fixture(); f.addSite(); const second = f.miner('second', 2);
    f.seats.getAssignedSource = f.actualGetAssignedSource;
    for (let i = 0; i < 3; i++) {
        f.run(second); f.stationary(); assert.deepStrictEqual(f.calls, [['harvest', 'remote']]);
        assert.strictEqual(second.memory.sourceId, 'remote');
        assert.strictEqual(second._workingRange, 0);
    }
});
test('3 full supplement builds, supplies Artificer, and drops when site missing', () => {
    const f = fixture(); f.addSite(); const second = f.miner('second', 2); second.store.energy = 50;
    f.run(second); f.stationary(); assert.deepStrictEqual(f.calls, [['build', 'site']]);
    f.addArtificer(); f.run(second); f.stationary(); assert.deepStrictEqual(f.calls, [['drop']]);
    f.room.sites = []; f.run(second); f.stationary(); assert.ok(f.calls.some(c => c[0] === 'drop'));
});
test('4 primary death promotes the existing supplement', () => {
    const f = fixture(); f.addSite(); const second = f.miner('second', 2);
    f.run(second); f.remove(f.creep); f.run(second);
    assert.deepStrictEqual(f.calls, [['harvest', 'remote'], ['move', 11, 10]]);
    assert.strictEqual(second.memory.miningSeat.type, 'container');
});
test('5 early replacement harvests while dying primary retains its station', () => {
    const f = fixture(); f.addSite(); f.creep.ticksToLive = 40;
    const second = f.miner('replacement', 5);
    f.run(second); f.stationary(); assert.deepStrictEqual(f.calls, [['harvest', 'remote']]);
    assert.strictEqual(second.memory.miningSeat.type, 'seat');
    assert.strictEqual(f.creep.memory.miningSeat.type, 'container');
});
test('6 five active WORK cover the source', () => {
    const f = fixture(); f.body(f.creep, 5); assert.deepStrictEqual(f.demand(), []);
});
test('7 three WORK request exactly two missing WORK', () => {
    const f = fixture(); f.body(f.creep, 3); assert.strictEqual(f.demand()[0].missingWork, 2);
});
test('8 two two-WORK miners permit a third one-WORK request', () => {
    const f = fixture(); f.body(f.creep, 2); f.miner('second', 2);
    assert.strictEqual(f.demand()[0].missingWork, 1);
});
test('9 physical seat cap rejects impossible third miner', () => {
    const f = fixture(); f.memory.seats.pop(); f.memory.seatCount = 2;
    f.info.effectiveEnergyPerTick = 12; f.body(f.creep, 2); f.miner('second', 2);
    assert.deepStrictEqual(f.demand(), []);
});
test('10 fresh Annex reservation increases desired coverage without waiting for death', () => {
    const f = fixture(); f.info.effectiveEnergyPerTick = 5; f.body(f.creep, 3);
    assert.deepStrictEqual(f.demand(), []);
    require('HiveMind.Memory').ensure().identity.username = 'me';
    f.room.controller = { reservation: { username: 'me', ticksToEnd: 4000 } };
    assert.strictEqual(f.demand()[0].missingWork, 2);
});
test('11 destroyed WORK does not count toward active coverage', () => {
    const f = fixture(); f.body(f.creep, 5);
    f.creep.body.slice(2).forEach(part => { part.hits = 0; });
    assert.strictEqual(f.planner.countRemoteAssignedExtractorWork('W1N1', f.info).work, 2);
    assert.strictEqual(f.demand()[0].missingWork, 3);
});
test('12 completion preserves both seats and adjacent supplemental transfers', () => {
    const f = fixture(); f.addSite(); const second = f.miner('second', 2); f.run(second);
    f.room.sites = []; f.addContainer();
    second.store.energy = 50; f.run(second); f.stationary(); assert.deepStrictEqual(f.calls, [['transfer', 'container']]);
    f.run(f.creep); f.stationary(); assert.deepStrictEqual(f.calls, [['transfer', 'container']]);
    assert.notStrictEqual(second.memory.miningSeatKey, f.creep.memory.miningSeatKey);
});
test('distant side seat drops full cargo instead of walking to completed container', () => {
    const f = fixture(); f.addContainer(); f.miner('adjacent', 1);
    const second = f.miner('far', 2, new RoomPosition(13, 10, f.room.name)); second.store.energy = 50;
    f.run(second); f.stationary(); assert.deepStrictEqual(f.calls, [['drop']]);
});
test('queued WORK and seats count toward coverage', () => {
    const f = fixture(); f.body(f.creep, 3);
    const request = { role: 'Extractor', memory: { ...f.creep.memory }, body: [WORK, WORK, CARRY, MOVE] };
    assert.deepStrictEqual(f.demand([request]), []);
    request.body = [WORK, CARRY, MOVE]; assert.strictEqual(f.demand([request])[0].missingWork, 1);
    f.memory.seatCount = 2; assert.deepStrictEqual(f.demand([request]), []);
});
test('dying miner stops covering future WORK so replacement demand can overlap', () => {
    const f = fixture(); f.body(f.creep, 5); f.creep.ticksToLive = 40;
    assert.strictEqual(f.demand()[0].missingWork, 5);
});
test('legacy duplicate station claims repair in favor of the physical primary', () => {
    const f = fixture(); const second = f.miner('aaa', 2);
    second.memory.miningSeat = { ...f.creep.memory.miningSeat }; second.memory.miningSeatKey = f.creep.memory.miningSeatKey;
    f.seats.getAssignedMiningSeat(f.creep, f.source);
    assert.strictEqual(second.memory.miningSeat, undefined);
    assert.ok(!f.seats.getAssignedMiningSeat(second, f.source).isEqualTo(f.station));
});
test('stale reassigned claims do not reserve station after the primary dies', () => {
    const f = fixture(); const stale = f.miner('stale', 2, new RoomPosition(20, 20, f.room.name));
    stale.memory.miningSeat = { ...f.creep.memory.miningSeat }; stale.memory.miningSeatKey = f.creep.memory.miningSeatKey;
    stale.memory.sourceId = 'different';
    f.remove(f.creep); const second = f.miner('second', 2);
    assert.deepStrictEqual(f.seats.getAssignedMiningSeat(second, f.source), f.station);
    assert.strictEqual(stale.memory.miningSeat, undefined);
});
test('no open side seat waits instead of double-claiming', () => {
    const f = fixture(); f.memory.seats = [f.station]; const second = f.miner('second', 2);
    assert.strictEqual(f.seats.getAssignedMiningSeat(second, f.source), null);
    assert.strictEqual(second.memory.extractorState, 'waitingForContainerSeat');
});
