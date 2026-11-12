// Isolated fixed-position alternatives. Does not write to the server/world.
const fs=require('fs'),path=require('path'),Module=require('module'),assert=require('assert');
const base=path.resolve(__dirname,'../audit-20261112/npc-battle-engine.cjs');
const lab=new Module(base,module);lab.filename=base;lab.paths=module.paths;
lab._compile(fs.readFileSync(base,'utf8')+'\nmodule.exports={creep,scope,load,dispatch,tick,keeperAI,C,root};',base);
const {creep,scope,load,dispatch,tick,keeperAI,C,root}=lab.exports;
const lairTick=load(path.join(root,'processor/intents/keeper-lairs/tick.js'));
function body(m,r,h){return [...Array(m).fill(C.MOVE),...Array(r).fill(C.RANGED_ATTACK),...Array(h).fill(C.HEAL)];}
function battle(bodies){
    const positions=[[10,10],[10,11],[9,10]];
    const guards=bodies.map((parts,i)=>creep('guard'+i,parts,...positions[i]));
    let keeper=creep('keeper',[...Array(17).fill(C.TOUGH),...Array(13).fill(C.MOVE),...Array(10).fill(0).flatMap(()=>[C.ATTACK,C.RANGED_ATTACK])],13,10,'3');
    keeper.name='Keeperlair';const lair={_id:'lair',type:'keeperLair',room:'ISOLATED',x:13,y:10};
    const s=scope([...guards,keeper,lair,{_id:'source',type:'source',x:14,y:10}]);let replacements=0,ticks=0;
    s.bulk.remove=id=>{const old=s.roomObjects[id];if(old){old.dead=true;delete s.roomObjects[id];}};
    s.bulk.insert=o=>{replacements++;o._id='replacement';o.actionLog={};s.roomObjects[o._id]=o;};
    while(!keeper.dead&&guards.some(g=>!g.dead)&&ticks<600){
        s.gameTime=++ticks;s.eventLog=[];
        const alive=guards.filter(g=>!g.dead);
        const patient=alive.slice().sort((a,b)=>a.hits/a.hitsMax-b.hits/b.hitsMax)[0];
        for(const c of [...alive,keeper]){c.actionLog={};for(const part of c.body)delete part._oldHits;}
        for(const g of alive)dispatch(g,{heal:{id:patient._id},rangedAttack:{id:keeper._id}},s);
        const npc=keeperAI(keeper,s);dispatch(keeper,npc[keeper._id]||{},s);
        for(const g of alive)tick(g,s);tick(keeper,s);lairTick(lair,s);
        if(replacements)break;
    }
    return {costs:bodies.map(b=>b.reduce((n,p)=>n+C.BODYPART_COST[p],0)),ticks,
        survivingGuards:guards.filter(g=>!g.dead).length,hits:guards.map(g=>g.hits),
        keeperDestroyed:!!keeper.dead&&!replacements,keeperHits:keeper.hits,replacements};
}
const cheap=battle([body(6,3,3)]);assert(cheap.costs[0]<=1800&&!cheap.keeperDestroyed&&cheap.survivingGuards===0);
const compact=battle([body(11,2,9)]);assert(compact.keeperDestroyed&&compact.survivingGuards===1&&compact.ticks<300);
const tooSlow=battle([body(10,1,9)]);assert(!tooSlow.keeperDestroyed&&tooSlow.replacements===1);
const trio=battle(Array.from({length:3},()=>body(5,2,3)));assert(trio.keeperDestroyed&&trio.survivingGuards===3&&trio.costs.every(c=>c<=1800));
const result={checks:4,model:'Installed combat and Keeper AI plus live lair processor; fixed front range three/rear four, perfect adjacent focused healing, no pathfinding/formation proof.',
    under1800Solo:cheap,compactSolo:compact,tooSlowSolo:tooSlow,coordinatedTrio:trio,
    activation:'None. Current independent-guard admission unchanged. A trio requires a new validated shared-healing/formation/failure controller.'};
fs.writeFileSync(path.join(__dirname,'keeper-variants.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
