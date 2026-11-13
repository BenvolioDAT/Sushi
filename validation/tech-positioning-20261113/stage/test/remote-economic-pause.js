const assert=require('assert'),mocks=require('./mock-screeps');
let passed=0;function test(n,fn){fn();passed++;console.log('PASS '+n);}
function fixture(){
    mocks.installGlobals();mocks.clearLocalModules();Game.time=1000;require('HiveMind.Memory').ensure();
    const home='W4N4',near='W4N3',far='W5N3';
    const account=()=>({version:1,since:0,buckets:[{at:0,sampledTicks:1000,selectedTicks:1000,harvested:20000,delivered:2000}]});
    const infos={n:{sourceId:'n',roomName:near,active:true,score:8,distance:20,accounting:account()},
        f:{sourceId:'f',roomName:far,active:true,score:6,distance:80,accounting:account()},
        f2:{sourceId:'f2',roomName:far,active:true,score:6,distance:90,accounting:account()}};
    const p={activeSourceIds:['n','f','f2'],sourceInfos:infos};
    Memory.rooms[home]={remotePlanner:p,remoteAccounting:account()};Memory.rooms[near]={sources:{n:{assignedMiner:[]}}};
    Memory.rooms[far]={sources:{f:{assignedMiner:['miner']},f2:{assignedMiner:[]}}};
    const economy={state:'STABLE',harvest:{workActive:10,workRequired:10},haul:{localCarry:20,requiredCarry:20},
        growth:{remote:{availableCarry:10,requiredCarry:100,backlog:5000}}};
    const R=require('Planner.Remote'),advance=n=>{Game.time+=n;for(const a of [Memory.rooms[home].remoteAccounting,...Object.values(infos).map(i=>i.accounting)]){a.buckets[0].sampledTicks+=n;a.buckets[0].selectedTicks+=n;}};
    const run=()=>R.updateEconomicSupport(home,p,economy);return{home,near,far,infos,p,economy,R,run,advance};
}
test('sustained measured hauling failure pauses the costliest ordinary room as a group and preserves a revenue room',()=>{
    const f=fixture();f.run();assert.equal(f.infos.f.economicPause,undefined);f.advance(500);f.run();
    assert.deepStrictEqual(f.p.activeSourceIds,['n']);assert(f.infos.f.economicPause&&f.infos.f2.economicPause);
    assert.equal(f.infos.f.economicPause.until,Game.time+1500);assert.equal(f.p.haulSupport.lastDecision.reason,'LOGISTICS_UNSUPPORTED');
});
test('short pressure sparse measurements and well-delivered production cannot pause a remote',()=>{
    for(const change of [f=>f.economy.growth.remote.availableCarry=80,
        f=>Memory.rooms[f.home].remoteAccounting.buckets[0].delivered=19000,
        f=>Memory.rooms[f.home].remoteAccounting.buckets[0].sampledTicks=1]){
        const f=fixture();change(f);f.run();f.advance(500);f.run();assert.equal(f.infos.f.economicPause,undefined);
    }
});
test('resume uses a separate headroom threshold cooldown stable health and current vision',()=>{
    const f=fixture();f.run();f.advance(500);f.run();f.economy.growth.remote={availableCarry:22,requiredCarry:20,backlog:100};
    f.advance(1499);f.run();assert(f.infos.f.economicPause);f.advance(25);f.run();
    const since=f.infos.f.economicPause.readySince;assert(since);f.advance(300);f.run();assert(f.infos.f.economicPause,'stale vision cannot authorize restart');
    Game.rooms[f.far]={name:f.far};f.advance(25);f.run();assert.equal(f.infos.f.economicPause,undefined);
    assert.equal(f.infos.f2.economicPause,undefined);
});
test('local deterioration resets the resume lease and the final ordinary room is never paused',()=>{
    const f=fixture();f.run();f.advance(500);f.run();f.economy.growth.remote={availableCarry:22,requiredCarry:20,backlog:100};
    f.advance(1500);f.run();f.economy.haul.localCarry=1;f.advance(25);f.run();assert.equal(f.infos.f.economicPause.readySince,undefined);
    const g=fixture();g.p.activeSourceIds=['n'];g.run();g.advance(500);g.run();assert.equal(g.infos.n.economicPause,undefined);
});
test('Keeper portfolios are excluded and disabling economic suspension preserves existing state',()=>{
    let f=fixture();require('Keeper.Intel').known=room=>room===f.far;f.run();f.advance(500);f.run();assert.equal(f.infos.f.economicPause,undefined);
    f=fixture();Memory.config.remote.economicPauseEnabled=false;const before=JSON.stringify(f.p);f.run();assert.equal(JSON.stringify(f.p),before);
});
test('paused miner assignments clear at home without losing cargo or source knowledge',()=>{
    const f=fixture();f.infos.f.economicPause={reason:'LOGISTICS_UNSUPPORTED'};
    const c={id:'miner',name:'miner',memory:{homeRoom:f.home,role:'Extractor',sourceId:'f',remoteMining:true,miningSeat:{x:1,y:1}},
        pos:new RoomPosition(25,25,f.home),store:{energy:50}};
    assert.equal(f.R.guardEconomicCivilian(c),false);assert(!c.memory.sourceId&&!c.memory.remoteMining);
    assert.deepStrictEqual(Memory.rooms[f.far].sources.f.assignedMiner,[]);assert.equal(c.store.energy,50);assert(f.infos.f);
});
test('paused partially loaded haulers retain delivery attribution and return through the existing delivery owner',()=>{
    const f=fixture();f.infos.f.economicPause={reason:'LOGISTICS_UNSUPPORTED'};
    const c={id:'hauler',memory:{homeRoom:f.home,role:'Freighter',pickupSourceId:'f',pickupRoom:f.far,freighterJob:'remote'},
        pos:new RoomPosition(25,25,f.far),store:{energy:100}};
    assert.equal(f.R.guardEconomicCivilian(c),false);assert.equal(c.memory.remoteDeliverySourceId,'f');
    assert.equal(c.memory.freighterJob,'remoteDelivery');assert.equal(c.memory.FreighterWorking,true);assert.equal(c.store.energy,100);
});
console.log(`Remote economic suspension: ${passed} passed`);
