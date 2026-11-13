const assert = require('assert');
const mocks = require('./mock-screeps');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function fixture() {
    mocks.installGlobals(); mocks.clearLocalModules();
    const room = { name:'home', find:()=>[] };
    Game.rooms.home=room; Memory.rooms.home={sources:{}};
    const pos=(x,y)=>new RoomPosition(x,y,'home');
    const miner={name:'miner',room,pos:pos(11,10),memory:{role:'Extractor'}};
    const mover={name:'hauler',room,pos:pos(10,10),memory:{role:'Freighter'},body:[]};
    const other={name:'other',room,pos:pos(12,10),memory:{role:'Freighter'}};
    require('HiveMind.Index').get=()=>({creepsByCurrentRoom:new Map([['home',[miner,mover,other]]])});
    require('traffic_manager').isProtectedStationaryMiner=c=>c===miner&&c.memory.moving!==true;
    const travel=require('utility.Travel.Creep');
    const route={from:pos(10,10),path:'33',complete:true,created:Game.time};
    RoomPosition.prototype.getDirectionTo=function(p){return p.x>this.x?RIGHT:LEFT;};
    return {room,pos,miner,mover,other,travel,route};
}
test('shared paths exclude protected mining stations while leaving ordinary traffic traversable',()=>{
    const f=fixture(), matrix=f.travel._test.buildRouteCostMatrix('home',f.mover);
    assert.equal(matrix.get(11,10),255);assert.notEqual(matrix.get(12,10),255);
    assert.notEqual(f.travel._test.buildRouteCostMatrix('home',f.miner).get(11,10),255,'a miner can leave its own station');
});
test('a previously cached lane into a protected miner is invalidated before submitting a move',()=>{
    const f=fixture(), opts={}; f.mover.memory._trav={path:'3'};
    const result=f.travel._test.followSharedRoute(f.mover,'lane',f.route,f.pos(13,10),1,opts);
    assert.equal(result.code,ERR_NO_PATH);assert(result.deleteRoute&&result.clearCreepRoute);
    assert.equal(opts.ignoreCreeps,false);assert.equal(f.mover.memory._trav,undefined);
});
test('moving miners and temporary hauler occupancy do not invalidate a reusable lane',()=>{
    const f=fixture();f.miner.memory.moving=true;
    assert.equal(f.travel._test.protectedMinerAt(f.miner.pos,f.mover),false);
    assert.notEqual(f.travel._test.buildRouteCostMatrix('home',f.mover).get(11,10),255);
    assert.equal(f.travel._test.protectedMinerAt(f.other.pos,f.mover),false);
});
console.log('Station traffic scenarios passed: '+passed);
