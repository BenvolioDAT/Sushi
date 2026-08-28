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
    Memory.rooms[roomName] = Memory.rooms[roomName] || { spawnQueue: [] };
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

test('Memory migration is additive and versioned', function() {
    installCombatWorld();
    Memory.hive = { players: { Friend: { classification: 'ally', manual: true } }, custom: 7 };
    const hive = fresh('HiveMind.Memory.js').migrate();
    assert.strictEqual(hive.custom, 7);
    assert.strictEqual(hive.players.Friend.classification, 'ally');
    assert.strictEqual(hive.schemaVersion, 4);
    assert.deepStrictEqual(hive.operations, {});
});

test('diplomacy honors allies, manual hostiles, NPCs, and decaying incidents', function() {
    installCombatWorld();
    const policy = fresh('Combat.Policy.js');
    policy.setClassification('Friend', 'ally');
    assert.strictEqual(policy.isAlly('Friend'), true);
    assert.strictEqual(policy.shouldDefendAgainst('Friend', { melee: 100 }, true), false);
    policy.setClassification('Enemy', 'hostile');
    assert.strictEqual(policy.mayLaunchOffense('Enemy'), true);
    assert.strictEqual(policy.getClassification('Invader'), 'npc');
    policy.recordIncident('Unknown', 120, { roomName: 'W1N1' });
    assert.strictEqual(policy.getClassification('Unknown'), 'hostile');
    Game.time += 50000;
    assert.strictEqual(policy.getClassification('Unknown'), 'neutral');
});

test('boost-aware combat math covers damage, healing, TOUGH, movement, and TTK', function() {
    installCombatWorld();
    const math = fresh('Combat.Math.js');
    const unit = hostile('boosted', [
        { type: TOUGH, boost: 'XGHO2' },
        { type: ATTACK, boost: 'UH2O' },
        { type: RANGED_ATTACK, boost: 'KO' },
        { type: HEAL, boost: 'LO' },
        { type: WORK, boost: 'ZH' },
        { type: MOVE, boost: 'ZO' }
    ], 10, 10);
    const analysis = math.analyzeBody(unit);
    assert.strictEqual(analysis.melee, 60);
    assert.strictEqual(analysis.ranged, 20);
    assert.strictEqual(analysis.heal, 24);
    assert.strictEqual(analysis.dismantle, 100);
    assert.ok(analysis.effectiveHits > analysis.liveHits);
    assert.strictEqual(analysis.movePower, 4);
    assert.strictEqual(math.damageAfterTough(unit, 300), 90);
    assert.strictEqual(math.timeToKill(unit, 0), Infinity);
    const close = hostile('close', [MOVE], 11, 10);
    assert.strictEqual(math.rangedMassDamage(unit, [close]), 20);
});

test('allies and harmless neutral WORK creeps do not create defense operations', function() {
    installCombatWorld();
    const worker = hostile('worker', [WORK, CARRY, MOVE], 20, 20, 'WorkerOwner');
    const ally = hostile('ally', [ATTACK, MOVE], 21, 20, 'Friend');
    const spawn = { id: 'spawn', my: true, structureType: STRUCTURE_SPAWN, pos: pos(25, 25), hits: 5000, hitsMax: 5000 };
    const room = roomWorld('W1N1', [worker, ally], [spawn]);
    const policy = fresh('Combat.Policy.js');
    policy.setClassification('Friend', 'ally');
    const ledger = fresh('Combat.ThreatLedger.js');
    const threat = ledger.observeRoom(room, [worker, ally]);
    assert.strictEqual(threat.harmfulHostileCount, 0);
    assert.strictEqual(Memory.hive.operations['defend:W1N1'], undefined);
    const warRoom = fresh('Logic.WarRoom.js');
    assert.strictEqual(warRoom.isHostileCreepThreat(worker), false);
    assert.strictEqual(warRoom.isHostileCreepThreat(ally), false);
});

test('real combat creeps create independent room defense operations', function() {
    installCombatWorld();
    const a = hostile('a', [ATTACK, MOVE], 24, 25, 'RaiderA');
    const b = hostile('b', [RANGED_ATTACK, MOVE], 24, 25, 'RaiderB');
    const spawnA = { id: 'spawnA', my: true, structureType: STRUCTURE_SPAWN, pos: pos(25, 25, 'W1N1') };
    const spawnB = { id: 'spawnB', my: true, structureType: STRUCTURE_SPAWN, pos: pos(25, 25, 'W2N2') };
    const roomA = roomWorld('W1N1', [a], [spawnA]);
    const roomB = roomWorld('W2N2', [b], [spawnB]);
    Game.spawns = { A: { my: true, room: roomA }, B: { my: true, room: roomB } };
    delete global.__sushiTickIndex;
    const ledger = fresh('Combat.ThreatLedger.js');
    assert.strictEqual(ledger.observeRoom(roomA, [a]).harmfulHostileCount, 1);
    assert.strictEqual(ledger.observeRoom(roomB, [b]).harmfulHostileCount, 1);
    assert.strictEqual(Memory.hive.operations['defend:W1N1'].state, 'ACTIVE');
    assert.strictEqual(Memory.hive.operations['defend:W2N2'].state, 'ACTIVE');
});

test('tower target prediction favors a guaranteed important healer kill', function() {
    installCombatWorld();
    const tank = hostile('tank', Array(20).fill(TOUGH).concat([ATTACK, MOVE]), 24, 25, 'Enemy');
    const healer = hostile('healer', [HEAL, MOVE], 25, 24, 'Enemy');
    healer.hits = 100;
    const defenseTower = tower('tower', 20, 20);
    const spawn = { id: 'spawn', my: true, structureType: STRUCTURE_SPAWN, pos: pos(25, 25) };
    const room = roomWorld('W1N1', [tank, healer], [defenseTower, spawn]);
    fresh('Combat.Policy.js').setClassification('Enemy', 'hostile');
    fresh('Combat.ThreatLedger.js').observeRoom(room, [tank, healer]);
    const towerLogic = fresh('Logic.Tower.js');
    const evaluation = towerLogic.chooseTowerTarget(room, [defenseTower], [tank, healer]);
    assert.strictEqual(evaluation.target.id, 'healer');
    assert.strictEqual(evaluation.killable, true);
});

test('towers heal a predicted casualty instead of wasting fire', function() {
    installCombatWorld();
    const attacker = hostile('attacker', Array(20).fill(ATTACK).concat([MOVE]), 21, 20, 'Enemy');
    attacker.hits = attacker.hitsMax = 5000;
    const defenseTower = tower('tower', 20, 20);
    const spawn = { id: 'spawn', my: true, structureType: STRUCTURE_SPAWN, pos: pos(25, 25) };
    const room = roomWorld('W1N1', [attacker], [defenseTower, spawn]);
    const defender = {
        id: 'defender', name: 'defender', my: true, room, pos: pos(20, 21),
        hits: 100, hitsMax: 1000, memory: { role: 'Ronin', homeRoom: 'W1N1' }, body: body([ATTACK, MOVE])
    };
    Game.creeps.defender = defender;
    fresh('Combat.Policy.js').setClassification('Enemy', 'hostile');
    delete global.__sushiTickIndex;
    fresh('Combat.ThreatLedger.js').observeRoom(room, [attacker]);
    const decision = fresh('Logic.Tower.js').run(room);
    assert.strictEqual(decision.action, 'heal');
    assert.deepStrictEqual(defenseTower.heals, ['defender']);
    assert.deepStrictEqual(defenseTower.attacks, []);
});

test('dynamic defender demand is zero in peace and clears standing army requests', function() {
    installCombatWorld();
    const spawnStructure = { id: 'spawn', my: true, structureType: STRUCTURE_SPAWN, pos: pos(25, 25) };
    const room = roomWorld('W1N1', [], [spawnStructure]);
    Memory.rooms.W1N1.spawnQueue = [
        { role: 'Ronin', memory: { role: 'Ronin', homeRoom: 'W1N1' } },
        { role: 'Volley', memory: { role: 'Volley', homeRoom: 'W1N1' } },
        { role: 'Cleric', memory: { role: 'Cleric', homeRoom: 'W1N1' } }
    ];
    Game.spawns.Spawn1 = { my: true, room };
    delete global.__sushiTickIndex;
    fresh('Combat.ThreatLedger.js').observeRoom(room, []);
    const manager = fresh('spawn.request.manager.js');
    const result = manager.requestDefendersForRoom(room, null);
    assert.strictEqual(result.demand.desiredMelee + result.demand.desiredRanged + result.demand.desiredHealers, 0);
    assert.strictEqual(Memory.rooms.W1N1.spawnQueue.length, 0);
});

test('safe mode ignores scouts and activates only for an overwhelming critical breach', function() {
    installCombatWorld();
    let activations = 0;
    const scout = hostile('scout', [MOVE], 20, 20, 'Unknown');
    const spawn = { id: 'spawn', my: true, structureType: STRUCTURE_SPAWN, pos: pos(25, 25) };
    const room = roomWorld('W1N1', [scout], [spawn], {
        controller: { activateSafeMode() { activations++; return OK; } }
    });
    let ledger = fresh('Combat.ThreatLedger.js');
    ledger.observeRoom(room, [scout]);
    let policy = fresh('SafeMode.Policy.js');
    assert.strictEqual(policy.run(room).activated, false);
    assert.strictEqual(activations, 0);

    Game.time++;
    const breach = hostile('breach', Array(20).fill(ATTACK).concat([MOVE]), 25, 24, 'Enemy');
    breach.room = room;
    room.find = function(type) {
        if (type === FIND_STRUCTURES || type === FIND_MY_STRUCTURES) return [spawn];
        if (type === FIND_HOSTILE_CREEPS) return [breach];
        if (type === FIND_MY_CREEPS) return [];
        return [];
    };
    fresh('Combat.Policy.js').setClassification('Enemy', 'hostile');
    delete global.__sushiTickIndex;
    ledger = fresh('Combat.ThreatLedger.js');
    ledger.observeRoom(room, [breach]);
    Memory.hive.settings.safeMode.manualConfirmation = false;
    policy = fresh('SafeMode.Policy.js');
    assert.strictEqual(policy.run(room).activated, true);
    assert.strictEqual(activations, 1);
});

test('fortification targets scale with RCL, economy, and threat', function() {
    installCombatWorld();
    const wall = { id: 'wall', structureType: STRUCTURE_WALL, hits: 1000, hitsMax: 100000000, pos: pos(10, 10) };
    const room = roomWorld('W1N1', [], [wall], { storage: { store: { [RESOURCE_ENERGY]: 300000 } } });
    const towerLogic = fresh('Logic.Tower.js');
    const peaceful = towerLogic.getFortificationTarget(room, wall);
    const invader = hostile('invader', [ATTACK, MOVE], 11, 10, 'Invader');
    invader.room = room;
    fresh('Combat.ThreatLedger.js').observeRoom(room, [invader]);
    const threatened = towerLogic.getFortificationTarget(room, wall);
    assert.ok(peaceful > 10000);
    assert.ok(threatened > peaceful);
});

console.log(`Phase 3 tests passed: ${passed}`);
