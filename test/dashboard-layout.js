const assert = require('assert');
const fs = require('fs');
const mocks = require('./mock-screeps');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
class Visual {
    constructor() { this.calls = []; }
    rect(x,y,width,height,style) { this.calls.push({ type: 'rect', x,y,width,height,style }); return this; }
    text(text,x,y,style) { this.calls.push({ type: 'text', text,x,y,style }); return this; }
}
function setup(level = 3, dense = false) {
    mocks.installGlobals(); mocks.clearLocalModules();
    const room = { name: 'W3S47', controller: { my: true, level, progress: 1000, progressTotal: 10000 },
        energyAvailable: 300, energyCapacityAvailable: 550, find: () => [] };
    Game.rooms[room.name] = room;
    Memory.rooms[room.name] = { colony: { growthAllowed: false, blockedReason: 'minimum local miner floor missing', nextMandatoryRole: 'Extractor' },
        spawn: { queue: [{ role: 'Extractor' }], lastDecision: { tick: Game.time, status: 'BLOCK', selectedRole: 'Extractor',
            waitingForEnergy: 'miner', energyAvailable: 300, requiredEnergy: 550, reason: 'Waiting for energy' } },
        remotePlanner: { remotes: dense ? Object.fromEntries(Array.from({ length: 50 }, (_,i) => ['W' + i + 'N1', { status: 'active', sourceIds: ['source'] }])) : {} } };
    room.storage = { store: { energy: 30000, ...(dense ? Object.fromEntries(Array.from({ length: 60 }, (_,i) => ['RESOURCE_' + i + '_LONG', 1000])) : {}) } };
    const economy = { state: 'RECOVERY', sampleTick: Game.time, reason: 'harvesting below sustainable local demand', storageEnergy: 30000,
        growth: { mode: 'RECOVERY', reserveTarget: 2000 },
        harvest: { workRequired: 10, workActive: 7, workQueued: 3, workSpawning: 0, expectedIncome: 20, actualOrEstimatedIncome: 14,
            sources: Array.from({ length: dense ? 8 : 2 }, (_,i) => ({ id: 'source' + i, workRequired: 5, workActive: i ? 2 : 5,
                stationedWork: i ? 2 : 5, workSpawning: 0, workQueued: i ? 3 : 0, expectedIncome: 10, estimatedIncome: i ? 4 : 10 })) } };
    require('../HiveMind.Economy').get = () => economy;
    const index = require('../HiveMind.Index').get();
    index.creepsByHomeRoom.set(room.name, Array.from({ length: dense ? 40 : 8 }, (_,i) => ({ memory: { role: dense ? 'LongRoleName_' + i : i < 2 ? 'Extractor' : 'Tech' } })));
    index.allCreeps = index.creepsByHomeRoom.get(room.name);
    return { room, economy, Dashboard: require('../Visual.Dashboard'), Layout: require('../Visual.Layout') };
}
function inspect(layout, Layout) {
    const v = new Visual(); Layout.draw(v, layout);
    for (const p of layout.panels) {
        assert.ok(p.x >= 0 && p.y >= 0); assert.ok(p.x + p.width <= 49.5); assert.ok(p.y + p.height <= 49.1);
    }
    for (let i = 0; i < layout.panels.length; i++) for (let j = i + 1; j < layout.panels.length; j++) {
        const a = layout.panels[i], b = layout.panels[j];
        assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, 'panels overlap');
    }
    for (const call of v.calls.filter(c => c.type === 'text')) {
        const p = layout.panels.find(p => call.x > p.x && call.x < p.x + p.width && call.y > p.y && call.y < p.y + p.height);
        assert.ok(p, 'text must be inside a panel'); const font = parseFloat(call.style.font);
        assert.ok(call.x + call.text.length * font * 0.68 <= p.x + p.width - Layout.STYLE.padding + 0.01);
        assert.ok(call.y - font >= p.y); assert.ok(call.y + font * 0.25 < p.y + p.height);
    }
    return v;
}
test('all display modes and RCL1 through RCL8 keep panels and text inside the room', () => {
    for (let rcl = 1; rcl <= 8; rcl++) for (const mode of ['COMPACT', 'NORMAL', 'DEBUG']) {
        const w = setup(rcl); inspect(w.Dashboard.build(w.room, mode), w.Layout);
    }
});
test('dense population, alerts, resources and remotes are bounded with explicit overflow', () => {
    const w = setup(8, true); const layout = w.Dashboard.build(w.room, 'DEBUG'); const v = inspect(layout, w.Layout);
    assert.ok(v.calls.some(c => c.text && /more - see console/.test(c.text)));
    assert.ok(layout.panels.every(p => p.rows.length <= 12)); assert.ok(v.calls.length < 120);
});
test('long text is truncated using the available tile width and readable font sizes', () => {
    const w = setup(); Memory.rooms.W3S47.colony.blockedReason = 'VERY LONG '.repeat(200);
    const layout = w.Dashboard.build(w.room, 'NORMAL'); const v = inspect(layout, w.Layout);
    assert.ok(v.calls.some(c => c.text && c.text.endsWith('...')));
    assert.ok(v.calls.filter(c => c.type === 'text').every(c => parseFloat(c.style.font) >= 0.58));
});
test('empty or missing economy data renders safely without large empty remote panels', () => {
    const w = setup(1); require('../HiveMind.Economy').get = () => null; Memory.rooms.W3S47 = {};
    const layout = w.Dashboard.build(w.room); inspect(layout, w.Layout);
    assert.ok(!layout.panels.some(p => p.title === 'REMOTE OPERATIONS'));
    assert.doesNotThrow(() => w.Dashboard.run());
    assert.strictEqual(require('../Diagnostics.View').room('W99N99'), null);
});
test('OFF and the legacy disable switch perform no dashboard drawing or CPU read', () => {
    const w = setup(); let draws = 0, reads = 0;
    global.RoomVisual = class extends Visual { constructor() { super(); draws++; } };
    Game.cpu.getUsed = () => { reads++; return 0; };
    require('../HiveMind.Memory').getConfig('visuals').dashboardMode = 'OFF'; w.Dashboard.run();
    assert.strictEqual(draws, 0); assert.strictEqual(reads, 0);
    Memory.config.visuals.dashboardMode = 'NORMAL'; Memory.config.visuals.showDashboard = false;
    w.Dashboard.run(); assert.strictEqual(draws, 0);
});
test('selected-room mode and no owned rooms are safe', () => {
    const w = setup(); require('../HiveMind.Memory').getConfig('visuals').dashboardRoom = 'W99N99';
    let draws = 0; global.RoomVisual = class extends Visual { constructor() { super(); draws++; } };
    w.Dashboard.run(); assert.strictEqual(draws, 0); Game.rooms = {}; require('../HiveMind.Index').resetForTests();
    assert.doesNotThrow(() => w.Dashboard.run());
});
test('stale spawn decisions are explicitly labelled and never displayed as current', () => {
    const w = setup(); Memory.rooms.W3S47.spawn.lastDecision.tick--;
    const view = require('../Diagnostics.View').room('W3S47'); assert.strictEqual(view.spawn.current, false);
    const v = inspect(w.Dashboard.build(w.room), w.Layout);
    assert.ok(v.calls.some(c => c.text && c.text.includes('Stale @')));
});
test('compact view contains room RCL economy energy CPU and critical alerts', () => {
    const w = setup(), v = inspect(w.Dashboard.build(w.room, 'COMPACT'), w.Layout);
    const text = v.calls.filter(c => c.type === 'text').map(c => c.text).join('\n');
    for (const token of ['W3S47', 'RCL 3', 'RECOVERY', 'energy', 'CPU', 'Growth paused']) assert.ok(text.includes(token));
    assert.ok(!text.includes('RESOURCE ECONOMY'));
});
test('height exhaustion collapses low-priority panels without shrinking type', () => {
    const w = setup(); const l = w.Layout.create();
    for (let i = 0; i < 30; i++) w.Layout.add(l, 0, 'PANEL ' + i, Array(30).fill('content'), { maxRows: 9 });
    inspect(l, w.Layout); assert.ok(l.hidden > 0); assert.ok(l.panels.length < 10);
});
test('mock preview serializes the actual RoomVisual draw calls', () => {
    const w = setup(); const v = inspect(w.Dashboard.build(w.room, 'NORMAL'), w.Layout);
    const esc = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
    const scale = 18;
    const shapes = v.calls.map(c => c.type === 'rect' ? '<rect x="' + c.x * scale + '" y="' + c.y * scale + '" width="' + c.width * scale + '" height="' + c.height * scale + '" fill="' + c.style.fill + '" stroke="' + c.style.stroke + '"/>' :
        '<text x="' + c.x * scale + '" y="' + c.y * scale + '" font-size="' + parseFloat(c.style.font) * scale + '" font-family="monospace" fill="' + c.style.color + '">' + esc(c.text) + '</text>');
    fs.writeFileSync('dashboard-preview.draws.json', JSON.stringify(v.calls));
    fs.writeFileSync('dashboard-preview.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900" viewBox="0 0 900 900"><rect width="900" height="900" fill="#18201a"/>' + shapes.join('') + '</svg>');
});
console.log('Dashboard geometry cases passed: ' + passed);
