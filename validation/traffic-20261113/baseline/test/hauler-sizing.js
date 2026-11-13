const assert=require('assert'),mocks=require('./mock-screeps');
let passed=0;function test(n,fn){fn();passed++;console.log('PASS '+n);}
function fixture(){
    mocks.installGlobals();mocks.clearLocalModules();Game.time=1000;BODYPART_COST={carry:50,move:50};
    const room={name:'W1N1',energyCapacityAvailable:1800,energyAvailable:400};
    require('Harvest.Planning').energyCapacity=r=>r.energyCapacityAvailable;
    const economy={state:'STABLE',energyTrend:10,harvest:{actualOrEstimatedIncome:20},haul:{localCarry:20}};
    require('HiveMind.Economy').get=()=>economy;
    const request={role:'Freighter',body:Array(10).fill(CARRY).concat(Array(10).fill(MOVE))};
    const preview={body:Array(4).fill(CARRY).concat(Array(4).fill(MOVE)),selection:{affordable:true}};
    const S=require('Spawn.Sizing');return{room,economy,request,preview,evaluate:urgent=>S.evaluate(room,request,preview,urgent)};
}
test('a healthy new hauler waits briefly for its admitted efficient body instead of immediately spawning small',()=>{
    const f=fixture();const s=f.evaluate(false);assert(s.wait);assert.equal(s.preferredCost,1000);assert(s.reason.includes('hauling'));
});
test('ordinary hauler waiting ends after twenty ticks and energy refills cannot restart it',()=>{
    const f=fixture();f.evaluate(false);for(let n=1;n<=20;n++){Game.time++;f.room.energyAvailable+=1;const s=f.evaluate(false);assert.equal(s.wait,n<20);}
    assert.equal(f.request.spawnSizing.deadline,1020);
});
test('urgent local recovery and economic deterioration release a hauler wait immediately',()=>{
    let f=fixture();f.evaluate(false);assert.equal(f.evaluate(true).wait,false);
    f=fixture();f.evaluate(false);f.economy.energyTrend=-2;assert.equal(f.evaluate(false).wait,false);
});
test('consolidated renewals fixed bodies and impossible capacity retain their existing selection behavior',()=>{
    for(const change of [f=>f.request.freighterRenewal=true,f=>f.request.bodyRequirements={fixed:true},f=>f.room.energyCapacityAvailable=0]){
        const f=fixture();change(f);assert.equal(f.evaluate(false).wait,false);
    }
});
test('modeled negative spend trend does not force tiny haulers in a stable funded colony',()=>{
    const f=fixture();f.economy.energyTrend=-20;f.economy.growth={energyAboveReserve:10000};
    assert.equal(f.evaluate(false).wait,true);Game.time+=20;assert.equal(f.evaluate(false).wait,false);
});
test('a smaller live hauling deficit lowers preferred cost without restarting the wait deadline',()=>{
    const f=fixture();f.evaluate(false);Game.time+=10;f.request.requestedCarryParts=3;
    f.preview.body=[CARRY,CARRY,CARRY,MOVE,MOVE,MOVE];assert.equal(f.evaluate(false).wait,false);
    assert.equal(f.request.spawnSizing.preferredCost,300);assert.equal(f.request.spawnSizing.deadline,1020);
    Game.time+=10;f.request.requestedCarryParts=10;assert.equal(f.evaluate(false).wait,false);
});
console.log(`Hauler sizing: ${passed} passed`);
