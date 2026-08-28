const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { root } = require('./mock-screeps');

/* These were proven unreachable at the Phase 0 baseline. Phase 1 removes the
 * obsolete roles; Traveler remains a console-compatible movement facade. */
const allowlistedOrphans = new Set([]);
const files = fs.readdirSync(root)
    .filter(file => file.endsWith('.js') && !file.startsWith('test.'))
    .sort();
const fileSet = new Set(files);
const graph = new Map();
const missing = [];

for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
    const requires = [];
    const pattern = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (let match; (match = pattern.exec(source));) {
        if (match[1].startsWith('.') || match[1].includes('/')) continue;
        const target = match[1].endsWith('.js') ? match[1] : `${match[1]}.js`;
        if (!fileSet.has(target)) missing.push(`${file} -> ${match[1]}`);
        else requires.push(target);
    }
    graph.set(file, requires);
}
assert.deepStrictEqual(missing, [], `Missing local modules:\n${missing.join('\n')}`);

const reachable = new Set();
function visit(file) {
    if (reachable.has(file)) return;
    reachable.add(file);
    for (const target of graph.get(file) || []) visit(target);
}
visit('main.js');
const orphans = files.filter(file => !reachable.has(file));
const unexpectedOrphans = orphans.filter(file => !allowlistedOrphans.has(file));

const cycles = [];
const visiting = new Set();
const visited = new Set();
function findCycles(file, stack) {
    if (visiting.has(file)) {
        const start = stack.indexOf(file);
        cycles.push(stack.slice(start).concat(file).join(' -> '));
        return;
    }
    if (visited.has(file)) return;
    visiting.add(file);
    for (const target of graph.get(file) || []) findCycles(target, stack.concat(target));
    visiting.delete(file);
    visited.add(file);
}
for (const file of files) findCycles(file, [file]);

assert.deepStrictEqual(unexpectedOrphans, [], `Unexpected orphan modules: ${unexpectedOrphans.join(', ')}`);
assert.deepStrictEqual(cycles, [], `Circular dependencies:\n${cycles.join('\n')}`);
console.log(`PASS graph: ${files.length} modules resolve; ${reachable.size} reachable; 0 cycles`);
if (orphans.length) console.log(`Baseline allowlisted orphans: ${orphans.join(', ')}`);
