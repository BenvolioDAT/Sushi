const assert = require('assert');
const { world } = require('./freighter-renewal');
let passed = 0;
function fixture() {
    const f = world(6, 800, 34);
    f.snapshot.state = 'RECOVERY'; f.snapshot.recoveryReason = 'LOCAL_HARVEST_SHORTAGE';
    f.snapshot.harvest.workActive = 9; f.snapshot.harvest.workRequired = 10;
    for (let i = 0; i < 6; i++) f.unit('old' + i, 1, 90 + i * 5);
    f.refresh();
    return f;
}
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
test('a funded local cohort consolidates during capacity-limited harvest recovery', () => {
    const f = fixture(); const result = f.plan();
    assert.equal(result.requested, 1, result.reason);
    assert.ok(f.queue[0].freighterRenewal);
    assert.equal(require('spawn.manager').runRoom(f.room.name).result, OK);
    assert.equal(f.calls[0].body.filter(p => p === CARRY).length, 6);
    assert.equal(f.calls[0].memory.freighterPredecessors.length, 6);
    assert.ok(Object.values(Game.creeps).filter(c => c.memory.role === 'Freighter').every(c => !c.memory.freighterRetiring));
});
test('lost reserves, negative energy trend and hard cap still reject discretionary renewal', () => {
    for (const change of [f => { f.snapshot.growth.energyAboveReserve = 0; },
        f => { f.snapshot.energyTrend = -5; },
        f => { require('HiveMind.Capacity').get().rooms[f.room.name].population.hardSafetyCap = 1; }]) {
        const f = fixture(); change(f); const result = f.plan();
        assert.equal(result.requested, 0, change.toString());
        assert.equal(f.calls.length, 0);
    }
});
test('missing harvest and survival retain immediate affordable hauling recovery', () => {
    const f = fixture(); f.snapshot.state = 'SURVIVAL'; f.snapshot.harvest.actualOrEstimatedIncome = 0;
    assert.equal(f.E.freighterRenewalPlan(f.room, 'local'), null);
    const request = {role:'Artificer',body:[WORK,CARRY,MOVE],memory:{role:'Artificer',homeRoom:f.room.name}};
    assert.equal(require('Spawn.Policy').evaluate(f.room, request, require('Spawn.Context').snapshot(f.room.name)).allowed, false);
});
console.log('Hauling recovery scenarios passed: ' + passed);
