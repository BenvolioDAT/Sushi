const assert = require('assert');
const mocks = require('./mock-screeps');
let passed=0;
function test(name, fn) { fn();passed++;console.log('PASS '+name); }
function fixture() {
    mocks.installGlobals();mocks.clearLocalModules();
    let reads=0,cpuReads=0;Game.cpu={limit:100,getUsed:()=>{cpuReads++;return 1;}};
    Memory.config={diagnostics:{mode:'NORMAL'}};
    const P=require('Diagnostics.Probe');
    const view=()=>{reads++;return {economyTick:Game.time,state:'RECOVERY',reason:'test',activeWork:10,requiredWork:10,
        hauling:{requiredCarry:20,localCarry:21,backlog:1600},sources:[{id:'source',haulCarry:20,backlog:1600}],
        freighters:[{name:'h',room:'W1N1',carryParts:21,cargo:500,flow:{picked:500,delivered:0}}]};};
    return {P,view,reads:()=>reads,cpuReads:()=>cpuReads};
}
test('disabled probe performs no view scans CPU reads or Memory writes',()=>{
    const f=fixture(),before=JSON.stringify(Memory);f.P.sample(()=>{throw Error('must not scan');});
    f.P.exception('E','W1N1',Error('test'),'test');assert.equal(f.P.status().enabled,false);
    assert.equal(JSON.stringify(Memory),before);assert.equal(f.cpuReads(),0);
});
test('enabled probe captures actionable hauling state only at its configured cadence',()=>{
    const f=fixture();f.P.toggle(true,{room:'W1N1',interval:10,duration:100});f.P.sample(f.view);
    for(let i=0;i<9;i++){Game.time++;f.P.sample(f.view);}assert.equal(f.reads(),1);
    Game.time++;f.P.sample(f.view);assert.equal(f.reads(),2);
    assert.equal(f.P.report().samples[0].haul.backlog,1600);assert.equal(f.P.report().samples[0].freighters[0].cargo,500);
});
test('probe expires automatically and manual OFF retains evidence without collecting',()=>{
    const f=fixture();f.P.toggle(true,{room:'W1N1',duration:10});f.P.sample(f.view);Game.time+=10;f.P.sample(f.view);
    assert.equal(f.P.status().enabled,false);assert.equal(f.P.status().stopReason,'EXPIRED');
    const before=JSON.stringify(Memory);f.P.sample(f.view);assert.equal(JSON.stringify(Memory),before);
    f.P.toggle(true,{room:'W1N1'});f.P.toggle(false);Game.time+=50;f.P.sample(f.view);
    assert.equal(f.reads(),1);assert.equal(f.P.report().samples.length,1);
});
test('probe bounds retained evidence and captures useful full stacks only while enabled',()=>{
    const f=fixture();f.P.toggle(true,{room:'W1N1',duration:2000,interval:10});
    for(let i=0;i<100;i++){Game.time+=10;f.P.sample(f.view);f.P.exception('E','W1N1',Error('bad '+i),'unit');}
    const r=f.P.report();assert(r.samples.length<=20);assert(r.errors.length<=8);
    assert(r.errors.at(-1).stack.includes('diagnostic-probe.js'));assert(JSON.stringify(Memory.hive.telemetry.probe).length<=30000);
    f.P.toggle(false);const before=JSON.stringify(Memory);f.P.exception('E',null,Error('off'),'unit');assert.equal(JSON.stringify(Memory),before);
});
test('tick rollback and master diagnostics OFF stop a running probe',()=>{
    for(const action of [()=>{Game.time--;},()=>{Memory.config.diagnostics.mode='OFF';}]){
        const f=fixture();f.P.toggle(true,{room:'W1N1'});action();f.P.sample(f.view);assert.equal(f.P.enabled(),false);assert.equal(f.reads(),0);
    }
});
test('CPU pressure skips optional collection and invalid options do not enable it',()=>{
    const f=fixture();assert(f.P.toggle(true,{room:'bad'}).error);assert.equal(f.P.enabled(),false);
    f.P.toggle(true,{room:'W1N1'});Game.cpu.getUsed=()=>90;f.P.sample(f.view);assert.equal(f.reads(),0);assert.equal(f.P.status().skipped,1);
});
test('master OFF prevents hidden nested profiling while preserving the wrapped result',()=>{
    const f=fixture();Memory.config.diagnostics.mode='OFF';const D=require('Diagnostics');
    assert.equal(D.measureOperation('test',()=>42),42);assert.equal(f.cpuReads(),0);assert.equal(D.operationProfile(),null);
});
test('ordinary error recording and probe evidence are independent toggles',()=>{
    const f=fixture(),D=require('Diagnostics');D.exception('ROLE_EXCEPTION','W1N1',Error('normal'),'Extractor');
    assert.equal(f.P.report().errors.length,0);assert.equal(D.events(10,{severity:'ERROR'}).length,1);
    f.P.toggle(true,{room:'W1N1'});D.exception('ROLE_EXCEPTION','W1N1',Error('enabled'),'Extractor');assert.equal(f.P.report().errors.length,1);
});
console.log('Diagnostic probe scenarios passed: '+passed);
