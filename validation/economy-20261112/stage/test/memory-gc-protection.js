const assert = require('assert');
const mocks = require('./mock-screeps');
let passed = 0;
function fixture() {
    mocks.installGlobals(); mocks.clearLocalModules(); Game.time = 50000;
    const H = require('HiveMind.Memory');
    Object.assign(H.getConfig('memoryGC'), { workBudget: 100, intelRetention: 20000 });
    const intel = () => ({ identity: {type:'INTEL'}, lastScanned:1,
        controller:{owner:null}, sources:{source:{pos:{x:10,y:10}}}, scoutIntel:{tick:1},
        invaderCore:{id:'remembered-core',level:0,observedAt:1} });
    Memory.rooms = { home: { identity:{type:'HOME'}, remotePlanner:{activeSourceIds:['s'],
        sourceInfos:{s:{roomName:'remote',active:true,route:{roomSequence:['home','transit','remote']}}} } },
        remote:intel(), transit:intel(), abandoned:intel() };
    return require('HiveMind.MemoryGC');
}
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
test('selected remote sources and transit intel survive an age-based sweep', () => {
    const gc = fixture(); gc.run({force:true});
    assert.ok(Memory.rooms.remote.sources); assert.ok(Memory.rooms.transit.controller);
    assert.equal(Memory.rooms.abandoned.sources, undefined);
    assert.ok(Memory.rooms.abandoned.invaderCore, 'lack of vision cannot clear a remembered core');
});
test('removing a strategic reference releases ordinary expired intel for cleanup', () => {
    const gc = fixture(); gc.run({force:true});
    Memory.rooms.home.remotePlanner.activeSourceIds = [];
    Memory.rooms.home.remotePlanner.sourceInfos.s.active = false;
    Game.time++; gc.run({force:true});
    assert.equal(Memory.rooms.remote.sources, undefined); assert.equal(Memory.rooms.transit.controller, undefined);
});
test('established suspended remotes and active operation rooms remain protected', () => {
    const gc = fixture(); const info=Memory.rooms.home.remotePlanner.sourceInfos.s;
    info.active=false; info.established=true; Memory.rooms.home.remotePlanner.activeSourceIds=[];
    require('HiveMind.Memory').ensure().operations.op={state:'ACTIVE',targetRoom:'abandoned'};
    gc.run({force:true}); assert.ok(Memory.rooms.remote.sources); assert.ok(Memory.rooms.abandoned.controller);
});
test('lost colonies cannot retain every old remote as an active parent forever',()=>{
    const gc=fixture(),H=require('HiveMind.Memory');
    Memory.rooms.home.identity={type:'HOME'};Memory.rooms.home.structurePlanner={durablePlan:true};
    H.syncHomeRooms({ownedSpawnRooms:[]});
    assert.strictEqual(Memory.rooms.remote.identity.type,'INTEL');
    gc.run({force:true});assert.strictEqual(Memory.rooms.remote.sources,undefined);
    assert.deepStrictEqual(Memory.rooms.home.structurePlanner,{durablePlan:true},'durable plans remain available for future recovery');
    assert(Memory.rooms.remote.invaderCore,'remembered dangers must survive loss of parent');
});

test('owned rooms without a spawn still retain their remote intelligence',()=>{
    const gc=fixture(),H=require('HiveMind.Memory');Game.rooms.home={controller:{my:true}};
    Memory.rooms.home.remotePlanner.remotes={remote:{status:'active',sourceIds:['s']}};
    H.syncHomeRooms({ownedSpawnRooms:[]});gc.run({force:true});
    assert.strictEqual(Memory.rooms.home.identity.type,'OWNED_BOOTSTRAP');
    assert.strictEqual(Memory.rooms.remote.identity.type,'REMOTE');assert(Memory.rooms.remote.sources);
});
console.log('Memory protection scenarios passed: ' + passed);
