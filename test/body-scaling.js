const assert = require('assert');
const mocks = require('./mock-screeps');
mocks.installGlobals();
const Profiles = require('../BodyProfiles');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function build(role, options) { return Profiles.build(role, { energyCapacity: 10000, energyAvailable: 300, ...options }); }
test('F large Tech supplies 18 missing WORK with one body under CPU pressure', () => {
    const body = build('Tech', { desiredWork: 18, controllerFed: true, cpuMode: 'low' });
    assert.strictEqual(body.WORK, 18); assert.ok(body.bodyParts <= 50); assert.match(body.reason, /CPU constrained/);
});
test('G emergency Tech uses an immediately affordable useful minimum', () => {
    const body = build('Tech', { desiredWork: 18, urgency: 'EMERGENCY', energyAvailable: 200 });
    assert.strictEqual(body.WORK, 1); assert.strictEqual(body.cost, 200);
});
test('H large local Artificer covers 20 WORK when the roads are proven', () => {
    const body = build('Artificer', { desiredWork: 20, routeProfile: 'ROAD_HEAVY', provenRoads: true });
    assert.strictEqual(body.WORK, 20); assert.strictEqual(body.bodyParts, 45);
});
test('I J K Extractors never exceed local or remote missing WORK', () => {
    for (const work of [1, 2, 3, 4, 5]) for (const routeProfile of ['UNKNOWN', 'REMOTE_OFFROAD']) {
        const body = build('Extractor', { desiredWork: work, maxWork: work, routeProfile });
        assert.strictEqual(body.WORK, work); assert.strictEqual(body.CARRY, 1);
    }
    const config = require('../role.creepBodyConfig');
    assert.strictEqual(config.getExtractorBody({ energyCapacityAvailable: 5000 }).filter(p => p === WORK).length, 5);
});
test('L M proven roads carry 33 parts versus 25 on unknown routes; planned roads do not qualify', () => {
    const road = build('Freighter', { desiredCarry: 40, routeProfile: 'ROAD_HEAVY', provenRoads: true });
    const unknown = build('Freighter', { desiredCarry: 40 });
    assert.strictEqual(road.CARRY, 33); assert.strictEqual(unknown.CARRY, 25);
    assert.strictEqual(build('Freighter', { desiredCarry: 40, routeProfile: 'ROAD_HEAVY' }).CARRY, 25);
});
test('N O generated bodies stay affordable and within 50 parts across role, energy and demand ranges', () => {
    for (const role of ['Tech', 'Artificer', 'Extractor', 'Freighter', 'Foreman', 'ThoriumHauler',
        'ThoriumMiner', 'MineralMiner', 'Ronin', 'Volley', 'Cleric', 'Scout', 'Annex', 'ReactorClaimer']) {
        for (const energy of [0, 100, 200, 300, 550, 800, 1800, 5600, 12900]) {
            const result = Profiles.build(role, { energyCapacity: energy, desiredWork: 100,
                desiredCarry: 100, desiredPower: 100, desiredClaim: 1 });
            if (result) { assert.ok(result.body.length <= 50); assert.ok(result.cost <= energy); }
        }
    }
});
test('replacement deadlines bound spawn bursts and Thorium aging rejects unprofitable bodies', () => {
    const body = build('Tech', { desiredWork: 18, urgency: 'REPLACEMENT', replacementDeadline: 30 });
    assert.ok(body.spawnTime <= 30);
    assert.strictEqual(build('ThoriumHauler', { desiredCarry: 25, season11AgingMultiplier: 20, roundTrip: 100 }), null);
    assert.ok(build('ThoriumHauler', { desiredCarry: 25, season11AgingMultiplier: 2, roundTrip: 100 }));
});
test('Scout and claiming bodies stay mission-sized; combat preserves mobility and ordering', () => {
    assert.deepStrictEqual(build('Scout', {}).body, ['move']);
    assert.deepStrictEqual(build('Annex', {}).body, ['claim', 'move']);
    const ronin = build('Ronin', { desiredPower: 15 });
    assert.strictEqual(ronin.body[0], 'tough'); assert.strictEqual(ronin.body.at(-1), 'heal');
    assert.ok(ronin.bodyParts > 30);
});
console.log('Body scaling tests passed: ' + passed);
