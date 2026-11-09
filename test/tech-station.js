const assert = require('assert');
const mocks = require('./mock-screeps');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function fixture() {
    mocks.installGlobals(); mocks.clearLocalModules();
    let moves = 0, upgrades = 0, withdrawals = 0, moveTarget;
    const room = { name: 'W39S47', controller: { pos: new RoomPosition(7, 35, 'W39S47'), ticksToDowngrade: 20000 },
        find: type => type === FIND_STRUCTURES ? structures : [] };
    const container = { id: 'controllerFuel', structureType: STRUCTURE_CONTAINER, pos: new RoomPosition(5, 33, room.name),
        store: { energy: 2000, getUsedCapacity() { return this.energy; } } };
    const structures = [container];
    Game.rooms[room.name] = room;
    const c = { name: 'Tech_001', room, pos: new RoomPosition(6, 32, room.name),
        memory: { role: 'Tech', homeRoom: room.name, controllerGrowthFloor: true, upgrading: false },
        store: { energy: 49, getUsedCapacity() { return this.energy; }, getFreeCapacity() { return 50 - this.energy; } },
        upgradeController() { if (this.pos.getRangeTo(room.controller) > 3) return ERR_NOT_IN_RANGE; if (!this.store.energy) return ERR_NOT_ENOUGH_ENERGY; upgrades++; this.store.energy--; return OK; },
        withdraw(target) { if (this.pos.getRangeTo(target) > 1) return ERR_NOT_IN_RANGE; withdrawals++; this.store.energy = 50; return OK; },
        setTrafficLock(value) { this._trafficLocked = value; }, setWorkingArea(pos, range) { this._workingPos = pos; this._workingRange = range; } };
    Game.creeps[c.name] = c;
    require('HiveMind.ColonyState').get = () => ({ growthAllowed: true, rcl: 3 });
    const E = require('HiveMind.Economy'); E.canSpend = () => true;
    require('utility.Travel.Creep').move = (creep,target) => { moves++; moveTarget = target.pos || target; return OK; };
    const role = require('role.Tech');
    return { c, container, structures, E, role, moves: () => moves, moveTarget: () => moveTarget,
        upgrades: () => upgrades, withdrawals: () => withdrawals };
}
test('a partially loaded Tech already in upgrade range uses its energy without refill travel', () => {
    const f = fixture(); f.role.run(f.c); assert.strictEqual(f.upgrades(), 1); assert.strictEqual(f.moves(), 0);
    assert.strictEqual(f.c.memory.upgrading, true);
});
test('a Tech upgrades and refills on one tile for 120 ticks without movement', () => {
    const f = fixture();
    for (let i = 0; i < 120; i++) { f.role.run(f.c); assert.strictEqual(f.c._trafficLocked, true); Game.time++; }
    assert.strictEqual(f.moves(), 0); assert.ok(f.upgrades() >= 115); assert.ok(f.withdrawals() >= 2);
    assert.strictEqual(f.c._workingRange, 3);
});
test('out-of-range Techs still move to upgrade range', () => {
    const f = fixture(); f.c.pos = new RoomPosition(6, 31, 'W39S47'); f.c.memory.upgrading = true;
    f.role.run(f.c); assert.strictEqual(f.moves(), 1); assert.strictEqual(f.c._trafficLocked, false);
});
test('an empty nearby container releases the stationary traffic lock', () => {
    const f = fixture(); f.container.store.energy = 0; f.role.run(f.c);
    assert.strictEqual(f.c._trafficLocked, false);
});
test('station optimization does not bypass economic policy', () => {
    const f = fixture(); f.E.canSpend = () => false;
    require('utility.Creep').fillRoomEnergy = () => {};
    f.role.run(f.c); assert.strictEqual(f.upgrades(), 0); assert.strictEqual(f.c._trafficLocked, false);
});

test('a policy-paused loaded Tech does not leave its station merely to park near a full base', () => {
    for (const energy of [1, 49]) {
        const f = fixture(); f.E.canSpend = () => false; f.c.store.energy = energy;
        const spawn = { structureType: STRUCTURE_SPAWN, pos: new RoomPosition(22,27,'W39S47'),
            store: { getFreeCapacity: () => 0 } };
        const tower = { structureType: STRUCTURE_TOWER, pos: new RoomPosition(21,27,'W39S47'),
            store: { getFreeCapacity: () => 0 } };
        f.c.pos.findClosestByPath = (type, options) => type === FIND_MY_SPAWNS ? spawn :
            [spawn,tower].find(s => !options?.filter || options.filter(s)) || null;
        f.c.transfer = () => { throw new Error('full stores cannot be transfer targets'); };
        for (let i=0;i<120;i++) { f.role.run(f.c); Game.time++; }
        assert.strictEqual(f.moves(),0,'policy refusal must not invoke Foreman parking');
        assert.strictEqual(f.upgrades(),0); assert.strictEqual(f.c._trafficLocked,false);
        assert.strictEqual(f.c.store.energy,energy);
    }
});

test('a policy-paused loaded Tech still delivers to a real core energy shortage', () => {
    const f=fixture(); f.E.canSpend=()=>false;
    const spawn={structureType:STRUCTURE_SPAWN,pos:new RoomPosition(22,27,'W39S47'),
        store:{getFreeCapacity:()=>100}};
    f.c.pos.findClosestByPath=(type,options)=>!options?.filter||options.filter(spawn)?spawn:null;
    f.c.transfer=target=>{assert.strictEqual(target,spawn);return ERR_NOT_IN_RANGE;};
    f.role.run(f.c);assert.strictEqual(f.moves(),1);assert.strictEqual(f.moveTarget(),spawn.pos);
    assert.strictEqual(f.upgrades(),0);assert.strictEqual(f.c._trafficLocked,false);
});
test('a Tech leaves a delivery road once, then upgrades and refills without further movement', () => {
    const f = fixture(); f.c.pos = new RoomPosition(5,32,'W39S47');
    f.structures.push({ structureType: STRUCTURE_ROAD, pos: f.c.pos });
    f.role.run(f.c); assert.strictEqual(f.upgrades(),1); assert.strictEqual(f.moves(),1);
    assert.strictEqual(f.c._trafficLocked,false);
    assert.ok(f.moveTarget().getRangeTo(f.container) <= 1);
    assert.ok(f.moveTarget().getRangeTo(f.c.room.controller) <= 3);
    f.c.pos = f.moveTarget();
    for(let i=0;i<120;i++){Game.time++;f.role.run(f.c);assert.strictEqual(f.c._trafficLocked,true);}
    assert.strictEqual(f.moves(),1); assert.ok(f.withdrawals()>=2);
});
test('an occupied or blocked off-road station cannot pull a Tech out of its working tile', () => {
    for (const blocked of [true,false]) {
        const f = fixture(); f.c.pos = new RoomPosition(5,32,'W39S47');
        f.structures.push({ structureType: STRUCTURE_ROAD, pos: f.c.pos });
        if(blocked) Game.map.getRoomTerrain = () => ({get:()=>TERRAIN_MASK_WALL});
        else for(let x=4;x<=6;x++)for(let y=31;y<=33;y++)if(x!==5||y!==32){
            const name='occupant'+x+':'+y;
            Game.creeps[name]={name,my:true,room:f.c.room,pos:new RoomPosition(x,y,'W39S47'),body:[],memory:{role:'Artificer'}};
        }
        f.role.run(f.c); assert.strictEqual(f.moves(),0); assert.strictEqual(f.c._trafficLocked,true);
    }
});
test('multiple stationary Techs can use an unoccupied fuel container without locking its delivery road', () => {
    const f=fixture();f.c.pos=new RoomPosition(5,32,'W39S47');
    for(const [x,y] of [[5,32],[6,32],[6,33]])f.structures.push({structureType:STRUCTURE_ROAD,pos:new RoomPosition(x,y,'W39S47')});
    for(const [x,y] of [[4,32],[4,33]]){const name='other'+y;Game.creeps[name]={name,my:true,room:f.c.room,
        pos:new RoomPosition(x,y,'W39S47'),body:[],memory:{role:'Tech'}};}
    f.role.run(f.c);assert.strictEqual(f.moves(),1);assert.ok(f.moveTarget().isEqualTo(f.container.pos));
    f.c.pos=f.moveTarget();for(let i=0;i<120;i++){Game.time++;f.role.run(f.c);assert.strictEqual(f.c._trafficLocked,true);}
    assert.strictEqual(f.moves(),1);assert.ok(f.withdrawals()>=2);
});
console.log('Tech station scenarios passed: ' + passed);
