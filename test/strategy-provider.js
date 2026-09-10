const assert = require('assert');
const fs = require('fs');
const path = require('path');
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
assert.strictEqual(Strategy.getScoutModifier({ roomName: 'W8N20', unknown: true }), 0);
const Expansion = require('../Logic.Expansion');
Game.gcl = { level: 1 };
let expansion = Expansion.ensureExpansionMemory();
assert.strictEqual(expansion.configuredRoomLimit, null);
assert.strictEqual(Expansion.getMaxOwnedRooms(expansion), 1);
Game.gcl.level = 2;
assert.strictEqual(Expansion.getMaxOwnedRooms(expansion), 2,
    'GCL growth must not require editing a remembered current-GCL cap');
for (const file of ['HiveMind.Capacity.js', 'Spawn.Policy.js', 'spawn.manager.js',
    'spawn.request.manager.js', 'Spawn.DemandBoard.js', 'role.Scout.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const token of ['ThoriumMiner', 'ThoriumHauler', 'ReactorClaimer',
        'season11RouteDistance', 'season11ReactorId', 'season11ReactorGuard']) {
        assert.strictEqual(source.includes(token), false, `${file} must not contain ${token}`);
    }
}
console.log('Permanent strategy provider no-season test passed');
