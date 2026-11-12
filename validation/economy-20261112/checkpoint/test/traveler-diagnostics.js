const assert=require('assert'),mocks=require('./mock-screeps');
mocks.installGlobals();mocks.clearLocalModules();
const T=require('Traveler').Traveler;
let passed=0;
function test(name,fn){fn();passed++;console.log('PASS '+name);}
function capture(fn){const original=console.log,lines=[];console.log=s=>lines.push(s);try{fn(lines);}finally{console.log=original;}}
const c={name:'scout',pos:new RoomPosition(10,10,'W1N1')},dest=new RoomPosition(25,25,'W2N1');
test('Traveler CPU diagnostics default off without logging or diagnostic Memory writes',()=>{
    Memory.config={diagnostics:{mode:'NORMAL'}};const data={};
    capture(lines=>{T.reportPathCpu(c,data,15,3000,dest);assert.equal(lines.length,0);});
    assert.deepStrictEqual(data,{});
});
test('Traveler reports current expensive searches with bounded cadence and distinct cumulative cost',()=>{
    Memory.config={diagnostics:{mode:'NORMAL',travelerCpu:{enabled:true,threshold:5,interval:100}}};
    const data={};Game.time=1000;
    capture(lines=>{
        T.reportPathCpu(c,data,8,3000,dest);Game.time++;T.reportPathCpu(c,data,9,3009,dest);
        Game.time=1100;T.reportPathCpu(c,data,6,3015,dest);
        assert.equal(lines.length,2);assert(lines[0].includes('searchCpu=8.00 cumulativeCpu=3000'));
    });assert.equal(data.pathCpuWarningAt,1100);
});
test('Cheap searches do not log just because cumulative CPU is high',()=>{
    const data={};capture(lines=>{T.reportPathCpu(c,data,1,10000,dest);assert.equal(lines.length,0);});
    assert.deepStrictEqual(data,{});
});
test('Master diagnostics OFF stops Traveler logging and rollback rebases the throttle',()=>{
    Memory.config.diagnostics.mode='OFF';const data={pathCpuWarningAt:2000};Game.time=1000;
    capture(lines=>{T.reportPathCpu(c,data,8,3000,dest);assert.equal(lines.length,0);});
    assert.equal(data.pathCpuWarningAt,2000);Memory.config.diagnostics.mode='NORMAL';
    capture(lines=>{T.reportPathCpu(c,data,8,3000,dest);assert.equal(lines.length,1);});
    assert.equal(data.pathCpuWarningAt,1000);
});
console.log(`Traveler diagnostics: ${passed} passed`);
