// This release is restricted to the explicitly requested local test branch.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '../..');
const authorized = path.resolve('C:/Users/xbenv/AppData/Local/Screeps/scripts/192_168_0_217___21025/Sushi');
assert.equal(root, authorized, 'Wrong local deployment directory');
const Build = require(path.join(root, 'tools/runtime-build'));
const Deploy = require(path.join(root, 'tools/deploy-runtime'));
const baseline = path.join(__dirname, 'baseline');
const stage = path.join(__dirname, 'stage');
assert.deepStrictEqual(Build.inventory(root), Build.inventory(baseline), 'Source changed during audit; review drift before deployment');
const plan = Deploy.makePlan(stage, root, path.join(__dirname, 'release'));
assert.deepStrictEqual(plan.changed.slice().sort(), ['HiveMind.MemoryGC.js', 'Runtime.Build.js']);
const result = Deploy.apply(plan);
fs.writeFileSync(path.join(__dirname, 'release/result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
