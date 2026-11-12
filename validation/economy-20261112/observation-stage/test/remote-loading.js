const assert=require('assert');
const {world}=require('./freighter-renewal');
let passed=0;
function fixture(){
    const f=world(6,800,34);const remote={name:'W38S47',find:()=>[]};Game.rooms[remote.name]=remote;
    const c=f.unit('hauler',5,1000,'remoteHauling');c.room=remote;c.pos=new RoomPosition(10,10,remote.name);
    Object.assign(c.memory,{freighterJob:'remote',pickupRoom:remote.name,pickupSourceId:'rs',pickupTargetId:'old',pickupTargetType:'dropped'});
    const miner=f.unit('remoteMiner',1,1000);miner.pos=new RoomPosition(10,11,remote.name);miner.room=remote;
    miner.memory={role:'Extractor',homeRoom:f.room.name,sourceId:'rs',remoteMining:true};
    miner.body=[WORK,WORK,WORK,CARRY,MOVE].map(type=>({type,hits:100}));
    const info={sourceId:'rs',roomName:remote.name,parentRoomName:f.room.name,parentHome:f.room.name,
        active:true,operational:true,distance:69,score:4,risk:0,numOpen:3,route:{valid:true}};
    f.memory.remotePlanner={pathVersion:1,activeSourceIds:['rs'],sourceInfos:{rs:info},remotes:{}};
    const haul={targetId:null,targetType:null,lastSeen:Game.time,lastAdvertisedBy:miner.name,amount:0};
    Memory.rooms[remote.name]={sources:{rs:{id:'rs',pos:{x:10,y:11,roomName:remote.name},seatCount:3,haul}}};
    f.refresh();const planner=require('Planner.Remote');planner.moveFreighterAlongRemotePath=()=>false;
    planner.recordRemoteTripLeg=()=>{};planner.getHomeDeliveryTarget=()=>null;
    const role=require('role.Freighter');const pickups=[];
    c.pickup=t=>{pickups.push(t.id);return OK;};c.drop=()=>OK;
    c.pos.findClosestByPath=()=>null;require('utility.Travel.Creep').moveToRoom=()=>OK;
    require('HiveMind.Economy').checkSpend=()=>({allowed:true});
    return {...f,c,miner,info,haul,planner,pickups,role,run:()=>role._test.handleRemoteCollection(c)};
}
function test(name,fn){fn();passed++;console.log('PASS '+name);}
test('a live drop buffer keeps its source claim while the resource ID changes',()=>{
    const f=fixture();f.haul.targetId='new';f.haul.targetType='dropped';
    assert.ok(f.planner.shouldUseRemoteSource(f.room.name,'rs'), JSON.stringify(f.info));
    Game.getObjectById=id=>id==='new'?{id:'new',resourceType:RESOURCE_ENERGY,amount:50,pos:f.c.pos}:null;
    assert.ok(f.planner.refreshRemoteFreighterReservation(f.c), JSON.stringify(f.c.memory));
    assert.equal(f.run(),true);assert.deepEqual(f.pickups,['new']);assert.equal(f.c.memory.pickupSourceId,'rs');
});
test('a partial load waits for the next drop and then leaves with an efficient load',()=>{
    const f=fixture();f.c.store.energy=1;assert.equal(f.run(),true);
    assert.equal(f.c.memory.FreighterWorking,undefined);assert.equal(f.c.memory.freighterJob,'remote');
    const start=f.c.memory.remoteLoadStartedAt;Game.time+=10;f.haul.lastSeen=Game.time;
    f.haul.targetId='next';f.haul.targetType='dropped';
    Game.getObjectById=id=>id==='next'?{id:'next',resourceType:RESOURCE_ENERGY,amount:200,pos:f.c.pos}:null;
    f.run();assert.equal(f.c.memory.remoteLoadStartedAt,start,'new pile must not restart the deadline');
    Game.time++;f.c.store.energy=201;f.haul.targetId=null;f.haul.lastSeen=Game.time;Game.getObjectById=()=>null;
    f.run();assert.equal(f.c.memory.freighterJob,'remoteDelivery');assert.equal(f.c.memory.FreighterWorking,true);
    assert.equal(f.c.memory.remoteDeliverySourceId,'rs');assert.equal(f.c.memory.remoteLoadStartedAt,undefined);
});
test('loading timeout and low remaining lifetime return partial cargo',()=>{
    for(const change of [f=>{f.c.memory.remoteLoadStartedAt=Game.time-50;},f=>{f.c.ticksToLive=100;}]){
        const f=fixture();f.c.store.energy=10;change(f);f.run();
        assert.equal(f.c.memory.freighterJob,'remoteDelivery');assert.equal(f.c.store.energy,10);
    }
});
test('miner death cannot keep a partial courier waiting at an empty station',()=>{
    const f=fixture();f.c.store.energy=10;delete Game.creeps[f.miner.name];f.run();
    assert.equal(f.c.memory.freighterJob,'remoteDelivery');
});
test('a closed source returns partial cargo with source and destination evidence intact',()=>{
    const f=fixture();f.c.store.energy=10;f.info.active=false;f.run();
    assert.equal(f.c.memory.freighterJob,'remoteDelivery');assert.equal(f.c.memory.remoteDeliverySourceId,'rs');
    assert.equal(f.c.memory.remoteDeliveryRoom,'W38S47');assert.equal(f.c.store.energy,10);
});
console.log('Remote loading scenarios passed: '+passed);
