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

function installCombatWorld() {
    mocks.installGlobals({ limit: 100, tickLimit: 500, bucket: 10000, getUsed: () => 0 });
    Object.assign(global, {
        FIND_STRUCTURES: 1,
        FIND_MY_STRUCTURES: 2,
        FIND_HOSTILE_CREEPS: 3,
        FIND_MY_CREEPS: 4,
        FIND_CONSTRUCTION_SITES: 5,
        FIND_HOSTILE_POWER_CREEPS: 6,
        FIND_MY_POWER_CREEPS: 7,
        STRUCTURE_TOWER: 'tower',
        STRUCTURE_SPAWN: 'spawn',
        STRUCTURE_STORAGE: 'storage',
        STRUCTURE_TERMINAL: 'terminal',
        STRUCTURE_RAMPART: 'rampart',
        STRUCTURE_WALL: 'constructedWall',
        STRUCTURE_ROAD: 'road',
        STRUCTURE_CONTAINER: 'container',
        STRUCTURE_EXTENSION: 'extension',
        STRUCTURE_CONTROLLER: 'controller',
        ATTACK_POWER: 30,
        RANGED_ATTACK_POWER: 10,
        HEAL_POWER: 12,
        RANGED_HEAL_POWER: 4,
        DISMANTLE_POWER: 50,
        TOWER_POWER_ATTACK: 600,
        TOWER_POWER_HEAL: 400,
        BOOSTS: {
            attack: { UH2O: { attack: 2 } },
            ranged_attack: { KO: { rangedAttack: 2 } },
            heal: { LO: { heal: 2 } },
            work: { ZH: { dismantle: 2 } },
            move: { ZO: { fatigue: 2 } },
            tough: { GO: { damage: 0.5 }, XGHO2: { damage: 0.3 } }
        }
    });
    mocks.clearLocalModules();
}

function pos(x, y, roomName = 'W1N1') {
    return new RoomPosition(x, y, roomName);
}

function body(types) {
    return types.map(value => typeof value === 'string' ?
        { type: value, hits: 100 } : { type: value.type, hits: value.hits === undefined ? 100 : value.hits, boost: value.boost });
}

function hostile(id, types, x, y, owner = 'Enemy') {
    const parts = body(types);
    return {
        id,
        name: id,
        owner: { username: owner },
        body: parts,
        hits: parts.length * 100,
        hitsMax: parts.length * 100,
        pos: pos(x, y),
        my: false,
        getActiveBodyparts(type) { return this.body.filter(part => part.type === type && part.hits > 0).length; }
    };
}

function roomWorld(roomName, hostiles, structures, extra = {}) {
    const room = {
        name: roomName,
        energyAvailable: 800,
        energyCapacityAvailable: 800,
        controller: Object.assign({ my: true, level: 8, pos: pos(25, 25, roomName), safeModeAvailable: 1 }, extra.controller),
        storage: extra.storage,
        find(type) {
            if (type === FIND_STRUCTURES || type === FIND_MY_STRUCTURES) return structures || [];
            if (type === FIND_HOSTILE_CREEPS) return hostiles || [];
            if (type === FIND_MY_CREEPS) return Object.values(Game.creeps).filter(creep => creep.room === room);
            return [];
        },
        getEventLog: extra.getEventLog
    };
    for (const item of hostiles || []) {
        item.room = room;
        item.pos.roomName = roomName;
    }
    for (const item of structures || []) if (item.pos) item.pos.roomName = roomName;
    Game.rooms[roomName] = room;
    Memory.rooms[roomName] = Memory.rooms[roomName] || { spawn: { queue: [] } };
    return room;
}

function tower(id, x, y, energy = 1000) {
    return {
        id,
        my: true,
        structureType: STRUCTURE_TOWER,
        pos: pos(x, y),
        store: { [RESOURCE_ENERGY]: energy, getUsedCapacity: () => energy },
        attacks: [], heals: [], repairs: [],
        attack(target) { this.attacks.push(target.id); return OK; },
        heal(target) { this.heals.push(target.id); return OK; },
        repair(target) { this.repairs.push(target.id); return OK; }
    };
}

function remoteWorld(owner = 'Invader', types = ['attack', 'move'], relevant = true) {
    installCombatWorld();
    const home = roomWorld('W1N1', [], []);
    Game.spawns.Home = { my: true, room: home, owner: { username: 'Sushi' } };
    const unit = hostile('visitor', types, 20, 20, owner);
    const remote = roomWorld('W1N2', [unit], [], { controller: { my: false } });
    if (relevant) Memory.rooms.W1N1.remotePlanner = {
        activeSourceIds: ['source'], sourceInfos: {
            source: { roomName: remote.name, active: true, state: 'ACTIVE', route: { roomSequence: ['W1N1', 'W1N2'] } }
        }, remotes: {}
    };
    delete global.__sushiTickIndex;
    return { home, remote, unit, policy: fresh('Combat.Policy.js'), ledger: fresh('Combat.ThreatLedger.js') };
}

test('NPC remote defense, Keeper classification, unrelated intel, and clear confirmation', () => {
    for (const owner of ['Invader', 'Source Keeper']) {
        const { remote, unit, policy, ledger } = remoteWorld(owner);
        assert.strictEqual(policy.setClassification(owner, 'neutral'), false);
        assert.strictEqual(policy.getClassification(owner), 'npc');
        const snapshot = ledger.observeRoom(remote, [unit]);
        assert.strictEqual(snapshot.dangerousHostileCount, 1);
        assert.strictEqual(snapshot.actionableHostileCount, 1);
        const operation = Memory.hive.operations['defend:W1N2'];
        assert.strictEqual(operation.type, 'DEFEND_REMOTE');
        assert.strictEqual(operation.originRoom, 'W1N1');
        assert(operation.desiredCapabilities.damage > 0);
        assert.strictEqual(fresh('Logic.WarRoom.js').isHostileCreepThreat(unit), true);
        const squads = fresh('Squad.Controller.js');
        squads.plan();
        assert(Object.values(Memory.hive.demands).some(d => d.role === 'Volley'));
        Game.time++;
        ledger.observeRoom(remote, []);
        assert.strictEqual(operation.state, 'COMPLETE');
        assert.strictEqual(fresh('Planner.Remote.js').hasSeriousDanger(remote), false);
        assert.strictEqual(fresh('HiveMind.Memory.js').getConfig('remote').allowKeeperRooms, false);
    }
    const { remote, unit, ledger } = remoteWorld('Invader', [ATTACK, MOVE], false);
    assert.strictEqual(ledger.observeRoom(remote, [unit]).dangerousHostileCount, 1);
    assert.strictEqual(Memory.hive.operations['defend:W1N2'], undefined);
});

test('default observe preserves danger with no human operation, spawn demand, tower or WarRoom target', () => {
    for (const classification of ['neutral', 'hostile', 'ally']) {
        const { remote, unit, policy, ledger } = remoteWorld('Bob');
        if (classification !== 'neutral') policy.setClassification('Bob', classification);
        const snapshot = ledger.observeRoom(remote, [unit]);
        assert.strictEqual(snapshot.dangerousHostileCount, classification === 'ally' ? 0 : 1);
        assert.strictEqual(snapshot.actionableHostileCount, 0);
        assert.strictEqual(Memory.hive.operations['defend:W1N2'], undefined);
        assert.strictEqual(fresh('Logic.WarRoom.js').isHostileCreepThreat(unit), false);
        const demand = fresh('Defense.Demand.js').getDemand(remote);
        assert.strictEqual(demand.desiredRanged + demand.desiredMelee + demand.desiredHealers, 0);
        fresh('Squad.Controller.js').plan();
        assert.strictEqual(Object.keys(Memory.hive.demands).length, 0);
        assert.strictEqual(fresh('Logic.Tower.js').chooseTowerTarget(remote, [tower('t', 20, 21)], [unit]), null);
    }
    const { remote, unit, ledger } = remoteWorld('Worker', [WORK, CARRY, MOVE]);
    assert.strictEqual(ledger.observeRoom(remote, [unit]).dangerousHostileCount, 0);
});

test('defend requires hostility or confirmed aggression and mode switches update permissions', () => {
    const { remote, unit, policy, ledger } = remoteWorld('Bob');
    const config = fresh('HiveMind.Memory.js').getConfig('combat').diplomacy;
    config.playerResponseMode = 'defend';
    assert.strictEqual(ledger.observeRoom(remote, [unit]).actionableHostileCount, 0);
    policy.setClassification('Bob', 'hostile');
    Game.time++;
    assert.strictEqual(ledger.observeRoom(remote, [unit]).actionableHostileCount, 1);
    config.playerResponseMode = 'observe';
    Game.time++;
    ledger.observeRoom(remote, [unit]);
    assert.strictEqual(Memory.hive.operations['defend:W1N2'].state, 'COMPLETE');
    config.playerResponseMode = 'defend';
    Game.time++;
    ledger.observeRoom(remote, [unit]);
    assert.strictEqual(Memory.hive.operations['defend:W1N2'].state, 'ACTIVE');
    assert.strictEqual(policy.mayAutoEngage(unit, { roomName: 'W9N9' }), false);
    assert.strictEqual(policy.mayLaunchOffense(unit), false);
    config.playerResponseMode = 'war';
    assert.strictEqual(policy.mayLaunchOffense(unit), true);
    policy.setClassification('Bob', 'ally');
    assert.strictEqual(policy.mayLaunchOffense(unit, true), false);
});

test('confirmed creep aggression is recorded once per tick and learned during observe', () => {
    const { remote, unit, policy, ledger } = remoteWorld('Bob');
    global.EVENT_ATTACK = 1;
    const worker = { id: 'worker', my: true, memory: { role: 'Freighter' } };
    Game.getObjectById = id => id === unit.id ? unit : id === worker.id ? worker : null;
    remote.getEventLog = () => [{ event: EVENT_ATTACK, objectId: unit.id, data: { targetId: worker.id } }];
    for (let i = 0; i < 3; i++) {
        Game.time++;
        ledger.observeRoom(remote, [unit]);
        const score = Memory.hive.players.Bob.incidentScore;
        ledger.observeRoom(remote, [unit]);
        assert.strictEqual(Memory.hive.players.Bob.incidentScore, score);
    }
    assert.strictEqual(policy.getClassification('Bob'), 'hostile');
    assert.strictEqual(Memory.hive.players.Bob.classification, 'hostile');
    assert.strictEqual(Memory.hive.players.Bob.lastIncident.roomName, remote.name);
    assert.strictEqual(Memory.hive.operations['defend:W1N2'], undefined);
    assert.strictEqual(fresh('Planner.Remote.js').hasSeriousDanger(remote), true);
    policy.setClassification('Bob', 'ally');
    const score = Memory.hive.players.Bob.incidentScore;
    Game.time++;
    ledger.observeRoom(remote, [unit]);
    assert.strictEqual(Memory.hive.players.Bob.incidentScore, score);
    assert.strictEqual(policy.getClassification('Bob'), 'ally');
});

test('tower fire and unrelated targets never create diplomacy incidents; tower damage remains', () => {
    const { remote, unit, policy, ledger } = remoteWorld('Bob');
    global.EVENT_ATTACK = 1;
    const enemyTower = { ...tower('enemyTower', 20, 20), my: false, owner: { username: 'Bob' } };
    const worker = { id: 'worker', my: true, pos: pos(20, 21, remote.name) };
    Game.getObjectById = id => ({ enemyTower, worker, visitor: unit })[id];
    remote.getEventLog = () => [{ event: EVENT_ATTACK, objectId: 'enemyTower', data: { targetId: 'worker' } }];
    ledger.observeRoom(remote, [unit]);
    assert.strictEqual(policy.ensurePlayer('Bob').incidentScore, 0);
    assert(fresh('Combat.Math.js').towerDamage(enemyTower, worker) > 0);
    worker.my = undefined;
    remote.getEventLog = () => [{ event: EVENT_ATTACK, objectId: 'visitor', data: { targetId: 'worker' } }];
    Game.time++;
    ledger.observeRoom(remote, [unit]);
    assert.strictEqual(policy.ensurePlayer('Bob').incidentScore, 0);
});

test('lost vision retains NPC danger briefly, expires defense, and honors player mode changes', () => {
    const { remote, unit, ledger } = remoteWorld();
    ledger.observeRoom(remote, [unit]);
    delete Game.rooms[remote.name];
    Game.time++;
    delete global.__sushiTickIndex;
    ledger.run();
    assert.strictEqual(Memory.hive.operations['defend:W1N2'].state, 'ACTIVE');
    Game.time += 1501;
    delete global.__sushiTickIndex;
    ledger.run();
    assert.strictEqual(Memory.hive.operations['defend:W1N2'].state, 'COMPLETE');
    assert.strictEqual(ledger.getRoomThreat(remote.name), null);
});

test('cached targets and area attacks respect observation while explicit manual orders remain usable', () => {
    const { remote, unit, ledger, policy } = remoteWorld('Bob');
    ledger.observeRoom(remote, [unit]);
    Game.getObjectById = id => id === unit.id ? unit : null;
    const war = fresh('Logic.WarRoom.js');
    const member = { room: remote, pos: pos(20, 21, remote.name), memory: { combatTargetId: unit.id } };
    // Apply Screeps find filters, which the minimal room fixture normally ignores.
    const find = remote.find;
    remote.find = (type, options) => find(type).filter(item => !options || !options.filter || options.filter(item));
    assert.strictEqual(war.getCombatTarget(member), null);
    assert.strictEqual(war.mayMassAttack(member), false);
    Memory.hive.operations.manual = { state: 'ACTIVE', manualDirective: true, policyApproved: true,
        targetRoom: remote.name, targetOwner: 'Bob', type: 'ATTACK_PLAYER' };
    member.memory.operationId = 'manual';
    assert.strictEqual(war.getCombatTarget(member), unit);
    policy.setClassification('Bob', 'ally');
    assert.strictEqual(war.getCombatTarget(member), null);
    assert.strictEqual(war.mayMassAttack(member), false);
});

test('NPC toggle and unseen human mode changes cancel automatic replacements', () => {
    let world = remoteWorld();
    const config = fresh('HiveMind.Memory.js').getConfig('combat').diplomacy;
    config.npcAutoDefense = false;
    assert.strictEqual(world.ledger.observeRoom(world.remote, [world.unit]).actionableHostileCount, 0);
    assert.strictEqual(Memory.hive.operations['defend:W1N2'], undefined);
    world = remoteWorld('Bob');
    world.policy.setClassification('Bob', 'hostile');
    const diplomacy = fresh('HiveMind.Memory.js').getConfig('combat').diplomacy;
    diplomacy.playerResponseMode = 'defend';
    world.ledger.observeRoom(world.remote, [world.unit]);
    const squads = fresh('Squad.Controller.js');
    squads.plan();
    delete Game.rooms[world.remote.name];
    delete global.__sushiTickIndex;
    Game.time++;
    diplomacy.playerResponseMode = 'observe';
    world.ledger.run();
    assert.strictEqual(Memory.hive.operations['defend:W1N2'].state, 'COMPLETE');
    for (const squad of Object.values(Memory.hive.squads)) assert.deepStrictEqual(squads.emitDemands(squad), []);
});

console.log(`Combat diplomacy tests passed: ${passed}`);

