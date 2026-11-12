const assert=require('assert');
const {world}=require('./freighter-renewal');
let passed=0;
function test(name,fn){fn();passed++;console.log('PASS '+name);}
function fixture(){
    const f=world(20,1800,40);f.room.energyCapacityAvailable=1800;f.room.controller.level=6;
    f.unit('local',20,1200);
    for(let i=0;i<4;i++){const c=f.unit('worker'+i,18,1200);c.memory.role='Artificer';}
    const remote=f.unit('remoteMiner',1,1200);remote.memory={role:'Extractor',homeRoom:f.room.name,remoteMining:true,sourceId:'rs'};
    remote.body=[WORK,WORK,WORK,WORK,WORK,MOVE].map(type=>({type,hits:100}));remote.pos=new RoomPosition(10,11,'W38S47');
    Memory.creeps[remote.name]=remote.memory;
    f.memory.remotePlanner={activeSourceIds:['rs'],sourceInfos:{rs:{sourceId:'rs',roomName:'W38S47',active:true,
        operational:true,effectiveEnergyPerTick:10,roundTripTicks:100,route:{valid:true}}}};
    Memory.rooms.W38S47={sources:{rs:{pos:{x:10,y:10},haul:{amount:2000,reservedCarry:0,lastSeen:Game.time}}}};
    f.refresh();Game.cpu.limit=100;Game.cpu.bucket=10000;Game.cpu.getUsed=()=>1;
    global.__sushiCpuRolling={tick:Game.time-1,samples:100,total:20,phases:{}};
    const H=require('HiveMind.Memory');H.ensure().capacity={tick:Game.time,rooms:{[f.room.name]:{
        cpu:{share:70},population:{softCap:100,hardSafetyCap:150},energy:{known:true,healthy:true,aboveReserve:100000,trend:1}}}};
    f.snapshot.growth.energyAboveReserve=100000;
    const request={role:'Freighter',body:[...Array(18).fill(CARRY),...Array(18).fill(MOVE)],requestedCarryParts:18,maxCarryParts:18,
        priority:87,memory:{role:'Freighter',homeRoom:f.room.name,assignmentFunction:'remoteHauling'}};
    const A=require('Spawn.Arbiter');return {...f,H,A,request,admit:()=>A.admit(f.room.name,request)};
}
test('an idle spawn admits a useful remote hauler that fits instead of rejecting the maximum body forever',()=>{
    const f=fixture(),P=require('Spawn.Policy'),C=require('Spawn.Context');
    assert.strictEqual(P.evaluate(f.room,f.request,C.snapshot(f.room.name)).reason,'SPAWN_LOAD_HIGH');
    const r=f.admit();assert.strictEqual(r.ok,true,JSON.stringify(r));assert.strictEqual(r.requested,1);
    assert(r.request.capacityFit.carry>=4&&r.request.capacityFit.carry<18);
    assert.strictEqual(r.request.body.filter(p=>p===CARRY).length,r.request.requestedCarryParts);
    assert.strictEqual(f.admit().requested,0,'stable assignment must not create duplicates');
    const result=require('spawn.manager').runRoom(f.room.name);assert.strictEqual(result.result,OK,JSON.stringify(result));
    assert(f.calls[0].body.filter(p=>p===CARRY).length<=r.request.capacityFit.carry,'execution cannot grow above admitted fit');
});
test('fitted haulers still obey energy CPU and hard population gates',()=>{
    for(const change of [f=>{f.H.ensure().capacity.rooms[f.room.name].energy.aboveReserve=0;},
        f=>{Game.cpu.bucket=100;},f=>{f.H.ensure().capacity.rooms[f.room.name].population.hardSafetyCap=1;}]){
        const f=fixture();change(f);assert.strictEqual(f.admit().ok,false);assert.strictEqual(f.queue.length,0);
    }
});
test('fixed bodies and validated renewals cannot be silently resized',()=>{
    for(const change of [r=>{r.bodyRequirements={fixed:true,body:r.body};},r=>{r.freighterRenewal={assignment:'remote',predecessors:[]};}]){
        const f=fixture();change(f.request);const r=f.admit();assert.strictEqual(r.ok,false);assert.strictEqual(f.queue.length,0);
    }
});
test('no useful spawn envelope defers rather than creating a stream of tiny haulers',()=>{
    const f=fixture();f.spawn.spawning={name:'busy',remainingTime:250,needTime:250};
    assert.strictEqual(f.admit().ok,false);assert.strictEqual(f.queue.length,0);
});
test('fitted remote work waits for a useful minimum while retaining affordable execution',()=>{
    const f=fixture(),r=f.admit();assert(r.ok);f.room.energyAvailable=100;
    require('spawn.manager').runRoom(f.room.name);assert.strictEqual(f.calls.length,0,'one CARRY is not a useful fit');
    f.room.energyAvailable=600;require('spawn.manager').runRoom(f.room.name);
    assert.strictEqual(f.calls.length,1);assert(f.calls[0].body.filter(p=>p===CARRY).length>=4);
});
test('ordinary new remote requests also avoid one-part fragmentation without inflating a small deficit',()=>{
    for(const wanted of [18,2]){
        const f=fixture();for(let i=0;i<4;i++){delete Game.creeps['worker'+i];delete Memory.creeps['worker'+i];}f.refresh();
        f.request.body=[...Array(wanted).fill(CARRY),...Array(wanted).fill(MOVE)];f.request.requestedCarryParts=f.request.maxCarryParts=wanted;
        const r=f.admit();assert(r.ok,JSON.stringify(r));assert.strictEqual(r.request.capacityFit,undefined);
        assert.strictEqual(r.request.minimumCarryParts,Math.min(4,wanted));
        f.room.energyAvailable=100;require('spawn.manager').runRoom(f.room.name);assert.strictEqual(f.calls.length,0);
        f.room.energyAvailable=Math.min(4,wanted)*100;require('spawn.manager').runRoom(f.room.name);assert.strictEqual(f.calls.length,1);
        assert.strictEqual(f.calls[0].body.filter(p=>p===CARRY).length,Math.min(4,wanted));
    }
});
console.log('Spawn hauler-fit scenarios passed: '+passed);
