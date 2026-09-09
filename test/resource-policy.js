const assert = require('assert');
const path = require('path');
const mocks = require('./mock-screeps');

let passed = 0;
function test(name, fn) {
    fn();
    passed++;
    console.log(`PASS ${name}`);
}

function fresh(file) {
    const resolved = path.join(mocks.root, file);
    delete require.cache[require.resolve(resolved)];
    return require(resolved);
}

function reset() {
    mocks.installGlobals({ limit: 100, tickLimit: 500, bucket: 10000, getUsed: () => 0 });
    Object.assign(global, {
        FIND_STRUCTURES: 1,
        FIND_MINERALS: 2,
        FIND_CONSTRUCTION_SITES: 3,
        FIND_HOSTILE_CREEPS: 4,
        FIND_HOSTILE_POWER_CREEPS: 5,
        FIND_MY_POWER_CREEPS: 6,
        FIND_MY_CREEPS: 7,
        STRUCTURE_EXTRACTOR: 'extractor',
        STRUCTURE_CONTAINER: 'container',
        STRUCTURE_STORAGE: 'storage',
        STRUCTURE_TERMINAL: 'terminal',
        STRUCTURE_LINK: 'link',
        STRUCTURE_LAB: 'lab',
        STRUCTURE_OBSERVER: 'observer',
        LAB_REACTION_AMOUNT: 5,
        LAB_BOOST_MINERAL: 30,
        LAB_BOOST_ENERGY: 20,
        RESOURCE_POWER: 'power',
        REACTIONS: { H: { O: 'OH' }, U: { L: 'UL', H: 'UH' }, Z: { K: 'ZK' }, ZK: { UL: 'G' }, UH: { OH: 'UH2O' }, X: { UH2O: 'XUH2O' } }
    });
    delete global.__sushiDemandBoard;
    delete global.__sushiResourceJobs;
    mocks.clearLocalModules();
}

function pos(x, y, roomName = 'W1N1') {
    return new RoomPosition(x, y, roomName);
}

function store(values = {}, capacity = 10000) {
    const result = { ...values };
    Object.defineProperties(result, {
        getUsedCapacity: { enumerable: false, value(resourceType) {
            if (resourceType) return this[resourceType] || 0;
            return Object.keys(this).reduce((sum, key) => sum + (typeof this[key] === 'number' ? this[key] : 0), 0);
        } },
        getFreeCapacity: { enumerable: false, value(resourceType) {
            return Math.max(0, capacity - this.getUsedCapacity(resourceType));
        } }
    });
    return result;
}

function makeRoom(name, options = {}) {
    const structures = options.structures || [];
    const minerals = options.minerals || [];
    const result = {
        name,
        controller: options.controller || { my: true, level: 8 },
        energyAvailable: options.energyAvailable === undefined ? 3000 : options.energyAvailable,
        energyCapacityAvailable: options.energyCapacityAvailable || 3000,
        storage: options.storage || null,
        terminal: options.terminal || null,
        find(type) {
            if (type === FIND_STRUCTURES) return structures;
            if (type === FIND_MINERALS) return minerals;
            if (type === FIND_MY_CREEPS) return Object.values(Game.creeps).filter(creep => creep.room === result);
            return [];
        }
    };
    for (const object of structures.concat(minerals)) if (object && object.pos) object.pos.roomName = name;
    for (const structure of [result.storage, result.terminal]) if (structure && !structures.includes(structure)) structures.push(structure);
    Game.rooms[name] = result;
    Memory.rooms[name] = Memory.rooms[name] || { spawn: { queue: [] } };
    return result;
}

function mineral(id = 'mineral', amount = 5000, type = 'H', x = 10, y = 10) {
    return { id, mineralAmount: amount, mineralType: type, pos: pos(x, y), ticksToRegeneration: amount ? null : 1000 };
}

function structure(id, structureType, x, y, values = {}, capacity = 10000) {
    return { id, structureType, my: true, pos: pos(x, y), store: store(values, capacity), cooldown: 0 };
}

function installObjectLookup(objects) {
    const map = new Map(objects.filter(Boolean).map(object => [object.id, object]));
    Game.getObjectById = id => map.get(id) || null;
}

function courier(name, courierRoom, capacity = 100) {
    const result = new Creep();
    Object.assign(result, {
        id: name, name, room: courierRoom, pos: pos(20, 20, courierRoom.name), spawning: false,
        memory: { role: 'ResourceCourier', homeRoom: courierRoom.name },
        body: [{ type: CARRY, hits: 100 }, { type: MOVE, hits: 100 }], ticksToLive: 1000,
        store: store({}, capacity),
        withdraw(source, resourceType, requested) {
            const quantity = Math.min(requested || capacity, source.store[resourceType] || 0, capacity);
            if (!quantity) return ERR_NOT_ENOUGH_ENERGY;
            source.store[resourceType] -= quantity;
            this.store[resourceType] = (this.store[resourceType] || 0) + quantity;
            return OK;
        },
        transfer(target, resourceType) {
            const quantity = this.store[resourceType] || 0;
            if (!quantity) return ERR_NOT_ENOUGH_ENERGY;
            target.store[resourceType] = (target.store[resourceType] || 0) + quantity;
            this.store[resourceType] = 0;
            return OK;
        }
    });
    Game.creeps[name] = result;
    return result;
}


function setup(type = 'U', quantity = 0, options = {}) {
    reset();
    const node = mineral('mineral', 12000, type);
    const vault = structure('storage', 'storage', 20, 20, { [type]: quantity, energy: 100000 }, options.capacity || 1000000);
    const terminal = structure('terminal', 'terminal', 21, 20, { energy: 30000 }, 300000);
    terminal.send = () => OK;
    const staging = structure('stage', 'container', 11, 10, {}, 2000);
    const extractor = structure('extractor', 'extractor', 10, 10);
    const structures = [vault, terminal, staging, extractor];
    const room = makeRoom('W1N1', { storage: vault, terminal, minerals: [node], structures });
    installObjectLookup(structures.concat(node));
    const Policy = fresh('Resource.Policy.js'), Hive = fresh('HiveMind.Memory.js');
    return { Policy, hive: Hive.ensure(), room, vault, terminal, staging, node, structures };
}
function refresh(ctx) { Game.time += 11; delete global.__sushiTickIndex; return ctx.Policy.snapshot(true); }
function second(ctx, values = {}, withLabs = false) {
    const vault = structure('storage2', 'storage', 20, 20, { energy: 100000, ...values }, 1000000);
    const terminal = structure('terminal2', 'terminal', 21, 20, { energy: 30000 }, 300000);
    terminal.send = () => OK;
    const structures = [vault, terminal];
    if (withLabs) structures.push(structure('la', 'lab', 10, 10), structure('lb', 'lab', 11, 10), structure('lc', 'lab', 10, 11));
    const room = makeRoom('W2N2', { storage: vault, terminal, structures });
    installObjectLookup(ctx.structures.concat(structures, ctx.node));
    delete global.__sushiTickIndex;
    return room;
}

test('below low starts mining and emits through DemandBoard', () => {
    const c = setup('U', 7000), M = fresh('Resource.Minerals.js');
    const state = M.observe(c.room); assert.strictEqual(state.mineral.reasonCode, 'MINING_RESOURCE_DEFICIT');
    assert.ok(M.emitDemands(c.room, state).some(d => d.role === 'MineralMiner'));
});
test('high stops replacement demand immediately; cargo is deposited', () => {
    const c = setup('U', 7000), M = fresh('Resource.Minerals.js');
    M.emitDemands(c.room, M.observe(c.room)); c.vault.store.U = 28000; refresh(c);
    const state = M.observe(c.room); M.emitDemands(c.room, state);
    assert.strictEqual(state.mineral.reasonCode, 'PAUSED_TARGET_REACHED');
    assert.ok(!fresh('Spawn.DemandBoard.js').getDemands().some(d => d.role === 'MineralMiner'));
    const creep = new Creep(); Object.assign(creep, { room: c.room, memory: { mineralId: c.node.id }, store: store({ U: 20 }, 50),
        transfer(target) { this.store.U = 0; target.store.U = 20; return OK; }, harvest() { throw Error('paused miner harvested'); } });
    c.node.pos.findInRange = () => [c.staging]; fresh('role.MineralMiner.js').run(creep);
    assert.strictEqual(c.staging.store.U, 20);
});
test('hysteresis ignores small movements and resumes below low', () => {
    const c = setup('U', 28000); c.Policy.snapshot(); c.vault.store.U = 24950; refresh(c);
    assert.strictEqual(c.Policy.extraction(c.room, 'U').allowed, false);
    c.vault.store.U = 7000; refresh(c); assert.strictEqual(c.Policy.extraction(c.room, 'U').allowed, true);
    c.vault.store.U = 16000; refresh(c); assert.strictEqual(c.Policy.extraction(c.room, 'U').allowed, true);
});
test('reaction demand raises raw target using actual missing compound', () => {
    const c = setup('U', 3200); fresh('Resource.Labs.js').configureReaction(c.room.name, 'UH', 8400);
    const r = c.Policy.snapshot().resources.U; assert.strictEqual(r.demandAmount, 8400); assert.strictEqual(r.targetLow, 16400);
});
test('boost reservation and matching reaction goal are not counted twice', () => {
    const c = setup('U', 3200), L = fresh('Resource.Labs.js');
    L.requestBoost('squad', c.room.name, { a: [{ compound: 'UH', parts: 100 }] });
    L.configureReaction(c.room.name, 'UH', 3750);
    const r = c.Policy.snapshot().resources; assert.strictEqual(r.UH.demandAmount, 3750); assert.strictEqual(r.U.demandAmount, 3750);
});
test('existing intermediate inventory reduces raw production requirements once', () => {
    const c = setup(); c.vault.store.UH = 500;
    fresh('Resource.Labs.js').configureReaction(c.room.name, 'UH', 1000);
    assert.strictEqual(c.Policy.snapshot().resources.U.demandAmount, 500);
});
test('X defaults are larger and all stock targets are configurable', () => {
    const c = setup('X', 4000); let r = c.Policy.snapshot().resources.X;
    assert.deepStrictEqual([r.targetLow, r.targetDesired, r.targetHigh], [15000, 25000, 40000]);
    Memory.config.resources.policy = { stockTargets: { X: { resumeBelow: 1, desired: 2, pauseAbove: 3 } } };
    r = refresh(c).resources.X; assert.strictEqual(r.targetHigh, 3);
});
test('storage pressure blocks mining without deleting or dropping stock', () => {
    const c = setup('U', 7000, { capacity: 150000 });
    const before = JSON.stringify(c.vault.store); assert.strictEqual(c.Policy.extraction(c.room, 'U').reason, 'PAUSED_STORAGE_PRESSURE');
    assert.strictEqual(JSON.stringify(c.vault.store), before); assert.strictEqual(c.Policy.capacity(c.room).reservedFree, 100000);
});
function season(c) {
    global.RESOURCE_THORIUM = 'T'; global.FIND_REACTORS = 10051; Creep.prototype.claimReactor = () => OK;
    const S = fresh('Logic.Season11.js'), memory = S.ensureMemory(); memory.mode = 'active';
    const a = { key: 'mine:W1N1', roomName: 'W1N1', homeRoom: 'W1N1', remaining: 12000, ready: true, mineralId: c.node.id, stagingId: c.staging.id };
    memory.assignments.mining.W1N1 = a;
    return { S, memory, a, R: fresh('Season11.ResourcePolicy.js') };
}
test('finite Thorium ignores raw high water marks', () => {
    const c = setup('T', 25000), s = season(c);
    assert.strictEqual(s.R.assess(s.a, s.memory).reason, 'FINITE_RESOURCE'); assert.strictEqual(s.S.shouldPauseMining('W1N1'), false);
});
test('Thorium pauses for true SURVIVAL', () => {
    const c = setup('T', 25000), s = season(c); Memory.rooms.W1N1.economy = { state: 'SURVIVAL' };
    assert.strictEqual(s.R.assess(s.a, s.memory).reason, 'PAUSED_SURVIVAL');
});
test('generic mineral pipeline never owns Thorium', () => {
    const c = setup('T', 0); season(c); const M = fresh('Resource.Minerals.js'), state = M.observe(c.room);
    assert.strictEqual(state.mineral.active, false); assert.deepStrictEqual(M.emitDemands(c.room, state), []); assert.deepStrictEqual(M.jobs(c.room, state), []);
});
test('250 plus 5 per tick times 60 predicts 550 and dispatches now', () => {
    const c = setup('T', 0), s = season(c);
    assert.deepStrictEqual(s.R.prediction(250, 5, 60), { currentStaging: 250, miningRate: 5, haulerETA: 60, expectedAtArrival: 550, urgent: true });
    c.staging.store.T = 250; s.a.observedHarvestRate = 5;
    const plans = s.R.reservePlans(c.room, s.memory, () => ({ requestedCarryParts: 2, memory: {}, assignmentKey: 'haul:test' }), () => 0);
    assert.strictEqual(plans.length, 1); assert.ok(plans[0].desired >= 1);
});
test('unowned Reactor diverts cargo to owned Storage', () => {
    const c = setup('T', 0), s = season(c); let delivered = null;
    const reactor = structure('enemy', 'reactor', 22, 20, {}, 1000); reactor.my = false;
    installObjectLookup(c.structures.concat(c.node, reactor));
    s.memory.reactors.enemy = { id: 'enemy', my: false, roomName: 'W1N1' };
    const creep = { room: c.room, pos: pos(20, 20), memory: { role: 'ThoriumHauler', season11SourceRoom: 'W1N1', season11StagingId: c.staging.id, season11ReactorId: 'enemy' }, store: store({ T: 100 }), transfer(target) { delivered = target.id; return OK; } };
    fresh('role.ThoriumHauler.js').run(creep); assert.strictEqual(delivered, c.vault.id);
});
test('missing Reactor and staging still preserve carried Thorium in Storage', () => {
    const c = setup('T', 0); season(c); let delivered;
    const creep = { room: c.room, pos: pos(20, 20), memory: { season11SourceRoom: 'W1N1' }, store: store({ T: 100 }), transfer(target) { delivered = target.id; return OK; } };
    fresh('role.ThoriumHauler.js').run(creep); assert.strictEqual(delivered, c.vault.id);
});
test('terminals do not distribute raw minerals for symmetry', () => {
    const c = setup('U', 50000); second(c); c.terminal.store.U = 10000;
    fresh('Resource.Terminals.js').planBalance(); assert.deepStrictEqual(c.hive.resources.transfers, {});
});
test('active reaction shortage stages owned terminal transfer from Storage', () => {
    const c = setup('U', 20000), room2 = second(c); fresh('Resource.Labs.js').configureReaction(room2.name, 'UH', 500);
    const T = fresh('Resource.Terminals.js'); T.planBalance();
    assert.ok(c.hive.resources.transfers['terminal:W1N1:W2N2:U']);
    assert.ok(T.jobs(c.room).some(j => j.resourceType === 'U' && j.sourceId === c.vault.id && j.targetId === c.terminal.id));
});
test('boost shortage triggers transfer and reverse sends observe cooldown', () => {
    const c = setup('UH', 5000), room2 = second(c); c.terminal.store.UH = 500;
    fresh('Resource.Labs.js').requestBoost('s', room2.name, { a: [{ compound: 'UH', parts: 10 }] });
    const T = fresh('Resource.Terminals.js'); T.planBalance(); const report = T.run(); assert.ok(report.some(r => r.result === OK));
    room2.terminal.store.UH = 500;
    assert.strictEqual(T.validate({ fromRoom: room2.name, toRoom: c.room.name, resourceType: 'UH', amount: 100, validUntil: Game.time + 100 }).reason, 'transfer hysteresis');
});
test('terminal capacity and transaction energy reserves are protected', () => {
    const c = setup('U', 0), r = second(c); c.terminal.store.U = 1000;
    r.terminal.store.energy = 260000;
    const T = fresh('Resource.Terminals.js'), t = { fromRoom: c.room.name, toRoom: r.name, resourceType: 'U', amount: 500, validUntil: Game.time + 100 };
    assert.strictEqual(T.validate(t).ok, false); r.terminal.store.energy = 30000; c.terminal.store.energy = 20100;
    assert.strictEqual(T.validate(t).reason, 'send energy reserve');
});
test('hub prefers an owned healthy lab cluster with terminal and Storage', () => {
    const c = setup(); const room = second(c, {}, true); assert.strictEqual(c.Policy.snapshot().hubs[0], room.name);
});
test('missing X receives bounded diversity bonus over duplicate U', () => {
    const c = setup('U', 0); assert.strictEqual(c.Policy.diversity('U'), 0); assert.strictEqual(c.Policy.diversity('X'), 8);
    assert.ok(c.Policy.diversity('X') < 12, 'cannot compensate even one additional route room');

});
test('Power has no raw inventory cap and deposits in working Power Spawn then Storage', () => {
    const c = setup('power', 50000); assert.strictEqual(c.Policy.snapshot().resources.power.targetHigh, 0);
    let destination; const creep = { room: c.room, pos: pos(20, 20), memory: { powerBankOperationId: 'power-bank:a', powerBankHomeRoom: c.room.name }, store: store({ power: 100 }), transfer(target) { destination = target.id; return OK; } };
    const R = fresh('role.ResourceCourier.js'); R.runPowerBankHauler(creep); assert.strictEqual(destination, c.vault.id);
    c.room.powerSpawn = structure('ps', 'powerSpawn', 20, 21, { power: 0 }, 100);
    R.runPowerBankHauler(creep); assert.strictEqual(destination, 'ps');
    c.room.powerSpawn.store.power = 25; R.runPowerBankHauler(creep); assert.strictEqual(destination, c.vault.id);
});
test('nonseason operation is safe without RESOURCE_THORIUM', () => {
    const c = setup(); delete global.RESOURCE_THORIUM; delete global.FIND_REACTORS;
    assert.strictEqual(c.Policy.extraction(c.room, 'U').allowed, true); assert.doesNotThrow(() => fresh('Resource.Terminals.js').planBalance());
});
test('snapshot caches inventory and excludes creep cargo; diagnostics serialize', () => {
    const c = setup('U', 200); const first = c.Policy.snapshot(); c.vault.store.U = 999;
    assert.strictEqual(c.Policy.snapshot(), first); assert.strictEqual(first.resources.U.totalStored, 200);
    assert.doesNotThrow(() => JSON.stringify(first)); assert.strictEqual(refresh(c).resources.U.totalStored, 999);
});
test('Reactor runway subtracts observation age and protects established streaks', () => {
    const c = setup('T'); const s = season(c);
    const a = s.R.runway({ thorium: 844, lastSeen: Game.time - 10, continuousWork: 10000 }, 400, 400);
    assert.strictEqual(a.supplyRunwayTicks, 834); assert.strictEqual(a.requiredRunwayTicks, 950);
    assert.ok(a.emergencyPriority > s.R.runway({ thorium: 844, lastSeen: Game.time, continuousWork: 1 }, 400, 400).emergencyPriority);
});

test('Ghodium demand stops at 10k and reports missing chemistry inputs', () => {
    const c = setup('U', 0), hub = second(c, {}, true);
    c.Policy.snapshot(); c.Policy.planReactions();
    assert.ok(c.hive.resources.labs[hub.name].blockingIngredients.length > 0);
    assert.ok(c.Policy.state().production.some(t => t.product === 'G'));
    hub.storage.store.G = 10000; refresh(c);
    assert.ok(!c.Policy.state().production.some(t => t.product === 'G'));
    assert.strictEqual(c.Policy.state().resources.G.miningState, 'PAUSED_TARGET_REACHED');
});
test('Ghodium uses existing labs to produce missing intermediates', () => {
    const c = setup('U', 0), hub = second(c, { U: 10000, L: 10000, Z: 10000, K: 10000 }, true);
    c.Policy.snapshot(); c.Policy.planReactions();
    const goal = c.hive.resources.labs[hub.name].reactionGoal;
    assert.strictEqual(goal.policyManaged, true); assert.ok(['UL', 'ZK'].includes(goal.product));
    assert.strictEqual(goal.targetAmount, 10000);
});
test('Storage consolidation has a concrete pressure trigger', () => {
    const c = setup('U', 20000, { capacity: 150000 }), receiver = second(c);
    fresh('Resource.Terminals.js').planBalance();
    const transfer = Object.values(c.hive.resources.transfers)[0];
    assert.strictEqual(transfer.toRoom, receiver.name); assert.strictEqual(transfer.reason, 'Storage pressure consolidation');
});
test('finite Thorium in Storage never triggers the container pile cap', () => {
    const c = setup('T', 25000), s = season(c); s.a.stagingId = c.vault.id;
    assert.strictEqual(s.R.assess(s.a, s.memory).allowed, true);
});
test('startup reservations can move into Storage without delaying owned Reactor fuel', () => {
    const c = setup('T', 0), s = season(c); c.staging.store.T = 450;
    s.memory.reactors.new = { my: false }; s.memory.reactors.owned = { my: true };
    s.memory.thoriumReservations = { tick: Game.time, stores: { stage: { total: 450, reactors: { new: 300, owned: 150 } } } };
    let withdrawn = 0;
    const creep = { room: c.room, pos: pos(11, 10), memory: { season11SourceRoom: 'W1N1', season11StagingId: 'stage', season11ReserveStorageId: 'storage' },
        store: store({}, 500), withdraw(target, type, n) { withdrawn = n; return OK; } };
    fresh('role.ThoriumHauler.js').run(creep); assert.strictEqual(withdrawn, 300);
    assert.strictEqual(s.memory.thoriumReservations.stores.stage.reactors.owned, 150);
    assert.strictEqual(s.memory.thoriumReservations.stores.stage.reactors.new, 0);
});
test('dedicated Reactor hauler withdraws reserved Storage fuel when staging is empty', () => {
    const c = setup('T', 1000), s = season(c); let source = null;
    const reactor = structure('reactor', 'reactor', 22, 20, { T: 100 }, 1000);
    installObjectLookup(c.structures.concat(c.node, reactor));
    s.memory.reactors.reactor = { my: true, roomName: c.room.name };
    s.memory.thoriumReservations = { tick: Game.time, stores: { storage: { total: 1000, reactors: { reactor: 800 } } } };
    const creep = { room: c.room, pos: pos(20, 20), memory: { season11SourceRoom: 'W1N1', season11StagingId: 'stage', season11ReactorId: 'reactor' },
        store: store({}, 500), withdraw(target) { source = target.id; return OK; } };
    fresh('role.ThoriumHauler.js').run(creep); assert.strictEqual(source, 'storage');
    assert.strictEqual(s.memory.thoriumReservations.stores.storage.reactors.reactor, 300);
});
test('terminal pressure pauses extraction even with a healthy Storage', () => {
    const c = setup('U', 0); c.terminal.store.energy = 260000;
    assert.strictEqual(c.Policy.extraction(c.room, 'U').reason, 'PAUSED_STORAGE_PRESSURE');
});
test('all meaningful inventory locations count once and creep cargo stays excluded', () => {
    const c = setup('U', 200);
    c.terminal.store.U = 30; c.staging.store.U = 40;
    c.structures.push(structure('lab', 'lab', 20, 19, { U: 50 }), structure('factory', 'factory', 20, 18, { U: 60 }));
    Game.creeps.transit = { name: 'transit', memory: {}, body: [], room: c.room, store: store({ U: 9999 }) };
    installObjectLookup(c.structures.concat(c.node)); delete global.__sushiTickIndex;
    const r = c.Policy.snapshot().resources.U;
    assert.strictEqual(r.totalStored, 380); assert.strictEqual(r.stagingAmount, 40); assert.strictEqual(r.labAmount, 50);
});

test('otherwise equal expansion candidates prefer missing mineral diversity', () => {
    const c = setup('U', 0); delete global.RESOURCE_THORIUM; delete global.FIND_REACTORS;
    Game.spawns.Spawn1 = { my: true, room: c.room }; Game.map.getRoomLinearDistance = () => 2;
    Game.map.findRoute = () => [{ room: 'W2N2' }];
    Memory.rooms.W3N3 = { scoutIntel: { sourceCount: 2, mineralType: 'U' } };
    Memory.rooms.W2N3 = { scoutIntel: { sourceCount: 2, mineralType: 'X' } };
    const E = fresh('Logic.Expansion.js'), m = E.ensureExpansionMemory(); m.minRangeBetweenBases = 0;
    const candidate = E.chooseExpansionTarget(m, [c.room]);
    assert.strictEqual(candidate.roomName, 'W2N3'); assert.strictEqual(m.candidates.W2N3.mineralDiversityBonus, 8);
});
test('valid Thorium nomination outranks a missing X candidate', () => {
    const c = setup('U', 0), s = season(c);
    Game.spawns.Spawn1 = { my: true, room: c.room }; Game.map.getRoomLinearDistance = () => 2;
    Game.map.findRoute = () => [{ room: 'W2N2' }];
    Memory.rooms.W3N3 = { scoutIntel: { sourceCount: 2, mineralType: 'X' } };
    Memory.rooms.W2N3 = { scoutIntel: { sourceCount: 2 } };
    s.memory.rooms.W2N3 = { roomName: 'W2N3', lastSeen: Game.time, controllerOwner: null, controllerReservation: null,
        hostileCreeps: 0, hostileStructures: 0, threatParts: 0, thorium: { id: 'finite', remaining: 50000, density: 3, depleted: false } };
    const E = fresh('Logic.Expansion.js'), m = E.ensureExpansionMemory(); m.minRangeBetweenBases = 0;
    const candidate = E.chooseExpansionTarget(m, [c.room]);
    assert.strictEqual(candidate.roomName, 'W2N3'); assert.strictEqual(candidate.season11, true);
});
test('boost requested without local labs routes production inputs to a suitable hub', () => {
    const c = setup('X', 4000), hub = second(c, {}, true);
    fresh('Resource.Labs.js').requestBoost('s', c.room.name, { a: [{ compound: 'XUH2O', parts: 100 }] });
    const p = c.Policy.snapshot();
    assert.strictEqual(p.rooms[c.room.name].needs.XUH2O, 3750);
    assert.ok(p.rooms[hub.name].needs.X >= 3750);
    assert.ok(p.production.some(task => task.product === 'XUH2O' && task.roomName === hub.name));
});

test('partial Power delivery does not cancel other recovered cargo', () => {
    const c = setup('power', 0); c.room.powerSpawn = structure('ps', 'powerSpawn', 21, 20, {}, 100);
    c.hive.power.operations.a = { state: 'LOOTING', recoveryTarget: 100 };
    let sent;
    const creep = { room: c.room, pos: pos(20, 20), memory: { powerBankOperationId: 'power-bank:a', powerBankHomeRoom: c.room.name },
        store: store({ power: 100 }), transfer(target, type, n) { sent = n; return OK; } };
    fresh('role.ResourceCourier.js').runPowerBankHauler(creep);
    assert.strictEqual(sent, 25); assert.strictEqual(c.hive.power.operations.a.deliveredPower, 25);
    assert.strictEqual(c.hive.power.operations.a.state, 'RETURNING');
});
console.log(`Resource strategy tests passed: ${passed}`);
