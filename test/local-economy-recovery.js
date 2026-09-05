const assert = require('assert');
const mocks = require('./mock-screeps');

function setup() {
    mocks.installGlobals();
    mocks.clearLocalModules();
    delete global.__sushiEconomy;
    global.HARVEST_POWER = 2;
    global.ENERGY_REGEN_TIME = 300;
    global.CREEP_LIFE_TIME = 1500;
    global.BODYPART_COST = { [WORK]: 100, [CARRY]: 50, [MOVE]: 50 };
    const room = { name: 'W5N8', energyAvailable: 1300, energyCapacityAvailable: 1300,
        controller: { my: true, level: 5, ticksToDowngrade: 80000 },
        storage: { id: 'storage', pos: new RoomPosition(25, 25, 'W5N8'), store: { energy: 952000 } },
        find(kind) { return kind === FIND_SOURCES ? this.sources : kind === FIND_MY_SPAWNS ? [Game.spawns.Spawn1] : []; } };
    room.sources = ['sourceA', 'sourceB'].map((id, i) => ({ id, energyCapacity: 3000, energy: 3000,
        pos: new RoomPosition(10 + i * 20, 10, room.name) }));
    Game.rooms[room.name] = room;
    Game.getObjectById = id => room.sources.find(source => source.id === id) || null;
    Memory.rooms[room.name] = { spawn: { queue: [] }, sources: Object.fromEntries(room.sources.map(source =>
        [source.id, { id: source.id, assignedMiner: [], seatCount: 2 }])) };
    Game.spawns.Spawn1 = { name: 'Spawn1', id: 'spawn', room, my: true,
        pos: new RoomPosition(24, 25, room.name), spawning: null,
        spawnCreep(body, name, options) {
            this.spawning = { name, remainingTime: body.length * 3 };
            Memory.creeps[name] = options.memory;
            return OK;
        } };
    return room;
}
function unit(room, name, role, parts, memory = {}) {
    const creep = new Creep();
    Object.assign(creep, { name, room, memory: { role, homeRoom: room.name, ...memory },
        body: parts.map(type => ({ type, hits: 100 })), ticksToLive: 1000,
        pos: room.sources.find(source => source.id === memory.sourceId)?.pos || new RoomPosition(24, 25, room.name) });
    Game.creeps[name] = creep;
    Memory.creeps[name] = creep.memory;
    return creep;
}
function request(sourceId = 'sourceA', work = 5) {
    return { role: 'Extractor', priority: 120, body: [...Array(work).fill(WORK), MOVE, CARRY],
        requestedWorkParts: work, maxWorkParts: work,
        memory: { role: 'Extractor', homeRoom: 'W5N8', sourceRoom: 'W5N8', targetRoom: 'W5N8', sourceId } };
}
function sample(room) {
    delete global.__sushiTickIndex;
    return require('HiveMind.Economy').updateRoom(room);
}
function test(name, fn) { fn(); console.log('PASS ' + name); }

test('A-E real snapshot separates queue, spawning, active WORK and income', () => {
    const room = setup();
    const economy = require('HiveMind.Economy');
    unit(room, 'foreman', 'Foreman', [CARRY, MOVE]);
    unit(room, 'hauler', 'Freighter', [...Array(24).fill(CARRY), MOVE]);
    let snapshot = sample(room);
    assert.strictEqual(snapshot.harvest.workRequired, 10);
    assert.strictEqual(snapshot.harvest.expectedIncome, 20);
    assert.strictEqual(economy.localHarvestCoverage(snapshot).status, 'MISSING');
    const queue = Memory.rooms.W5N8.spawn.queue;
    queue.push(request('sourceA'), request('sourceB'));
    snapshot = sample(room);
    let colony = require('HiveMind.ColonyState').update(room);
    assert.strictEqual(colony.localHarvest.status, 'RECOVERING');
    assert.strictEqual(colony.coreFloor.complete, false);
    assert.strictEqual(colony.growthAllowed, false);
    assert.strictEqual(colony.objective, 'RESTORE_CORE_ECONOMY');
    assert.strictEqual(economy.canSpend(room, 'controllerGrowth'), false);
    assert.strictEqual(economy.canSpend(room, 'controllerSafety'), true);
    assert.strictEqual(require('spawn.manager').runRoom(room.name).result, OK);
    snapshot = sample(room);
    assert.deepStrictEqual([snapshot.harvest.workActive, snapshot.harvest.workSpawning, snapshot.harvest.workQueued], [0, 5, 5]);
    assert.strictEqual(economy.localHarvestCoverage(snapshot).status, 'RECOVERING');
    const name = Game.spawns.Spawn1.spawning.name;
    unit(room, name, 'Extractor', [...Array(5).fill(WORK), MOVE, CARRY], Memory.creeps[name]);
    Game.spawns.Spawn1.spawning = null;
    snapshot = sample(room);
    assert.strictEqual(snapshot.harvest.actualOrEstimatedIncome, 10);
    assert.strictEqual(economy.localHarvestCoverage(snapshot).status, 'RECOVERING');
    assert.strictEqual(require('spawn.manager').runRoom(room.name).result, OK);
    const second = Game.spawns.Spawn1.spawning.name;
    unit(room, second, 'Extractor', [...Array(5).fill(WORK), MOVE, CARRY], Memory.creeps[second]);
    Game.spawns.Spawn1.spawning = null;
    for (let i = 0; i < 60; i++) { Game.time++; snapshot = sample(room); }
    colony = require('HiveMind.ColonyState').update(room);
    assert.strictEqual(colony.localHarvest.status, 'HEALTHY');
    assert.strictEqual(colony.coreFloor.complete, true);
    assert.strictEqual(colony.growthAllowed, true);
    assert.ok(['STABLE', 'SURPLUS'].includes(snapshot.state));
});

test('F recovery revalidates above role and room caps, then drops redundant source demand', () => {
    const room = setup();
    for (let i = 0; i < 30; i++) unit(room, 'worker' + i, i < 6 ? 'Extractor' : 'Artificer', [WORK, MOVE],
        i < 6 ? { remoteMining: true, sourceRoom: 'W4N8' } : {});
    sample(room);
    const arbiter = require('Spawn.Arbiter');
    const first = arbiter.admit(room.name, request(), { emergency: true, bypassRoleCap: true });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(arbiter.revalidate(room, first.request).allowed, true);
    assert.strictEqual(arbiter.admit(room.name, request('sourceB')).ok, true);
    assert.strictEqual(arbiter.admit(room.name, { ...request(), requestId: 'duplicate' }).ok, false);
    assert.strictEqual(arbiter.admit(room.name, { role: 'Artificer', body: [WORK, MOVE, CARRY], memory: { role: 'Artificer' } }).ok, false);
    assert.strictEqual(require('spawn.manager').runRoom(room.name).result, OK);
    assert.strictEqual(Memory.rooms.W5N8.spawn.lastDecision.arbiterReason, 'mandatory local economy recovery');
});

test('per-source recovery cannot use 10 WORK on source A to hide empty source B', () => {
    const room = setup();
    unit(room, 'miner', 'Extractor', [...Array(10).fill(WORK), MOVE], { sourceId: 'sourceA' });
    const snapshot = sample(room);
    assert.strictEqual(snapshot.harvest.workActive, 5);
    assert.strictEqual(snapshot.harvest.actualOrEstimatedIncome, 10);
    assert.strictEqual(require('HiveMind.Economy').localHarvestCoverage(snapshot).status, 'MISSING');
    Memory.rooms.W5N8.spawn.queue.push(request('sourceA'), request('gone'), request('sourceB'));
    assert.strictEqual(require('spawn.manager').runRoom(room.name).result, OK);
    assert.strictEqual(Memory.creeps[Game.spawns.Spawn1.spawning.name].sourceId, 'sourceB');
    assert.strictEqual(Memory.rooms.W5N8.spawn.queue.length, 0);
});

test('Economy and Colony agree at the per-source sustainable threshold', () => {
    const room = setup();
    unit(room, 'first', 'Extractor', [...Array(4).fill(WORK), MOVE], { sourceId: 'sourceA' });
    unit(room, 'second', 'Extractor', [...Array(5).fill(WORK), MOVE], { sourceId: 'sourceB' });
    const snapshot = sample(room);
    assert.strictEqual(snapshot.rawState, 'RECOVERY');
    assert.strictEqual(require('HiveMind.Economy').localHarvestCoverage(snapshot).status, 'MISSING');
});

test('G diagnostics preserve API error, selected request, body cost and revalidation reason', () => {
    const room = setup();
    sample(room);
    Memory.rooms.W5N8.spawn.queue.push(request());
    Game.spawns.Spawn1.spawnCreep = () => ERR_INVALID_ARGS;
    require('Tick.Planning').runSpawning({ rooms: { W5N8: {} } });
    const decision = Memory.rooms.W5N8.spawn.lastDecision;
    assert.strictEqual(decision.status, 'ERROR');
    assert.strictEqual(decision.result, ERR_INVALID_ARGS);
    assert.strictEqual(decision.stage, 'spawnCreep');
    assert.strictEqual(decision.bodyCost, 700);
    assert.strictEqual(decision.economyReason, 'core economy');
    assert.strictEqual(decision.selectedRole, 'Extractor');
    assert.ok(decision.selectedRequestId);
});

test('expired, malformed and unaffordable work cannot conceal the decision', () => {
    const room = setup();
    sample(room);
    const queue = Memory.rooms.W5N8.spawn.queue;
    queue.push({ ...request(), memory: {} }, request());
    room.energyAvailable = 199;
    require('spawn.manager').runRoom(room.name);
    assert.strictEqual(queue.length, 1);
    assert.strictEqual(Memory.rooms.W5N8.spawn.lastDecision.status, 'BLOCK');
    room.energyAvailable = 1300;
    assert.strictEqual(require('spawn.manager').runRoom(room.name).result, OK);
});

test('A funded RCL5 with 25 noncombat units generates and spawns a targeted local miner', () => {
    const room = setup();
    unit(room, 'foreman', 'Foreman', [CARRY, MOVE]);
    unit(room, 'hauler', 'Freighter', [...Array(24).fill(CARRY), MOVE]);
    for (let i = 0; i < 23; i++) unit(room, 'worker' + i, 'Artificer', [WORK, CARRY, MOVE]);
    sample(room);
    require('HiveMind.ColonyState').run();
    require('spawn.request.manager').runForRoom(room);
    const queue = Memory.rooms.W5N8.spawn.queue;
    assert.ok(queue.some(item => item.role === 'Extractor' && item.memory.sourceId === 'sourceA'));
    assert.strictEqual(require('spawn.manager').runRoom(room.name).result, OK);
});

test('only missing source WORK receives the temporary bypass, including replacement handoff', () => {
    const room = setup();
    unit(room, 'partial', 'Extractor', [...Array(4).fill(WORK), MOVE], { sourceId: 'sourceA' });
    sample(room);
    Memory.rooms.W5N8.spawn.queue.push(request());
    assert.strictEqual(require('spawn.manager').runRoom(room.name).result, OK);
    assert.strictEqual(Memory.rooms.W5N8.spawn.lastDecision.work, 1);
    Game.spawns.Spawn1.spawning = null;
    Game.creeps.partial.ticksToLive = 10;
    sample(room);
    const replacement = require('Spawn.Arbiter').admit(room.name, request());
    assert.strictEqual(replacement.ok, true);
    assert.strictEqual(require('Spawn.Arbiter').revalidate(room, replacement.request).allowed, true);
});

test('critical local hauling gets a bounded bypass and normal policy resumes once covered', () => {
    const room = setup();
    for (let i = 0; i < 30; i++) unit(room, 'worker' + i, 'Artificer', [WORK, MOVE]);
    sample(room);
    const hauler = { role: 'Freighter', body: [...Array(24).fill(CARRY), MOVE],
        memory: { role: 'Freighter', homeRoom: room.name } };
    const arbiter = require('Spawn.Arbiter');
    const first = arbiter.admit(room.name, hauler);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(arbiter.revalidate(room, first.request).allowed, true);
    assert.strictEqual(arbiter.admit(room.name, { ...hauler, requestId: 'extra' }).ok, false);
});

test('name exhaustion, role cap and expiration have explicit diagnostics', () => {
    const room = setup();
    sample(room);
    Memory.rooms.W5N8.spawn.queue.push(request());
    for (let i = 1; i <= 100; i++) Memory.creeps['Extractor_' + String(i).padStart(3, '0')] = { role: 'Extractor' };
    const manager = require('spawn.manager');
    assert.strictEqual(manager.runRoom(room.name).result, ERR_NAME_EXISTS);
    assert.strictEqual(Memory.rooms.W5N8.spawn.lastDecision.stage, 'name');
    assert.match(Memory.rooms.W5N8.spawn.lastDecision.reason, /No free creep name/);
    Memory.rooms.W5N8.spawn.queue[0].expiresAt = Game.time - 1;
    manager.runRoom(room.name);
    assert.strictEqual(Memory.rooms.W5N8.spawn.lastDecision.reason, 'request expired');
});

test('a baseline Tech still upgrades during downgrade danger while growth is paused', () => {
    const room = setup();
    room.controller.ticksToDowngrade = 1000;
    room.controller.pos = new RoomPosition(24, 25, room.name);
    const tech = unit(room, 'tech', 'Tech', [WORK, CARRY, MOVE], { controllerGrowthFloor: true, upgrading: true });
    tech.store = { energy: 50, getUsedCapacity: () => 50, getFreeCapacity: () => 0 };
    let upgraded = false;
    tech.upgradeController = () => { upgraded = true; return OK; };
    sample(room);
    require('HiveMind.ColonyState').update(room);
    assert.strictEqual(Memory.rooms.W5N8.colony.growthAllowed, false);
    require('role.Tech').run(tech);
    assert.strictEqual(upgraded, true);
});
