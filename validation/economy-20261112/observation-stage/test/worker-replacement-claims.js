const assert = require('assert');
const { world } = require('./freighter-renewal');
let passed=0;
function test(name,fn){fn();passed++;console.log('PASS '+name);}
function fixture(){
    const f=world(); f.memory.techDesiredWork=12;f.unit('localHauler',6,1000);
    const old=f.unit('oldTech',1,140);old.memory={role:'Tech',homeRoom:f.room.name};
    old.body=[WORK,CARRY,MOVE].map(type=>({type,hits:100}));Memory.creeps[old.name]=old.memory;
    global.__sushiCpuRolling={total:18,samples:100};f.refresh();
    const plan=()=>f.manager.runForRoom(f.room,{skipNormalPlanning:true});
    return {...f,old,plan};
}
test('one expiring Tech cannot repeatedly fund successors through the CPU replacement allowance',()=>{
    const f=fixture();f.plan();const request=f.queue.find(q=>q.role==='Tech');assert.ok(request);
    assert.strictEqual(require('spawn.manager').runRoom(f.room.name).result,OK);
    assert.strictEqual(f.calls[0].memory.role,'Tech');
    f.plan();assert.strictEqual(f.queue.filter(q=>q.role==='Tech').length,0,'accepted/spawning replacement must own its predecessor');
    const call=f.calls[0],c=f.unit(call.name,1,1500);c.memory=call.memory;c.body=call.body.map(type=>({type,hits:100}));
    Memory.creeps[c.name]=c.memory;f.spawn.spawning=null;Game.time+=10;f.old.ticksToLive-=10;f.refresh();
    f.plan();assert.strictEqual(f.queue.filter(q=>q.role==='Tech').length,0,'born replacement must retain its predecessor claim');
});
function claimedWorker(f,role='Tech'){
    const c=f.unit('successor',1,1450);c.memory={role,homeRoom:f.room.name,workerReplacementWork:1,
        workerPredecessors:[{name:f.old.name,deathAt:Game.time+f.old.ticksToLive}]};
    c.body=[WORK,CARRY,MOVE].map(type=>({type,hits:100}));Memory.creeps[c.name]=c.memory;f.refresh();return c;
}
test('claims survive heap rebuilds and release on successor damage or death',()=>{
    const f=fixture(),c=claimedWorker(f),C=require('Spawn.Context');
    f.refresh();assert.ok(C.replacementClaims(f.room.name,'Tech').has(f.old.name));
    c.body[0].hits=0;f.refresh();assert.strictEqual(C.replacementClaims(f.room.name,'Tech').size,0);
    c.body[0].hits=100;delete Game.creeps[c.name];f.refresh();
    assert.strictEqual(C.replacementClaims(f.room.name,'Tech').size,0);
});
test('expired or reused predecessor generations cannot retain replacement credit',()=>{
    const f=fixture();claimedWorker(f);const C=require('Spawn.Context');
    assert.ok(C.replacementClaims(f.room.name,'Tech').has(f.old.name));
    Game.time++;f.old.ticksToLive=140;f.refresh();assert.strictEqual(C.replacementClaims(f.room.name,'Tech').size,0);
    delete Game.creeps[f.old.name];f.refresh();assert.strictEqual(C.replacementClaims(f.room.name,'Tech').size,0);
});
test('Artificer claims respect work category and queue revalidation excludes itself',()=>{
    const f=fixture();f.old.memory.role='Artificer';f.old.memory.artificerWorkCategory='criticalMaintenance';
    const c=claimedWorker(f,'Artificer');c.memory.artificerWorkCategory='criticalMaintenance';f.refresh();
    const C=require('Spawn.Context');assert.ok(C.replacementClaims(f.room.name,'Artificer').has(f.old.name));
    c.memory.artificerWorkCategory='construction';assert.strictEqual(C.replacementClaims(f.room.name,'Artificer').size,0);
    delete Game.creeps[c.name];const q={role:'Artificer',replacementFor:[f.old.name],expiresAt:Game.time+10};f.queue.push(q);f.refresh();
    assert.ok(C.replacementClaims(f.room.name,'Artificer').has(f.old.name));
    assert.strictEqual(C.replacementClaims(f.room.name,'Artificer',q).size,0);
});
console.log('Worker replacement claim scenarios passed: '+passed);
