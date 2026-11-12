const assert = require('assert');
const mocks = require('./mock-screeps');
mocks.installGlobals(); mocks.clearLocalModules();
Object.assign(global,{ATTACK_POWER:30,RANGED_ATTACK_POWER:10,HEAL_POWER:12,RANGED_HEAL_POWER:4,
    DISMANTLE_POWER:50,TOWER_POWER_ATTACK:600,TOWER_POWER_HEAL:400,PWR_OPERATE_TOWER:3,PWR_DISRUPT_TOWER:10});
const math=require('Combat.Math'), tactics=require('Squad.Tactics');
const pos=(x,y,roomName='home')=>new RoomPosition(x,y,roomName);
const unit=(name,x,y,parts)=>({name,id:name,pos:pos(x,y),hits:parts.length*100,hitsMax:parts.length*100,
    body:parts.map(type=>({type,hits:100}))});
let passed=0;
function test(name,fn){fn();passed++;console.log('PASS '+name);}
test('tower falloff, operate and disrupt powers match engine arithmetic',()=>{
    const tower={pos:pos(10,10),effects:[]},target={pos:pos(11,10)};
    assert.equal(math.towerDamage(tower,target),600);
    target.pos=pos(30,10);assert.equal(math.towerDamage(tower,target),150);
    tower.effects=[{effect:3,level:5,ticksRemaining:10},{effect:10,level:5,ticksRemaining:10}];
    assert.equal(math.towerDamage(tower,target),112);assert.equal(math.towerHeal(tower,target),75);
    tower.effects[0].ticksRemaining=0;assert.equal(math.towerDamage(tower,target),75);
});
test('cross-room coordinates cannot supply damage or healing at local range',()=>{
    const a=unit('a',10,10,[RANGED_ATTACK]),b=unit('b',10,10,[HEAL]);
    b.pos=pos(10,10,'elsewhere');
    assert.equal(math.rangeBetween(a,b),Infinity);assert.equal(math.incomingDamage(b,[a]),0);
    assert.equal(tactics.healingAtTarget(a,[b]),0);
    assert.equal(math.towerDamage({pos:a.pos},b),0);
});
test('a tower needs ten energy to attack or heal',()=>{
    const tower={pos:pos(10,10),store:{energy:9}},target={pos:pos(11,10)};
    assert.equal(math.towerDamage(tower,target),0);assert.equal(math.towerHeal(tower,target),0);
    tower.store.energy=10;assert.equal(math.towerDamage(tower,target),600);
});
test('ranged squads kite melee, choose mass fire and retreat on healer loss',()=>{
    const a=unit('a',10,10,[RANGED_ATTACK,MOVE]),h=unit('h',9,10,[HEAL,MOVE]);
    const enemy=unit('e',11,10,[ATTACK,MOVE]),enemy2=unit('e2',10,11,[ATTACK,MOVE]);
    const result=tactics.evaluateDuo(a,h,[enemy,enemy2],[]);
    assert.equal(result.movement,'kite');assert.equal(result.attackMode,'mass');
    assert.equal(tactics.evaluateDuo(a,null,[enemy],[]).retreat,true);
});
test('destroyed combat parts and boosted TOUGH affect actual capabilities',()=>{
    BOOSTS.tough={XGHO2:{damage:0.3}};
    const a=unit('a',10,10,[TOUGH,RANGED_ATTACK,MOVE]);a.body[0].boost='XGHO2';a.body[1].hits=0;
    assert.equal(math.analyzeBody(a).ranged,0);
    assert.equal(math.damageAfterTough(a,100),30);
});
console.log('Combat mechanics scenarios passed: '+passed);
