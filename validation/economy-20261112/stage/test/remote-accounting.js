const assert=require('assert'),mocks=require('./mock-screeps');
let passed=0;function test(n,fn){fn();passed++;console.log('PASS '+n);}
function fixture(){
    mocks.installGlobals();mocks.clearLocalModules();Game.time=1000;
    Memory.config={remote:{accountingEnabled:true}};
    const home='W1N1',remote='W1N2',id='source';
    const info={sourceId:id,roomName:remote,active:true};
    Memory.rooms[home]={remotePlanner:{sourceInfos:{[id]:info}}};
    const miner={id:'miner',my:true,memory:{role:'Extractor',homeRoom:home,sourceId:id,remoteMining:true},ticksToLive:900,store:{energy:0}};
    const hauler={id:'hauler',my:true,memory:{role:'Freighter',homeRoom:home,assignmentFunction:'remoteHauling',remoteDeliverySourceId:id},ticksToLive:900,store:{energy:100}};
    const target={id:'storage',structureType:STRUCTURE_STORAGE,pos:new RoomPosition(25,25,home)};
    const events=[],remoteEvents=[],h={name:home,getEventLog:()=>events},r={name:remote,getEventLog:()=>remoteEvents};
    Game.rooms={[home]:h,[remote]:r};const creeps=[miner,hauler];
    require('HiveMind.Index').get=()=>({ownedRooms:[h],visibleRooms:[h,r],creepsByHomeRoom:new Map([[home,creeps]])});
    Game.getObjectById=id=>({miner,hauler,storage:target}[id]);
    const A=require('Remote.Accounting');return{A,home,remote,id,info,miner,hauler,target,events,remoteEvents,creeps};
}
test('remote accounting counts resolved harvest and home structure transfers rather than presence or intents',()=>{
    const f=fixture();f.remoteEvents.push({event:EVENT_HARVEST,objectId:'miner',data:{targetId:f.id,amount:10}});
    f.events.push({event:EVENT_TRANSFER,objectId:'hauler',data:{targetId:'storage',resourceType:RESOURCE_ENERGY,amount:100}});
    f.A.run();const s=f.A.summary(f.info.accounting);assert.equal(s.harvested,10);assert.equal(s.delivered,100);
    assert.equal(s.visibleTicks,1);assert.equal(s.deliveredEPT,100);
});
test('same-tick calls and a module/global reset cannot double count resolved events',()=>{
    const f=fixture();f.remoteEvents.push({event:EVENT_HARVEST,objectId:'miner',data:{targetId:f.id,amount:10}});
    f.A.run();f.A.run();delete require.cache[require.resolve('Remote.Accounting')];require('Remote.Accounting').run();
    assert.equal(f.A.summary(f.info.accounting).harvested,10);
});
test('remote accounting rejects transfers into creeps, remote rooms and nonenergy resources',()=>{
    const f=fixture();f.events.push({event:EVENT_TRANSFER,objectId:'hauler',data:{targetId:'miner',resourceType:RESOURCE_ENERGY,amount:100}});
    f.events.push({event:EVENT_TRANSFER,objectId:'hauler',data:{targetId:'storage',resourceType:'H',amount:100}});
    f.remoteEvents.push({event:EVENT_TRANSFER,objectId:'hauler',data:{targetId:'storage',resourceType:RESOURCE_ENERGY,amount:100}});
    f.A.run();assert.equal(f.A.summary(f.info.accounting).delivered||0,0);
});
test('accounting records actual accepted remote spawn expenditure and preserves shared cost categories',()=>{
    const f=fixture();BODYPART_COST={work:100,carry:50,move:50};
    f.A.recordSpawn(f.home,{role:'Freighter',memory:{assignmentFunction:'remoteHauling'}},[CARRY,MOVE]);
    f.A.recordSpawn(f.home,{role:'Extractor',memory:{remoteMining:true,sourceId:f.id}},[WORK,CARRY,MOVE]);
    f.A.recordSpawn(f.home,{role:'Freighter',memory:{assignmentFunction:'localLogistics'}},[CARRY,MOVE]);
    const h=f.A.summary(Memory.rooms[f.home].remoteAccounting);assert.equal(h.haulerSpawnCost,100);assert.equal(h.minerSpawnCost,200);
    assert.equal(f.A.summary(f.info.accounting).minerSpawnCost,200);
});
test('early losses and cargo are recorded once while sampling gaps do not invent losses',()=>{
    const f=fixture();f.A.run();f.creeps.splice(1,1);Game.time++;f.A.run();
    const h=f.A.summary(Memory.rooms[f.home].remoteAccounting);assert.equal(h.earlyLosses,1);assert.equal(h.lostCargo,100);
    Game.time+=10;f.creeps.length=0;f.A.run();assert.equal(f.A.summary(Memory.rooms[f.home].remoteAccounting).earlyLosses,1);
});
test('accounting buckets and actor registries remain bounded; rollback starts a fresh evidence epoch',()=>{
    const f=fixture();for(let n=0;n<20;n++){Game.time=1000+n*250;f.A.run();}
    assert(f.info.accounting.buckets.length<=8);assert(Object.keys(Memory.rooms[f.home].remoteAccounting.actors).length<=128);
    Game.time=10;f.A.run();assert.equal(f.info.accounting.since,10);
});
test('disabled remote accounting reads no game index and changes no Memory',()=>{
    const f=fixture();Memory.config.remote.accountingEnabled=false;require('HiveMind.Index').get=()=>{throw Error('must not scan');};
    const before=JSON.stringify(Memory);f.A.run();f.A.recordSpawn(f.home,{memory:{}},[]);assert.equal(JSON.stringify(Memory),before);
});
console.log(`Remote accounting: ${passed} passed`);
