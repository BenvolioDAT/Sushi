const assert = require('assert');
const { world } = require('./freighter-renewal');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function fixture() {
    const f = world(18,800,54); Game.time += 25;
    f.unit('local',18,1200); f.unit('hauler',8,1000,'remoteHauling');
    const miner=f.unit('remoteMiner',1,1200);
    miner.memory={role:'Extractor',homeRoom:f.room.name,remoteMining:true,sourceId:'rs'};
    miner.body=[WORK,WORK,WORK,MOVE].map(type=>({type,hits:100}));
    miner.pos=new RoomPosition(10,11,'W38S47');Memory.creeps[miner.name]=miner.memory;
    const info={sourceId:'rs',roomName:'W38S47',active:true,operational:true,effectiveEnergyPerTick:5,roundTripTicks:166,route:{valid:true}};
    f.memory.remotePlanner={activeSourceIds:['rs'],sourceInfos:{rs:info}};
    const source={pos:{x:10,y:10},haul:{amount:2000,reservedCarry:0,lastSeen:Game.time}};
    Memory.rooms.W38S47={sources:{rs:source}};
    Object.assign(f.snapshot.harvest.sources[0],{workActive:10,workRequired:10,estimatedIncome:20,expectedIncome:20});
    f.refresh();
    Game.cpu.bucket=8000;Game.cpu.getUsed=()=>10;
    global.__sushiCpuRolling={tick:Game.time-1,samples:100,total:16.4,phases:{}};
    const H=require('HiveMind.Memory'), C=require('HiveMind.Capacity');
    const view={cpu:{share:0},population:{softCap:3,hardSafetyCap:56},
        energy:{known:true,healthy:true,aboveReserve:10000,trend:1}};
    H.ensure().capacity={tick:Game.time,rooms:{[f.room.name]:view}};
    const request={role:'Freighter',body:[...Array(8).fill(CARRY),...Array(8).fill(MOVE)],requestedCarryParts:8,maxCarryParts:8,
        priority:87,memory:{role:'Freighter',homeRoom:f.room.name,assignmentFunction:'remoteHauling'}};
    const decision=()=>require('Spawn.Policy').evaluate(f.room,request,require('Spawn.Context').snapshot(f.room.name));
    return {...f,H,C,view,request,decision,info,source,miner};
}
test('the live CPU ceiling blocks ordinary growth but admits bounded delivery of already-produced remote income',()=>{
    const f=fixture();f.H.getConfig('capacity').remoteHaulRelief=false;
    assert.strictEqual(f.decision().reason,'CPU_CAPACITY_EXHAUSTED');
    f.H.getConfig('capacity').remoteHaulRelief=true;
    const d=f.decision();assert.strictEqual(d.allowed,true,JSON.stringify(d));
    assert.strictEqual(d.reason,'PRODUCTIVE_REMOTE_HAUL_RELIEF');
    assert.ok(d.remoteHaulRelief.projectedCpu<=18);assert.strictEqual(d.missingCarry,8);
    const other={...f.request,role:'Annex',body:[CLAIM,MOVE],memory:{role:'Annex',homeRoom:f.room.name}};
    assert.strictEqual(f.C.evaluate(f.room,other,require('Spawn.Context').snapshot(f.room.name),false,false).allowed,false);
});
test('relief caps the actual spawned body to recurring production missing after existing haulers',()=>{
    const f=fixture();f.unit('secondHauler',8,1000,'remoteHauling');
    const d=f.decision();assert.strictEqual(d.missingCarry,3);
    f.queue.push(f.request);
    const result=require('spawn.manager').runRoom(f.room.name);
    assert.strictEqual(result.result,OK,JSON.stringify(result));
    assert.strictEqual(f.calls[0].body.filter(p=>p===CARRY).length,3);
    assert.ok(f.calls[0].memory.remoteHaulRelief);assert.ok(f.calls[0].memory.remoteHaulRelief.projectedCpu<=18);
});
test('home shortages, stale evidence, unsafe routes and absent or nearly expired miners cannot borrow the margin',()=>{
    const changes=[f=>{f.snapshot.state='RECOVERY';},f=>{f.snapshot.sampleTick--;},
        f=>{f.snapshot.harvest.sources[0].estimatedIncome=0;},f=>{f.snapshot.harvest.sources[0].healthyWork=0;},
        f=>{Game.creeps.foreman.ticksToLive=99;},f=>{f.snapshot.haul.localCarry=1;},
        f=>{f.snapshot.haul.backlog=5000;},f=>{Memory.hive.threats[f.room.name]={harmfulHostileCount:1};},
        f=>{Memory.hive.threats.W38S47={harmfulHostileCount:1};},f=>{f.source.haul.lastSeen-=26;},
        f=>{f.source.haul.lastSeen++;},f=>{f.source.haul.reservedCarry=2000;},f=>{f.info.route.valid=false;},
        f=>{f.info.roundTripTicks=0;},f=>{f.miner.spawning=true;},f=>{f.miner.ticksToLive=100;},
        f=>{f.miner.pos=new RoomPosition(20,20,'W38S47');},f=>{f.miner.body.find(p=>p.type===MOVE).hits=0;}];
    for(const change of changes){const f=fixture();change(f);assert.strictEqual(f.decision().allowed,false,change.toString());}
});
test('CPU pressure, bucket reserve, hard population, energy and spawn limits remain enforced',()=>{
    const changes=[f=>{Game.cpu.bucket=5999;},f=>{Game.cpu.getUsed=()=>19;},
        f=>{global.__sushiCpuRolling.total=18;},f=>{global.__sushiCpuRolling.tick--;},
        f=>{global.__sushiCpuRolling.samples=1;},f=>{f.view.population.hardSafetyCap=1;},
        f=>{f.view.energy.aboveReserve=100;},f=>{f.view.energy.trend=-5;},
        f=>{f.spawn.spawning={name:'busy',remainingTime:300,needTime:300};}];
    for(const change of changes){const f=fixture();change(f);assert.strictEqual(f.decision().allowed,false,change.toString());}
});
test('spawning and newborn CPU are reserved, accepted intents and visible bodies are not charged twice',()=>{
    for(const visible of [false,true]){
        const f=fixture();f.H.ensure().telemetry.populationRoles={Artificer:{cpu:1.5}};
        require('Spawn.Intents').record(f.spawn,'incoming',{role:'Artificer',body:[WORK,CARRY,MOVE],memory:{role:'Artificer',homeRoom:f.room.name}},200,800);
        if(visible){const c=f.unit('incoming',1,1500);c.memory.role='Artificer';c.spawning=true;}
        assert.strictEqual(f.decision().allowed,false,'unmeasured incoming CPU must consume the margin');
        global.__sushiCpuRolling.total=15.9;
        assert.strictEqual(f.decision().allowed,true,'one pending cost fits; a duplicate charge would not');
        if(visible){Game.creeps.incoming.spawning=false;assert.strictEqual(f.decision().allowed,true);
            global.__sushiCpuRolling.total=16.4;assert.strictEqual(f.decision().allowed,false,'newborn CPU has not settled yet');}
    }
});
test('a prior-tick spawn absent from Game.creeps still reserves its future CPU',()=>{
    const f=fixture();f.H.ensure().telemetry.populationRoles={Artificer:{cpu:1.5}};
    f.spawn.spawning={name:'previousTick',remainingTime:8,needTime:9};
    Memory.creeps.previousTick={role:'Artificer',homeRoom:f.room.name};
    assert.strictEqual(f.decision().allowed,false);
});
test('another queued or spawning hauler prevents duplicate relief and changed production is revalidated',()=>{
    const f=fixture();assert.strictEqual(f.decision().allowed,true);
    const other={...f.request,memory:{...f.request.memory}};f.queue.push(other);
    assert.strictEqual(f.decision().allowed,false);f.queue.pop();
    f.info.effectiveEnergyPerTick=1;assert.strictEqual(f.decision().allowed,false);
});
test('active Artificer tasks replace stale emergency birth labels while pending emergency work remains protected',()=>{
    const f=fixture(), c=f.unit('builder',1,1000);c.memory={role:'Artificer',homeRoom:f.room.name,
        economyCategory:'criticalMaintenance',criticalMaintenance:true,artificerTask:'BUILD_REMOTE',artificerWorkCategory:'remoteBootstrap'};
    assert.strictEqual(f.C.classify(c),'ECONOMIC');c.memory.artificerTask='CRITICAL_REPAIR';c.memory.artificerWorkCategory='criticalMaintenance';
    assert.strictEqual(f.C.classify(c),'MANDATORY');c.spawning=true;c.memory.artificerWorkCategory='remoteBootstrap';
    assert.strictEqual(f.C.classify(c),'MANDATORY');
});
test('reload warmup and explicitly tighter limits are respected, and ordinary admission keeps its normal budget',()=>{
    let f=fixture();Game.time-=10;f.snapshot.sampleTick=Game.time;f.source.haul.lastSeen=Game.time;
    f.H.ensure().capacity.tick=Game.time;global.__sushiCpuRolling.tick=Game.time-1;
    assert.strictEqual(f.decision().allowed,false);
    f=fixture();f.H.getConfig('capacity').remoteHaulReliefCeiling=0.8;assert.strictEqual(f.decision().allowed,false);
    f=fixture();global.__sushiCpuRolling.total=17.6;f.H.ensure().telemetry.populationRoles={Freighter:{cpu:0.05}};
    assert.strictEqual(f.decision().allowed,false,'reserve at least 0.5 CPU for an incoming hauler');
    f=fixture();global.__sushiCpuRolling.total=10;f.view.cpu.share=5;f.view.population.softCap=20;
    const d=f.decision();assert.strictEqual(d.allowed,true);assert.strictEqual(d.remoteHaulRelief,undefined);
});
function restartFixture(){
    const f=fixture();delete Game.creeps.remoteMiner;delete Memory.creeps.remoteMiner;
    f.source.haul.lastAdvertisedAt=Game.time-100;f.source.haul.lastDeliveryAt=Game.time-50;
    f.info.roundTripTicks=62;f.refresh();
    f.request={role:'Extractor',body:[WORK,WORK,WORK,MOVE,MOVE,CARRY],requestedWorkParts:3,maxWorkParts:3,
        priority:86,memory:{role:'Extractor',homeRoom:f.room.name,remoteMining:true,sourceId:'rs',sourceRoom:'W38S47',targetRoom:'W38S47'}};
    f.decision=()=>require('Spawn.Policy').evaluate(f.room,f.request,require('Spawn.Context').snapshot(f.room.name));
    return f;
}
test('a previously productive remote can restart using existing hauling within the same CPU margin',()=>{
    const f=restartFixture(),d=f.decision();assert.strictEqual(d.allowed,true,JSON.stringify(d));
    assert.strictEqual(d.reason,'SUPPORTED_REMOTE_RESTART');assert.strictEqual(d.remoteRestart.productionCarry,7);
    f.queue.push(f.request);const result=require('spawn.manager').runRoom(f.room.name);
    assert.strictEqual(result.result,OK,JSON.stringify(result));assert.ok(f.calls[0].memory.remoteRestart);
});
test('restoration refuses speculative sources, unsupported hauling and concurrent remote miners',()=>{
    const changes=[f=>{f.source.haul.lastAdvertisedAt-=1501;},f=>{delete f.source.haul.lastDeliveryAt;},
        f=>{f.source.haul.lastSeen-=26;},f=>{f.info.roundTripTicks=166;},f=>{f.miner=f.unit('otherMiner',1,1000);
            f.miner.memory={role:'Extractor',homeRoom:f.room.name,remoteMining:true,sourceId:'other'};},
        f=>{f.queue.push({...f.request,memory:{...f.request.memory,sourceId:'other'}});},
        f=>{Game.cpu.bucket=5999;},f=>{global.__sushiCpuRolling.total=18;}];
    for(const change of changes){const f=restartFixture();change(f);assert.strictEqual(f.decision().allowed,false,change.toString());}
});
test('fresh friendly reservation output is covered before a supported restart is allowed',()=>{
    const f=restartFixture();f.request.body.unshift(WORK,WORK);f.request.requestedWorkParts=f.request.maxWorkParts=5;
    f.H.ensure().identity.username='me';f.info.grossEnergyPerTick=10;
    Memory.rooms.W38S47.controller={reservation:{username:'me',ticksToEnd:2000,observedAt:Game.time}};
    assert.strictEqual(f.decision().allowed,false,'reserved source needs fourteen CARRY, not stale unreserved seven');
    f.unit('support',6,1000,'remoteHauling');assert.strictEqual(f.decision().allowed,true);
});
test('a proven mine can restart without a fresh stockpile scan, but ownership intel cannot be stale or hostile',()=>{
    const f=restartFixture();f.source.haul.lastSeen-=300;f.source.haul.amount=0;
    Memory.rooms.W38S47.controller={lastObservedAt:Game.time-300,owner:null,reservation:null};
    assert.strictEqual(f.decision().allowed,true,'mining creates new energy; current stock is not the restart justification');
    Memory.rooms.W38S47.controller.lastObservedAt=Game.time-501;assert.strictEqual(f.decision().allowed,false);
    Memory.rooms.W38S47.controller.lastObservedAt=Game.time;Memory.rooms.W38S47.controller.owner='other';
    assert.strictEqual(f.decision().allowed,false);
});
test('stale or future role CPU samples do not permanently price an absent scout as an expensive old workload',()=>{
    const f=fixture(),roles=f.H.ensure().telemetry.populationRoles={Scout:{cpu:1.5,tick:Game.time}};
    assert.strictEqual(f.C.roleCpu('Scout'),1.5);
    roles.Scout.tick=Game.time-501;assert.strictEqual(f.C.roleCpu('Scout'),0.2);
    roles.Scout.tick=Game.time+1;assert.strictEqual(f.C.roleCpu('Scout'),0.2);
});
console.log('Remote hauling capacity scenarios passed: '+passed);
