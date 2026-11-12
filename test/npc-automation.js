const assert = require('assert');
const mocks = require('./mock-screeps');
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log('PASS ' + name); } catch(e) { process.exitCode = 1; console.error('FAIL ' + name, e.stack); } }
function fixture(coreMode = false) {
    mocks.installGlobals(); mocks.clearLocalModules();
    Object.assign(global, { ATTACK_POWER: 30, HEAL_POWER: 12, RANGED_ATTACK_POWER: 10, TERRAIN_MASK_SWAMP: 2,
        ENERGY_REGEN_TIME: 300, SOURCE_ENERGY_KEEPER_CAPACITY: 4000, SOURCE_ENERGY_CAPACITY: 3000, CREEP_LIFE_TIME: 1500,
        CARRY_CAPACITY: 50, HARVEST_POWER: 2,
        STRUCTURE_KEEPER_LAIR: 'keeperLair', STRUCTURE_INVADER_CORE: 'invaderCore', STRUCTURE_CONTAINER: 'container',
        STRUCTURE_ROAD: 'road', STRUCTURE_RAMPART: 'rampart',
        BODYPART_COST: { work: 100, move: 50, carry: 50, attack: 80, ranged_attack: 150, heal: 250, tough: 10 } });
    const name = coreMode ? 'W3N6' : 'W4N6', structures = [], hostiles = [], sources = [];
    const home = { name: 'HOME', energyAvailable: 5600, energyCapacityAvailable: 5600,
        controller: { my: true, level: 7, owner: { username: 'me' }, pos: new RoomPosition(25,25,'HOME') },
        find: type => type === FIND_MY_SPAWNS ? [spawn] : [] };
    const room = { name, lookForAt: () => [], find(type, options) {
        const list = type === FIND_STRUCTURES || type === FIND_HOSTILE_STRUCTURES ? structures :
            type === FIND_HOSTILE_CREEPS ? hostiles : type === FIND_SOURCES ? sources : [];
        return options && options.filter ? list.filter(options.filter) : list;
    } };
    const spawn = { id: 'spawn', name: 'spawn', my: true, room: home, pos: new RoomPosition(25,25,'HOME') };
    Game.spawns.spawn = spawn; Game.rooms = { HOME: home, [name]: room };
    Memory.rooms = { HOME: {}, [name]: { sources: {} } };
    for (let i = 0; i < (coreMode ? 1 : 3); i++) {
        const source = { id: 's' + i, energyCapacity: 4000, pos: new RoomPosition(10 + i * 10,10 + i * 8,name) };
        sources.push(source); Memory.rooms[name].sources[source.id] = { id: source.id, pos: source.pos,
            seats: [{ x: source.pos.x - 1, y: source.pos.y, roomName: name }], seatCount: 1 };
        if (!coreMode) structures.push({ id: 'l' + i, structureType: 'keeperLair', pos: new RoomPosition(source.pos.x,source.pos.y + 3,name), ticksToSpawn: 200 });
    }
    const core = coreMode ? { id: 'core', structureType: 'invaderCore', owner: { username: 'Invader' },
        level: 0, hits: 100000, pos: new RoomPosition(25,25,name) } : null;
    if (core) { structures.push(core); Memory.rooms[name].invaderCore = { id: core.id, level: 0, observedAt: Game.time }; }
    const E = require('HiveMind.Economy'), economy = { state: 'STABLE', stateSince: Game.time - 100, growth: { energyAboveReserve: 100000,
        spawnPressure: 0, remote: { requiredCarry: 0, availableCarry: 0 } } };
    E.get = () => economy; E.canSpend = () => true; E.checkSpend = () => ({ allowed: true });
    const Index = require('HiveMind.Index'), Intel = require('Keeper.Intel'), Remote = require('Planner.Remote');
    const realPrepare = Remote.prepareKeeperOperation;
    Remote.prepareKeeperOperation = () => ({ ready: true, at: Game.time, sourceIds: sources.map(s => s.id),
        lairIds: structures.filter(s => s.structureType === 'keeperLair').map(s => s.id), travelTicks: 10, infrastructureCost: 0.5, displacedNet: 0 });
    Remote.prepareNpcCoreRoute = () => ({ at: Game.time, targetId: 'core', rooms: ['HOME', name], travelTicks: 20 });
    const Ops = require('Keeper.Operations'), NPC = require('NPC.Operations'), Policy = require('NPC.Policy'), Board = require('Spawn.DemandBoard');
    const moves = [];
    require('utility.Travel.Creep').moveToRoom = (c, target) => { moves.push({ name: c.name, room: target }); return OK; };
    require('utility.Travel.Creep').move = (c, target, options) => { moves.push({ name: c.name, pos: target.pos || target, options }); return OK; };
    const next = (ticks = 1) => { Game.time += ticks; Index.resetForTests(); };
    const add = (name, role, parts, memory = {}, target = home, x = 25, y = 25) => {
        const c = { id: name, name, room: target, pos: new RoomPosition(x,y,target.name), memory: { role,homeRoom:'HOME',...memory },
            body: parts.map(type => ({type,hits:100})), ticksToLive: 1400, hits: parts.length * 100, hitsMax: parts.length * 100,
            owner: { username: 'me' }, getActiveBodyparts(type) { return this.body.filter(p => p.type === type && p.hits).length; }, heal: () => OK,
            rangedAttack: () => OK, attack: () => OK, say: () => {}, store: { energy: 0, getFreeCapacity: () => 50 } };
        Game.creeps[name] = c; Memory.creeps[name] = c.memory; Index.resetForTests(); return c;
    };
    const guard = (i, spawning = false) => { const c = add('g'+i,'Volley',Ops.body(), { keeperPatrolRoom:name,
        keeperOperationId:'keeper:'+name, keeperLairId:'l'+i, targetRoom:name }); c.spawning = spawning; return c; };
    const enter = c => { c.room = room; const i = Number(c.memory.keeperLairId.slice(1)); c.pos = new RoomPosition(sources[i].pos.x + 4,sources[i].pos.y,name); };
    const enemy = (owner = 'Source Keeper', parts = [ATTACK,RANGED_ATTACK], i = 0) => ({ id:'e'+i, name:'Keeperl'+i,
        owner:{ username:owner }, body:parts.map(type=>({type,hits:100})),hits:5000,hitsMax:5000,
        pos:new RoomPosition(sources[i].pos.x - 1,sources[i].pos.y,name) });
    const op = () => Memory.rooms[name].keeperOperation;
    const advance = () => Ops.run();
    const secure = () => { advance(); for (let i=0;i<3;i++) enter(guard(i)); next(); advance(); next(25); advance(); };
    return { name, room, home, spawn, structures, hostiles, sources, core, economy, E, Index, Intel, Remote, Ops, NPC, Policy, Board,
        next, add, guard, enter, enemy, op, advance, secure, moves, realPrepare };
}

test('Keeper operations discover arbitrary rooms and defer unaffordable complete forces without spawning', () => {
    const f=fixture(); f.home.energyCapacityAvailable=1800; f.advance();
    assert.strictEqual(f.op().phase,'DEFERRED'); assert.strictEqual(f.op().reason,'GUARD_BODY_UNAFFORDABLE');
    assert.strictEqual(f.Board.getDemands().length,0); assert.strictEqual(f.Policy.miningAllowed(f.name,'HOME'),false);
});
test('assembly requests one fixed capable guard per energy lair with replacement travel lead', () => {
    const f=fixture(); f.advance(); const demands=f.Board.getDemands();
    assert.strictEqual(f.op().phase,'ASSEMBLE'); assert.strictEqual(demands.length,3);
    assert(demands.every(d=>d.bodyRequirements.fixed&&d.bodyRequirements.body.length===40&&d.count===1));
    assert.strictEqual(new Set(demands.map(d=>d.memory.keeperLairId)).size,3);
    assert(demands.every(d=>d.replacementBuffer===280));
});
test('partial and spawning forces rally at home and cannot authorize civilian requests', () => {
    const f=fixture(); f.advance(); const a=f.guard(0), b=f.guard(1,true); f.next(); f.advance();
    require('Keeper.Combat').run(a); assert.strictEqual(a.memory.keeperPatrolState,'RALLY');
    assert.strictEqual(f.op().phase,'ASSEMBLE'); assert.strictEqual(f.Policy.miningAllowed(f.name),false);
    assert.strictEqual(f.Policy.spawnAllowed(f.home,{role:'Extractor',memory:{sourceRoom:f.name}}).allowed,false);
    assert.strictEqual(b.spawning,true);
});
test('a complete force deploys before clearing, and guards remain assigned to their own lairs', () => {
    const f=fixture(); f.advance(); const guards=[0,1,2].map(i=>f.guard(i)); f.next(); f.advance();
    assert.strictEqual(f.op().phase,'CLEAR'); guards.forEach(c=>require('Keeper.Combat').run(c));
    assert.strictEqual(f.moves.filter(m=>m.room===f.name).length,3);
    guards.forEach(f.enter); f.hostiles.push(...[0,1,2].map(i=>f.enemy('Source Keeper',[ATTACK,RANGED_ATTACK],i))); f.next(); f.advance();
    assert.strictEqual(f.op().phase,'CLEAR'); assert.strictEqual(f.Policy.miningAllowed(f.name),false);
    guards.forEach(c=>require('Keeper.Combat').run(c));
    guards.forEach((c,i)=>assert.strictEqual(c.memory.keeperTargetId,'e'+i));
});
test('clear room and guard coverage must remain verified before miners and later haulers enter', () => {
    const f=fixture(); f.secure(); assert.strictEqual(f.op().phase,'MINE');
    assert(f.Policy.miningAllowed(f.name,'HOME')); assert.strictEqual(f.Policy.haulingAllowed(f.name),false);
    assert(f.Policy.spawnAllowed(f.home,{role:'Extractor',memory:{sourceRoom:f.name}}).allowed);
    assert.strictEqual(f.Policy.spawnAllowed(f.home,{role:'Freighter',memory:{pickupRoom:f.name}}).allowed,false);
    f.sources.forEach((s,i)=>f.add('miner'+i,'Extractor',[...Array(7).fill(WORK),CARRY,...Array(4).fill(MOVE)],{sourceId:s.id},f.room,s.pos.x-1,s.pos.y));
    f.next(); f.advance(); assert.strictEqual(f.op().phase,'HAUL'); assert(f.Policy.haulingAllowed(f.name));
});
test('vision loss closes both civilian gates immediately without treating the room as cleared', () => {
    const f=fixture(); f.secure(); delete Game.rooms[f.name]; f.next(); f.advance();
    assert.strictEqual(f.op().phase,'SUSPENDED'); assert.strictEqual(f.Policy.miningAllowed(f.name),false);
    assert.strictEqual(f.Policy.haulingAllowed(f.name),false);
    assert.strictEqual(Memory.rooms[f.name].intelRefreshReason,'KEEPER_OPERATION_NEEDS_VISION');
});
test('premature guard death closes the operation, cancels pending forces and enters loss cooldown', () => {
    const f=fixture(); f.secure(); delete Game.creeps.g0; f.next(); f.advance();
    assert.strictEqual(f.op().phase,'COOLDOWN'); assert.strictEqual(f.op().reason,'GUARD_DIED_EARLY');
    assert.strictEqual(f.Policy.miningAllowed(f.name),false); assert.strictEqual(f.Board.getDemands().length,0);
    f.next(100); f.advance(); assert.strictEqual(f.op().phase,'COOLDOWN');
});
test('ordinary Invaders suspend Keeper economics and return guard forces instead of mixing NPC scenarios', () => {
    const f=fixture(); f.secure(); f.hostiles.push(f.enemy('Invader')); f.next(); f.advance();
    assert.strictEqual(f.op().reason,'NON_KEEPER_THREAT'); assert.strictEqual(f.op().phase,'SUSPENDED');
    require('Keeper.Combat').run(Game.creeps.g0); assert.strictEqual(f.moves.at(-1).room,'HOME');
});
test('funding and existing remote logistics must support the full new operation', () => {
    for(const reason of ['reserve','hauling','recovery']) {
        const f=fixture(); if(reason==='reserve')f.economy.growth.energyAboveReserve=5000;
        if(reason==='hauling')f.economy.growth.remote.requiredCarry=10;
        if(reason==='recovery')f.economy.state='RECOVERY'; f.advance();
        assert.strictEqual(f.Board.getDemands().length,0); assert.strictEqual(f.Policy.miningAllowed(f.name),false);
    }
});
test('stale queued forces fail execution revalidation and cannot degrade to cheap bodies', () => {
    const f=fixture(); f.advance(); const d=f.Board.getDemands()[0];
    const request={role:'Volley',body:d.bodyRequirements.body,bodyRequirements:d.bodyRequirements,memory:d.memory};
    assert(f.Policy.spawnAllowed(f.home,request).allowed);
    const preview=require('spawn.manager').previewAffordableQueuedBodyForSpawn({room:{...f.home,energyAvailable:1800}},request);
    assert.strictEqual(preview.selection.affordable,false);
    f.op().phase='COOLDOWN'; assert.strictEqual(f.Policy.spawnAllowed(f.home,request).allowed,false);
});
test('insufficient economic gain over displaced ordinary sources rejects Keeper expansion', () => {
    const f=fixture(); const prepare=f.Remote.prepareKeeperOperation; f.Remote.prepareKeeperOperation=()=>({...prepare(),displacedNet:100});
    f.advance(); assert.strictEqual(f.op().reason,'KEEPER_PORTFOLIO_NO_GAIN'); assert.strictEqual(f.Board.getDemands().length,0);
});
test('terrain-aware evacuation accounts for actual roads, plains and swamps', () => {
    const f=fixture(), c=f.guard(0); f.structures.push({id:'road',structureType:'road',pos:new RoomPosition(1,1,f.name)});
    Game.map.getRoomTerrain=()=>({get:(x,y)=>x===3?2:0}); f.next();
    assert.strictEqual(f.Intel.escapeTicks(c,[new RoomPosition(1,1,f.name),new RoomPosition(2,1,f.name),new RoomPosition(3,1,f.name)],f.name),7);
});
test('the operation does not charge its own staging queue twice against spawn capacity', () => {
    const f=fixture();f.advance();const op=f.op();
    Memory.rooms.HOME.spawn={queue:[0,1,2].map(()=>({memory:{keeperOperationId:op.id}}))};
    f.economy.growth.spawnPressure=0.75;f.next();f.advance();
    assert.strictEqual(f.op().phase,'ASSEMBLE');assert.strictEqual(f.Board.getDemands().length,3);
});
test('new mining demand cannot deadlock HAUL setup by counting its own missing CARRY as pre-existing debt', () => {
    const f=fixture();f.secure();f.economy.growth.remote.requiredCarry=50;
    f.next();f.advance();assert.strictEqual(f.op().phase,'MINE');assert.strictEqual(f.op().funded,true);
});
test('the real source planner prepares reusable geometry without admitting civilians before guards', () => {
    const f=fixture(),home=f.home,homeName='W3N6';
    home.name=homeName;home.controller.pos=new RoomPosition(4,25,homeName);f.spawn.pos=new RoomPosition(4,25,homeName);
    delete Game.rooms.HOME;Game.rooms[homeName]=home;Memory.rooms[homeName]=Memory.rooms.HOME;delete Memory.rooms.HOME;
    Memory.rooms[f.name].keeperOperation={id:'keeper:'+f.name,originRoom:homeName,roomName:f.name,phase:'ASSESS',updatedAt:Game.time};
    Game.map.describeExits=name=>name===homeName?{7:f.name}:{3:homeName};
    PathFinder.search=(origin,goal)=>{
        const path=[3,2,1,0].map(x=>new RoomPosition(x,25,homeName));
        const x=goal.pos.x,y=goal.pos.y;path.push(new RoomPosition(49,25,f.name));
        for(let px=48;px>=x;px--)path.push(new RoomPosition(px,25,f.name));
        for(let py=25;py!==y;){py+=py<y?1:-1;path.push(new RoomPosition(x,py,f.name));}
        return {path,incomplete:false};
    };
    f.Index.resetForTests();const plan=f.realPrepare(homeName,f.name);
    assert.strictEqual(plan.ready,true);assert.strictEqual(plan.sourceIds.length,3);
    const saved=Memory.rooms[homeName].remotePlanner;assert.strictEqual(saved.activeSourceIds.length,0);
    assert.strictEqual(Object.keys(saved.sourceInfos).length,3);assert.strictEqual(f.Policy.miningAllowed(f.name),false);
    const op=Memory.rooms[f.name].keeperOperation;Object.assign(op,{sourceIds:plan.sourceIds,lairIds:plan.lairIds,
        phase:'MINE',updatedAt:Game.time,economics:{combat:10,net:12}});
    f.sources.forEach((source,i)=>f.add('guard'+i,'Volley',f.Ops.body(),{homeRoom:homeName,
        keeperPatrolRoom:f.name,keeperOperationId:op.id,keeperLairId:'l'+i},f.room,source.pos.x+4,source.pos.y));
    f.room.createConstructionSite=()=>OK;
    assert(f.Remote.shouldUseRemoteSource(homeName,'s0',true));
    f.Remote.scanVisibleRoom(homeName,f.room);
    assert.deepStrictEqual(saved.activeSourceIds.slice().sort(),plan.sourceIds.slice().sort(),JSON.stringify({saved,op},null,2));
    assert(f.Remote.getRemotePath(homeName,'s0').length>0,JSON.stringify(saved.sourceInfos.s0.route));
});
test('guard demands reach the real queue with fixed bodies and survive ordinary-defense cleanup', () => {
    const f=fixture();f.advance();
    f.add('foreman','Foreman',[CARRY,MOVE]);f.add('miner','Extractor',[WORK,CARRY,MOVE]);f.add('courier','Freighter',[CARRY,MOVE]);
    require('HiveMind.Capacity').evaluate=()=>({allowed:true});
    require('HiveMind.ColonyState').get=()=>({phase:'GROWTH'});f.E.canSpawnRequest=()=>({allowed:true});
    const report=f.Board.flush();const queue=Memory.rooms.HOME.spawn.queue;
    assert(queue.length>0,JSON.stringify(report));assert(queue.every(q=>q.bodyRequirements.fixed&&q.body.length===40));
    require('spawn.request.manager').cleanDefenseQueue('HOME',{desiredRanged:0,desiredMelee:0,desiredHealers:0,harmfulHostileCount:0});
    assert(queue.length>0);
});
test('Keeper miner production requests retain seven WORK while waiting for affordable energy', () => {
    const f=fixture();f.secure();const captured=[];
    f.Remote.getRemoteExtractorDemand=()=>[{sourceId:'s0',remoteRoomName:f.name,missingWork:7,sourceInfo:{state:'BOOTSTRAPPING'}}];
    require('Spawn.Arbiter').admit=(room,request)=>{captured.push(request);return{ok:true,requested:1,request};};
    require('spawn.request.manager').requestRemoteExtractorsForRoom(f.home,[WORK,CARRY,MOVE],40,1);
    assert.strictEqual(captured.length,1);assert(captured[0].bodyRequirements.fixed);
    assert.strictEqual(captured[0].body.filter(p=>p===WORK).length,7);assert.strictEqual(captured[0].minimumWorkParts,7);
});
test('unopposed level-zero cores automatically request an ATTACK body rather than a WORK breacher', () => {
    const f=fixture(true); f.NPC.run(); const op=Memory.rooms[f.name].npcCoreOperation;
    assert.strictEqual(op.phase,'ASSEMBLE'); const d=f.Board.getDemands()[0];
    assert.strictEqual(d.role,'Ronin'); assert.strictEqual(d.bodyRequirements.body.filter(p=>p===ATTACK).length,6);
    assert.strictEqual(d.bodyRequirements.body.includes(WORK),false);
});
test('core attacker engages only the confirmed level-zero target and confirms removal before completion', () => {
    const f=fixture(true); f.NPC.run(); const c=f.add('breaker','Ronin',f.NPC.body(),{npcCoreOperationId:'npcCore:'+f.name,targetRoom:f.name},f.room,24,25);
    let attacked=0;c.attack=target=>{assert.strictEqual(target,f.core);attacked++;return OK;}; f.next(); f.NPC.run();f.NPC.runCreep(c);
    assert.strictEqual(attacked,1); f.structures.length=0; delete Memory.rooms[f.name].invaderCore; f.next(); f.NPC.run();
    assert.strictEqual(Memory.rooms[f.name].npcCoreOperation.phase,'COMPLETE'); f.NPC.runCreep(c);
    assert.strictEqual(f.moves.at(-1).room,'HOME');
});
test('strongholds, deployment effects, towers, armed defenders and players cannot use lesser-core clearance', () => {
    for(const threat of ['stronghold','deploy','tower','invader','player']) {
        const f=fixture(true);
        if(threat==='stronghold'){f.core.level=1;Memory.rooms[f.name].invaderCore.level=1;}
        if(threat==='deploy')f.core.ticksToDeploy=10;
        if(threat==='tower')f.structures.push({structureType:'tower',my:false});
        if(threat==='invader')f.hostiles.push(f.enemy('Invader'));
        if(threat==='player')f.hostiles.push(f.enemy('someone',[]));
        f.NPC.run();assert.strictEqual(f.Board.getDemands().length,0);assert.strictEqual(Memory.rooms[f.name].npcCoreOperation.phase,'DEFERRED');
    }
});
test('core loss of vision or a newly defended room withdraws the attacker and cancels replacement requests', () => {
    const f=fixture(true); f.NPC.run(); const c=f.add('breaker','Ronin',f.NPC.body(),{npcCoreOperationId:'npcCore:'+f.name,targetRoom:f.name},f.room);
    f.next();f.NPC.run();delete Game.rooms[f.name];f.next();f.NPC.run();f.NPC.runCreep(c);
    assert.strictEqual(f.Board.getDemands().length,0);assert.strictEqual(f.moves.at(-1).room,'HOME');
    assert.notStrictEqual(Memory.rooms[f.name].npcCoreOperation.phase,'COMPLETE');
});
test('Ronin does not issue self-healing that suppresses an in-range melee attack', () => {
    const f=fixture(true), c=f.add('ronin','Ronin',[ATTACK,HEAL,MOVE],{},f.room,10,10), target=f.enemy('Invader');target.pos=new RoomPosition(11,10,f.name);
    let heals=0,attacks=0;c.hits=250;c.heal=()=>{heals++;return OK;};c.attack=()=>{attacks++;return OK;};
    const war=require('Logic.WarRoom');war.getCombatTarget=()=>target;war.clearCombatTarget=()=>{};
    require('utility.Travel.Creep').moveOffExit=()=>false;
    require('role.Ronin').run(c);assert.strictEqual(heals,0);assert.strictEqual(attacks,1);
});
test('an attack on home recalls Keeper forces and their bodies remain available for ordinary NPC defense', () => {
    const f=fixture();f.advance();const c=f.guard(0);
    require('HiveMind.Memory').ensure().threats.HOME={dangerousHostileCount:1};f.next();f.advance();
    assert.strictEqual(f.op().reason,'HOME_UNDER_ATTACK');
    const invader=f.enemy('Invader');invader.pos=new RoomPosition(24,25,'HOME');
    const homeFind=f.home.find;f.home.find=type=>type===FIND_HOSTILE_CREEPS?[invader]:homeFind(type);
    f.Index.resetForTests();assert.strictEqual(require('Keeper.Combat').run(c),false);
});
test('mixed Keeper-room invaders cannot bypass the staged operation through generic defense requests', () => {
    const f=fixture();f.secure();
    assert.strictEqual(require('Combat.Policy').mayAutoEngage('Invader',{roomName:f.name,attackedUs:true}),false);
});
test('a force that cannot make clearing progress backs off instead of consuming endless replacements', () => {
    const f=fixture();f.advance();[0,1,2].forEach(i=>f.enter(f.guard(i)));
    f.hostiles.push(...[0,1,2].map(i=>f.enemy('Source Keeper',[ATTACK,RANGED_ATTACK],i)));
    f.next();f.advance();assert.strictEqual(f.op().phase,'CLEAR');
    f.next(151);f.advance();assert.strictEqual(f.op().phase,'COOLDOWN');assert.strictEqual(f.op().reason,'KEEPER_CLEAR_STALLED');
    assert.strictEqual(f.Board.getDemands().length,0);
});
test('unsupported Keeper damage profiles cannot launch the standard force', () => {
    const f=fixture();f.hostiles.push(f.enemy('Source Keeper',Array(11).fill(RANGED_ATTACK)));
    f.advance();assert.strictEqual(f.op().reason,'KEEPER_PROFILE_UNSUPPORTED');assert.strictEqual(f.Board.getDemands().length,0);
});
test('a stalled lesser-core attack receives a loss cooldown rather than a new wave', () => {
    const f=fixture(true);f.NPC.run();f.add('breaker','Ronin',f.NPC.body(),{npcCoreOperationId:'npcCore:'+f.name,targetRoom:f.name});
    f.next();f.NPC.run();f.next(201);f.NPC.run();
    assert.strictEqual(Memory.rooms[f.name].npcCoreOperation.reason,'CORE_CLEAR_STALLED');assert.strictEqual(f.Board.getDemands().length,0);
});

test('safe core pauses reset the progress clock without counting an assault failure', () => {
    const f=fixture(true);f.NPC.run();f.add('breaker','Ronin',f.NPC.body(),{npcCoreOperationId:'npcCore:'+f.name,targetRoom:f.name});
    f.next();f.NPC.run(); const op=Memory.rooms[f.name].npcCoreOperation;
    assert(op.progress); f.economy.state='RECOVERY';f.next();f.NPC.run();
    assert.strictEqual(op.reason,'CORE_FORCE_UNFUNDED');assert.strictEqual(op.progress,undefined);
    f.next(250);f.economy.state='STABLE';f.NPC.run();
    assert.strictEqual(op.phase,'CLEAR');assert.strictEqual(op.progress.tick,Game.time);assert.strictEqual(op.failures||0,0);
});

test('an expired core force without completion consumes the bounded retry budget', () => {
    const f=fixture(true);f.NPC.run();const c=f.add('breaker','Ronin',f.NPC.body(),{npcCoreOperationId:'npcCore:'+f.name,targetRoom:f.name});
    c.ticksToLive=1400;f.next();f.NPC.run();const op=Memory.rooms[f.name].npcCoreOperation;
    delete Game.creeps[c.name];delete Memory.creeps[c.name];f.next(1401);f.NPC.run();
    assert.strictEqual(op.failures,1);assert.strictEqual(op.phase,'COOLDOWN');assert(op.retryAt>Game.time);
    assert.strictEqual(f.Board.getDemands().length,0);
});

test('a brief recovery exit cannot finance a new core expedition', () => {
    const f=fixture(true);f.economy.stateSince=Game.time;f.NPC.run();
    assert.strictEqual(Memory.rooms[f.name].npcCoreOperation.reason,'CORE_ECONOMY_SETTLING');assert.strictEqual(f.Board.getDemands().length,0);
    f.next(99);f.NPC.run();assert.strictEqual(f.Board.getDemands().length,0);
    f.next();f.NPC.run();assert.strictEqual(Memory.rooms[f.name].npcCoreOperation.phase,'ASSEMBLE');assert.strictEqual(f.Board.getDemands().length,1);
});
test('planned miner evacuation windows cannot repeatedly tear down a commissioned hauling fleet', () => {
    const f=fixture();f.secure();
    const miners=f.sources.map((s,i)=>f.add('miner'+i,'Extractor',[...Array(7).fill(WORK),CARRY,...Array(4).fill(MOVE)],
        {sourceId:s.id,remoteMining:true,sourceRoom:f.name},f.room,s.pos.x-1,s.pos.y));
    f.next();f.advance();assert.strictEqual(f.op().phase,'HAUL');
    miners[0].pos=new RoomPosition(25,25,'HOME');miners[0].room=f.home;f.next();f.advance();
    assert.strictEqual(f.op().phase,'HAUL');assert(f.Policy.haulingAllowed(f.name));
});
test('Keeper CARRY planning waits for real miners and accounts for economy-before-operations tick ordering', () => {
    const f=fixture();f.secure();
    const info={sourceId:'s0',roomName:f.name,parentHome:'HOME',grossEnergyPerTick:13.333,effectiveEnergyPerTick:13.333,roundTripTicks:40};
    f.sources.forEach((s,i)=>f.add('miner'+i,'Extractor',[...Array(7).fill(WORK),CARRY,...Array(4).fill(MOVE)],
        {sourceId:s.id,remoteMining:true,sourceRoom:f.name},f.room,s.pos.x-1,s.pos.y));
    assert.strictEqual(f.E.remoteHaulRequirement(info,{amount:1000,lastSeen:Game.time},'HOME'),0);
    f.next();f.advance();assert.strictEqual(f.op().phase,'HAUL');
    f.next();assert(f.E.remoteHaulRequirement(info,{amount:0,lastSeen:Game.time},'HOME')>0);
    f.next(2);assert.strictEqual(f.E.remoteHaulRequirement(info,{amount:1000,lastSeen:Game.time},'HOME'),0);
});
test('funded staging retains Scout vision until a combat unit arrives, but deferral does not pin the Scout', () => {
    const f=fixture();f.advance();assert(f.Policy.needsObserver(f.name));
    const c=f.guard(0);f.enter(c);f.Index.resetForTests();assert.strictEqual(f.Policy.needsObserver(f.name),false);
    c.pos=new RoomPosition(25,25,'HOME');c.room=f.home;f.Index.resetForTests();
    f.op().phase='DEFERRED';f.op().funded=false;assert.strictEqual(f.Policy.needsObserver(f.name),false);
});
test('the Scout role holds safe room vision for funded assembly instead of immediately choosing another room', () => {
    const f=fixture();f.advance();
    const scout=f.add('observer','Scout',[MOVE],{homeRoom:'HOME'},f.room,48,25);
    require('utility').scanRoom=()=>{};f.Remote.onScoutRoom=()=>true;
    require('Strategy.Provider').observeRoom=()=>{};
    require('Strategy.Provider').runScoutDirective=()=>false;
    require('Power.Intel').observeRoom=()=>{};
    require('utility.Travel.Creep').moveOffExit=()=>false;
    require('role.Scout').run(scout);
    assert.strictEqual(scout.memory.npcObserveRoom,f.name);
    assert.strictEqual(f.moves.length,0);
});

console.log('NPC automation scenarios passed: '+passed);
