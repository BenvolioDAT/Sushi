const assert = require('assert');
const fs = require('fs');
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
        FIND_HOSTILE_STRUCTURES: 3,
        FIND_MY_CREEPS: 4,
        FIND_CONSTRUCTION_SITES: 5,
        FIND_HOSTILE_POWER_CREEPS: 6,
        FIND_MY_POWER_CREEPS: 7,
        STRUCTURE_TOWER: 'tower',
        STRUCTURE_RAMPART: 'rampart',
        STRUCTURE_WALL: 'constructedWall',
        STRUCTURE_SPAWN: 'spawn',
        STRUCTURE_CONTROLLER: 'controller',
        TERRAIN_MASK_WALL: 1,
        LOOK_STRUCTURES: 'structure',
        ATTACK_POWER: 30,
        RANGED_ATTACK_POWER: 10,
        HEAL_POWER: 12,
        RANGED_HEAL_POWER: 4,
        DISMANTLE_POWER: 50,
        REPAIR_POWER: 100,
        TOWER_POWER_ATTACK: 600,
        BOOSTS: {},
        OBSTACLE_OBJECT_TYPES: ['spawn', 'extension', 'constructedWall']
    });
    delete global.__sushiDemandBoard;
    delete global.__sushiQuadMatrices;
    delete global.__sushiOffenseRoutes;
    mocks.clearLocalModules();
}

function pos(x, y, roomName = 'W1N1') {
    return new RoomPosition(x, y, roomName);
}

function parts(types) {
    return types.map(value => typeof value === 'string' ? { type: value, hits: 100 } : {
        type: value.type,
        hits: value.hits === undefined ? 100 : value.hits,
        boost: value.boost
    });
}

function makeRoom(name = 'W1N1', options = {}) {
    const hostiles = options.hostiles || [];
    const structures = options.structures || [];
    const hostileStructures = options.hostileStructures || structures.filter(structure => structure.my === false);
    const room = {
        name,
        controller: options.controller || { my: name === 'W1N1', level: 8 },
        energyAvailable: 3000,
        energyCapacityAvailable: 3000,
        find(type) {
            if (type === FIND_HOSTILE_CREEPS) return hostiles;
            if (type === FIND_HOSTILE_STRUCTURES) return hostileStructures;
            if (type === FIND_STRUCTURES) return structures;
            if (type === FIND_MY_CREEPS) return Object.values(Game.creeps).filter(creep => creep.room === room);
            return [];
        },
        lookForAt(type, x, y) {
            if (type !== LOOK_STRUCTURES) return [];
            return structures.filter(structure => structure.pos && structure.pos.x === x && structure.pos.y === y);
        }
    };
    for (const object of hostiles.concat(structures)) {
        object.room = room;
        if (object.pos) object.pos.roomName = name;
    }
    Game.rooms[name] = room;
    Memory.rooms[name] = { spawnQueue: [] };
    Game.getObjectById = id => Object.values(Game.creeps).find(creep => creep.id === id || creep.name === id) ||
        hostiles.concat(structures).find(object => object.id === id) || null;
    return room;
}

function makeCreep(name, role, types, x, y, room) {
    const body = parts(types);
    const creep = new Creep();
    Object.assign(creep, {
        id: name,
        name,
        my: true,
        room,
        pos: pos(x, y, room.name),
        body,
        hits: body.length * 100,
        hitsMax: body.length * 100,
        fatigue: 0,
        ticksToLive: 1400,
        spawning: false,
        memory: { role, homeRoom: 'W1N1' },
        attacks: [],
        meleeAttacks: [],
        dismantles: [],
        heals: [],
        rangedHeals: [],
        pulls: [],
        rangedAttack(target) { this.attacks.push(target.id); return OK; },
        rangedMassAttack() { this.massAttacks = (this.massAttacks || 0) + 1; return OK; },
        attack(target) { this.meleeAttacks.push(target.id); return OK; },
        dismantle(target) { this.dismantles.push(target.id); return OK; },
        heal(target) { this.heals.push(target.name); return OK; },
        rangedHeal(target) { this.rangedHeals.push(target.name); return OK; },
        pull(target) { this.pulls.push(target.name); return OK; },
        setTrafficLock(value) { this.trafficLocked = value; return OK; },
        getActiveBodyparts(type) { return this.body.filter(part => part.type === type && part.hits > 0).length; }
    });
    Game.creeps[name] = creep;
    return creep;
}

function enemy(name, types, x, y, room, owner = 'Enemy') {
    const body = parts(types);
    const target = {
        id: name,
        name,
        my: false,
        owner: { username: owner },
        room,
        pos: pos(x, y, room.name),
        body,
        hits: body.length * 100,
        hitsMax: body.length * 100,
        getActiveBodyparts(type) { return this.body.filter(part => part.type === type && part.hits > 0).length; }
    };
    return target;
}

function structure(id, type, x, y, roomName = 'W2N2', options = {}) {
    return {
        id,
        structureType: type,
        my: false,
        owner: { username: options.owner || 'Enemy' },
        hits: options.hits === undefined ? 100000 : options.hits,
        hitsMax: options.hitsMax || 100000,
        pos: pos(x, y, roomName),
        store: options.energy === undefined ? undefined : { [RESOURCE_ENERGY]: options.energy }
    };
}

function createOperation(id = 'attack:W2N2', options = {}) {
    const hive = fresh('HiveMind.Memory.js').ensure();
    hive.operations[id] = {
        id,
        type: options.type || 'ATTACK_PLAYER',
        state: options.state || 'ACTIVE',
        priority: options.priority || 90,
        originRoom: options.originRoom || 'W1N1',
        targetRoom: options.targetRoom || 'W2N2',
        targetId: options.targetId || null,
        targetOwner: options.targetOwner || 'Enemy',
        desiredCapabilities: options.desiredCapabilities || { damage: 200, ranged: 200, healing: 200 },
        policyApproved: options.policyApproved !== false,
        manualDirective: options.manualDirective !== false,
        preferredSquadType: options.squadType || 'RANGED_QUAD',
        assignedCreeps: [],
        assignedSquads: [],
        timeoutTick: options.timeoutTick || null
    };
    return hive.operations[id];
}

function attach(squad, members) {
    for (const [slot, member] of Object.entries(members)) {
        if (!member) continue;
        member.memory.squadId = squad.id;
        member.memory.squadSlot = slot;
        member.memory.formationRole = slot;
        member.memory.operationId = squad.operationId;
    }
    delete global.__sushiTickIndex;
}

function rangedMembers(room, coordinates = [[10, 10], [11, 10], [10, 11], [11, 11]]) {
    return {
        rangedA: makeCreep('rangedA', 'Volley', [MOVE, MOVE, RANGED_ATTACK, RANGED_ATTACK], ...coordinates[0], room),
        rangedB: makeCreep('rangedB', 'Volley', [MOVE, MOVE, RANGED_ATTACK, RANGED_ATTACK], ...coordinates[1], room),
        healerA: makeCreep('healerA', 'Cleric', [MOVE, MOVE, HEAL, HEAL], ...coordinates[2], room),
        healerB: makeCreep('healerB', 'Cleric', [MOVE, MOVE, HEAL, HEAL], ...coordinates[3], room)
    };
}

function movementRecorder() {
    const api = require(path.join(mocks.root, 'utility.Travel.Creep.js'));
    const moves = [];
    api.move = (member, target, options) => {
        const targetPos = target && target.pos || target;
        moves.push({ member: member.name, target: targetPos && `${targetPos.roomName}:${targetPos.x}:${targetPos.y}`, options });
        return OK;
    };
    api.moveOffExit = member => {
        moves.push({ member: member.name, offExit: true });
        return OK;
    };
    return moves;
}

test('quad Memory stores stable formation, readiness, retreat, and replacement fields', function() {
    reset();
    makeRoom('W1N1');
    createOperation();
    const quad = fresh('Squad.Quad.js');
    const squad = quad.create({ id: 'quad:test', operationId: 'attack:W2N2', originRoom: 'W1N1', targetRoom: 'W2N2' });
    assert.strictEqual(squad.type, 'RANGED_QUAD');
    assert.deepStrictEqual(squad.memberSlots, ['rangedA', 'rangedB', 'healerA', 'healerB']);
    for (const field of [
        'leader', 'members', 'desiredMemberCapabilities', 'rallyPosition', 'sharedTargetId',
        'formationMode', 'formationTransform', 'stateStartTick', 'retreatDestination',
        'readinessThreshold', 'abortThreshold', 'expectedTravelTime', 'minimumAcceptableTTL',
        'replacementRequirements', 'stateTimeouts', 'debugReason'
    ]) assert.notStrictEqual(squad[field], undefined, field);
    const siege = quad.create({ id: 'quad:siege', type: 'SIEGE_QUAD', operationId: 'attack:W2N2', originRoom: 'W1N1', targetRoom: 'W2N2' });
    assert.deepStrictEqual(siege.memberSlots, ['strikerA', 'strikerB', 'healerA', 'healerB']);
});

test('offensive policy rejects implicit attacks and configured allies', function() {
    reset();
    makeRoom('W2N2', { controller: { my: false, owner: { username: 'Neighbor' } } });
    const offensive = fresh('Combat.Operations.js');
    const operation = createOperation('implicit', { targetOwner: 'Neighbor', manualDirective: false, policyApproved: false });
    let assessment = offensive.evaluate(operation);
    assert.strictEqual(assessment.code, 'NO_DIRECTIVE');
    const policy = require(path.join(mocks.root, 'Combat.Policy.js'));
    policy.setClassification('Neighbor', policy.CLASSIFICATIONS.ALLY);
    operation.manualDirective = true;
    assessment = offensive.evaluate(operation);
    assert.strictEqual(assessment.code, 'ALLY_TARGET');
    assert.strictEqual(offensive.createManual('ATTACK_PLAYER', { targetRoom: 'W2N2', targetOwner: 'Neighbor' }).ok, false);
});

test('manual offense persists explicit objective, composition, retreat, and target directives', function() {
    reset();
    const offensive = fresh('Combat.Operations.js');
    const created = offensive.createManual('ATTACK_PLAYER', {
        id: 'manual:siege', originRoom: 'W1N1', targetRoom: 'W2N2', targetOwner: 'Enemy',
        objective: 'DISMANTLE_BREACH', squadType: 'SIEGE_QUAD', retreatRoom: 'W1N1'
    });
    assert.strictEqual(created.ok, true);
    assert.strictEqual(created.operation.manualDirective, true);
    assert.strictEqual(created.operation.preferredSquadType, 'SIEGE_QUAD');
    assert.deepStrictEqual(created.operation.minimumSquadComposition, { striker: 2, healer: 2 });
    assert.strictEqual(created.operation.retreatRoom, 'W1N1');
    const target = { id: 'tower1', pos: pos(20, 20, 'W2N2') };
    assert.strictEqual(offensive.setManualTarget('manual:siege', target), true);
    assert.strictEqual(created.operation.targetId, 'tower1');
    assert.deepStrictEqual(created.operation.targetPosition, { x: 20, y: 20, roomName: 'W2N2' });
});

test('safe mode pauses offense while impossible attrition aborts it', function() {
    reset();
    const hostiles = [];
    const targetRoom = makeRoom('W2N2', {
        hostiles,
        controller: { my: false, owner: { username: 'Enemy' }, safeMode: 100 }
    });
    hostiles.push(enemy('enemyHealer', [MOVE, HEAL, HEAL, HEAL, HEAL, HEAL], 20, 20, targetRoom));
    const offensive = fresh('Combat.Operations.js');
    const operation = createOperation('attrition', { desiredCapabilities: { damage: 20, healing: 100 } });
    let assessment = offensive.evaluate(operation);
    assert.strictEqual(assessment.code, 'SAFE_MODE');
    targetRoom.controller.safeMode = 0;
    assessment = offensive.evaluate(operation);
    assert.strictEqual(assessment.code, 'OUTHEALED');
    offensive.run();
    assert.strictEqual(operation.state, 'ABORTED');
    assert.ok(operation.debugReason.includes('cannot beat healing'));
});

test('unbreakable siege math and overwhelming tower support abort feeding', function() {
    reset();
    const hostiles = [];
    const wall = structure('wall', STRUCTURE_WALL, 21, 20, 'W2N2', { hits: 1000000 });
    const tower = structure('tower', STRUCTURE_TOWER, 25, 25, 'W2N2', { energy: 1000 });
    const targetRoom = makeRoom('W2N2', {
        hostiles, structures: [wall, tower], hostileStructures: [wall, tower],
        controller: { my: false, owner: { username: 'Enemy' } }
    });
    hostiles.push(enemy('worker', [MOVE, WORK, WORK, WORK, WORK], 20, 20, targetRoom));
    const offensive = fresh('Combat.Operations.js');
    const breach = createOperation('breach', { desiredCapabilities: { damage: 100, dismantle: 0, healing: 1000 } });
    assert.strictEqual(offensive.evaluate(breach).code, 'UNBREAKABLE');
    const towerRun = createOperation('tower-run', { desiredCapabilities: { damage: 1000, dismantle: 1000, healing: 50 } });
    assert.strictEqual(offensive.evaluate(towerRun).code, 'UNSURVIVABLE');
    offensive.run();
    assert.strictEqual(breach.state, 'ABORTED');
    assert.strictEqual(towerRun.state, 'ABORTED');
});

test('offensive policy rejects a mission without a retreat route', function() {
    reset();
    makeRoom('W2N2', { controller: { my: false, owner: { username: 'Enemy' } } });
    Game.map.findRoute = () => ERR_NO_PATH;
    const offensive = fresh('Combat.Operations.js');
    const operation = createOperation('trapped', {
        desiredCapabilities: { damage: 1000, dismantle: 1000, healing: 1000 }
    });
    const assessment = offensive.evaluate(operation);
    assert.strictEqual(assessment.code, 'NO_RETREAT_PATH');
    assert.strictEqual(assessment.metrics.retreatRouteAvailable, false);
});

test('approved operation creates exactly one quad and four shared demands', function() {
    reset();
    makeRoom('W1N1');
    makeRoom('W2N2', { controller: { my: false, owner: { username: 'Enemy' } } });
    const offensive = fresh('Combat.Operations.js');
    const created = offensive.createManual('RAID_REMOTE', {
        id: 'raid:test', originRoom: 'W1N1', targetRoom: 'W2N2', targetOwner: 'Enemy'
    }).operation;
    offensive.run();
    assert.strictEqual(created.policyApproved, true);
    const controller = fresh('Squad.Controller.js');
    const planned = controller.plan();
    const squad = controller.get('quad:raid:test');
    assert.ok(squad);
    assert.strictEqual(planned.filter(item => item.id === squad.id).length, 1);
    assert.strictEqual(squad.demandIds.length, 4);
    const demands = fresh('Spawn.DemandBoard.js').getDemands().filter(demand => demand.squadId === squad.id);
    assert.strictEqual(demands.length, 4);
    assert.ok(demands.every(demand => demand.memory.allowOffensiveTargets === true));
});

test('formation positions are a valid compact 2x2 and blocked orientation rotates', function() {
    reset();
    const blocker = structure('block', STRUCTURE_SPAWN, 11, 11, 'W1N1', { owner: 'Sushi' });
    blocker.my = true;
    const home = makeRoom('W1N1', { structures: [blocker] });
    createOperation();
    const quad = fresh('Squad.Quad.js');
    const squad = quad.create({ id: 'quad:test', operationId: 'attack:W2N2', originRoom: 'W1N1', targetRoom: 'W2N2', rallyPosition: pos(10, 10) });
    const members = rangedMembers(home);
    attach(squad, members);
    const refreshed = quad.refreshMembers(squad);
    const anchor = pos(10, 10);
    const rotated = quad.chooseTransform(squad, anchor, home, refreshed, []);
    assert.ok(rotated);
    assert.notStrictEqual(rotated.index, 0);
    const coordinates = Object.values(rotated.positions).map(value => `${value.x}:${value.y}`);
    assert.strictEqual(new Set(coordinates).size, 4);
    assert.strictEqual(Math.max(...Object.values(rotated.positions).map(value => value.x)) -
        Math.min(...Object.values(rotated.positions).map(value => value.x)), 1);
    assert.strictEqual(Math.max(...Object.values(rotated.positions).map(value => value.y)) -
        Math.min(...Object.values(rotated.positions).map(value => value.y)), 1);
    assert.strictEqual(quad.buildFormationCostMatrix(home).get(11, 11), 255);
});

test('rallied quad enters marching only after a complete 2x2 formation', function() {
    reset();
    const home = makeRoom('W1N1');
    createOperation();
    const quad = fresh('Squad.Quad.js');
    const moves = movementRecorder();
    const squad = quad.create({ id: 'quad:test', operationId: 'attack:W2N2', originRoom: 'W1N1', targetRoom: 'W2N2', rallyPosition: pos(10, 10) });
    const members = rangedMembers(home);
    attach(squad, members);
    squad.state = 'RALLYING';
    quad.runSquad(squad);
    assert.strictEqual(squad.state, 'MARCHING');
    assert.strictEqual(squad.formationMode, 'ATTACK');
    assert.strictEqual(moves.length, 0, 'already-formed members should not issue conflicting movement');
});

test('transport mode emits one deterministic snake intent per member and synchronizes fatigue with pull', function() {
    reset();
    const home = makeRoom('W1N1');
    createOperation();
    const quad = fresh('Squad.Quad.js');
    const moves = movementRecorder();
    const squad = quad.create({ id: 'quad:test', operationId: 'attack:W2N2', originRoom: 'W1N1', targetRoom: 'W2N2' });
    const members = rangedMembers(home, [[10, 10], [9, 10], [8, 10], [7, 10]]);
    attach(squad, members);
    quad.refreshMembers(squad);
    quad.transport(squad, members, pos(25, 25, 'W2N2'));
    assert.strictEqual(moves.length, 4);
    assert.strictEqual(new Set(moves.map(move => move.member)).size, 4);
    assert.strictEqual(new Set(moves.map(move => move.target)).size, 4);
    assert.strictEqual(squad.formationMode, 'TRANSPORT');

    moves.length = 0;
    members.rangedB.fatigue = 2;
    quad.transport(squad, members, pos(25, 25, 'W2N2'));
    assert.deepStrictEqual(members.rangedA.pulls, ['rangedB']);
    assert.ok(moves.some(move => move.member === 'rangedB'));
    assert.ok(moves.some(move => move.member === 'rangedA'));
});

test('border crossing switches to rally and never gives members independent target paths', function() {
    reset();
    const home = makeRoom('W1N1');
    createOperation();
    const quad = fresh('Squad.Quad.js');
    const moves = movementRecorder();
    const squad = quad.create({ id: 'quad:test', operationId: 'attack:W2N2', originRoom: 'W1N1', targetRoom: 'W2N2' });
    const members = rangedMembers(home, [[0, 10], [1, 10], [2, 10], [3, 10]]);
    attach(squad, members);
    quad.refreshMembers(squad);
    quad.transport(squad, members, pos(25, 25, 'W2N2'));
    assert.strictEqual(squad.formationMode, 'RALLY');
    assert.ok(moves.some(move => move.member === 'rangedA' && move.offExit));
    assert.strictEqual(moves.filter(move => move.target && move.target.startsWith('W2N2')).length, 0);
});

test('leader replacement preserves surviving member slots', function() {
    reset();
    const home = makeRoom('W1N1');
    createOperation();
    const quad = fresh('Squad.Quad.js');
    const squad = quad.create({ id: 'quad:test', operationId: 'attack:W2N2', originRoom: 'W1N1', targetRoom: 'W2N2' });
    const members = rangedMembers(home);
    attach(squad, members);
    quad.refreshMembers(squad);
    assert.strictEqual(squad.leader, 'rangedA');
    delete Game.creeps.rangedA;
    delete global.__sushiTickIndex;
    const survivors = quad.refreshMembers(squad);
    assert.strictEqual(squad.leader, 'rangedB');
    assert.strictEqual(squad.leaderSlot, 'rangedB');
    assert.strictEqual(survivors.rangedB.name, 'rangedB');
    assert.strictEqual(squad.members.rangedA, null);
});

test('quad shares focus fire and predictive healing before coordinated movement', function() {
    reset();
    const hostiles = [];
    const arena = makeRoom('W2N2', { hostiles, controller: { my: false, owner: { username: 'Enemy' } } });
    createOperation('attack:W2N2', { targetRoom: 'W2N2' });
    const hostile = enemy('melee', [MOVE, ATTACK], 13, 10, arena);
    hostiles.push(hostile);
    const quad = fresh('Squad.Quad.js');
    movementRecorder();
    const squad = quad.create({ id: 'quad:test', operationId: 'attack:W2N2', originRoom: 'W1N1', targetRoom: 'W2N2' });
    const members = rangedMembers(arena);
    members.rangedA.hits -= 100;
    attach(squad, members);
    squad.state = 'ENGAGING';
    quad.runSquad(squad);
    assert.strictEqual(squad.sharedTargetId, 'melee');
    assert.deepStrictEqual(members.rangedA.attacks, ['melee']);
    assert.deepStrictEqual(members.rangedB.attacks, ['melee']);
    assert.ok(members.healerA.heals.includes('rangedA') || members.healerB.heals.includes('rangedA'));
    assert.ok(['ATTACK', 'RETREAT'].includes(squad.formationMode));
});

test('a casualty elects a new leader and withdraws the surviving formation', function() {
    reset();
    const arena = makeRoom('W2N2', { controller: { my: false, owner: { username: 'Enemy' } } });
    createOperation('attack:W2N2', { targetRoom: 'W2N2' });
    const quad = fresh('Squad.Quad.js');
    movementRecorder();
    const squad = quad.create({ id: 'quad:test', operationId: 'attack:W2N2', originRoom: 'W1N1', targetRoom: 'W2N2', retreatDestination: pos(25, 25, 'W1N1') });
    const members = rangedMembers(arena);
    attach(squad, members);
    squad.state = 'ENGAGING';
    quad.refreshMembers(squad);
    delete Game.creeps.rangedA;
    delete global.__sushiTickIndex;
    quad.runSquad(squad);
    assert.strictEqual(squad.leader, 'rangedB');
    assert.strictEqual(squad.state, 'RETREATING');
    assert.ok(squad.debugReason.includes('casualty') || squad.debugReason.includes('replacement'));
});

test('expired operations suppress replacements that cannot arrive in time', function() {
    reset();
    makeRoom('W1N1');
    const operation = createOperation('attack:short', { timeoutTick: Game.time + 100 });
    const quad = fresh('Squad.Quad.js');
    const squad = quad.create({ id: 'quad:short', operationId: operation.id, originRoom: 'W1N1', targetRoom: 'W2N2', expectedTravelTime: 100 });
    assert.deepStrictEqual(quad.emitDemands(squad), []);
    assert.strictEqual(squad.demandIds.length, 0);
    assert.strictEqual(squad.debugReason, 'Replacement cannot arrive before operation timeout');
});

test('squad facade controls quad members so normal role movement cannot conflict', function() {
    const controllerSource = fs.readFileSync(path.join(mocks.root, 'Squad.Controller.js'), 'utf8');
    const creepTickSource = fs.readFileSync(path.join(mocks.root, 'Tick.Creeps.js'), 'utf8');
    assert.ok(controllerSource.includes("require('Squad.Quad')"));
    assert.ok(controllerSource.includes('QuadController.runSquad'));
    assert.ok(creepTickSource.includes('if (squadControlled.has(creep.name)) continue'));
    const quadSource = fs.readFileSync(path.join(mocks.root, 'Squad.Quad.js'), 'utf8');
    assert.ok(quadSource.includes('travel.move(member, target'));
    assert.strictEqual(/\b(member|leader|creep)\.move\s*\(/.test(quadSource), false, 'quad must not directly own final creep.move');
    assert.strictEqual(/\b(member|leader|creep)\.moveTo\s*\(/.test(quadSource), false, 'quad must not call native moveTo');
});

console.log(`Phase 8 tests passed: ${passed}`);
