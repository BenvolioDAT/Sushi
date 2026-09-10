const assert = require('assert');
const mocks = require('./mock-screeps');

mocks.installGlobals({ limit: 100, bucket: 10000, getUsed: () => 0 });
mocks.clearLocalModules();
delete global.RESOURCE_THORIUM;
delete global.FIND_REACTORS;
delete global.Creep.prototype.claimReactor;
const Strategy = require('../Strategy.Provider');
assert.deepStrictEqual(Strategy.active(), []);
assert.deepStrictEqual(Strategy.capabilities(), {
    market: true, externalTerminalTransfers: true, portals: true
});
assert.strictEqual(Strategy.getExpansionNomination(), null);
assert.deepStrictEqual(Strategy.getColonyObjectives({ name: 'W1N1', controller: { level: 7 } }), []);
assert.deepStrictEqual(Strategy.getSpecialSpawnPlans({ name: 'W1N1' }), []);
assert.deepStrictEqual(Strategy.getSurplusInvestments({ name: 'W1N1' }, {}, {}), []);
assert.strictEqual(Strategy.getSpecialResourcePolicy('U'), null);
assert.strictEqual(Memory.hive && Memory.hive.season, undefined);
console.log('Permanent strategy provider no-season test passed');
