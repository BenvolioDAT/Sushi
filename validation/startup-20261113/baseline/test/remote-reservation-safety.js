const assert=require('assert');
const {world}=require('./freighter-renewal');
let passed=0;
function fixture(){
    const f=world(6,800,34);Game.time=200;
    const H=require('HiveMind.Memory');H.ensure().identity.username='me';
    const remote={name:'W38S47',controller:{reservation:{username:'Invader',ticksToEnd:100}},find:()=>[]};
    Game.rooms[remote.name]=remote;
    const miner=f.unit('remoteMiner',1,1000);miner.room=remote;miner.pos=new RoomPosition(10,10,remote.name);
    miner.memory={role:'Extractor',homeRoom:f.room.name,sourceId:'rs',sourceRoom:remote.name,remoteMining:true};
    miner.body=[WORK,WORK,WORK,CARRY,MOVE,MOVE].map(type=>({type,hits:100}));Memory.creeps[miner.name]=miner.memory;
    const info={sourceId:'rs',roomName:remote.name,parentRoomName:f.room.name,parentHome:f.room.name,
        distance:69,numOpen:4,active:true,operational:true,score:4,risk:0,effectiveEnergyPerTick:5,grossEnergyPerTick:10,
        roundTripTicks:138,route:{valid:true,roomSequence:[f.room.name,remote.name]}};
    f.memory.remotePlanner={activeSourceIds:['rs'],sourceInfos:{rs:info},remotes:{}};
    const stock={amount:0,lastSeen:Game.time,reservedCarry:0};
    Memory.rooms[remote.name]={sources:{rs:{id:'rs',pos:{x:10,y:11,roomName:remote.name},seatCount:4,haul:stock}}};
    f.refresh();require('HiveMind.Economy').checkSpend=()=>({allowed:true});
    return {...f,remote,miner,info,stock,planner:require('Planner.Remote')};
}
function test(name,fn){fn();passed++;console.log('PASS '+name);}
test('visible foreign reservations suppress source admission before scoring',()=>{
    const f=fixture();assert.equal(f.planner.shouldUseRemoteSource(f.room.name,'rs',true),false);
    assert.equal(f.info.blockedReason,'HOSTILE_RESERVATION');
});
test('a stationed miner retreats instead of repeatedly attempting an impossible harvest',()=>{
    const f=fixture(),steps=[];PathFinder.search=()=>({incomplete:false,path:[new RoomPosition(9,10,f.remote.name)]});
    require('utility.Travel.Creep').move=(c,p)=>{steps.push(p);return OK;};
    assert.equal(f.planner.moveExtractorAlongRemotePath(f.miner,f.room.name,'rs'),true);
    assert.equal(f.miner.memory.extractorState,'remoteRetreat');assert.equal(steps.length,1);
    assert.equal(f.info.active,false);assert.equal(f.info.operational,false);
    assert.deepEqual(f.memory.remotePlanner.activeSourceIds,[]);
    f.miner.pos=new RoomPosition(22,27,f.room.name);Game.time++;
    assert.equal(f.planner.moveExtractorAlongRemotePath(f.miner,f.room.name,'rs'),true);
    assert.equal(steps.length,1,'a recalled miner stays home until access returns');
});
test('hostile reservations cannot promise recurring hauling, but real backlog stays collectible',()=>{
    const f=fixture();assert.equal(f.E.remoteHaulRequirement(f.info,f.stock,f.room.name),0);
    f.stock.amount=1000;assert.ok(f.E.remoteHaulRequirement(f.info,f.stock,f.room.name)>0);
    f.stock.amount=0;f.remote.controller.reservation={username:'me',ticksToEnd:100};Game.time++;
    assert.ok(f.E.remoteHaulRequirement(f.info,f.stock,f.room.name)>0,'a friendly reservation permits actual committed production');
});
test('reservation expiry releases the source through timed intel without deleting its plan',()=>{
    const f=fixture();f.planner.shouldUseRemoteSource(f.room.name,'rs',true);
    delete Game.rooms[f.remote.name];Game.time+=101;
    assert.equal(f.planner.shouldUseRemoteSource(f.room.name,'rs',true),true);
    assert.ok(f.memory.remotePlanner.sourceInfos.rs);
});
console.log('Remote reservation safety scenarios passed: '+passed);
