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

function reset(state = 'STABLE', spawnFill = 1) {
    mocks.installGlobals({ limit: 100, tickLimit: 500, bucket: 10000, getUsed: () => 0 });
    mocks.clearLocalModules();
    delete global.__sushiArtificerControllerHelpers;
    const objects = {};
    Game.getObjectById = id => objects[id] || null;
    const room = {
        name: 'W1N1', energyAvailable: Math.round(800 * spawnFill), energyCapacityAvailable: 800,
        controller: { id: 'controller', my: true, level: 3, ticksToDowngrade: 10000,
            pos: new RoomPosition(25, 25, 'W1N1') },
        sites: [], structures: [], storage: null,
        find(kind, options) {
            let values = [];
            if (kind === FIND_MY_CONSTRUCTION_SITES || kind === FIND_CONSTRUCTION_SITES) values = this.sites;
            else if (kind === FIND_MY_STRUCTURES || kind === FIND_STRUCTURES) values = this.structures;
            return options && options.filter ? values.filter(options.filter) : values;
        }
    };
    objects.controller = room.controller;
    Game.rooms[room.name] = room;
    Memory.rooms[room.name] = {
        RepairStructure: [], ArtificerRepairWorkers: {}, ArtificerRepairClaims: {},
        spawn: { queue: [] },
        economy: {
            state, rawState: state, spawnFill,
            harvest: { workActive: 5, workQueued: 0, actualOrEstimatedIncome: 10 },
            haul: { localCarry: 5, queuedCarry: 0, requiredCarry: 5 },
            bootstrap: { floorReachable: true, unrecoverable: false }
        }
    };
    return { room, objects };
}

function addObject(world, object) {
    world.objects[object.id] = object;
    return object;
}

function addArtificer(world, name = 'artificer', energy = 50) {
    const creep = new Creep();
    creep.name = name;
    creep.room = world.room;
    creep.pos = new RoomPosition(20, 20, world.room.name);
    creep.memory = { role: 'Artificer', homeRoom: world.room.name };
    creep.body = [{ type: WORK, hits: 100 }, { type: CARRY, hits: 100 }, { type: MOVE, hits: 100 }];
    creep.ticksToLive = 1000;
    creep.store = {
        [RESOURCE_ENERGY]: energy,
        getUsedCapacity: () => energy,
        getFreeCapacity: () => Math.max(0, 50 - energy)
    };
    creep.pos.findClosestByPath = function(kind, options) {
        if (Array.isArray(kind)) return kind[0] || null;
        let values = world.room.find(kind, options);
        return values[0] || null;
    };
    creep.pos.findClosestByRange = creep.pos.findClosestByPath;
    creep.upgrades = 0;
    creep.repairs = 0;
    creep.builds = 0;
    creep.transfers = 0;
    creep.upgradeController = target => { creep.lastUpgrade = target; creep.upgrades++; return OK; };
    creep.repair = target => { creep.lastRepair = target; creep.repairs++; return OK; };
    creep.build = target => { creep.lastBuild = target; creep.builds++; return OK; };
    creep.transfer = target => { creep.lastTransfer = target; creep.transfers++; return OK; };
    creep.withdraw = () => OK;
    creep.pickup = () => OK;
    creep.harvest = () => OK;
    Game.creeps[name] = creep;
    Memory.creeps[name] = creep.memory;
    return creep;
}

function addSite(world, id = 'site', type = STRUCTURE_EXTENSION) {
    const site = addObject(world, { id, structureType: type, my: true, progress: 0, progressTotal: 100,
        pos: new RoomPosition(21, 20, world.room.name) });
    world.room.sites.push(site);
    Game.constructionSites[id] = site;
    return site;
}

function addRepair(world, id = 'repair', type = STRUCTURE_SPAWN) {
    const target = addObject(world, { id, structureType: type, hits: 100, hitsMax: 1000,
        pos: new RoomPosition(21, 20, world.room.name) });
    world.room.structures.push(target);
    Memory.rooms[world.room.name].RepairStructure.push(id);
    return target;
}

test('idle powered Artificer upgrades when no repair or construction exists', () => {
    const world = reset();
    const creep = addArtificer(world);
    fresh('role.Artificer.js').run(creep);
    assert.strictEqual(creep.lastUpgrade, world.room.controller);
    assert.strictEqual(creep.memory.artificerTask, 'UPGRADE_FALLBACK');
});

test('critical repair preempts controller fallback', () => {
    const world = reset();
    const target = addRepair(world);
    const creep = addArtificer(world);
    fresh('role.Artificer.js').run(creep);
    assert.strictEqual(creep.lastRepair, target);
    assert.strictEqual(creep.upgrades, 0);
    assert.strictEqual(creep.memory.artificerTask, 'CRITICAL_REPAIR');
});

test('important local construction preempts fallback when construction is permitted', () => {
    const world = reset();
    const site = addSite(world);
    const creep = addArtificer(world);
    fresh('role.Artificer.js').run(creep);
    assert.strictEqual(creep.lastBuild, site);
    assert.strictEqual(creep.upgrades, 0);
});

test('blocked remote spending clears and does not select remembered remote work', () => {
    const world = reset('RECOVERY');
    const creep = addArtificer(world);
    creep.memory.remoteWorkTargetId = 'remoteSite';
    creep.memory.remoteWorkRoomName = 'W1N2';
    creep.memory.remoteWorkX = 20;
    creep.memory.remoteWorkY = 20;
    creep.memory.remoteWorkType = 'buildRemoteRoad';
    addObject(world, { id: 'remoteSite', structureType: STRUCTURE_ROAD, my: true,
        progress: 0, progressTotal: 100, pos: new RoomPosition(20, 20, 'W1N2') });
    fresh('role.Artificer.js').run(creep);
    assert.strictEqual(creep.memory.remoteWorkTargetId, undefined);
    assert.strictEqual(creep.builds, 0);
});

test('RECOVERY permits at most one temporary Artificer controller helper', () => {
    const world = reset('RECOVERY');
    const first = addArtificer(world, 'art-a');
    const second = addArtificer(world, 'art-b');
    const role = fresh('role.Artificer.js');
    role.run(first);
    role.run(second);
    assert.strictEqual(first.upgrades + second.upgrades, 1);
    assert.strictEqual([first, second].filter(c => c.memory.artificerTask === 'UPGRADE_FALLBACK').length, 1);
});

test('SURVIVAL with low spawn energy refills the base instead of upgrading', () => {
    const world = reset('SURVIVAL', 0.1);
    const extension = addObject(world, { id: 'extension', structureType: STRUCTURE_EXTENSION,
        store: { getFreeCapacity: () => 50 }, pos: new RoomPosition(21, 20, world.room.name) });
    world.room.structures.push(extension);
    const creep = addArtificer(world);
    fresh('role.Artificer.js').run(creep);
    assert.strictEqual(creep.lastTransfer, extension);
    assert.strictEqual(creep.upgrades, 0);
    assert.strictEqual(creep.memory.artificerTask, 'EMERGENCY_FILL');
});

test('controller downgrade danger permits controller-safety behavior', () => {
    const world = reset('SURVIVAL', 1);
    world.room.controller.ticksToDowngrade = 4999;
    const creep = addArtificer(world);
    fresh('role.Artificer.js').run(creep);
    assert.strictEqual(creep.upgrades, 1);
    assert.match(creep.memory.artificerReason, /safety/i);
    assert.strictEqual(creep.memory.controllerEmergency, undefined);
});

test('Artificer returns to building when a valid site appears', () => {
    const world = reset();
    const creep = addArtificer(world);
    const role = fresh('role.Artificer.js');
    role.run(creep);
    assert.strictEqual(creep.upgrades, 1);
    const site = addSite(world);
    Game.time++;
    role.run(creep);
    assert.strictEqual(creep.lastBuild, site);
    assert.strictEqual(creep.memory.artificerTask, 'BUILD_LOCAL');
});

test('idle Artificer WORK does not suppress the baseline Tech floor', () => {
    const world = reset('RECOVERY');
    world.room.controller.level = 1;
    Game.spawns.Spawn1 = { name: 'Spawn1', my: true, room: world.room, spawning: null,
        pos: new RoomPosition(24, 25, world.room.name) };
    const addRole = (name, role, body, memory = {}) => {
        const unit = addArtificer(world, name, 0);
        unit.memory = { role, homeRoom: world.room.name, ...memory };
        unit.body = body.map(type => ({ type, hits: 100 }));
        Memory.creeps[name] = unit.memory;
        return unit;
    };
    addRole('foreman', 'Foreman', [CARRY, MOVE]);
    addRole('miner-a', 'Extractor', [WORK, WORK, MOVE]);
    addRole('miner-b', 'Extractor', [WORK, WORK, MOVE]);
    addRole('freighter', 'Freighter', [CARRY, MOVE]);
    const idle = addRole('idle-art', 'Artificer', [WORK, WORK, CARRY, MOVE]);
    idle.memory.artificerTask = 'UPGRADE_FALLBACK';
    delete global.__sushiTickIndex;
    const colony = fresh('HiveMind.ColonyState.js').update(world.room);
    assert.strictEqual(colony.baselineTechRequired, true);
    assert.strictEqual(colony.techPlannedWork, 0);
    assert.strictEqual(colony.nextMandatoryRole, 'Tech');
});

test('repair claims, cleanup, movement ownership, and established Memory remain compatible', () => {
    const world = reset();
    const target = addRepair(world, 'road', STRUCTURE_ROAD);
    const creep = addArtificer(world);
    creep.memory.keepMe = 'compatible';
    creep.repair = repairTarget => { creep.lastRepair = repairTarget; return ERR_NOT_IN_RANGE; };
    fresh('role.Artificer.js').run(creep);
    assert.strictEqual(creep.memory.keepMe, 'compatible');
    assert.strictEqual(creep.memory.repairTargetId, target.id);
    assert.strictEqual(Memory.rooms.W1N1.ArtificerRepairClaims[target.id], creep.name);
    assert.ok(global.__sushiTrafficIntents || creep.memory._travel || creep.lastRepair === target);
    target.hits = target.hitsMax;
    Game.time++;
    fresh('role.Artificer.js').run(creep);
    assert.strictEqual(creep.memory.repairTargetId, undefined);
});

test('controller fallback collection ignores source-side drops but accepts protected spawn drops', () => {
    const world = reset();
    const sourceDrop = { id: 'sourceDrop', resourceType: RESOURCE_ENERGY, amount: 100,
        pos: new RoomPosition(10, 10, world.room.name) };
    const spawnDrop = { id: 'spawnDrop', resourceType: RESOURCE_ENERGY, amount: 100,
        pos: new RoomPosition(23, 25, world.room.name) };
    sourceDrop.pos.findInRange = () => [{}];
    spawnDrop.pos.findInRange = () => [];
    const creep = addArtificer(world, 'collector', 0);
    creep.pos.findClosestByPath = (kind, options) => {
        if (kind !== FIND_DROPPED_RESOURCES) return null;
        return [sourceDrop, spawnDrop].find(options.filter) || null;
    };
    let picked = null;
    creep.pickup = target => { picked = target; return OK; };
    fresh('role.Artificer.js').run(creep);
    assert.strictEqual(creep.memory.artificerNextTask, 'UPGRADE_FALLBACK');
    assert.strictEqual(picked, spawnDrop);
});

console.log(`Artificer controller-fallback regression tests passed: ${passed}`);
