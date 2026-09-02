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
    delete global.__sushiArtificerReachability;
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

function workParts(body) {
    return (body || []).filter(part => part === WORK || part && part.type === WORK).length;
}

function setArtificerWork(creep, category, count, spawning = false) {
    creep.memory.artificerWorkCategory = category;
    creep.memory.artificerTask = category === 'criticalMaintenance' ? 'CRITICAL_REPAIR' :
        category === 'criticalInfrastructure' ? 'BUILD_LOCAL' :
        category === 'remote' ? 'BUILD_REMOTE' : 'REPAIR';
    creep.body = Array.from({ length: count }, () => ({ type: WORK, hits: 100 }))
        .concat([{ type: CARRY, hits: 100 }, { type: MOVE, hits: 100 }]);
    creep.spawning = spawning;
    return creep;
}

function addRemoteConstruction(world, id = 'remote-road', type = STRUCTURE_ROAD) {
    const roomName = 'W1N2';
    const site = {
        id, structureType: type, my: true, progress: 0, progressTotal: 100,
        pos: new RoomPosition(20, 20, roomName)
    };
    Game.map.describeExits = room => room === world.room.name ? { [TOP]: roomName } : {};
    Memory.rooms[world.room.name].remotePlanner = {
        lastRun: Game.time, pathVersion: 1, activeSourceIds: ['remote-source'], remotes: {},
        sourceInfos: {
            'remote-source': {
                sourceId: 'remote-source', roomName, parentRoomName: world.room.name,
                active: true, distance: 20
            }
        }
    };
    Game.rooms[roomName] = {
        name: roomName,
        find(kind, options) {
            const values = kind === FIND_MY_CONSTRUCTION_SITES ? [site] : [];
            return options && options.filter ? values.filter(options.filter) : values;
        }
    };
    return site;
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
    addSite(world, 'critical-build', STRUCTURE_EXTENSION);
    const creep = addArtificer(world);
    fresh('role.Artificer.js').run(creep);
    assert.strictEqual(creep.lastRepair, target);
    assert.strictEqual(creep.builds, 0);
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

test('Artificer demand classifies important local construction as critical infrastructure', () => {
    const world = reset('RECOVERY');
    addSite(world, 'classified-extension', STRUCTURE_EXTENSION);
    const demand = fresh('spawn.request.manager.js').getArtificerBuildDemand(world.room);
    assert.strictEqual(demand.economyCategory, 'criticalInfrastructure');
    assert.strictEqual(fresh('HiveMind.Economy.js').canSpend(world.room.name, demand.economyCategory), true);
    Memory.rooms[world.room.name].economy.state = 'SURVIVAL';
    assert.strictEqual(fresh('HiveMind.Economy.js').canSpend(world.room.name, demand.economyCategory), false);
});

test('mixed critical repair and construction demand stays separated by economy category', () => {
    const world = reset('RECOVERY');
    addRepair(world, 'critical-repair', STRUCTURE_SPAWN);
    addSite(world, 'critical-site', STRUCTURE_EXTENSION);
    const requests = fresh('spawn.request.manager.js');
    const demand = requests.getArtificerBuildDemand(world.room);
    assert.ok(demand.workByEconomyCategory.criticalMaintenance > 0);
    assert.ok(demand.workByEconomyCategory.criticalInfrastructure > 0);
    assert.strictEqual(fresh('HiveMind.Economy.js').canSpend(world.room.name, 'criticalMaintenance'), true);
    assert.strictEqual(fresh('HiveMind.Economy.js').canSpend(world.room.name, 'criticalInfrastructure'), true);

    const first = requests.requestDynamicArtificersForRoom(world.room, demand);
    assert.strictEqual(first.economyCategory, 'criticalMaintenance');
    const maintenanceRequest = Memory.rooms[world.room.name].spawn.queue[0];
    assert.strictEqual(maintenanceRequest.economyCategory, 'criticalMaintenance');
    assert.strictEqual(maintenanceRequest.memory.criticalMaintenance, true);
    assert.ok(workParts(maintenanceRequest.body) <= demand.workByEconomyCategory.criticalMaintenance);

    const refreshed = requests.getArtificerBuildDemand(world.room);
    const second = requests.requestDynamicArtificersForRoom(world.room, refreshed);
    assert.strictEqual(second.economyCategory, 'criticalInfrastructure');
    assert.deepStrictEqual(
        Memory.rooms[world.room.name].spawn.queue.map(request => request.economyCategory).sort(),
        ['criticalInfrastructure', 'criticalMaintenance']
    );
    const infrastructureRequest = Memory.rooms[world.room.name].spawn.queue.find(
        request => request.economyCategory === 'criticalInfrastructure'
    );
    assert.strictEqual(infrastructureRequest.memory.criticalMaintenance, false);

    const survivalWorld = reset('SURVIVAL');
    addRepair(survivalWorld, 'survival-critical-repair', STRUCTURE_SPAWN);
    addSite(survivalWorld, 'survival-critical-site', STRUCTURE_EXTENSION);
    const survivalRequests = fresh('spawn.request.manager.js');
    const survivalDemand = survivalRequests.getArtificerBuildDemand(survivalWorld.room);
    const admitted = survivalRequests.requestDynamicArtificersForRoom(
        survivalWorld.room,
        survivalDemand
    );
    assert.strictEqual(admitted.ok, true);
    assert.strictEqual(admitted.economyCategory, 'criticalMaintenance');
    const remaining = survivalRequests.getArtificerBuildDemand(survivalWorld.room);
    const blocked = survivalRequests.requestDynamicArtificersForRoom(survivalWorld.room, remaining);
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.economyCategory, 'criticalInfrastructure');
    assert.match(blocked.reason, /SURVIVAL|criticalInfrastructure/i);
    assert.strictEqual(Memory.rooms[survivalWorld.room.name].spawn.queue.length, 1);
});

test('critical construction cannot classify or unlock normal and remote demand', () => {
    const world = reset('RECOVERY');
    addSite(world, 'critical-site', STRUCTURE_EXTENSION);
    addSite(world, 'normal-site', STRUCTURE_ROAD);
    const requests = fresh('spawn.request.manager.js');
    const localDemand = requests.getArtificerBuildDemand(world.room);
    assert.strictEqual(localDemand.economyCategory, 'criticalInfrastructure');
    assert.ok(localDemand.workByEconomyCategory.criticalInfrastructure > 0);
    assert.strictEqual(localDemand.workByEconomyCategory.construction, 0);

    const mixed = {
        desiredWork: 4, livingWork: 0, queuedWork: 0, missingWork: 4,
        workByEconomyCategory: {
            criticalMaintenance: 0, criticalInfrastructure: 2,
            construction: 0, remote: 2
        },
        missingWorkByEconomyCategory: {
            criticalMaintenance: 0, criticalInfrastructure: 2,
            construction: 0, remote: 2
        },
        mode: 'mixed-test'
    };
    const critical = requests.requestDynamicArtificersForRoom(world.room, mixed);
    assert.strictEqual(critical.economyCategory, 'criticalInfrastructure');
    assert.ok(workParts(Memory.rooms[world.room.name].spawn.queue[0].body) <= 2);

    mixed.queuedWork = critical.requestedWork;
    mixed.missingWork = 2;
    mixed.missingWorkByEconomyCategory.criticalInfrastructure = 0;
    const remote = requests.requestDynamicArtificersForRoom(world.room, mixed);
    assert.strictEqual(remote.ok, false);
    assert.strictEqual(remote.economyCategory, 'remote');
    assert.match(remote.reason, /RECOVERY|remote/i);
    assert.strictEqual(Memory.rooms[world.room.name].spawn.queue.length, 1);

    const normalWorld = reset('RECOVERY');
    addSite(normalWorld, 'normal-only-site', STRUCTURE_ROAD);
    const normalDemand = fresh('spawn.request.manager.js').getArtificerBuildDemand(normalWorld.room);
    assert.strictEqual(normalDemand.economyCategory, 'construction');
    assert.ok(normalDemand.workByEconomyCategory.construction > 0);
    assert.strictEqual(fresh('HiveMind.Economy.js').canSpend(normalWorld.room.name, 'construction'), false);
});

test('living, spawning, and queued Artificer WORK covers only its assigned category', () => {
    const world = reset('STABLE');
    addRepair(world, 'accounting-critical', STRUCTURE_SPAWN);
    for (let i = 0; i < 4; i++) addRepair(world, `accounting-road-${i}`, STRUCTURE_ROAD);
    addSite(world, 'accounting-extension', STRUCTURE_EXTENSION);
    addRemoteConstruction(world);

    setArtificerWork(addArtificer(world, 'maintenance-worker'), 'criticalMaintenance', 1);
    setArtificerWork(addArtificer(world, 'infrastructure-worker'), 'criticalInfrastructure', 2);
    setArtificerWork(addArtificer(world, 'construction-worker'), 'construction', 1);
    const spawning = setArtificerWork(
        addArtificer(world, 'spawning-infrastructure'),
        'criticalInfrastructure',
        2,
        true
    );
    Game.spawns.Spawn1 = {
        name: 'Spawn1', my: true, room: world.room,
        spawning: { name: spawning.name }, pos: new RoomPosition(25, 25, world.room.name)
    };
    Memory.creeps['spawning-remote'] = {
        role: 'Artificer', homeRoom: world.room.name,
        artificerWorkCategory: 'remote', artificerSpawnWorkParts: 1
    };
    Game.spawns.Spawn2 = {
        name: 'Spawn2', my: true, room: world.room,
        spawning: { name: 'spawning-remote' },
        pos: new RoomPosition(26, 25, world.room.name)
    };
    Memory.rooms[world.room.name].spawn.queue.push(
        {
            role: 'Artificer', economyCategory: 'construction', body: [WORK, CARRY, MOVE],
            memory: { role: 'Artificer', homeRoom: world.room.name, artificerWorkCategory: 'construction' }
        },
        {
            role: 'Artificer', economyCategory: 'remote', body: [WORK, CARRY, MOVE],
            memory: { role: 'Artificer', homeRoom: world.room.name, artificerWorkCategory: 'remote' }
        }
    );

    const demand = fresh('spawn.request.manager.js').getArtificerBuildDemand(world.room);
    assert.deepStrictEqual(demand.livingWorkByEconomyCategory, {
        criticalMaintenance: 1,
        criticalInfrastructure: 2,
        construction: 1,
        remote: 0
    });
    assert.deepStrictEqual(demand.spawningWorkByEconomyCategory, {
        criticalMaintenance: 0,
        criticalInfrastructure: 2,
        construction: 0,
        remote: 1
    });
    assert.deepStrictEqual(demand.queuedWorkByEconomyCategory, {
        criticalMaintenance: 0,
        criticalInfrastructure: 0,
        construction: 1,
        remote: 1
    });
    assert.deepStrictEqual(demand.missingWorkByEconomyCategory, {
        criticalMaintenance: 1,
        criticalInfrastructure: 4,
        construction: 0,
        remote: 0
    });
    assert.strictEqual(demand.missingWork, 5);
    assert.strictEqual(demand.economyCategory, 'criticalMaintenance');
});

test('started Artificer remains categorized after its request leaves the queue', () => {
    const world = reset('STABLE');
    addRepair(world, 'spawning-critical-repair', STRUCTURE_SPAWN);
    const requests = fresh('spawn.request.manager.js');
    const initialDemand = requests.getArtificerBuildDemand(world.room);
    const requested = requests.requestDynamicArtificersForRoom(world.room, initialDemand);
    assert.strictEqual(requested.ok, true);
    assert.strictEqual(requested.economyCategory, 'criticalMaintenance');

    let startedBody = null;
    let startedName = null;
    const spawn = {
        name: 'Spawn1', my: true, room: world.room, spawning: null,
        pos: new RoomPosition(25, 25, world.room.name),
        spawnCreep(body, name, options) {
            startedBody = body.slice();
            startedName = name;
            Memory.creeps[name] = Object.assign({}, options.memory);
            this.spawning = { name };
            return OK;
        }
    };
    Game.spawns.Spawn1 = spawn;

    const result = fresh('spawn.manager.js').runRoom(world.room.name);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(Memory.rooms[world.room.name].spawn.queue.length, 0);
    assert.strictEqual(spawn.spawning.name, startedName);
    const startedWork = workParts(startedBody);
    assert.ok(startedWork > 0);
    assert.strictEqual(Memory.creeps[startedName].artificerSpawnWorkParts, startedWork);

    Game.time++;
    delete global.__sushiTickIndex;
    const spawningDemand = fresh('spawn.request.manager.js').getArtificerBuildDemand(world.room);
    assert.strictEqual(
        spawningDemand.spawningWorkByEconomyCategory.criticalMaintenance,
        startedWork
    );
    assert.strictEqual(spawningDemand.missingWorkByEconomyCategory.criticalMaintenance, 0);
    assert.strictEqual(spawningDemand.spawningWork, startedWork);
    assert.strictEqual(spawningDemand.totalArtificerWork, startedWork);
    const duplicate = requests.requestDynamicArtificersForRoom(world.room, spawningDemand);
    assert.strictEqual(duplicate.requested, 0);
    assert.strictEqual(Memory.rooms[world.room.name].spawn.queue.length, 0);

    const startedMemory = Memory.creeps[startedName];
    const visible = addArtificer(world, startedName);
    visible.memory = startedMemory;
    Memory.creeps[startedName] = startedMemory;
    visible.body = startedBody.map(type => ({ type, hits: 100 }));
    visible.spawning = true;
    Game.time++;
    delete global.__sushiTickIndex;
    const visibleDemand = fresh('spawn.request.manager.js').getArtificerBuildDemand(world.room);
    assert.strictEqual(
        visibleDemand.spawningWorkByEconomyCategory.criticalMaintenance,
        startedWork
    );
    assert.strictEqual(visibleDemand.spawningWork, startedWork);
    assert.strictEqual(visibleDemand.totalArtificerWork, startedWork);

    spawn.spawning = null;
    visible.spawning = false;
    Game.time++;
    delete global.__sushiTickIndex;
    const completedDemand = fresh('spawn.request.manager.js').getArtificerBuildDemand(world.room);
    assert.strictEqual(
        completedDemand.livingWorkByEconomyCategory.criticalMaintenance,
        startedWork
    );
    assert.strictEqual(completedDemand.spawningWork, 0);
    assert.strictEqual(completedDemand.totalArtificerWork, startedWork);
});

test('inactive or invalid Artificer spawn metadata does not suppress replacement demand', () => {
    const world = reset('STABLE');
    addRepair(world, 'replacement-critical-repair', STRUCTURE_SPAWN);
    Memory.creeps.finishedArtificer = {
        role: 'Artificer', homeRoom: world.room.name,
        artificerWorkCategory: 'criticalMaintenance', artificerSpawnWorkParts: 2
    };
    Memory.creeps.invalidSpawn = {
        role: 'Artificer', homeRoom: world.room.name,
        artificerWorkCategory: 'criticalMaintenance', artificerSpawnWorkParts: 'invalid'
    };
    Game.spawns.Spawn1 = {
        name: 'Spawn1', my: true, room: world.room,
        spawning: { name: 'invalidSpawn' },
        pos: new RoomPosition(25, 25, world.room.name)
    };

    let demand = fresh('spawn.request.manager.js').getArtificerBuildDemand(world.room);
    assert.strictEqual(demand.spawningWorkByEconomyCategory.criticalMaintenance, 0);
    assert.strictEqual(demand.missingWorkByEconomyCategory.criticalMaintenance, 2);

    Game.spawns.Spawn1.spawning = { name: 'finishedArtificer' };
    demand = fresh('spawn.request.manager.js').getArtificerBuildDemand(world.room);
    assert.strictEqual(demand.missingWorkByEconomyCategory.criticalMaintenance, 0);

    Game.spawns.Spawn1.spawning = null;
    Game.time++;
    delete global.__sushiTickIndex;
    demand = fresh('spawn.request.manager.js').getArtificerBuildDemand(world.room);
    assert.strictEqual(demand.spawningWorkByEconomyCategory.criticalMaintenance, 0);
    assert.strictEqual(demand.missingWorkByEconomyCategory.criticalMaintenance, 2);
});

test('an Artificer assigned to remote work does not cover critical local work', () => {
    const world = reset('RECOVERY');
    addRepair(world, 'uncovered-critical', STRUCTURE_SPAWN);
    const remote = setArtificerWork(
        addArtificer(world, 'committed-remote'),
        'remote',
        4
    );
    assert.strictEqual(remote.memory.artificerTask, 'BUILD_REMOTE');
    const demand = fresh('spawn.request.manager.js').getArtificerBuildDemand(world.room);
    assert.strictEqual(demand.livingWorkByEconomyCategory.remote, 4);
    assert.strictEqual(demand.missingWorkByEconomyCategory.criticalMaintenance, 2);
    assert.strictEqual(demand.economyCategory, 'criticalMaintenance');
});

test('flexible Artificer WORK avoids overspawning while emergency work remains unavailable', () => {
    const flexibleWorld = reset('STABLE');
    addRepair(flexibleWorld, 'flexible-critical', STRUCTURE_SPAWN);
    const flexible = addArtificer(flexibleWorld, 'flexible-worker');
    flexible.body = [
        { type: WORK, hits: 100 }, { type: WORK, hits: 100 },
        { type: CARRY, hits: 100 }, { type: MOVE, hits: 100 }
    ];
    flexible.memory.artificerTask = 'UPGRADE_FALLBACK';
    const covered = fresh('spawn.request.manager.js').getArtificerBuildDemand(flexibleWorld.room);
    assert.strictEqual(covered.flexibleLivingWork, 2);
    assert.strictEqual(covered.missingWorkByEconomyCategory.criticalMaintenance, 0);
    assert.strictEqual(covered.missingWork, 0);

    const emergencyWorld = reset('SURVIVAL', 0.1);
    addRepair(emergencyWorld, 'emergency-critical', STRUCTURE_SPAWN);
    const emergency = addArtificer(emergencyWorld, 'emergency-worker');
    emergency.body = flexible.body;
    emergency.memory.artificerTask = 'EMERGENCY_FILL';
    const unavailable = fresh('spawn.request.manager.js').getArtificerBuildDemand(emergencyWorld.room);
    assert.strictEqual(unavailable.unavailableLivingWork, 2);
    assert.strictEqual(unavailable.missingWorkByEconomyCategory.criticalMaintenance, 2);
});

test('RECOVERY permits important local construction but still blocks routine construction', () => {
    const importantWorld = reset('RECOVERY');
    const importantSite = addSite(importantWorld, 'extension-site', STRUCTURE_EXTENSION);
    const builder = addArtificer(importantWorld, 'recovery-builder');
    fresh('role.Artificer.js').run(builder);
    assert.strictEqual(builder.lastBuild, importantSite);
    assert.strictEqual(builder.memory.artificerTask, 'BUILD_LOCAL');

    const routineWorld = reset('RECOVERY');
    addSite(routineWorld, 'road-site', STRUCTURE_ROAD);
    const guarded = addArtificer(routineWorld, 'recovery-guarded');
    fresh('role.Artificer.js').run(guarded);
    assert.strictEqual(guarded.builds, 0);

    const survivalWorld = reset('SURVIVAL', 1);
    addSite(survivalWorld, 'survival-extension', STRUCTURE_EXTENSION);
    const survivalGuarded = addArtificer(survivalWorld, 'survival-guarded');
    fresh('role.Artificer.js').run(survivalGuarded);
    assert.strictEqual(survivalGuarded.builds, 0);
});

test('routine repair does not preempt important local construction', () => {
    const world = reset();
    const road = addRepair(world, 'damaged-road', STRUCTURE_ROAD);
    const site = addSite(world, 'tower-site', STRUCTURE_TOWER);
    const creep = addArtificer(world);
    fresh('role.Artificer.js').run(creep);
    assert.strictEqual(creep.lastBuild, site);
    assert.strictEqual(creep.lastRepair, undefined);
    assert.strictEqual(creep.memory.artificerTask, 'BUILD_LOCAL');
    assert.strictEqual(road.hits < road.hitsMax, true);
});

test('empty Artificer collects energy for important RECOVERY construction', () => {
    const world = reset('RECOVERY');
    addSite(world, 'spawn-site', STRUCTURE_SPAWN);
    const container = addObject(world, {
        id: 'energy-container', structureType: STRUCTURE_CONTAINER,
        store: { [RESOURCE_ENERGY]: 500, getUsedCapacity: () => 500 },
        pos: new RoomPosition(19, 20, world.room.name)
    });
    world.room.structures.push(container);
    const creep = addArtificer(world, 'empty-builder', 0);
    let withdrawn = null;
    creep.withdraw = target => { withdrawn = target; return OK; };
    fresh('role.Artificer.js').run(creep);
    assert.strictEqual(creep.memory.artificerNextTask, 'BUILD_LOCAL');
    assert.strictEqual(withdrawn, container);
});

test('completed remembered build target is replaced', () => {
    const completedWorld = reset();
    const completed = addSite(completedWorld, 'completed-site', STRUCTURE_EXTENSION);
    completed.progress = completed.progressTotal;
    const replacement = addSite(completedWorld, 'replacement-site', STRUCTURE_EXTENSION);
    const resumed = addArtificer(completedWorld, 'resumed-builder');
    resumed.memory.buildTargetId = completed.id;
    fresh('role.Artificer.js').run(resumed);
    assert.strictEqual(resumed.lastBuild, replacement);
    assert.strictEqual(resumed.memory.buildTargetId, replacement.id);

});

test('destroyed, wrong-room, and non-owned remembered targets are replaced', () => {
    for (const invalidKind of ['destroyed', 'wrong-room', 'non-owned']) {
        const world = reset();
        const replacement = addSite(world, `${invalidKind}-replacement`, STRUCTURE_EXTENSION);
        const creep = addArtificer(world, `${invalidKind}-builder`);
        creep.memory.buildTargetId = `${invalidKind}-target`;
        if (invalidKind !== 'destroyed') {
            addObject(world, {
                id: creep.memory.buildTargetId, structureType: STRUCTURE_EXTENSION,
                my: invalidKind !== 'non-owned', progress: 0, progressTotal: 100,
                pos: new RoomPosition(21, 20, invalidKind === 'wrong-room' ? 'W9N9' : world.room.name)
            });
        }
        fresh('role.Artificer.js').run(creep);
        assert.strictEqual(creep.lastBuild, replacement);
        assert.strictEqual(creep.memory.buildTargetId, replacement.id);
    }
});

test('unreachable remembered target is cleared and a reachable replacement is selected', () => {
    const world = reset();
    const unreachable = addSite(world, 'unreachable-tower', STRUCTURE_TOWER);
    const replacement = addSite(world, 'reachable-extension', STRUCTURE_EXTENSION);
    unreachable.pos = new RoomPosition(35, 35, world.room.name);
    replacement.pos = new RoomPosition(30, 30, world.room.name);
    const creep = addArtificer(world, 'pathing-builder');
    creep.memory.buildTargetId = unreachable.id;
    creep.pos.findClosestByPath = kind => {
        if (!Array.isArray(kind)) return null;
        return kind.find(site => site.id === replacement.id) || null;
    };
    fresh('role.Artificer.js').run(creep);
    assert.strictEqual(creep.lastBuild, replacement);
    assert.strictEqual(creep.memory.buildTargetId, replacement.id);
});

test('reachability results avoid repeated pathfinding for the same failed or valid target', () => {
    for (const reachable of [false, true]) {
        const world = reset();
        const site = addSite(world, reachable ? 'cached-valid' : 'cached-unreachable', STRUCTURE_EXTENSION);
        site.pos = new RoomPosition(35, 35, world.room.name);
        const creep = addArtificer(world, reachable ? 'cached-valid-builder' : 'cached-failed-builder');
        creep.memory.buildTargetId = site.id;
        let pathCalls = 0;
        creep.pos.findClosestByPath = kind => {
            if (!Array.isArray(kind)) return null;
            pathCalls++;
            return reachable ? site : null;
        };
        creep.build = () => ERR_NOT_IN_RANGE;
        creep.travelTo = () => OK;
        const role = fresh('role.Artificer.js');
        role.run(creep);
        Game.time++;
        role.run(creep);
        assert.strictEqual(pathCalls, 1);
        if (!reachable) assert.strictEqual(creep.memory.buildTargetId, undefined);
        else assert.strictEqual(creep.memory.buildTargetId, site.id);
    }
});

test('rejected remembered target is not immediately reselected over a valid replacement', () => {
    const world = reset();
    const rejectedTarget = addSite(world, 'rejected-site', STRUCTURE_EXTENSION);
    const replacement = addSite(world, 'usable-site', STRUCTURE_EXTENSION);
    const creep = addArtificer(world, 'rejected-builder');
    creep.memory.buildTargetId = rejectedTarget.id;
    creep.build = target => {
        if (target === rejectedTarget) return ERR_INVALID_TARGET;
        creep.lastBuild = target;
        return OK;
    };
    fresh('role.Artificer.js').run(creep);
    assert.strictEqual(creep.lastBuild, replacement);
    assert.strictEqual(creep.memory.buildTargetId, replacement.id);
});

test('remembered target is preserved when valid and cleared when no longer permitted', () => {
    const stableWorld = reset();
    const remembered = addSite(stableWorld, 'remembered-road', STRUCTURE_ROAD);
    const stable = addArtificer(stableWorld, 'stable-builder');
    stable.memory.buildTargetId = remembered.id;
    fresh('role.Artificer.js').run(stable);
    assert.strictEqual(stable.lastBuild, remembered);
    assert.strictEqual(stable.memory.buildTargetId, remembered.id);

    const recoveryWorld = reset('RECOVERY');
    const blocked = addSite(recoveryWorld, 'blocked-road', STRUCTURE_ROAD);
    const recovery = addArtificer(recoveryWorld, 'recovery-builder');
    recovery.memory.buildTargetId = blocked.id;
    fresh('role.Artificer.js').run(recovery);
    assert.strictEqual(recovery.builds, 0);
    assert.strictEqual(recovery.memory.buildTargetId, undefined);
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
