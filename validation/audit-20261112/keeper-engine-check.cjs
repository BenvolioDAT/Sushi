// Executes installed engine code in an isolated VM with in-memory fake bulk writes.
// No imports of server drivers, connections, live Memory or world mutation.
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');
const { createRequire } = require('module');
const root = 'D:/SteamLibrary/steamapps/common/Screeps/server/package/node_modules/@screeps/engine/src';
const localRequire = createRequire(path.join(root, 'utils.js'));
const lodash = localRequire('lodash');
const constants = { ENERGY_REGEN_TIME: 300, TOUGH: 'tough', MOVE: 'move', ATTACK: 'attack', RANGED_ATTACK: 'ranged_attack' };
const utils = { getDriver: () => ({ constants }), dist: (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) };
function load(relative, imports) {
    const file = path.join(root, relative), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, __dirname: path.dirname(file),
        require: name => { if (!(name in imports)) throw Error('Unexpected import ' + name); return imports[name]; } }, { filename: file });
    return module.exports;
}
const tick = load('processor/intents/keeper-lairs/tick.js', { lodash, '../../../utils': utils });
const lair = { _id: 'lair', type: 'keeperLair', x: 15, y: 15, room: 'TEST' };
const keeper = { _id: 'keeper', type: 'creep', user: '3', name: 'Keeperlair', hits: 5000 };
const inserted = [], removed = [];
const bulk = { update: (object, changes) => Object.assign(object, changes), insert: object => inserted.push(object), remove: id => removed.push(id) };
tick(lair, { roomObjects: { keeper }, bulk, gameTime: 100 }); assert.strictEqual(lair.nextSpawnTime, undefined);
keeper.hits = 4999; tick(lair, { roomObjects: { keeper }, bulk, gameTime: 101 }); assert.strictEqual(lair.nextSpawnTime, 401);
tick(lair, { roomObjects: { keeper }, bulk, gameTime: 102 }); assert.strictEqual(lair.nextSpawnTime, 401);
tick(lair, { roomObjects: { keeper }, bulk, gameTime: 400 });
assert.deepStrictEqual(removed, ['keeper']); assert.strictEqual(inserted[0].body.length, 50); assert.strictEqual(inserted[0].hits, 5000);
const parts = Object.fromEntries(['tough', 'move', 'attack', 'ranged_attack'].map(type => [type, inserted[0].body.filter(p => p.type === type).length]));
assert.deepStrictEqual(parts, { tough: 17, move: 13, attack: 10, ranged_attack: 10 });
const moved = [];
const npc = load('processor/intents/creeps/keepers/pretick.js', { lodash, '../../../../utils': utils,
    '../../../common/fake-runtime': { moveTo: (object, source) => { moved.push(source._id); return 1; } } });
const creature = { _id: 'keeper', x: 15, y: 15 };
const intents = npc(creature, { roomObjects: { a: { _id: 'a', type: 'source', x: 10, y: 10 },
    b: { _id: 'b', type: 'mineral', x: 15, y: 14 }, player: { _id: 'player', type: 'creep', user: 'me', x: 16, y: 15, hits: 1000 } }, bulk });
assert.strictEqual(creature.memory_sourceId, 'a'); assert.deepStrictEqual(moved, ['a']);
assert(intents.keeper.attack); assert(intents.keeper.rangedAttack);
const actions = [];
const dispatch = load('processor/intents/creeps/intents.js', { lodash,
    'bulk-require': () => Object.fromEntries(['heal', 'rangedAttack', 'attack', 'move'].map(action => [action, () => actions.push(action)])) });
dispatch({}, { heal: {}, rangedAttack: {}, move: {} }, {});
assert.deepStrictEqual(actions, ['heal', 'move', 'rangedAttack']);
actions.length = 0; dispatch({}, { heal: {}, attack: {} }, {}); assert.deepStrictEqual(actions, ['heal']);
console.log(JSON.stringify({ passed: 8, engineVersion: localRequire('../package.json').version,
    checks: ['undamaged Keeper has no countdown', 'damage starts 300-tick timer', 'timer does not restart',
        'new spawn replaces living Keeper', '50-part body composition', 'first resource within five, not nearest',
        'Keeper attacks both melee and ranged', 'self-heal coexists with ranged attack, suppresses melee attack'], parts }, null, 2));
