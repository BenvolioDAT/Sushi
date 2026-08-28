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
        FIND_HOSTILE_CREEPS: 2,
        FIND_MY_CREEPS: 3,
        FIND_CONSTRUCTION_SITES: 4,
        FIND_HOSTILE_POWER_CREEPS: 5,
        FIND_MY_POWER_CREEPS: 6,
        STRUCTURE_TOWER: 'tower',
        STRUCTURE_RAMPART: 'rampart',
        STRUCTURE_SPAWN: 'spawn',
        STRUCTURE_CONTROLLER: 'controller',
        TERRAIN_MASK_WALL: 1,
        LOOK_STRUCTURES: 'structure',
        ATTACK_POWER: 30,
        RANGED_ATTACK_POWER: 10,
        HEAL_POWER: 12,
        RANGED_HEAL_POWER: 4,
        DISMANTLE_POWER: 50,
        TOWER_POWER_ATTACK: 600,
        BOOSTS: {
            ranged_attack: { XKHO2: { rangedAttack: 4 } },
            heal: { XLHO2: { heal: 4 } },
            tough: { XGHO2: { damage: 0.3 } }
        },
        OBSTACLE_OBJECT_TYPES: ['spawn', 'extension', 'constructedWall']
    });
    delete global.__sushiDemandBoard;
    mocks.clearLocalModules();
}

function position(x, y, roomName = 'W1N1') {
    return new RoomPosition(x, y, roomName);
}

function parts(types) {
    return types.map(value => typeof value === 'string' ? { type: value, hits: 100 } : {
        type: value.type, hits: value.hits === undefined ? 100 : value.hits, boost: value.boost
    });
}

function room(name = 'W1N1', hostiles = [], structures = []) {
    const result = {
        name,
        controller: { my: true, level: 8 },
        energyAvailable: 3000,
        energyCapacityAvailable: 3000,
        find(type) {
            if (type === FIND_HOSTILE_CREEPS) return hostiles;
            if (type === FIND_STRUCTURES) return structures;
            if (type === FIND_MY_CREEPS) return Object.values(Game.creeps).filter(creep => creep.room === result);
            return [];
        },
        lookForAt() { return []; }
    };
    for (const hostile of hostiles) hostile.room = result;
    Game.rooms[name] = result;
    Memory.rooms[name] = { spawnQueue: [] };
    return result;
}

function creep(name, role, types, x, y, creepRoom) {
    const result = new Creep();
    Object.assign(result, {
        id: name,
        name,
        my: true,
        room: creepRoom,
        pos: position(x, y, creepRoom.name),
        body: parts(types),
        hits: types.length * 100,
        hitsMax: types.length * 100,
        fatigue: 0,
        ticksToLive: 1200,
        spawning: false,
        memory: { role, homeRoom: creepRoom.name },
        attacks: [],
        massAttacks: 0,
        heals: [],
        rangedHeals: [],
        rangedAttack(target) { this.attacks.push(target.id); return OK; },
        rangedMassAttack() { this.massAttacks++; return OK; },
        heal(target) { this.heals.push(target.name); return OK; },
        rangedHeal(target) { this.rangedHeals.push(target.name); return OK; },
        say() { return OK; },
        getActiveBodyparts(type) { return this.body.filter(part => part.type === type && part.hits > 0).length; },
        setTrafficLock(value) { this.trafficLocked = value; return OK; }
    });
    Game.creeps[name] = result;
    return result;
}

function enemy(name, types, x, y, enemyRoom, hits) {
    const body = parts(types);
    const result = {
        id: name,
        name,
        my: false,
        owner: { username: 'Enemy' },
        room: enemyRoom,
        pos: position(x, y, enemyRoom.name),
        body,
        hits: hits === undefined ? body.length * 100 : hits,
        hitsMax: body.length * 100,
        getActiveBodyparts(type) { return this.body.filter(part => part.type === type && part.hits > 0).length; }
    };
    return result;
}

function operation(id = 'defend:W1N1') {
    const hive = fresh('HiveMind.Memory.js').ensure();
    hive.operations[id] = {
        id,
        type: 'DEFEND_OWNED_ROOM',
        state: 'ACTIVE',
        priority: 95,
        originRoom: 'W1N1',
        targetRoom: 'W1N1',
        desiredCapabilities: { damage: 100, healing: 50 },
        assignedCreeps: [],
        assignedSquads: []
    };
    return hive.operations[id];
}

function attach(squad, attacker, healer) {
    for (const [slot, member] of [['attacker', attacker], ['healer', healer]]) {
        if (!member) continue;
        member.memory.squadId = squad.id;
        member.memory.squadSlot = slot;
        member.memory.operationId = squad.operationId;
    }
    delete global.__sushiTickIndex;
}

test('duo Memory has every required durable field and survives module reload', function() {
    reset();
    room();
    operation();
    const controller = fresh('Squad.Controller.js');
    const squad = controller.createDuo({
        id: 'duo:test', operationId: 'defend:W1N1', originRoom: 'W1N1', targetRoom: 'W2N2'
    });
    assert.deepStrictEqual(Array.from(controller.STATES), [
        'FORMING', 'RALLYING', 'BOOSTING', 'MARCHING', 'ENGAGING',
        'RETREATING', 'RECOVERING', 'COMPLETE', 'ABORTED'
    ]);
    for (const field of [
        'id', 'operationId', 'type', 'state', 'leader', 'members', 'desiredMemberCapabilities',
        'rallyPosition', 'targetRoom', 'sharedTargetId', 'formationMode', 'stateStartTick',
        'retreatDestination', 'readinessThreshold', 'abortThreshold', 'expectedTravelTime',
        'minimumAcceptableTTL', 'replacementRequirements', 'debugReason'
    ]) assert.notStrictEqual(squad[field], undefined, field);
    mocks.clearLocalModules();
    assert.strictEqual(require(path.join(mocks.root, 'Squad.Controller.js')).get('duo:test').targetRoom, 'W2N2');
});

test('guarded transitions reject invalid reversals and timeout into recovery', function() {
    reset();
    room();
    operation();
    const controller = fresh('Squad.Controller.js');
    const squad = controller.createDuo({ id: 'duo:test', operationId: 'defend:W1N1', originRoom: 'W1N1', targetRoom: 'W2N2' });
    assert.strictEqual(controller.transition(squad, 'RALLYING', 'formed'), true);
    assert.strictEqual(controller.transition(squad, 'FORMING', 'invalid reverse'), false);
    squad.stateStartTick = Game.time - 251;
    controller.runSquad(squad);
    assert.strictEqual(squad.state, 'RECOVERING');
    assert.strictEqual(squad.debugReason, 'RALLYING timed out');
});

test('forming waits for both members and rejects insufficient travel TTL', function() {
    reset();
    const home = room();
    operation();
    const controller = fresh('Squad.Controller.js');
    const squad = controller.createDuo({ id: 'duo:test', operationId: 'defend:W1N1', originRoom: home.name, targetRoom: 'W2N2' });
    const attacker = creep('attacker', 'Volley', [MOVE, RANGED_ATTACK], 24, 25, home);
    attach(squad, attacker, null);
    controller.runSquad(squad);
    assert.strictEqual(squad.state, 'FORMING');
    const healer = creep('healer', 'Cleric', [MOVE, HEAL], 25, 25, home);
    healer.ticksToLive = squad.minimumAcceptableTTL - 1;
    attach(squad, attacker, healer);
    controller.runSquad(squad);
    assert.strictEqual(squad.state, 'FORMING');
    healer.ticksToLive = 1200;
    controller.runSquad(squad);
    assert.strictEqual(squad.state, 'RALLYING');
});

test('rallied adjacent members advance to marching while blocked leaders hold', function() {
    reset();
    const home = room();
    operation();
    const controller = fresh('Squad.Controller.js');
    const squad = controller.createDuo({ id: 'duo:test', operationId: 'defend:W1N1', originRoom: home.name, targetRoom: 'W2N2' });
    const attacker = creep('attacker', 'Volley', [MOVE, RANGED_ATTACK], 24, 25, home);
    const healer = creep('healer', 'Cleric', [MOVE, HEAL], 25, 25, home);
    attach(squad, attacker, healer);
    squad.state = 'RALLYING';
    controller.runSquad(squad);
    assert.strictEqual(squad.state, 'MARCHING');
    attacker.fatigue = 1;
    controller.runSquad(squad);
    assert.strictEqual(attacker.trafficLocked, true);
    assert.strictEqual(squad.debugReason, 'Holding leader for follower or fatigue');
});

test('melee pressure produces a deterministic kite tile without abandoning a safe rampart', function() {
    reset();
    const arena = room();
    const attacker = creep('attacker', 'Volley', [MOVE, RANGED_ATTACK, RANGED_ATTACK], 10, 10, arena);
    const healer = creep('healer', 'Cleric', [MOVE, HEAL], 9, 10, arena);
    const melee = enemy('melee', [MOVE, ATTACK], 11, 10, arena);
    const tactics = fresh('Squad.Tactics.js');
    const decision = tactics.evaluateDuo(attacker, healer, [melee], []);
    assert.strictEqual(decision.movement, 'kite');
    const kite = tactics.chooseKitePositions(attacker, healer, [melee]);
    assert.ok(kite.primary);
    assert.ok(kite.primary.getRangeTo(melee) > attacker.pos.getRangeTo(melee));
    arena.lookForAt = (type, x, y) => x === 10 && y === 10 ?
        [{ structureType: STRUCTURE_RAMPART, my: true }] : [];
    assert.strictEqual(tactics.chooseKitePositions(attacker, healer, [melee]).primary, null);
});

test('independent Volley fallback also kites a nearby melee threat through travel', function() {
    reset();
    const hostiles = [];
    const arena = room('W1N1', hostiles);
    const volley = creep('volley', 'Volley', [MOVE, RANGED_ATTACK], 10, 10, arena);
    const melee = enemy('melee', [MOVE, ATTACK], 11, 10, arena);
    hostiles.push(melee);
    const role = fresh('role.Volley.js');
    const travelApi = require(path.join(mocks.root, 'utility.Travel.Creep.js'));
    let movement = null;
    travelApi.move = (member, target, options) => { movement = { member, target, options }; return OK; };
    role.run(volley);
    assert.ok(movement);
    assert.strictEqual(movement.member, volley);
    assert.ok(movement.target.getRangeTo(melee) > volley.pos.getRangeTo(melee));
    assert.strictEqual(movement.options.trafficPriority, 70);
});

test('boosted and tower-supported burst forces retreat', function() {
    reset();
    const arena = room();
    const attacker = creep('attacker', 'Volley', [MOVE, RANGED_ATTACK], 10, 10, arena);
    const healer = creep('healer', 'Cleric', [MOVE, HEAL], 10, 11, arena);
    attacker.hits = 150;
    healer.hits = 100;
    const boosted = enemy('boosted', [
        MOVE,
        { type: RANGED_ATTACK, boost: 'XKHO2' },
        { type: RANGED_ATTACK, boost: 'XKHO2' }
    ], 11, 10, arena);
    const tower = { structureType: STRUCTURE_TOWER, my: false, pos: position(12, 10), store: { [RESOURCE_ENERGY]: 1000 } };
    const decision = fresh('Squad.Tactics.js').evaluateDuo(attacker, healer, [boosted], [tower]);
    assert.strictEqual(decision.retreat, true);
    assert.match(decision.retreatReason, /cannot survive predicted damage/);
});

test('predictive healing protects the member most likely to die', function() {
    reset();
    const arena = room();
    const attacker = creep('attacker', 'Volley', [MOVE, RANGED_ATTACK, RANGED_ATTACK], 10, 10, arena);
    const healer = creep('healer', 'Cleric', [MOVE, HEAL, HEAL], 9, 10, arena);
    attacker.hits = attacker.hitsMax - 50;
    healer.hits = healer.hitsMax - 120;
    const melee = enemy('melee', [ATTACK, ATTACK, ATTACK], 11, 10, arena);
    const choice = fresh('Squad.Tactics.js').chooseHealTarget([attacker, healer], [melee], []);
    assert.strictEqual(choice.member, attacker, 'larger missing-hit healer incorrectly beat immediate attacker risk');
});

test('shared target lock focuses fire and mass attack is chosen only when superior', function() {
    reset();
    const arena = room();
    const attacker = creep('attacker', 'Volley', [MOVE, RANGED_ATTACK, RANGED_ATTACK], 10, 10, arena);
    const healer = creep('healer', 'Cleric', [MOVE, HEAL], 9, 10, arena);
    const first = enemy('first', [HEAL, MOVE], 12, 10, arena, 100);
    const second = enemy('second', [ATTACK, MOVE], 11, 10, arena);
    const third = enemy('third', [ATTACK, MOVE], 10, 11, arena);
    const tactics = fresh('Squad.Tactics.js');
    assert.strictEqual(tactics.selectTarget(attacker, [second], first), first);
    assert.strictEqual(tactics.chooseAttackMode(attacker, first, [first]), 'single');
    assert.strictEqual(tactics.chooseAttackMode(attacker, first, [first, second, third]), 'mass');
    assert.strictEqual(tactics.evaluateDuo(attacker, healer, [second], [], { lockedTarget: first }).target, first);
});

test('engaging duo executes one shared focus-fire and predictive-heal plan', function() {
    reset();
    const hostiles = [];
    const arena = room('W1N1', hostiles);
    operation();
    const target = enemy('enemy-healer', [MOVE, RANGED_ATTACK, HEAL], 12, 10, arena);
    hostiles.push(target);
    Game.getObjectById = id => id === target.id ? target : null;
    const controller = fresh('Squad.Controller.js');
    const squad = controller.createDuo({ id: 'duo:test', operationId: 'defend:W1N1', originRoom: arena.name, targetRoom: arena.name });
    const attacker = creep('attacker', 'Volley', [MOVE, RANGED_ATTACK, RANGED_ATTACK], 10, 10, arena);
    const healer = creep('healer', 'Cleric', [MOVE, HEAL], 9, 10, arena);
    attacker.hits -= 50;
    attach(squad, attacker, healer);
    squad.state = 'ENGAGING';
    controller.runSquad(squad);
    assert.strictEqual(squad.sharedTargetId, target.id);
    assert.deepStrictEqual(attacker.attacks, [target.id]);
    assert.deepStrictEqual(healer.heals, [attacker.name]);
});

test('border separation regroups instead of issuing conflicting march paths', function() {
    reset();
    const origin = room('W1N1');
    const next = room('W2N2');
    operation();
    const controller = fresh('Squad.Controller.js');
    const travelApi = require(path.join(mocks.root, 'utility.Travel.Creep.js'));
    travelApi.moveOffExit = member => { member.exitHandled = true; return true; };
    travelApi.move = (member, target) => { member.moveTarget = target.name || target.roomName; return OK; };
    const squad = controller.createDuo({ id: 'duo:test', operationId: 'defend:W1N1', originRoom: origin.name, targetRoom: next.name });
    const attacker = creep('attacker', 'Volley', [MOVE, RANGED_ATTACK], 0, 25, next);
    const healer = creep('healer', 'Cleric', [MOVE, HEAL], 49, 25, origin);
    attach(squad, attacker, healer);
    squad.state = 'MARCHING';
    controller.runSquad(squad);
    assert.strictEqual(attacker.exitHandled, true);
    assert.strictEqual(healer.moveTarget, 'attacker');
    assert.strictEqual(squad.formationMode, 'RALLY');
});

test('healer loss triggers retreat and replacements remain deduplicated', function() {
    reset();
    const arena = room();
    operation();
    const controller = fresh('Squad.Controller.js');
    const squad = controller.createDuo({ id: 'duo:test', operationId: 'defend:W1N1', originRoom: arena.name, targetRoom: arena.name });
    const attacker = creep('attacker', 'Volley', [MOVE, RANGED_ATTACK], 10, 10, arena);
    attach(squad, attacker, null);
    squad.state = 'ENGAGING';
    controller.emitDemands(squad);
    controller.emitDemands(squad);
    assert.strictEqual(fresh('Spawn.DemandBoard.js').getDemands().length, 2);
    controller.runSquad(squad);
    assert.strictEqual(squad.state, 'RETREATING');
    assert.match(squad.debugReason, /Healer lost/);
});

test('squad assignment matching cannot borrow another squad member', function() {
    reset();
    const board = fresh('Spawn.DemandBoard.js');
    const demand = board.emit({
        id: 'squad:a:attacker', operationId: 'op', squadId: 'a', role: 'Volley', count: 1,
        capabilities: { ranged: 1 }
    });
    assert.strictEqual(board.memoryMatches(demand, { operationId: 'op', squadId: 'b', role: 'Volley' }), false);
    assert.strictEqual(board.memoryMatches(demand, { operationId: 'op', squadId: 'a', role: 'Volley' }), true);
});

test('squad-controlled creeps skip conflicting independent role execution', function() {
    reset();
    const arena = room();
    operation();
    const controller = fresh('Squad.Controller.js');
    const squad = controller.createDuo({ id: 'duo:test', operationId: 'defend:W1N1', originRoom: arena.name, targetRoom: arena.name });
    const attacker = creep('attacker', 'Volley', [MOVE, RANGED_ATTACK], 25, 25, arena);
    attach(squad, attacker, null);
    const dispatcher = fresh('Tick.Creeps.js');
    let independentRuns = 0;
    dispatcher.roles.Volley.run = () => { independentRuns++; };
    dispatcher.run();
    assert.strictEqual(independentRuns, 0);
});

console.log(`Phase 5 tests passed: ${passed}`);
