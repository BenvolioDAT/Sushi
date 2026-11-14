const fs=require('fs'),path=require('path'),assert=require('assert');
const read=name=>JSON.parse(fs.readFileSync(path.join(__dirname,name),'utf8'));
const before=read('before.json'),after=read('after.json');
for(const sample of [before,after]) {
    assert.equal(sample.n,676);
    assert.equal(sample.end-sample.start,sample.n);
    sample.mean=sample.sum/sample.n;
    sample.spikesPer1000=sample.spikes/sample.n*1000;
    sample.phaseMeans=Object.fromEntries(Object.entries(sample.phases).map(([k,v])=>[k,v/sample.n]));
}
const result={before,after,observedMeanReductionPercent:(before.mean-after.mean)/before.mean*100,
    caveat:'Completed user-loop CPU, excluding engine post-loop serialization. Consecutive live workloads, not an identical-state replay. Nested phase costs are inclusive.'};
fs.writeFileSync(path.join(__dirname,'comparison.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
