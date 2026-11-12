// Isolated installed-engine combat processors. Positions are held fixed; this
// verifies damage/healing/body attrition, not terrain or movement coordination.
const fs=require('fs'),vm=require('vm'),path=require('path'),assert=require('assert');
const {createRequire}=require('module');
const root='D:/SteamLibrary/steamapps/common/Screeps/server/package/node_modules/@screeps/engine/src';
const local=createRequire(path.join(root,'utils.js')),lodash=local('lodash');
const C=require('D:/SteamLibrary/steamapps/common/Screeps/server/package/node_modules/@screeps/common/lib/constants.js');
const utils={getDriver:()=>({constants:C}),isAtEdge:()=>false,sendAttackingNotification:()=>{},
    dist:(a,b)=>Math.max(Math.abs(a.x-b.x),Math.abs(a.y-b.y)),
    calcBodyEffectiveness:(body,type,action,power)=>body.filter(p=>p.type===type&&p.hits>0).length*power};
const engineUtils=fs.readFileSync(path.join(root,'utils.js'),'utf8');
const effectStart=engineUtils.indexOf('exports.calcBodyEffectiveness = function');
const effectEnd=engineUtils.indexOf('\n};',effectStart)+3;
if(effectStart<0||effectEnd<3)throw Error('Installed effectiveness function not found');
vm.runInNewContext(engineUtils.slice(effectStart,effectEnd),{exports:utils,C});
const cache=new Map();
function load(file){
    file=path.resolve(file);if(cache.has(file))return cache.get(file).exports;
    const mod={exports:{}};cache.set(file,mod);
    vm.runInNewContext(fs.readFileSync(file,'utf8'),{module:mod,exports:mod.exports,__dirname:path.dirname(file),require:name=>{
        if(name==='lodash')return lodash;
        if(name.endsWith('/utils'))return utils;
        if(name==='../movement')return{execute:()=>{}};
        if(name==='./_die')return(object,_,__,scope)=>{delete scope.roomObjects[object._id];object.dead=true;};
        if(name==='./_add-fatigue')return()=>{};
        if(name==='./_drop-resources-without-space')return()=>{};
        if(name==='./structures/_destroy')return(object,scope)=>{delete scope.roomObjects[object._id];object.dead=true;};
        if(name==='../../../common/fake-runtime')return{moveTo:()=>0};
        if(name==='bulk-require')return dirname=>Object.fromEntries(['heal','rangedAttack','attack','move'].map(action=>[action,
            action==='move'?()=>{}:load(path.join(dirname,action+'.js'))]));
        if(name.startsWith('.'))return load(path.resolve(path.dirname(file),name+'.js'));
        throw Error('Unexpected dependency: '+name);
    }},{filename:file});return mod.exports;
}
const dispatch=load(path.join(root,'processor/intents/creeps/intents.js'));
const tick=load(path.join(root,'processor/intents/creeps/tick.js'));
const keeperAI=load(path.join(root,'processor/intents/creeps/keepers/pretick.js'));
function creep(id,parts,x,y,user='me') {return {_id:id,type:'creep',name:id,user,room:'ISOLATED',x,y,
    body:parts.map(type=>({type,hits:100})),hits:parts.length*100,hitsMax:parts.length*100,
    actionLog:{},fatigue:0,store:{},storeCapacity:0};}
function scope(objects){return{roomObjects:Object.fromEntries(objects.map(o=>[o._id,o])),gameTime:0,eventLog:[],roomInfo:{},
    bulk:{update:(o,v)=>Object.assign(o,v),remove:()=>{}},roomController:null};}
function keeperBattle(range){
    const guard=creep('guard',[...Array(20).fill(C.MOVE),...Array(10).fill(C.RANGED_ATTACK),...Array(10).fill(C.HEAL)],10,10);
    const keeper=creep('keeper',[...Array(17).fill(C.TOUGH),...Array(13).fill(C.MOVE),...Array(10).fill(0).flatMap(()=>[C.ATTACK,C.RANGED_ATTACK])],10+range,10,'3');
    const s=scope([guard,keeper,{_id:'source',type:'source',x:keeper.x+1,y:10}]);
    let ticks=0;
    while(!guard.dead&&!keeper.dead&&ticks<150){s.gameTime=++ticks;s.eventLog=[];guard.actionLog={};keeper.actionLog={};
        for(const c of [guard,keeper]) for(const part of c.body) delete part._oldHits;
        dispatch(guard,{heal:{id:'guard'},rangedAttack:{id:'keeper'}},s);
        const npc=keeperAI(keeper,s);dispatch(keeper,npc.keeper||{},s);
        tick(guard,s);tick(keeper,s);
    }
    return{range,ticks,guardHits:guard.hits,keeperHits:keeper.hits,guardSurvived:!guard.dead,keeperDestroyed:!!keeper.dead};
}
const safe=keeperBattle(3);assert(safe.guardSurvived&&safe.keeperDestroyed);assert.strictEqual(safe.ticks,50);assert.strictEqual(safe.guardHits,4000);
const melee=keeperBattle(1);assert.strictEqual(melee.guardSurvived,false);assert.strictEqual(melee.keeperDestroyed,false);
const attacker=creep('attacker',[...Array(6).fill(C.MOVE),...Array(6).fill(C.ATTACK)],10,10);
const core={_id:'core',type:'invaderCore',user:'2',level:0,x:11,y:10,hits:100000};const s=scope([attacker,core]);
let ticks=0;while(!core.dead&&ticks<1000){s.gameTime=++ticks;attacker.actionLog={};dispatch(attacker,{attack:{id:'core'}},s);tick(attacker,s);}
assert(core.dead);assert.strictEqual(ticks,556);assert.strictEqual(attacker.hits,1200);
console.log(JSON.stringify({checks:3,engineVersion:local('../package.json').version,model:'Fixed positions, unboosted bodies, installed effectiveness/intent/damage/healing/body processors; no world writes.',
    rangedKeeper:safe,unsafeMelee:melee,unopposedCore:{ticks,attackerHits:attacker.hits,coreDestroyed:core.dead}},null,2));
