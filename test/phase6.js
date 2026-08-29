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
        REACTIONS: { H: { O: 'OH' } }
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
    Memory.rooms[name] = Memory.rooms[name] || { spawnQueue: [] };
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

test('resource Memory migration is additive and defaults market use off', function() {
    reset();
    Memory.hive = { custom: 9 };
    const hive = fresh('HiveMind.Memory.js').migrate();
    assert.strictEqual(hive.schemaVersion, 5);
    assert.strictEqual(hive.custom, 9);
    assert.deepStrictEqual(hive.resources.rooms, {});
    assert.strictEqual(hive.settings.resources.market, false);
});

test('mineral lifecycle waits for extractor, emits demand when active, and stops safely', function() {
    reset();
    const node = mineral();
    const terminal = structure('terminal', STRUCTURE_TERMINAL, 20, 20, {}, 50000);
    const structures = [terminal];
    const room = makeRoom('W1N1', { structures, minerals: [node], terminal });
    installObjectLookup(structures.concat(node));
    let index = fresh('HiveMind.Index.js');
    index.build();
    const minerals = fresh('Resource.Minerals.js');
    let state = minerals.observe(room);
    assert.strictEqual(state.mineral.active, false);
    assert.match(state.mineral.debugReason, /extractor/);

    const extractor = structure('extractor', STRUCTURE_EXTRACTOR, 10, 10);
    const container = structure('container', STRUCTURE_CONTAINER, 11, 10, { H: 500 }, 2000);
    structures.push(extractor, container);
    installObjectLookup(structures.concat(node));
    Game.time++;
    delete global.__sushiTickIndex;
    state = minerals.observe(room);
    assert.strictEqual(state.mineral.active, true);
    assert.strictEqual(minerals.emitDemands(room, state).length, 2);
    assert.strictEqual(minerals.jobs(room, state)[0].targetId, terminal.id);

    node.mineralAmount = 0;
    state = minerals.observe(room);
    assert.strictEqual(state.mineral.depleted, true);
    assert.strictEqual(state.mineral.active, false);
});

test('MineralMiner harvests through the extractor lifecycle and deposits cargo', function() {
    reset();
    const node = mineral();
    const container = structure('container', STRUCTURE_CONTAINER, 11, 10, {}, 2000);
    node.pos.findInRange = () => [container];
    const room = makeRoom('W1N1', { structures: [container], minerals: [node] });
    installObjectLookup([node, container]);
    const minerCreep = new Creep();
    Object.assign(minerCreep, {
        name: 'miner', room, pos: pos(11, 10), spawning: false,
        memory: { role: 'MineralMiner', mineralId: node.id, mineralType: 'H' },
        store: store({}, 50),
        harvest() { this.store.H = 10; return OK; },
        transfer(target, type) { target.store[type] = (target.store[type] || 0) + this.store[type]; this.store[type] = 0; return OK; },
        setWorkingArea() { this.workingArea = true; }
    });
    const role = fresh('role.MineralMiner.js');
    role.run(minerCreep);
    assert.strictEqual(minerCreep.memory.mineralState, 'harvesting');
    minerCreep.store.H = 50;
    role.run(minerCreep);
    assert.strictEqual(container.store.H, 50);
});

test('link routing moves source energy once and preserves emergency room energy', function() {
    reset();
    const transfers = [];
    function link(id, x, y, energy) {
        const result = structure(id, STRUCTURE_LINK, x, y, { [RESOURCE_ENERGY]: energy }, 800);
        result.transferEnergy = (target, quantity) => { transfers.push([id, target.id, quantity]); return OK; };
        return result;
    }
    const source = link('source', 10, 10, 800);
    const hub = link('hub', 20, 20, 0);
    const controller = link('controller', 25, 25, 0);
    const room = makeRoom('W1N1', { structures: [source, hub, controller], energyAvailable: 3000 });
    Memory.rooms.W1N1.structurePlanner = { plan: { links: {
        storage: { x: 20, y: 20, roomName: 'W1N1' },
        controller: { x: 25, y: 25, roomName: 'W1N1' },
        sources: { source1: { x: 10, y: 10, roomName: 'W1N1' } }
    } } };
    delete global.__sushiTickIndex;
    const report = fresh('Resource.Links.js').run(room);
    assert.deepStrictEqual(transfers, [['source', 'hub', 800]]);
    assert.strictEqual(report.transfers.length, 1);

    transfers.length = 0;
    source.store[RESOURCE_ENERGY] = 0;
    hub.store[RESOURCE_ENERGY] = 800;
    room.energyAvailable = 100;
    fresh('Resource.Links.js').run(room);
    assert.deepStrictEqual(transfers, [], 'hub drained during room-energy emergency');
});

test('terminals send only to visible owned terminals and retain an energy reserve', function() {
    reset();
    const sent = [];
    const fromTerminal = structure('from-terminal', STRUCTURE_TERMINAL, 20, 20, { [RESOURCE_ENERGY]: 30000, H: 2000 }, 50000);
    fromTerminal.send = (type, quantity, roomName) => { sent.push([type, quantity, roomName]); return OK; };
    const toTerminal = structure('to-terminal', STRUCTURE_TERMINAL, 20, 20, { [RESOURCE_ENERGY]: 30000 }, 50000);
    makeRoom('W1N1', { structures: [fromTerminal], terminal: fromTerminal });
    makeRoom('W2N2', { structures: [toTerminal], terminal: toTerminal });
    delete global.__sushiTickIndex;
    const terminals = fresh('Resource.Terminals.js');
    terminals.requestTransfer({ fromRoom: 'W1N1', toRoom: 'W2N2', resourceType: 'H', amount: 500 });
    terminals.run();
    assert.deepStrictEqual(sent, [['H', 500, 'W2N2']]);
    const hostileTerminal = structure('hostile-terminal', STRUCTURE_TERMINAL, 20, 20, {}, 50000);
    makeRoom('W9N9', { structures: [hostileTerminal], terminal: hostileTerminal, controller: { my: false, level: 8 } });
    const rejected = terminals.validate({ fromRoom: 'W1N1', toRoom: 'W9N9', resourceType: 'H', validUntil: Game.time + 1 });
    assert.strictEqual(rejected.ok, false);
    fromTerminal.store[RESOURCE_ENERGY] = 10000;
    assert.strictEqual(terminals.validate({ fromRoom: 'W1N1', toRoom: 'W2N2', resourceType: 'H', validUntil: Game.time + 1 }).reason, 'energy reserve');
    assert.strictEqual(Game.market, undefined);
});

test('active boost stock is reserved and missing compounds stage from an owned terminal', function() {
    reset();
    const localTerminal = structure('local-terminal', STRUCTURE_TERMINAL, 20, 20, { [RESOURCE_ENERGY]: 30000 }, 50000);
    const donorTerminal = structure('donor-terminal', STRUCTURE_TERMINAL, 20, 20, { [RESOURCE_ENERGY]: 30000, XKHO2: 1000 }, 50000);
    makeRoom('W1N1', { structures: [localTerminal], terminal: localTerminal });
    makeRoom('W2N2', { structures: [donorTerminal], terminal: donorTerminal });
    const hive = fresh('HiveMind.Memory.js').ensure();
    hive.squads.duo = {
        id: 'duo', operationId: 'op', state: 'FORMING', originRoom: 'W1N1',
        boostRequirements: { attacker: [{ compound: 'XKHO2', parts: 2 }], healer: [] }
    };
    delete global.__sushiTickIndex;
    const manager = fresh('Resource.Manager.js');
    manager.syncBoostRequests();
    const transfer = hive.resources.transfers['terminal:W2N2:W1N1:XKHO2'];
    assert.ok(transfer);
    assert.strictEqual(transfer.toRoom, 'W1N1');
    assert.strictEqual(fresh('Resource.Terminals.js').reservedAmount('W1N1', 'XKHO2'), 60);
});

test('lab reactions progress through loading, reacting, and unloading states', function() {
    reset();
    const storage = structure('storage', STRUCTURE_STORAGE, 20, 20, { H: 1000, O: 1000, [RESOURCE_ENERGY]: 5000 }, 50000);
    const inputA = structure('lab-a', STRUCTURE_LAB, 10, 10, {}, 3000);
    const inputB = structure('lab-b', STRUCTURE_LAB, 11, 10, {}, 3000);
    const output = structure('lab-out', STRUCTURE_LAB, 10, 11, {}, 3000);
    const reactions = [];
    output.runReaction = (a, b) => { reactions.push([a.id, b.id]); return OK; };
    const room = makeRoom('W1N1', { structures: [storage, inputA, inputB, output], storage });
    installObjectLookup([storage, inputA, inputB, output]);
    delete global.__sushiTickIndex;
    const labs = fresh('Resource.Labs.js');
    labs.configureReaction(room.name, 'OH', 100);
    let report = labs.run(room);
    assert.strictEqual(report.state.state, 'LOADING_INPUTS');
    assert.ok(report.jobs.some(job => job && job.resourceType === 'H'));
    inputA.store.H = 500;
    inputB.store.O = 500;
    inputA.store[RESOURCE_ENERGY] = inputB.store[RESOURCE_ENERGY] = output.store[RESOURCE_ENERGY] = 1000;
    Game.time++;
    report = labs.run(room);
    assert.strictEqual(report.state.state, 'REACTING');
    Game.time++;
    labs.run(room);
    assert.deepStrictEqual(reactions, [['lab-a', 'lab-b']]);
    output.store.OH = 100;
    Game.time++;
    report = labs.run(room);
    assert.strictEqual(report.state.state, 'UNLOADING');
    assert.ok(report.jobs.some(job => job && job.sourceId === output.id));
});

test('lab contamination enters cleaning and missing reaction data fails gracefully', function() {
    reset();
    const storage = structure('storage', STRUCTURE_STORAGE, 20, 20, {}, 50000);
    const labsList = [
        structure('lab-a', STRUCTURE_LAB, 10, 10, { Z: 100 }, 3000),
        structure('lab-b', STRUCTURE_LAB, 11, 10, {}, 3000),
        structure('lab-out', STRUCTURE_LAB, 10, 11, {}, 3000)
    ];
    const room = makeRoom('W1N1', { structures: [storage].concat(labsList), storage });
    installObjectLookup([storage].concat(labsList));
    delete global.__sushiTickIndex;
    const labs = fresh('Resource.Labs.js');
    labs.configureReaction(room.name, 'OH', 100);
    let report = labs.run(room);
    assert.strictEqual(report.state.state, 'CLEANING');
    assert.ok(report.jobs.some(job => job && job.resourceType === 'Z'));
    labs.clearReaction(room.name);
    REACTIONS = {};
    labs.configureReaction(room.name, 'UNKNOWN', 100);
    report = labs.run(room);
    assert.ok(['CLEANING', 'ERROR'].includes(report.state.state));
    labsList[0].store.Z = 0;
    Game.time++;
    report = labs.run(room);
    assert.strictEqual(report.state.state, 'ERROR');
});

test('boost workflow stages compounds, exposes rally positions, and verifies body boosts', function() {
    reset();
    const storage = structure('storage', STRUCTURE_STORAGE, 20, 20, { XKHO2: 100, XLHO2: 100, [RESOURCE_ENERGY]: 5000 }, 50000);
    const labA = structure('lab-a', STRUCTURE_LAB, 10, 10, {}, 3000);
    const labB = structure('lab-b', STRUCTURE_LAB, 11, 10, {}, 3000);
    const labC = structure('lab-c', STRUCTURE_LAB, 10, 11, {}, 3000);
    const room = makeRoom('W1N1', { structures: [storage, labA, labB, labC], storage });
    const attacker = new Creep();
    Object.assign(attacker, { name: 'attacker', room, pos: pos(10, 9), body: [{ type: RANGED_ATTACK, hits: 100 }], memory: { squadId: 'duo', squadSlot: 'attacker' } });
    const healer = new Creep();
    Object.assign(healer, { name: 'healer', room, pos: pos(11, 9), body: [{ type: HEAL, hits: 100 }], memory: { squadId: 'duo', squadSlot: 'healer' } });
    Game.creeps = { attacker, healer };
    labA.boostCreep = member => { member.body[0].boost = 'XKHO2'; return OK; };
    labB.boostCreep = member => { member.body[0].boost = 'XLHO2'; return OK; };
    installObjectLookup([storage, labA, labB, labC, attacker, healer]);
    delete global.__sushiTickIndex;
    const labs = fresh('Resource.Labs.js');
    labs.requestBoost('duo', room.name, {
        attacker: [{ compound: 'XKHO2', parts: 1 }],
        healer: [{ compound: 'XLHO2', parts: 1 }]
    });
    labs.run(room);
    Game.time++;
    let report = labs.run(room);
    assert.strictEqual(report.state.state, 'PREPARING_BOOSTS');
    assert.ok(report.jobs.length >= 4);
    labA.store.XKHO2 = 30;
    labA.store[RESOURCE_ENERGY] = 20;
    labB.store.XLHO2 = 30;
    labB.store[RESOURCE_ENERGY] = 20;
    Game.time++;
    report = labs.run(room);
    assert.strictEqual(report.state.state, 'BOOSTING_SQUAD');
    assert.strictEqual(labs.getBoostPositions('duo', 'attacker')[0].labId, labA.id);
    Game.time++;
    report = labs.run(room);
    assert.strictEqual(report.boost.state, 'COMPLETE');
    assert.strictEqual(attacker.body[0].boost, 'XKHO2');
    assert.strictEqual(healer.body[0].boost, 'XLHO2');
});

test('ResourceCourier executes a generated transfer job end to end', function() {
    reset();
    const source = structure('source', STRUCTURE_CONTAINER, 10, 10, { H: 80 }, 2000);
    const target = structure('target', STRUCTURE_TERMINAL, 20, 20, {}, 50000);
    const room = makeRoom('W1N1', { structures: [source, target], terminal: target });
    installObjectLookup([source, target]);
    const worker = courier('courier', room, 100);
    delete global.__sushiTickIndex;
    const manager = fresh('Resource.Manager.js');
    manager.addJobs([{ id: 'job', type: 'TRANSFER', roomName: room.name, resourceType: 'H', amount: 80, sourceId: source.id, targetId: target.id, priority: 50 }]);
    const role = fresh('role.ResourceCourier.js');
    role.run(worker);
    assert.strictEqual(worker.store.H, 80);
    role.run(worker);
    assert.strictEqual(worker.store.H, 0);
    assert.strictEqual(target.store.H, 80);
});

test('observer scanning staggers rooms and does not immediately rescan', function() {
    reset();
    Game.map.describeExits = roomName => roomName === 'W1N1' ? { 1: 'W1N2', 3: 'W2N1' } : {};
    Game.map.getRoomLinearDistance = () => 1;
    const observed = [];
    const room = makeRoom('W1N1');
    const observer = { id: 'observer', room, cooldown: 0, observeRoom(target) { observed.push(target); return OK; } };
    const api = fresh('Resource.Observer.js');
    api.run(observer);
    Game.time++;
    api.run(observer);
    assert.deepStrictEqual(observed, ['W1N2', 'W2N1']);
});

console.log(`Phase 6 tests passed: ${passed}`);
