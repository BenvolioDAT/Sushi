const assert = require('assert');
const mocks = require('./mock-screeps');
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log('PASS ' + name); } catch (e) { process.exitCode = 1; console.error('FAIL ' + name, e.stack); } }
function fixture() {
    mocks.installGlobals(); mocks.clearLocalModules();
    Object.assign(global, { HEAL_POWER: 12, RANGED_ATTACK_POWER: 10, ATTACK_POWER: 30 });
    const name = 'W6N4', structures = [], hostiles = [], sources = [], minerals = [];
    const room = { name, lookForAt: () => [], find(type, options) {
        const list = type === FIND_STRUCTURES || type === FIND_HOSTILE_STRUCTURES ? structures :
            type === FIND_HOSTILE_CREEPS ? hostiles : type === FIND_SOURCES ? sources : type === FIND_MINERALS ? minerals : [];
        return options && options.filter ? list.filter(options.filter) : list;
    } };
    Game.rooms[name] = room;
    Memory.rooms[name] = {};
    const source = { id: 'source', energyCapacity: 4000, pos: new RoomPosition(15, 4, name) };
    const lair = { id: 'lair', structureType: 'keeperLair', pos: new RoomPosition(15, 7, name), ticksToSpawn: 200 };
    sources.push(source); structures.push(lair);
    const Intel = require('Keeper.Intel'), Combat = require('Keeper.Combat'), index = require('HiveMind.Index');
    const next = () => { Game.time++; index.resetForTests(); };
    const keeper = (id = 'enemy', x = 14, y = 5) => ({ id, name: 'Keeperlair', owner: { username: 'Source Keeper' },
        hits: 5000, hitsMax: 5000, body: Array.from({ length: 10 }, () => ({ type: ATTACK, hits: 100 }))
            .concat(Array.from({ length: 10 }, () => ({ type: RANGED_ATTACK, hits: 100 }))),
        pos: new RoomPosition(x, y, name), getActiveBodyparts(type) { return this.body.filter(p => p.type === type).length; } });
    const guard = (name = 'guard', x = 20, y = 10) => {
        const c = { id: name, name, room, pos: new RoomPosition(x, y, room.name), hits: 4000, hitsMax: 4000, ticksToLive: 1400,
            body: [...Array(20).fill(MOVE), ...Array(10).fill(RANGED_ATTACK), ...Array(10).fill(HEAL)].map(type => ({ type, hits: 100 })),
            memory: { role: 'Volley', homeRoom: 'HOME', keeperPatrolRoom: room.name },
            getActiveBodyparts(type) { return this.body.filter(p => p.type === type && p.hits).length; }, heal: () => OK, rangedAttack: () => OK };
        Game.creeps[name] = c; index.resetForTests(); return c;
    };
    const travel = require('utility.Travel.Creep'), moves = [];
    travel.move = (c, target, opts) => { moves.push({ name: c.name, target, opts }); return OK; };
    travel.moveToRoom = (c, roomName) => { moves.push({ name: c.name, roomName }); return OK; };
    return { room, structures, hostiles, sources, minerals, source, lair, Intel, Combat, next, keeper, guard, moves };
}

test('lair ID, resource and timer are retained as plain data with one observation per tick', () => {
    const f = fixture(), first = f.Intel.observe(f.room);
    assert.strictEqual(first.lairs.lair.nextSpawnAt, Game.time + 200);
    assert.deepStrictEqual(first.lairs.lair.resourceIds, ['source']);
    f.lair.ticksToSpawn = 10; assert.strictEqual(f.Intel.observe(f.room), first);
    assert.doesNotThrow(() => JSON.stringify(first));
    f.next(); assert.strictEqual(f.Intel.observe(f.room).lairs.lair.nextSpawnAt, Game.time + 10);
});
test('mineral lairs are distinguished from energy source lairs', () => {
    const f = fixture(); f.minerals.push({ id: 'mineral', pos: new RoomPosition(41, 35, f.room.name) });
    f.structures.push({ id: 'mineralLair', structureType: 'keeperLair', pos: new RoomPosition(46, 34, f.room.name) });
    const intel = f.Intel.observe(f.room);
    assert.deepStrictEqual(intel.lairs.mineralLair.resourceIds, ['mineral']);
    assert.strictEqual(intel.resources.mineral.kind, 'mineral');
});
test('overlapping lair associations retain all resources the engine could select', () => {
    const f = fixture(); f.sources.push({ id: 'secondSource', energyCapacity: 4000, pos: new RoomPosition(16, 7, f.room.name) });
    assert.deepStrictEqual(f.Intel.observe(f.room).lairs.lair.resourceIds, ['source', 'secondSource']);
});
test('living damaged Keeper overrides an apparently long safe timer', () => {
    const f = fixture(); f.hostiles.push(f.keeper()); f.lair.ticksToSpawn = 299;
    assert.strictEqual(f.Intel.windowFor(f.room.name, 'source', { escapeTicks: 20 }).reason, 'ACTIVE_KEEPER');
    assert.deepStrictEqual(f.Intel.get(f.room.name).lairs.lair.keeperIds, ['enemy']);
});
test('unknown Keeper names near a resource still close its window', () => {
    const f = fixture(), enemy = f.keeper(); enemy.name = 'custom'; f.hostiles.push(enemy);
    assert.strictEqual(f.Intel.windowFor(f.room.name, 'source', { escapeTicks: 20 }).safe, false);
});
test('undefined countdown is unknown rather than safe', () => {
    const f = fixture(); delete f.lair.ticksToSpawn;
    assert.strictEqual(f.Intel.windowFor(f.room.name, 'source', { escapeTicks: 20 }).reason, 'KEEPER_TIMER_UNKNOWN');
});
test('windows include approach, loading and escape, with an early retreat margin', () => {
    const f = fixture(); f.lair.ticksToSpawn = 90;
    assert.strictEqual(f.Intel.windowFor(f.room.name, 'source', { approachTicks: 20, workTicks: 50, escapeTicks: 20 }).safe, false);
    assert.strictEqual(f.Intel.windowFor(f.room.name, 'source', { escapeTicks: 20 }).safe, true);
    f.lair.ticksToSpawn = 35; f.next();
    assert.strictEqual(f.Intel.windowFor(f.room.name, 'source', { escapeTicks: 20 }).safe, false);
});
test('lost vision, old records and future timestamps cannot certify safety', () => {
    const f = fixture(); f.Intel.observe(f.room); delete Game.rooms[f.room.name];
    for (const jump of [1, 5000, -10000]) {
        Game.time += jump; assert.strictEqual(f.Intel.windowFor(f.room.name, 'source', { escapeTicks: 0 }).safe, false);
    }
    assert.strictEqual(f.Intel.known(f.room.name), true);
});
test('current vision without a Keeper reopens the window; a core or other enemy closes it', () => {
    const f = fixture(); f.hostiles.push(f.keeper()); f.Intel.observe(f.room);
    f.hostiles.length = 0; f.next(); assert(f.Intel.windowFor(f.room.name, 'source', { escapeTicks: 10 }).safe);
    f.hostiles.push({ ...f.keeper(), owner: { username: 'Invader' } }); f.next();
    assert.strictEqual(f.Intel.windowFor(f.room.name, 'source', { escapeTicks: 10 }).reason, 'OTHER_HOSTILE');
    f.hostiles.length = 0; f.structures.push({ id: 'core', structureType: 'invaderCore' }); f.next();
    assert.strictEqual(f.Intel.windowFor(f.room.name, 'source', { escapeTicks: 10 }).reason, 'INVADER_CORE');
});
test('hazards block civilian paths and use traversable high cost for evacuation', () => {
    const f = fixture(); f.lair.ticksToSpawn = 20;
    const blocked = f.Intel.applyCosts(f.room.name, new PathFinder.CostMatrix());
    const escape = f.Intel.applyCosts(f.room.name, new PathFinder.CostMatrix(), true);
    assert.strictEqual(blocked.get(15, 4), 255); assert.strictEqual(escape.get(15, 4), 50);
    escape.set(15, 5, 255); assert.strictEqual(f.Intel.applyCosts(f.room.name, escape, true).get(15, 5), 255);
});
test('escape estimates account for fatigue, loaded weight and missing lanes or MOVE', () => {
    const f = fixture(), c = f.guard(), lane = Array.from({ length: 10 }, () => ({ roomName: f.room.name }));
    assert.strictEqual(f.Intel.escapeTicks(c, lane, f.room.name), 50);
    c.fatigue = 41; assert.strictEqual(f.Intel.escapeTicks(c, lane, f.room.name), 52);
    assert.strictEqual(f.Intel.escapeTicks(c, [], f.room.name), Infinity);
    c.body = [{ type: WORK, hits: 100 }]; assert.strictEqual(f.Intel.escapeTicks(c, lane, f.room.name), Infinity);
});
test('protection uses actual healthy live guards and fails immediately after death', () => {
    const f = fixture(), c = f.guard(); assert(f.Combat.protection(f.room.name, 'HOME').ready);
    c.hits = 3000; assert.strictEqual(f.Combat.protection(f.room.name, 'HOME').ready, false);
    c.hits = 4000; delete Game.creeps[c.name]; f.next(); assert.strictEqual(f.Combat.protection(f.room.name, 'HOME').ready, false);
});
test('desired or spawning guards and a single guard for multiple lairs cannot promise coverage', () => {
    const f = fixture(), c = f.guard(); c.spawning = true;
    assert.strictEqual(f.Combat.protection(f.room.name, 'HOME').ready, false);
    c.spawning = false; f.structures.push({ ...f.lair, id: 'second' }); f.next();
    assert.strictEqual(f.Combat.protection(f.room.name, 'HOME').required, 2);
    assert.strictEqual(f.Combat.protection(f.room.name, 'HOME').ready, false);
});
test('patrol heals and fires at range three without closing to melee', () => {
    const f = fixture(), c = f.guard('guard', 17, 5), enemy = f.keeper(); f.hostiles.push(enemy); f.next();
    let heals = 0, attacks = 0; c.heal = who => { assert.strictEqual(who, c); heals++; }; c.rangedAttack = who => { assert.strictEqual(who, enemy); attacks++; };
    f.Combat.run(c); assert.strictEqual(heals, 1); assert.strictEqual(attacks, 1); assert.strictEqual(f.moves.length, 0);
});
test('close-range combat kites and commits to retreat when incoming damage exceeds healing', () => {
    const f = fixture(), c = f.guard('guard', 15, 5); f.hostiles.push(f.keeper()); f.next();
    f.Combat.run(c); assert.strictEqual(c.memory.keeperPatrolState, 'RETREAT');
    assert(f.moves.length); f.next(); f.Combat.run(c); assert.strictEqual(f.moves.at(-1).roomName, 'HOME');
});
test('low lifetime and non-Keeper enemies cause withdrawal rather than a new battle', () => {
    for (const danger of ['ttl', 'invader', 'core']) {
        const f = fixture(), c = f.guard();
        if (danger === 'ttl') c.ticksToLive = 200;
        if (danger === 'invader') f.hostiles.push({ ...f.keeper(), owner: { username: 'Invader' } });
        if (danger === 'core') f.structures.push({ id: 'core', structureType: 'invaderCore' });
        f.next(); f.Combat.run(c); assert.strictEqual(f.moves.at(-1).roomName, 'HOME');
    }
});
test('a patrol at home requests vision instead of marching on old or missing intelligence', () => {
    const f = fixture(), c = f.guard(); f.Intel.observe(f.room);
    c.room = { name: 'HOME' }; c.pos = new RoomPosition(25, 25, 'HOME'); delete Game.rooms[f.room.name]; Game.time += 51;
    f.Combat.run(c); assert.strictEqual(c.memory.keeperPatrolState, 'WAIT_INTEL');
    assert.strictEqual(f.moves.length, 0);
    assert.strictEqual(Memory.rooms[f.room.name].intelRefreshReason, 'KEEPER_PATROL_NEEDS_VISION');
});
test('patrol target locks are stable and peers claim distinct Keepers', () => {
    const f = fixture(), a = f.guard('a'), b = f.guard('b');
    f.hostiles.push(f.keeper('first'), f.keeper('second', 25, 20)); f.next();
    f.Combat.run(a); f.Combat.run(b); assert.notStrictEqual(a.memory.keeperTargetId, b.memory.keeperTargetId);
    const locked = a.memory.keeperTargetId; f.next(); f.Combat.run(a); assert.strictEqual(a.memory.keeperTargetId, locked);
});
test('economics charges fixed combat, loaded hauling, mining and infrastructure; missing inputs cannot approve', () => {
    const f = fixture(); assert.strictEqual(f.Combat.economics(f.room.name).viable, false);
    const result = f.Combat.economics(f.room.name, { travelTicks: 100, uptime: 0.8, infrastructureCost: 1 });
    assert.strictEqual(result.guardBodyCost, 5000); assert.strictEqual(result.guards, 1);
    assert.strictEqual(result.carry, Math.ceil(result.peakGross * 204 / 50));
    assert(Math.abs(result.net - (result.gross - result.combat - result.mining - result.hauling - 1)) < 1e-9);
    assert.strictEqual(f.Combat.economics(f.room.name, { travelTicks: 1100, uptime: 0.2, infrastructureCost: 1 }).viable, false);
    assert.strictEqual(result.viable, false, 'income alone cannot certify spawn feasibility');
    const affordable = { travelTicks: 30, uptime: 1, infrastructureCost: 0.5, energyCapacity: 5600, spawnBudget: 1 };
    assert.strictEqual(f.Combat.economics(f.room.name, affordable).viable, true);
    assert.strictEqual(f.Combat.economics(f.room.name, { ...affordable, energyCapacity: 1800 }).reason, 'GUARD_BODY_UNAFFORDABLE');
    assert.strictEqual(f.Combat.economics(f.room.name, { ...affordable, spawnBudget: 0.1 }).reason, 'SPAWN_BUDGET_EXCEEDED');
});
test('Source Keepers cannot trigger ordinary remote defense, including after lost vision', () => {
    const f = fixture(); f.hostiles.push(f.keeper());
    Memory.rooms.HOME = { remotePlanner: { remotes: { [f.room.name]: {} } } };
    const ledger = require('Combat.ThreatLedger'), snapshot = ledger.observeRoom(f.room);
    assert.strictEqual(snapshot.hostiles[0].classification, 'SOURCE_KEEPER');
    assert.strictEqual(snapshot.actionableHostileCount, 0);
    delete Game.rooms[f.room.name]; f.next(); ledger.run();
    assert.strictEqual(snapshot.hostiles[0].autoEngage, false);
    assert.strictEqual(require('HiveMind.Memory').ensure().operations['defend:' + f.room.name], undefined);
    const policy = require('Combat.Policy');
    assert.strictEqual(policy.mayAutoEngage('Source Keeper', { roomName: f.room.name, attackedUs: true }), false);
    assert.strictEqual(policy.mayLaunchOffense('Source Keeper'), false);
    assert.strictEqual(policy.mayLaunchOffense('Source Keeper', true), true);
});

test('civilian guard runs before stationary mining and preserves partial hauling cargo on evacuation', () => {
    for (const role of ['Extractor', 'Freighter']) {
        const f = fixture(), c = f.guard('worker'); c.memory = { role, homeRoom: 'HOME', remoteMining: true,
            sourceId: 'source', pickupSourceId: 'source', pickupRoom: f.room.name, freighterJob: 'remote' };
        c.store = { energy: 75 };
        Memory.rooms.HOME = { remotePlanner: { pathVersion: 1, activeSourceIds: ['source'], remotes: {},
            sourceInfos: { source: { sourceId: 'source', roomName: f.room.name, parentRoomName: 'HOME',
                active: true, operational: true, route: { valid: true } } } } };
        let paths = 0; PathFinder.search = () => { paths++; return { incomplete: false, path: [new RoomPosition(20, 11, f.room.name)] }; };
        const planner = require('Planner.Remote');
        if (role === 'Extractor') {
            let lifecycle = 0; require('utility.Creep').runExtractorLifecycle = () => { lifecycle++; return true; };
            require('role.Extractor').run(c); assert.strictEqual(lifecycle, 0);
            assert.strictEqual(c.memory.extractorState, 'remoteRetreat');
        } else {
            assert(planner.guardKeeperCivilian(c, 'HOME', 'source'));
            assert.strictEqual(c.memory.freighterJob, 'remoteDelivery');
            assert.strictEqual(c.memory.remoteDeliverySourceId, 'source');
            assert.strictEqual(c.memory.remoteDeliveryRoom, f.room.name);
            assert.strictEqual(c.store.energy, 75); assert.strictEqual(c.memory.pickupSourceId, undefined);
        }
        assert.strictEqual(paths, 1); assert.strictEqual(f.moves.length, 1);
    }
});
test('fresh clear windows resume existing assignments and defender loss closes them without deleting routes', () => {
    const f = fixture(), c = f.guard('worker'); c.memory = { role: 'Extractor', homeRoom: 'HOME' };
    const info = { sourceId: 'source', roomName: f.room.name, route: { valid: true } };
    Memory.rooms.HOME = { remotePlanner: { pathVersion: 1, sourceInfos: { source: info }, remotes: {}, activeSourceIds: ['source'] } };
    f.Intel.escapeTicks = () => 10;
    f.Combat.protection = () => ({ ready: true });
    const planner = require('Planner.Remote');
    assert.strictEqual(planner.guardKeeperCivilian(c, 'HOME', 'source'), false);
    f.Combat.protection = () => ({ ready: false });
    PathFinder.search = () => ({ incomplete: false, path: [] });
    assert.strictEqual(planner.guardKeeperCivilian(c, 'HOME', 'source'), true);
    assert.strictEqual(c.memory.keeperWaitReason, 'KEEPER_PROTECTION_UNAVAILABLE');
    assert.strictEqual(info.route.valid, true);
    f.Combat.protection = () => ({ ready: true });
    assert.strictEqual(planner.guardKeeperCivilian(c, 'HOME', 'source'), false);
    assert.strictEqual(c.memory.keeperWaitReason, undefined);
});
test('empty recalled haulers release a closed assignment at home for other work', () => {
    const f = fixture(), c = f.guard('worker');
    c.pos = new RoomPosition(25, 25, 'HOME'); c.store = { energy: 0 };
    c.memory = { role: 'Freighter', homeRoom: 'HOME', freighterJob: 'remote', pickupRoom: f.room.name, pickupSourceId: 'source' };
    Memory.rooms.HOME = { remotePlanner: { pathVersion: 1, sourceInfos: { source: { sourceId: 'source', roomName: f.room.name, route: {} } }, remotes: {}, activeSourceIds: [] } };
    require('Planner.Remote').guardKeeperCivilian(c, 'HOME', 'source');
    assert.strictEqual(c.memory.freighterJob, undefined); assert.strictEqual(c.memory.homeRoom, 'HOME');
});
test('a broken server-side sign getter cannot interrupt Annex reservation or normal signing', () => {
    const f = fixture(), controller = { id: 'controller', pos: new RoomPosition(20, 11, f.room.name) };
    Object.defineProperty(controller, 'sign', { get() { throw TypeError("Cannot read properties of undefined (reading 'username')"); } });
    f.room.controller = controller;
    const c = f.guard('annex'); c.owner = { username: 'me' }; c.memory = { role: 'Annex', homeRoom: 'HOME', targetRoom: f.room.name };
    let reservations = 0, signs = 0;
    c.reserveController = () => { reservations++; return OK; }; c.signController = () => { signs++; return OK; };
    require('Planner.Remote').moveToRemoteRoomAlongRoute = () => false;
    require('role.Annex').run(c);
    assert.strictEqual(reservations, 1); assert.strictEqual(signs, 1);
    assert.strictEqual(c.memory.annexSignReadErrorAt, Game.time);
    assert.strictEqual(c.memory.annexState, 'signing');
});

test('passive Keeper danger cannot monopolize generic defense scouting after vision is lost',()=>{
    const f=fixture();f.hostiles.push(f.keeper());const ledger=require('Combat.ThreatLedger');
    ledger.observeRoom(f.room,f.hostiles);delete Game.rooms[f.room.name];Game.time++;
    delete Memory.rooms[f.room.name].intelRefreshRequestedAt;delete Memory.rooms[f.room.name].intelRefreshReason;
    ledger.run();assert.notStrictEqual(Memory.rooms[f.room.name].intelRefreshReason,'DEFENSE_NEEDS_INTEL');
    assert.strictEqual(require('HiveMind.Memory').ensure().threats[f.room.name].dangerousHostileCount,1);
});
console.log('Keeper safety scenarios passed: ' + passed);
