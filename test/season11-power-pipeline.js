const assert = require('assert');
const path = require('path');
const mocks = require('./mock-screeps');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
function fresh(file) {
    const resolved = path.join(mocks.root, file);
    delete require.cache[require.resolve(resolved)];
    return require(resolved);
}
function reset() {
    mocks.installGlobals({ limit: 100, tickLimit: 500, bucket: 10000, getUsed: () => 0 });
    Game.gcl = { level: 2, progress: 0, progressTotal: 1000 };
    Game.gpl = { level: 0, progress: 0, progressTotal: 1000 };
    global.RESOURCE_THORIUM = 'T';
    global.FIND_REACTORS = 'findReactors';
    global.RESOURCE_POWER = 'power';
    global.STRUCTURE_POWER_BANK = 'powerBank';
    global.STRUCTURE_POWER_SPAWN = 'powerSpawn';
    mocks.clearLocalModules();
}
function homeRoom() {
    const room = {
        name: 'W1N1', controller: { my: true, owner: { username: 'Sushi' }, level: 8 },
        energyAvailable: 3000, energyCapacityAvailable: 3000,
        find: constant => constant === FIND_STRUCTURES ? [] : []
    };
    Game.rooms[room.name] = room;
    Game.spawns.Spawn1 = { my: true, room };
    Memory.rooms[room.name] = { scoutIntel: { sourceCount: 2 } };
    return room;
}
function thoriumCandidate(Season11, options = {}) {
    const name = options.name || 'W2N2';
    Memory.rooms[name] = { scoutIntel: { sourceCount: options.sources === undefined ? 2 : options.sources } };
    Season11.ensureMemory().rooms[name] = {
        roomName: name, lastSeen: options.stale ? Game.time - 100000 : Game.time,
        controllerOwner: null, controllerReservation: null,
        hostileCreeps: options.hostile ? 1 : 0, hostileStructures: 0,
        threatParts: options.hostile ? 5 : 0,
        thorium: { id: `mineral:${name}`, remaining: options.remaining || 30000,
            density: options.density || 2, depleted: false }
    };
}
function miningWorld(level, structures, sites) {
    reset(); const home = homeRoom();
    home.storage = { id: 'homeStorage', store: { getUsedCapacity: type => type === RESOURCE_ENERGY ? 100000 : 0 } };
    for (const role of ['Foreman', 'Extractor', 'Freighter']) {
        Game.creeps[role] = { name: role, memory: { role, homeRoom: home.name }, room: home,
            body: [], ticksToLive: 1000, spawning: false };
    }
    const mineral = { id: 'mineral:W2N2', mineralType: 'T', mineralAmount: 30000,
        density: 2, pos: new RoomPosition(20, 20, 'W2N2') };
    mineral.pos.lookFor = type => type === LOOK_STRUCTURES ? structures : [];
    mineral.pos.findClosestByRange = list => list[0] || null;
    const target = { name: 'W2N2', controller: { my: true, level },
        find: constant => constant === FIND_STRUCTURES ? structures :
            constant === FIND_CONSTRUCTION_SITES ? sites : [] };
    Game.rooms[target.name] = target;
    Game.getObjectById = id => id === mineral.id ? mineral :
        structures.concat(sites).find(item => item.id === id) || null;
    mocks.clearLocalModules();
    const Economy = fresh('HiveMind.Economy.js'); Economy.canSpend = () => true;
    const Season11 = fresh('Logic.Season11.js');
    const memory = Season11.ensureMemory();
    memory.rooms.W2N2 = { roomName: 'W2N2', lastSeen: Game.time, controllerMy: true,
        controllerOwner: 'Sushi', controllerReservation: null, hostileCreeps: 0,
        hostileStructures: 0, threatParts: 0,
        thorium: { id: mineral.id, remaining: 30000, density: 2, depleted: false } };
    memory.reactors.R1 = { id: 'R1', roomName: 'W3N3', lastSeen: Game.time, thorium: 0, continuousWork: 0 };
    Season11.plan(true);
    return { Season11, assignment: Season11.ensureMemory().assignments.mining.W2N2, home, target, mineral };
}

test('high-value neutral Thorium nominates Expansion', () => {
    reset(); const home = homeRoom(); const Season11 = fresh('Logic.Season11.js');
    thoriumCandidate(Season11);
    const nomination = Season11.getExpansionNomination();
    assert.strictEqual(nomination.roomName, 'W2N2');
    assert.strictEqual(nomination.originRoom, home.name);
    assert.ok(nomination.reason.includes('exceeds'));
});

test('manual Expansion target overrides Season nomination', () => {
    reset(); const home = homeRoom(); const Season11 = fresh('Logic.Season11.js');
    thoriumCandidate(Season11);
    Memory.rooms.W3N3 = { scoutIntel: { sourceCount: 2 } };
    const Expansion = fresh('Logic.Expansion.js');
    const memory = Expansion.ensureExpansionMemory();
    memory.targetRoom = 'W3N3'; memory.state = 'selectTarget'; memory.minRangeBetweenBases = 0;
    const selected = Expansion.chooseExpansionTarget(memory, [home]);
    assert.ok(selected, JSON.stringify(memory.candidates.W3N3));
    assert.strictEqual(selected.roomName, 'W3N3');
    assert.strictEqual(selected.season11, undefined);
});

test('active Expansion remains committed instead of thrashing', () => {
    reset(); homeRoom(); const Season11 = fresh('Logic.Season11.js'); thoriumCandidate(Season11);
    const Expansion = fresh('Logic.Expansion.js'); const memory = Expansion.ensureExpansionMemory();
    memory.targetRoom = 'W3N3'; memory.originRoom = 'W1N1'; memory.state = 'claiming';
    Expansion.run();
    assert.strictEqual(memory.targetRoom, 'W3N3');
});

test('unsafe and stale Thorium cannot nominate expansion', () => {
    reset(); homeRoom(); let Season11 = fresh('Logic.Season11.js');
    thoriumCandidate(Season11, { hostile: true });
    assert.strictEqual(Season11.getExpansionNomination(), null);
    reset(); homeRoom(); Season11 = fresh('Logic.Season11.js');
    thoriumCandidate(Season11, { stale: true });
    assert.strictEqual(Season11.getExpansionNomination(), null);
});

test('low-value Thorium stays below nomination threshold', () => {
    reset(); homeRoom(); const Season11 = fresh('Logic.Season11.js');
    thoriumCandidate(Season11, { remaining: 100 });
    assert.strictEqual(Season11.getExpansionNomination(), null);
    assert.strictEqual(Season11.ensureMemory().expansionNomination.rejectionReason, 'INSUFFICIENT_THORIUM');
});

test('owned sub-RCL6 Thorium room reports WAITING_RCL6', () => {
    const world = miningWorld(5, [], []);
    assert.strictEqual(world.assignment.state, 'WAITING_RCL6');
    assert.strictEqual(world.assignment.ready, false);
});

test('RCL6 missing extractor wakes the existing structure planner', () => {
    const world = miningWorld(6, [], []);
    assert.strictEqual(world.assignment.state, 'PLANNING_EXTRACTOR');
    assert.strictEqual(Memory.rooms.W2N2.structurePlanner.forceReplan, true);
    assert.strictEqual(Memory.rooms.W2N2.season11Infrastructure.missing, 'extractor');
});

test('extractor construction site is not mining-ready', () => {
    const site = { id: 'extractorSite', structureType: STRUCTURE_EXTRACTOR,
        pos: new RoomPosition(20, 20, 'W2N2') };
    const world = miningWorld(6, [], [site]);
    assert.strictEqual(world.assignment.state, 'BUILDING_EXTRACTOR');
    assert.strictEqual(world.assignment.ready, false);
});

test('Season strategy adds only a bounded Expansion modifier', () => {
    reset(); const home = homeRoom(); const Season11 = fresh('Logic.Season11.js');
    Season11.setMode('auto'); thoriumCandidate(Season11, { name: 'W4N3', remaining: 50000 });
    const nomination = Season11.getExpansionNomination();
    assert.ok(nomination, JSON.stringify(Season11.ensureMemory().expansionNomination));
    const Expansion = fresh('Logic.Expansion.js'); const memory = Expansion.ensureExpansionMemory();
    memory.minRangeBetweenBases = 0; memory.maxRouteDistance = 20;
    const selected = Expansion.chooseExpansionTarget(memory, [home]);
    assert.ok(selected, JSON.stringify({ nomination, candidates: memory.candidates }));
    const diagnostics = memory.candidates.W4N3;
    assert.ok(Number.isFinite(diagnostics.baseEconomicScore));
    assert.ok(diagnostics.strategyRawValue >= 50000);
    assert.ok(diagnostics.strategyModifier > 0 && diagnostics.strategyModifier <= 80);
    assert.strictEqual(diagnostics.finalScore,
        diagnostics.baseEconomicScore + diagnostics.resourceStrategicValue + diagnostics.strategyModifier);
});

test('Season strategy mildly biases unknown northern scouting only', () => {
    reset(); homeRoom(); const Strategy = fresh('Strategy.Provider.js');
    assert.ok(Strategy.getScoutModifier({ roomName: 'W8N20', unknown: true }) >
        Strategy.getScoutModifier({ roomName: 'W8S20', unknown: true }));
    assert.strictEqual(Strategy.getScoutModifier({ roomName: 'W8N20', unknown: false }), 0);
    assert.strictEqual(Strategy.getScoutModifier({ roomName: 'W8N20', unknown: true, urgent: true }), 0);
    assert.strictEqual(global.__sushiSeason11ScoutBias.reason, 'SEASON11_UPPER_WORLD_BIAS');
});

test('Thorium staging rejects unrelated sites and plans but accepts a nearby site', () => {
    const extractor = { id: 'extractor', structureType: STRUCTURE_EXTRACTOR,
        pos: new RoomPosition(20, 20, 'W2N2'), isActive: () => true };
    let site = { id: 'sourceSite', structureType: STRUCTURE_CONTAINER,
        pos: new RoomPosition(10, 10, 'W2N2') };
    let world = miningWorld(6, [extractor], [site]);
    assert.strictEqual(world.assignment.state, 'PLANNING_STAGING');
    Memory.rooms.W2N2.structurePlanner.plan = { positions: { [STRUCTURE_CONTAINER]: [{ x: 25, y: 25 }] } };
    assert.strictEqual(world.Season11.planHasStructure('W2N2', STRUCTURE_CONTAINER, world.mineral), false);
    Memory.rooms.W2N2.structurePlanner.plan.positions[STRUCTURE_CONTAINER] = [{ x: 22, y: 20 }];
    assert.strictEqual(world.Season11.planHasStructure('W2N2', STRUCTURE_CONTAINER, world.mineral), true);
    site = { id: 'mineralSite', structureType: STRUCTURE_CONTAINER,
        pos: new RoomPosition(22, 20, 'W2N2') };
    world = miningWorld(6, [extractor], [site]);
    assert.strictEqual(world.assignment.state, 'BUILDING_STAGING');
});

test('Thorium staging rejects distant containers and Storage, but accepts nearby Storage', () => {
    const mineral = { pos: new RoomPosition(20, 20, 'W2N2') };
    reset();
    let room = { name: 'W2N2', storage: { id: 'farStorage', my: true,
        pos: new RoomPosition(25, 25, 'W2N2'), store: {} }, find: () => [] };
    Game.rooms.W2N2 = room; delete global.__sushiTickIndex;
    let Season11 = fresh('Logic.Season11.js');
    assert.strictEqual(Season11.findStagingStructure(room, mineral), null);
    room.storage = { id: 'nearStorage', my: true, pos: new RoomPosition(22, 20, 'W2N2'), store: {} };
    delete global.__sushiTickIndex;
    assert.strictEqual(Season11.findStagingStructure(room, mineral).id, 'nearStorage');
    const farContainer = { id: 'sourceContainer', structureType: STRUCTURE_CONTAINER,
        pos: new RoomPosition(10, 10, 'W2N2'), store: {} };
    room.storage = null; room.find = kind => kind === FIND_STRUCTURES ? [farContainer] : [];
    delete global.__sushiTickIndex; Season11 = fresh('Logic.Season11.js');
    assert.strictEqual(Season11.findStagingStructure(room, mineral), null);
});

test('completed extractor and staging produce exactly one miner demand', () => {
    const extractor = { id: 'extractor', structureType: STRUCTURE_EXTRACTOR,
        pos: new RoomPosition(20, 20, 'W2N2'), isActive: () => true };
    const container = { id: 'container', structureType: STRUCTURE_CONTAINER,
        pos: new RoomPosition(21, 20, 'W2N2'), store: { getUsedCapacity: () => 0, getFreeCapacity: () => 2000 } };
    const world = miningWorld(6, [extractor, container], []);
    assert.strictEqual(world.assignment.state, 'READY');
    assert.strictEqual(world.assignment.ready, true);
    world.Season11.ensureMemory().reactorPortfolio.reactors.R1 = {
        reactorId: 'R1', active: true, assignedMiningRooms: ['W2N2'], startup: { reserve: 500 }
    };
    const miners = world.Season11.getSpawnPlanForRoom(world.home).filter(plan => plan.role === 'ThoriumMiner');
    assert.strictEqual(miners.length, 1);
    assert.strictEqual(miners[0].desired, 1);
    world.Season11.setMode('auto');
    delete global.__sushiStrategyActive;
    const plans = fresh('Strategy.Provider.js').getSpecialSpawnPlans(world.home);
    const minerPlan = plans.find(plan => plan.role === 'ThoriumMiner');
    assert.ok(minerPlan && minerPlan.body.length > 0);
    for (const field of ['priority', 'originRoom', 'targetRoom', 'assignmentKey',
        'replacementBuffer', 'travelLeadTicks', 'validUntil', 'reason', 'memory',
        'economyCategory', 'strategyProvider', 'strategyCategory']) assert.notStrictEqual(minerPlan[field], undefined);
});

test('Power Bank intel persists and expires as plain data', () => {
    reset(); homeRoom(); const bank = { id: 'PB1', structureType: STRUCTURE_POWER_BANK,
        power: 4000, hits: 2000000, hitsMax: 2000000, ticksToDecay: 1000,
        pos: new RoomPosition(20, 20, 'W2N2') };
    const room = { name: 'W2N2', find: constant => constant === FIND_STRUCTURES ? [bank] : [] };
    Game.rooms.W2N2 = room;
    const Intel = fresh('Power.Intel.js'); Intel.observeRoom(room);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(Intel.state().banks.PB1)).id, 'PB1');
    Game.time = 1101; assert.strictEqual(Intel.cleanup(true), 1);
});

test('impossible Power Bank raid is rejected', () => {
    reset(); const Operations = fresh('Power.Operations.js');
    const result = Operations.evaluate({ hits: 2000000, ticksToDecay: 200,
        power: 5000, homeRoom: 'W1N1', routeDistance: 5, threat: { hostileCreeps: 0 } });
    assert.strictEqual(result.viable, false);
    assert.strictEqual(result.reason, 'CANNOT_KILL_BEFORE_DECAY');
});

test('viable Power Bank computes attack heal and haul capacity', () => {
    reset(); const Operations = fresh('Power.Operations.js');
    const result = Operations.evaluate({ hits: 500000, ticksToDecay: 5000,
        power: 4000, homeRoom: 'W1N1', routeDistance: 2, threat: { hostileCreeps: 0 } });
    assert.strictEqual(result.viable, true);
    assert.ok(result.attackers >= 1 && result.healers >= 1 && result.haulers >= 1);
    assert.ok(result.haulCapacity >= 4000);
});

test('Power Spawn processes when supplied and policy permits', () => {
    reset(); const room = homeRoom(); let calls = 0;
    const spawn = { id: 'PS1', structureType: STRUCTURE_POWER_SPAWN, my: true,
        isActive: () => true, processPower: () => { calls++; return OK; },
        store: { getUsedCapacity: type => type === RESOURCE_POWER ? 1 : 50 } };
    room.find = constant => constant === FIND_STRUCTURES ? [spawn] : [];
    const Economy = fresh('HiveMind.Economy.js'); Economy.canSpend = () => true;
    const Manager = fresh('Power.Manager.js');
    assert.strictEqual(Manager.processRoom(room), OK);
    assert.strictEqual(calls, 1);
});

test('Power Spawn obeys economy processing gate', () => {
    reset(); const room = homeRoom(); let calls = 0;
    const spawn = { id: 'PS1', structureType: STRUCTURE_POWER_SPAWN, isActive: () => true,
        processPower: () => { calls++; return OK; }, store: { getUsedCapacity: () => 100 } };
    room.find = constant => constant === FIND_STRUCTURES ? [spawn] : [];
    const Economy = fresh('HiveMind.Economy.js'); Economy.canSpend = () => false;
    const Manager = fresh('Power.Manager.js'); Manager.processRoom(room);
    assert.strictEqual(calls, 0);
});

test('Power Creep auto-create defaults off', () => {
    reset(); const Manager = fresh('Power.Manager.js');
    assert.strictEqual(Manager.managePowerCreep().state, 'AUTO_CREATE_DISABLED');
});

test('configured Power Creep creation requires free GPL', () => {
    reset(); let creates = 0; homeRoom();
    POWER_CLASS = { OPERATOR: 'operator' };
    PowerCreep.create = () => { creates++; return OK; };
    const MemoryApi = fresh('HiveMind.Memory.js');
    MemoryApi.getConfig('power').powerCreeps.autoCreate = true;
    const Manager = fresh('Power.Manager.js');
    Game.gpl.level = 0; Manager.managePowerCreep(); assert.strictEqual(creates, 0);
    Game.gpl.level = 1; Manager.managePowerCreep(); assert.strictEqual(creates, 1);
});

test('unspawned configured Power Creep selects owned active Power Spawn', () => {
    reset(); const room = homeRoom(); let selected = null;
    const spawn = { id: 'PS1', structureType: STRUCTURE_POWER_SPAWN, isActive: () => true,
        store: { getUsedCapacity: () => 0, getFreeCapacity: () => 2000 } };
    room.find = constant => constant === FIND_STRUCTURES ? [spawn] : [];
    Game.powerCreeps.SushiOperator = { ticksToLive: 0, spawn: target => { selected = target; return OK; } };
    const Economy = fresh('HiveMind.Economy.js'); Economy.canSpend = () => true;
    const MemoryApi = fresh('HiveMind.Memory.js'); MemoryApi.getConfig('power').powerCreeps.autoCreate = true;
    const Manager = fresh('Power.Manager.js'); Manager.managePowerCreep();
    assert.strictEqual(selected, spawn);
});

test('normal shards remain safe without seasonal and Power APIs', () => {
    reset(); delete global.RESOURCE_THORIUM; delete global.FIND_REACTORS;
    delete global.RESOURCE_POWER; delete global.STRUCTURE_POWER_BANK; delete global.STRUCTURE_POWER_SPAWN;
    assert.doesNotThrow(() => fresh('Logic.Season11.js').run());
    assert.doesNotThrow(() => fresh('Power.Intel.js').scanVisible());
    assert.doesNotThrow(() => fresh('Power.Manager.js').plan());
});

console.log(`Season 11 + Power pipeline tests passed: ${passed}`);
