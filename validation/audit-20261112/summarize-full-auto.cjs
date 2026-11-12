// Read-only audit calculations. Writes evidence files, never server state.
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '../..');
const labels = ['full-auto-baseline','full-auto-hauler-post-1','full-auto-hauler-post-2','full-auto-final-1','full-auto-final-2','full-auto-final-3','full-auto-final-4','full-auto-final-5'];
const data = labels.map(label => ({label, ...JSON.parse(fs.readFileSync(path.join(__dirname, label+'.json')))}));
const first = data[0], last = data.at(-1);
const summaries = data.map(s => {
    const p = s.rooms.W7N4, r = p.economy.growth.remote;
    return {label:s.label,tick:s.tick,build:s.build,matched:s.codeMatches,differences:s.codeDifferences,
        memoryChars:s.memoryChars,cpu:s.hive.telemetry.cpu.total,state:p.economy.state,
        freighters:s.counts.Freighter,remote:r,
        knownScoutRooms:Object.values(p.scoutPlan.rooms).filter(r=>r.lastScanTick).length,
        probeEnabled:s.config.diagnostics.probe.enabled,
        errors:s.hive.telemetry.creepErrors,
        recentErrors:(s.hive.telemetry.blackbox.recent||[]).map(e=>typeof e==='string'?JSON.parse(e):e).filter(e=>['ERROR','CRITICAL'].includes(e.severity))};
});
const db = JSON.parse(fs.readFileSync('D:/SteamLibrary/steamapps/common/Screeps/server/db.json'));
const objects=db.collections.find(c=>c.name==='rooms.objects').data;
const rooms=['W7N4','W8N4','W7N3'];
const sourceContainers=objects.filter(o=>o.type==='source'&&rooms.includes(o.room)).map(s=>({room:s.room,id:s._id,x:s.x,y:s.y,
    containers:objects.filter(o=>o.room===s.room&&o.type==='container'&&Math.max(Math.abs(o.x-s.x),Math.abs(o.y-s.y))<=1).map(o=>({id:o._id,x:o.x,y:o.y})),
    sites:objects.filter(o=>o.room===s.room&&o.type==='constructionSite'&&o.structureType==='container'&&Math.max(Math.abs(o.x-s.x),Math.abs(o.y-s.y))<=1).length}));
const newScoutRooms=Object.values(last.rooms.W7N4.scoutPlan.rooms).filter(r=>r.lastScanTick&&!first.rooms.W7N4.scoutPlan.rooms[r.roomName]?.lastScanTick);
const operations=Object.entries(last.rooms).flatMap(([room,m])=>[m.keeperOperation&&{room,kind:'keeper',phase:m.keeperOperation.phase,reason:m.keeperOperation.reason},m.npcCoreOperation&&{room,kind:'core',phase:m.npcCoreOperation.phase,reason:m.npcCoreOperation.reason}].filter(Boolean));
const remoteFreighters=last.creeps.filter(c=>c.memory.role==='Freighter'&&(c.memory.freighterAssignment==='remote'||c.memory.pickupRoom&&c.memory.pickupRoom!==c.memory.homeRoom||c.memory.remoteDeliverySourceId));
const result={finalBuild:require(path.join(root,'Runtime.Build')),sourceDecision:'User selected running 127.0.0.1 local copy; old IP copy left unchanged',
    validation:{suitePass:260,isolatedEnginePass:11,log:'full-auto-validation-4.log',syntaxModules:115,stageModulesMatched:115,scopedDiffCheck:true,noW6N4RuntimeLiteral:true},
    ui:{earlierExecutedQuery:{tick:779031,build:'51aa4c60bad4c2fde996e757a164b454d612e7908823cd0b4370b72101af83e8'},finalExecutedQuery:{tick:781774,build:'75288eb7ceb96f921dd3fe66efe285262e9ce63ea2c9da51b247f19e9ccc4c07',scoutTarget:'W8N5',scoutRoom:'W5N2',travelProgressAt:781770},probeEnabled:false,travelerCpuEnabled:false,probeStop:'EXPIRED',probeErrorCount:0,roomsObserved:['W7N4','W6N4','W8N4']},
    observations:summaries,newScoutRooms,sourceContainers,objectsTick:db.collections.find(c=>c.name==='env').data[0].data.gameTime,operations,
    remoteFreighters:remoteFreighters.map(c=>({name:c.name,bodyCarry:c.body.filter(p=>p.type==='carry').length,request:c.memory.requestId,flow:c.memory.freighterFlow,assignment:c.memory.freighterAssignment,source:c.memory.pickupSourceId,deliverySource:c.memory.remoteDeliverySourceId})),
    gc:last.hive.gc,
    scoutTravelDeferrals:Object.values(last.rooms.W7N4.scoutPlan.rooms).filter(r=>r.unreachableReason==='NO_TRAVEL_PROGRESS')};
fs.writeFileSync(path.join(__dirname,'full-auto-verification.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({snapshots:summaries.map(s=>({tick:s.tick,cpu:s.cpu,memory:s.memoryChars,freighters:s.freighters,carry:s.remote.availableCarry,backlog:s.remote.backlog,scouted:s.knownScoutRooms,errors:s.recentErrors.length})),newScoutRooms,sourceContainers,operations,gc:last.hive.gc},null,2));
