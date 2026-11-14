const assert = require('assert');
const mocks = require('./mock-screeps');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function fixture() { mocks.installGlobals(); mocks.clearLocalModules(); }

test('shared lane geometry survives Memory reparsing without reallocating positions', () => {
    fixture();
    let allocations = 0;
    const Position = RoomPosition;
    global.RoomPosition = new Proxy(Position, { construct(target, args) { allocations++; return new target(...args); } });
    const travel = require('utility.Travel.Creep');
    const route = {from:{x:10,y:10,roomName:'home'},path:'33335555'};
    const first = travel.getRoutePositions(route);
    assert.equal(allocations, 9);
    for (let i=0;i<100;i++) {
        Game.time++;
        assert.strictEqual(travel.getRoutePositions(JSON.parse(JSON.stringify(route))), first);
    }
    assert.equal(allocations, 9, 'no repeated path decoding across creeps or ticks');
    assert(Object.isFrozen(first) && first.every(Object.isFrozen));
    assert.equal(first[8].x,14); assert.equal(first[8].y,14);
});

test('changed route content invalidates geometry and malformed paths still fail', () => {
    fixture(); const travel=require('utility.Travel.Creep');
    const route={from:{x:10,y:10,roomName:'home'},path:'33'};
    const first=travel.getRoutePositions(route);
    route.path='55'; assert.notStrictEqual(travel.getRoutePositions(route),first);
    route.from.x=20; assert.equal(travel.getRoutePositions(route)[0].x,20);
    route.from.roomName='remote'; assert.equal(travel.getRoutePositions(route)[0].roomName,'remote');
    route.path='0'; assert.deepEqual(travel.getRoutePositions(route),[]);
    route.from.x=49; route.path='3'; assert.deepEqual(travel.getRoutePositions(route),[]);
});

test('geometry heap is bounded and evicts old lanes without changing their result', () => {
    fixture(); const travel=require('utility.Travel.Creep');
    const route={from:{x:10,y:10,roomName:'home'},path:'33'};
    const first=travel.getRoutePositions(route);
    for(let i=0;i<256;i++)travel.getRoutePositions({...route,from:{...route.from,roomName:'room'+i}});
    const again=travel.getRoutePositions(route);
    assert.notStrictEqual(again,first); assert.deepEqual(again,first);
});

test('an unobstructed remote move avoids alternate hazard scans',()=>{
    fixture(); const manager=require('traffic_manager'); let scans=0;
    const room={name:'home',find:()=>{scans++;return[];}};
    Game.rooms.home=room;Memory.rooms.home={sources:{}};
    const c={name:'c',my:true,room,pos:new RoomPosition(10,10,'home'),memory:{role:'Freighter'},
        body:[{type:MOVE,hits:100}],fatigue:0,move:()=>OK,
        _trafficIntent:{packedTarget:'11:10',fallbackPacked:[],remoteRoute:{}},_intendedPackedCoord:'11:10'};
    manager.run(room,new PathFinder.CostMatrix(),20,{creeps:[c]});
    assert.equal(c._matchedPackedCoord,'11:10'); assert.equal(scans,0);
});
console.log('CPU movement scenarios passed: '+passed);

