// Read-only persisted-world observer. No UI input or server mutations.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=path.resolve(__dirname,'../..'),dbPath='D:/SteamLibrary/steamapps/common/Screeps/server/db.json';
const sha=s=>crypto.createHash('sha256').update(s.replace(/\r\n/g,'\n')).digest('hex');
function summarizeLedger(value,tick){
    if(!value)return null;const sums={};const buckets=(value.buckets||[]).filter(b=>b.at>=Math.floor(tick/250)*250-1750);
    const start=Math.max(value.since,buckets.length?buckets[0].at:tick),ticks=Math.max(1,tick-start+1);
    for(const b of buckets)for(const [k,v]of Object.entries(b))if(k!=='at')sums[k]=(sums[k]||0)+v;
    return{start,end:tick,ticks,...sums,harvestedEPT:(sums.harvested||0)/ticks,deliveredEPT:(sums.delivered||0)/ticks};
}
function capture(label){
    const db=JSON.parse(fs.readFileSync(dbPath,'utf8')),col=n=>db.collections.find(c=>c.name===n)?.data||[];
    const env=col('env')[0].data,user=col('users').find(u=>u.username==='BenvolioDAT'),raw=env['memory:'+user._id],m=JSON.parse(raw),tick=Number(env.gameTime);
    const code=col('users.code').find(c=>c.user===user._id&&c.activeWorld);if(code?.branch!=='Sushi')throw Error('Unexpected active branch');
    const objects=col('rooms.objects'),mine=objects.filter(o=>o.user===user._id),creeps=mine.filter(o=>o.type==='creep').map(c=>({...c,memory:m.creeps?.[c.name]}));
    const homes=Object.fromEntries(Object.entries(m.rooms||{}).filter(([n,r])=>r.remotePlanner&&r.economy).map(([name,r])=>{
        const infos=Object.values(r.remotePlanner.sourceInfos||{}),units=creeps.filter(c=>c.memory?.homeRoom===name),a=summarizeLedger(r.remoteAccounting,tick);
        const sources=infos.filter(i=>i.active||i.accounting).map(i=>{
            const sm=m.rooms[i.roomName]?.sources?.[i.sourceId],obj=objects.find(o=>o._id===i.sourceId),near=objects.filter(o=>o.room===i.roomName&&obj&&Math.max(Math.abs(o.x-obj.x),Math.abs(o.y-obj.y))<=2);
            return{id:i.sourceId,room:i.roomName,active:i.active,state:i.state,reason:i.blockedReason,distance:i.distance,requiredCarry:i.requiredCarry,roundTrip:i.roundTripTicks,
                route:{valid:i.route?.valid,revision:i.route?.revision,terrain:i.route?.terrain,samples:i.route?.travelSamples,out:i.route?.observedOutboundTicks,back:i.route?.observedReturnTicks,trip:i.route?.observedRoundTripTicks,last:i.route?.lastObservedAt,traffic:i.route?.traffic},
                accounting:summarizeLedger(i.accounting,tick),haul:sm?.haul,model:i.scoreComponents,
                energy:obj?.energy,capacity:obj?.energyCapacity,containerEnergy:near.filter(o=>o.type==='container').reduce((s,o)=>s+(o.store?.energy||0),0),
                dropped:near.filter(o=>o.type==='energy').reduce((s,o)=>s+(o.energy||0),0),
                miners:units.filter(c=>c.memory?.sourceId===i.sourceId&&c.memory?.role==='Extractor').map(c=>({id:c._id,name:c.name,room:c.room,ttl:c.ageTime-tick,spawning:c.spawning,work:c.body.filter(p=>p.type==='work'&&p.hits>0).length,state:c.memory.extractorState})),
                support:i.economicPause};
        });
        return[name,{economy:r.economy,accounting:a,sourcePortfolio:r.remotePlanner.activeSourceIds,sources,capacity:m.hive?.capacity?.rooms?.[name],
            surplus:r.surplus,spawn:r.spawn,scout:{known:Object.values(r.scoutPlan?.rooms||{}).filter(x=>x.lastScanTick).length,stalls:Object.values(r.scoutPlan?.rooms||{}).filter(x=>x.unreachableUntil>tick)},
            creeps:units.map(c=>({id:c._id,name:c.name,role:c.memory?.role,assignment:c.memory?.assignmentFunction,room:c.room,x:c.x,y:c.y,ttl:c.ageTime-tick,hits:c.hits,spawning:c.spawning,
                carry:c.body.filter(p=>p.type==='carry'&&p.hits>0).length,parts:c.body.length,energy:c.store?.energy,source:c.memory?.sourceId,pickup:c.memory?.pickupSourceId,delivery:c.memory?.remoteDeliverySourceId,flow:c.memory?.freighterFlow,trip:c.memory?.remoteTrip,
                request:c.memory?.requestId,predecessors:c.memory?.freighterPredecessors,scoutTarget:c.memory?.targetRoom,scoutProgress:c.memory?.scoutTravelProgress}))}];
    }));
    const modules=Object.entries(code.modules).map(([n,s])=>[n.replace(/\$DOT\$/g,'.')+'.js',s]),differences=modules.filter(([n,s])=>!fs.existsSync(path.join(root,n))||sha(s)!==sha(fs.readFileSync(path.join(root,n),'utf8'))).map(([n])=>n);
    const snapshot={tick,capturedAt:new Date().toISOString(),dbSavedAt:fs.statSync(dbPath).mtime.toISOString(),build:modules.find(([n])=>n==='Runtime.Build.js')?.[1],moduleCount:modules.length,differences,
        memoryChars:raw.length,memoryCategories:Object.fromEntries(Object.entries(m).map(([k,v])=>[k,JSON.stringify(v).length])),cpu:m.hive?.telemetry?.cpu,bucket:m.hive?.capacity?.cpu?.bucket,limit:m.hive?.capacity?.cpu?.limit,
        diagnostics:m.config?.diagnostics,remoteConfig:m.config?.remote,homes,
        errors:m.hive?.telemetry?.creepErrors,recentErrors:(m.hive?.telemetry?.blackbox?.recent||[]).map(e=>typeof e==='string'?JSON.parse(e):e).filter(e=>['ERROR','CRITICAL'].includes(e.severity)),
        operations:Object.fromEntries(Object.entries(m.rooms||{}).filter(([n,r])=>r.keeperOperation||r.npcCoreOperation).map(([n,r])=>[n,{keeper:r.keeperOperation,core:r.npcCoreOperation}])),gc:m.hive?.gc};
    if(label){if(!/^[a-z0-9-]+$/i.test(label))throw Error('Invalid label');fs.writeFileSync(path.join(__dirname,label+'.json'),JSON.stringify(snapshot,null,2));}
    return snapshot;
}
function brief(s){return{tick:s.tick,modules:s.moduleCount,differences:s.differences,cpu:s.cpu?.total,memory:s.memoryChars,homes:Object.fromEntries(Object.entries(s.homes).map(([n,h])=>[n,{state:h.economy.state,carry:h.economy.growth?.remote?.availableCarry,demand:h.economy.growth?.remote?.requiredCarry,backlog:h.economy.growth?.remote?.backlog,ledger:h.accounting,haulers:h.creeps.filter(c=>c.role==='Freighter').length}]))};}
async function main(){
    if(process.argv[2]!=='follow'){console.log(JSON.stringify(brief(capture(process.argv[2]||'snapshot')),null,2));return;}
    const prefix=process.argv[3]||'window',duration=Number(process.argv[4]||2000),step=Number(process.argv[5]||500),first=capture(prefix+'-0');
    let last=first.tick,n=1;console.log(JSON.stringify(brief(first)));
    while(last-first.tick<duration){await new Promise(r=>setTimeout(r,20000));const s=capture();if(s.tick<last)throw Error('Tick rollback');if(s.tick-last<step)continue;fs.writeFileSync(path.join(__dirname,prefix+'-'+n+++'.json'),JSON.stringify(s,null,2));last=s.tick;console.log(JSON.stringify(brief(s)));}
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={capture,brief};
