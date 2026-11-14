const assert=require('assert'),mocks=require('./mock-screeps');
let passed=0;function test(n,fn){fn();passed++;console.log('PASS '+n);}
function fixture(){
    mocks.installGlobals();mocks.clearLocalModules();Game.time=5000;Game.map.getRoomStatus=()=>({status:'normal'});
    const H=require('HiveMind.Memory');H.ensure();require('Strategy.Provider').getScoutRadius=()=>3;
    require('Strategy.Provider').getScoutModifier=()=>0;
    const room='W4N4',priority='W4N3',unknown='W5N4';
    Memory.rooms[room]={scoutPlan:{homeRoom:room,radius:3,rooms:{
        [priority]:{roomName:priority,distance:1,lastScanTick:4900,unreachableUntil:0},
        [unknown]:{roomName:unknown,distance:1,lastScanTick:null,unreachableUntil:0}}}};
    Memory.rooms[priority]={intelPriority:95,intelRefreshRequestedAt:4000,intelRefreshReason:'INVADER_CORE_NEEDS_VISION'};
    const c={room:{name:room},memory:{homeRoom:room}},S=require('role.Scout');
    const choose=()=>{delete c.memory.targetRoom;S._test.chooseNextScoutRoom(c);return c.memory.targetRoom;};
    return{room,priority,unknown,c,choose,plan:Memory.rooms[room].scoutPlan};
}
test('routine refresh requests leave a discovery slot after three visits without deleting safety requests',()=>{
    const f=fixture();for(let i=0;i<3;i++)assert.strictEqual(f.choose(),f.priority);
    assert.strictEqual(f.choose(),f.unknown);assert.strictEqual(f.choose(),f.priority);
    assert.strictEqual(Memory.rooms[f.priority].intelPriority,95);assert.strictEqual(f.plan.priorityStreak,1);
});
test('critical and funded operation vision retain priority over exploration',()=>{
    for(const funded of [false,true]){const f=fixture();f.plan.priorityStreak=3;
        if(funded)Memory.rooms[f.priority].npcCoreOperation={funded:true,phase:'ASSEMBLE',updatedAt:Game.time};
        else Memory.rooms[f.priority].intelPriority=100;
        assert.strictEqual(f.choose(),f.priority);
    }
});
test('unreachable unknown rooms cannot consume the discovery slot',()=>{
    const f=fixture();f.plan.priorityStreak=3;f.plan.rooms[f.unknown].unreachableUntil=Game.time+100;
    assert.strictEqual(f.choose(),f.priority);
});
test('once discovery is complete the slot refreshes genuinely stale rooms',()=>{
    const f=fixture();f.plan.priorityStreak=3;f.plan.rooms[f.unknown].lastScanTick=1000;
    assert.strictEqual(f.choose(),f.unknown);
    f.plan.rooms[f.unknown].lastScanTick=Game.time;f.plan.priorityStreak=3;assert.strictEqual(f.choose(),f.priority);
});
console.log('Scout fairness scenarios passed: '+passed);
