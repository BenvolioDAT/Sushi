const assert=require('assert'),mocks=require('./mock-screeps');
let passed=0;function test(n,fn){fn();passed++;console.log('PASS '+n);}
function fixture(){
    mocks.installGlobals();mocks.clearLocalModules();Game.time=1000;
    require('HiveMind.Memory').ensure();Game.map.findExit=()=>RIGHT;
    const travel=require('utility.Travel.Creep');let moves=0;travel.moveToRoom=()=>{moves++;return OK;};
    const home='W4N4',target='W6N4';Memory.rooms[home]={scoutPlan:{homeRoom:home,rooms:{[target]:{roomName:target}}}};
    const c={room:{name:home},pos:new RoomPosition(1,3,home),fatigue:0,memory:{homeRoom:home,targetRoom:target,_trav:{path:'222'}}};
    const S=require('role.Scout');return{c,home,target,travel,entry:Memory.rooms[home].scoutPlan.rooms[target],move:()=>S._test.moveToTargetRoom(c,c.memory.targetRoom),moves:()=>moves,S};
}
test('successful intents that oscillate near an exit defer the destination after fifty ticks',()=>{
    const f=fixture();for(let i=0;i<50;i++){f.c.pos.y=3+i%2;assert.equal(f.move(),true);Game.time++;}
    assert.equal(f.move(),false);assert.equal(f.moves(),50);assert.equal(f.entry.unreachableUntil,1350);
    assert.equal(f.entry.unreachableReason,'NO_TRAVEL_PROGRESS');assert(!f.c.memory.targetRoom);assert(!f.c.memory._trav.path);
});
test('real displacement and room transitions renew the Scout travel lease',()=>{
    const f=fixture();f.move();Game.time+=49;f.c.pos.y+=5;assert(f.move());Game.time+=49;
    f.c.room.name='W5N4';f.c.pos=new RoomPosition(49,3,'W5N4');assert(f.move());assert(!f.entry.unreachableUntil);
});
test('fatigue does not consume the Scout no-progress lease',()=>{
    const f=fixture();f.c.fatigue=1;for(let i=0;i<100;i++){Game.time++;assert(f.move());}
    f.c.fatigue=0;Game.time+=49;assert(f.move());assert(!f.entry.unreachableUntil);
});
test('target changes and tick rollback rebase Scout progress',()=>{
    const f=fixture();f.move();Game.time+=500;f.c.memory.targetRoom='W3N4';assert(f.move());
    Game.time=1;assert(f.move());assert.equal(f.c.memory.scoutTravelProgress.at,1);
});
test('arrival clears progress while explicit no-path still defers immediately',()=>{
    const f=fixture();f.move();f.c.room.name=f.target;assert(f.move());assert(!f.c.memory.scoutTravelProgress);
    f.c.room.name=f.home;f.travel.moveToRoom=()=>ERR_NO_PATH;assert.equal(f.move(),false);assert.equal(f.entry.unreachableUntil,1300);
});
console.log(`Scout progress: ${passed} passed`);
