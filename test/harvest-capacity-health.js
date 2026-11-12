const assert = require('assert');
const mocks = require('./mock-screeps');
let passed = 0;
function fixture() {
    mocks.installGlobals(); mocks.clearLocalModules();
    const E=require('HiveMind.Economy');
    const source=(work,max,seats)=>({workRequired:5,workActive:work,stationedWork:work,
        estimatedIncome:work*2,expectedIncome:10,maxAchievableWork:max,seatCount:seats,
        spawnEnergyCapacity:550,constraint:max<5?'SPAWN_CAPACITY':'COVERED'});
    const snapshot={harvest:{workRequired:10,workActive:9,expectedIncome:20,actualOrEstimatedIncome:18,
        sources:[source(5,5,5),source(4,4,1)]},haul:{requiredCarry:17,localCarry:17,activeCarry:17,backlog:0},
        storageEnergy:0,terminalEnergy:0,spawnFill:1,replacementRisk:0,spawnPressure:{busy:0},energyTrend:0};
    return {E,snapshot};
}
function test(name,fn){fn();passed++;console.log('PASS '+name);}
test('a fully staffed 550-energy single-seat source cannot trap a 90%-covered colony in recovery',()=>{
    const {E,snapshot:s}=fixture();
    assert.equal(E.localHarvestCoverage(s).status,'HEALTHY');assert.equal(E.rawState(s).state,'STABLE');
    assert.equal(s.harvest.workRequired,10,'full demand stays visible');assert.equal(s.harvest.sources[1].workRequired,5);
    let previous={state:'RECOVERY',healthyTicks:0,lastSampleTick:Game.time-1};
    for(let i=0;i<40;i++){Game.time++;previous=E.applyHysteresis({...s},previous);}
    assert.equal(previous.state,'STABLE','ordinary recovery confirmation remains required');
});
test('spare seats, missing miners and unknown capability cannot use the constrained floor',()=>{
    for(const change of [s=>{s.harvest.sources[1].constraint='WORKFORCE';},
        s=>{s.harvest.sources[1].maxAchievableWork=5;},s=>{s.harvest.sources[1].seatCount=0;},
        s=>{s.harvest.sources[1].spawnEnergyCapacity=undefined;},
        s=>{s.harvest.sources[1].workActive=3;s.harvest.workActive=8;},
        s=>{s.harvest.actualOrEstimatedIncome=0;s.harvest.sources[1].estimatedIncome=0;}]) {
        const {E,snapshot:s}=fixture();change(s);
        assert.notEqual(E.localHarvestCoverage(s).status,'HEALTHY',change.toString());
        assert.notEqual(E.rawState(s).state,'STABLE',change.toString());
    }
});
test('the room-wide harvest floor and real replacement risks remain enforced',()=>{
    let {E,snapshot:s}=fixture();s.harvest.workActive=8;
    assert.equal(E.rawState(s).state,'RECOVERY');
    ({E,snapshot:s}=fixture());s.replacementRisk=1;
    assert.equal(E.rawState(s).reasonCode,'REPLACEMENT_RISK');
});
console.log('Harvest capacity health scenarios passed: '+passed);
