const assert=require('assert'),mocks=require('./mock-screeps');
let passed=0;function test(n,fn){fn();passed++;console.log('PASS '+n);}
function fixture(){
    mocks.installGlobals();mocks.clearLocalModules();Game.time=1000;
    Memory.config={diagnostics:{useSegments:false}};
    const D=require('Diagnostics');
    const view={room:'home',tick:Game.time,economyTick:Game.time,state:'RECOVERY',energy:10,energyCapacity:550,
        growthAllowed:false,harvestHealth:'MISSING',energyAboveReserve:0,activeWork:5,requiredWork:10,
        sources:[],hauling:{backlog:2000},logistics:{local:{living:10,required:10,idleWorkers:1,noProgressWorkers:1}}};
    D.install(()=>view);
    const next=()=>{Game.time++;view.tick=view.economyTick=Game.time;};
    return{D,view,next};
}
test('confirmed recovery clears warning status while preserving its original evidence and count',()=>{
    const f=fixture();f.D.record('ECONOMY','WARN','RECOVERY_ACTIVATED','home',{reason:'LOCAL_HAUL_SHORTAGE'});
    f.D.record('ERRORS','ERROR','UNRESOLVED_ERROR','home',{message:'keep me'});
    f.next();f.view.state='STABLE';const r=f.D.review('home');
    assert.equal(r.resolved,1);assert.equal(r.warnings,0);assert.equal(r.errors,1);
    const e=f.D.events(10).find(e=>e.event==='RECOVERY_ACTIVATED');
    assert.equal(e.tick,1000);assert.equal(e.count,1);assert.equal(e.resolvedAt,1001);assert.equal(e.data.reason,'LOCAL_HAUL_SHORTAGE');
    assert.equal(e.resolution,'RECOVERY_COMPLETED');
});
test('unknown warnings, ongoing failures and stale room samples are never auto-cleared',()=>{
    const f=fixture();for(const event of ['UNKNOWN_WARNING','RECOVERY_ACTIVATED','GROWTH_PAUSED'])f.D.record('ECONOMY','WARN',event,'home',{});
    f.next();assert.equal(f.D.review('home').resolved,0);
    f.view.state='STABLE';f.view.economyTick--;assert.equal(f.D.review('home').resolved,0);
    assert.equal(f.D.events(10).filter(e=>e.resolvedAt!==undefined).length,0);
});
test('a recurring symptom creates a new unresolved incident instead of overwriting resolved history',()=>{
    const f=fixture();f.D.record('ECONOMY','WARN','SPAWN_ENERGY_STARVATION','home',{available:10});
    f.next();f.view.energy=300;f.D.review('home');
    f.next();f.view.energy=10;f.D.record('ECONOMY','WARN','SPAWN_ENERGY_STARVATION','home',{available:10});
    const rows=f.D.events(10);assert.equal(rows.length,2);assert.notEqual(rows[0].id,rows[1].id);
    assert.equal(rows[1].resolvedAt,undefined);assert.equal(f.D.summary('home').warnings,1);
});
test('movement resumes only on actual later position evidence, while blocked living actors remain unresolved',()=>{
    const f=fixture();const c={name:'hauler',memory:{role:'Freighter'},pos:new RoomPosition(10,10,'home'),fatigue:0,ticksToLive:1000};
    Game.creeps.hauler=c;
    for(let n=0;n<7;n++){f.D.movement(c,OK,new RoomPosition(15,10,'home'));f.next();c.ticksToLive--;}
    assert.equal(f.D.review('home').resolved,0);assert(f.D.summary('home').warnings>0);
    c.pos=new RoomPosition(11,10,'home');f.D.movement(c,OK,new RoomPosition(15,10,'home'));
    assert(f.D.review('home').resolved>0);assert.equal(f.D.summary('home').warnings,0);
    const e=f.D.events(10).find(e=>e.event==='MOVEMENT_PERSISTENT_BLOCK');assert.equal(e.data.targetX,15);assert(e.data.stuckTicks>=5);
});
test('dead or reused creep generations resolve their old warning but retain a new generation incident',()=>{
    const f=fixture();f.D.record('MOVEMENT','WARN','MOVEMENT_PERSISTENT_BLOCK','home',{creep:'gone',x:10,y:10});
    f.D.record('MOVEMENT','WARN','MOVEMENT_PERSISTENT_BLOCK','home',{creep:'reused',x:10,y:10});
    f.next();Game.creeps.reused={ticksToLive:1500,body:[]};
    assert.equal(f.D.review('home').resolved,2);
    assert.deepStrictEqual(f.D.events(10).map(e=>e.resolution).sort(),['ACTOR_GONE','OLD_CREEP_GENERATION']);
});
test('readable reports expose hauling backlog and do not change the structured room API',()=>{
    const f=fixture();assert.equal(typeof Sushi.debug.report('home'),'string');
    assert(Sushi.debug.report('home').includes('Source backlog: 2000 energy'));
    assert.equal(Sushi.debug.room('home').current,f.view);
});
console.log('Diagnostic resolution scenarios passed: '+passed);
