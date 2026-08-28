const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { root } = require('./mock-screeps');

const intentionalDirectMovement = new Set([
    'traffic_manager.js',
    'utility.Travel.Creep.js',
    'Traveler.js',
    /* Existing one-tile source-seat displacement, retained as a known exception. */
    'role.Extractor.js'
]);
const intentionalPathfinding = new Set([
    'Traveler.js',
    'utility.Travel.Creep.js',
    'Planner.Remote.js',
    'Planner.Roads.js'
]);
const violations = [];
let matches = 0;

for (const file of fs.readdirSync(root).filter(name => name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
    const lines = source.split(/\r?\n/);
    lines.forEach((line, index) => {
        if (/\.moveTo\s*\(|\bcreep\.move\s*\(/.test(line)) {
            matches++;
            if (!intentionalDirectMovement.has(file)) violations.push(`${file}:${index + 1}: ${line.trim()}`);
        }
        if (/PathFinder\.search\s*\(/.test(line)) {
            matches++;
            if (!intentionalPathfinding.has(file)) violations.push(`${file}:${index + 1}: ${line.trim()}`);
        }
        if (/\.travelTo\s*\(|\.registerMove\s*\(/.test(line)) matches++;
    });
}
assert.deepStrictEqual(violations, [], `Unexpected movement bypasses:\n${violations.join('\n')}`);
console.log(`PASS movement: ${matches} movement/pathfinding call sites remain within the ownership contract`);
