// Offline analysis of console observations. Never connects to the game.
const fs = require('fs');
const path = require('path');
const build = '8c02678081b3e371337bf683b1bc45467967946349454a476f370c387e978f27';
const rows = fs.readdirSync(__dirname).filter(n => /^SUSHI_M\d+\.json$/.test(n))
    .map(n => ({ file: n, ...JSON.parse(fs.readFileSync(path.join(__dirname, n), 'utf8')) }))
    .filter(r => r.build.id === build).sort((a, b) => a.tick - b.tick);
const samples = rows.map((r, i) => {
    const previous = rows[i - 1];
    const local = r.freighters.filter(c => c.assignmentClass === 'local');
    const pairs = previous ? local.map(c => [previous.freighters.find(p =>
        p.name === c.name && p.ttl + previous.tick === c.ttl + r.tick), c]).filter(p => p[0]) : [];
    return { file: r.file, tick: r.tick, state: r.state, local: local.length,
        remote: r.freighters.filter(c => c.assignmentClass === 'remote').length,
        physicalLocalCarry: local.reduce((n, c) => n + c.carryParts, 0),
        healthyLocalCarry: r.haul.localCarry, requiredLocalCarry: r.haul.requiredCarry,
        backlog: r.haul.backlog, sourceWork: r.sources.map(s => s[1]), income: r.income ?? r.haul.creepHaulIncome,
        cpuEma: r.cpu.total, bucket: r.cpu.bucket, pixels: r.resource, progress: r.progress,
        claims: local.filter(c => c.predecessors.length).map(c => ({ name: c.name, predecessors: c.predecessors })),
        tech: r.tech, haulCpu: r.haulCpu || null,
        interval: previous ? { ticks: r.tick - previous.tick, survivingLocalGenerations: pairs.length,
            deliveredByThoseSurvivors: pairs.reduce((n, [a, b]) => n + (b.flow?.delivered || 0) - (a.flow?.delivered || 0), 0),
            controllerProgress: r.progress - previous.progress, bucketChange: r.cpu.bucket - previous.cpu.bucket } : null };
});
const result = { build, note: 'Survivor delivery deltas are conservative: expired generations are omitted. CPU is a rolling EMA, not a causal estimate. Samples do not prove every intervening engine tick.', samples };
fs.writeFileSync(path.join(__dirname, 'observations-summary.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ samples: samples.length, first: samples[0], last: samples.at(-1) }, null, 2));
