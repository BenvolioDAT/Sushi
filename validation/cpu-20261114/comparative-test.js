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

function world(seed, manager) {
    mocks.installGlobals(); let scans=0;
    const room={name:'home',find:()=>{scans++;return[];}};
    Game.rooms.home=room; Memory.rooms.home={sources:{}};
    let n=seed;
    const rand=limit=>{n=(Math.imul(n,1664525)+1013904223)>>>0;return (n>>>8)%limit;};
    const costs=new PathFinder.CostMatrix(), creeps=[], occupied=new Set();
    for(let i=0;i<25;i++) {
        let x,y,key;do{x=10+rand(8);y=10+rand(8);key=x+':'+y;}while(occupied.has(key));
        occupied.add(key);
        const c={name:'c'+i,my:true,room,pos:new RoomPosition(x,y,'home'),memory:{role:'Freighter'},
            body:[{type:MOVE,hits:rand(9)?100:0}],fatigue:rand(12)===0?1:0,spawning:rand(30)===0,
            _trafficPriority:rand(100),move:()=>OK};
        c._trafficLocked=rand(7)===0;
        if(rand(5)) {
            const dx=rand(3)-1,dy=rand(3)-1;
            c._trafficIntent={packedTarget:(x+dx)+':'+(y+dy),fixed:rand(4)===0,
                fallbackPacked:[],remoteRoute:rand(2)?{}:null};
            c._intendedPackedCoord=c._trafficIntent.packedTarget;
        }
        if(rand(6)===0)costs.set(x+1,y,255);
        creeps.push(c);
    }
    manager.run(room,costs,20,{creeps,blockers:[{id:'enemy',pos:new RoomPosition(14,14,'home')}]});
    return {matched:creeps.map(c=>c._matchedPackedCoord),scans};
}

// The pre-optimization resolver is retained with the audit checkpoint. Exercise
// actual chains, swaps, collisions, fixed intents, fatigue and damaged MOVE.
test('optimized traffic preserves baseline destinations over 200 crowded seeded scenes', () => {
    fixture();
    const path=require('path'),fs=require('fs'),vm=require('vm');
    const baseline=path.resolve(__dirname,'../../baseline/traffic_manager.js');
    if(!fs.existsSync(baseline)) throw Error('Missing CPU audit baseline fixture');
    const original={exports:{}};
    vm.runInNewContext(fs.readFileSync(baseline,'utf8'), {require,module:original,console,
        get Game(){return global.Game;},get Memory(){return global.Memory;},global,
        get Creep(){return global.Creep;},get RoomPosition(){return global.RoomPosition;},
        TOP,TOP_RIGHT,RIGHT,BOTTOM_RIGHT,BOTTOM,BOTTOM_LEFT,LEFT,TOP_LEFT,MOVE,WORK,CARRY,
        RESOURCE_ENERGY,TERRAIN_MASK_WALL,STRUCTURE_TOWER,STRUCTURE_CONTAINER,STRUCTURE_RAMPART,
        OBSTACLE_OBJECT_TYPES,FIND_STRUCTURES,FIND_HOSTILE_CREEPS,OK,ERR_INVALID_ARGS});
    const optimized=require('traffic_manager');
    for(let seed=1;seed<=200;seed++)assert.deepEqual(world(seed,optimized).matched,world(seed,original.exports).matched,'seed '+seed);
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

