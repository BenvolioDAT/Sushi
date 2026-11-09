// Offline analysis of console observations. Never connects to the game.
const fs = require('fs');
const path = require('path');
const builds = ['8c02678081b3e371337bf683b1bc45467967946349454a476f370c387e978f27',
    'c40df0d0b2d595cae1557eced18318bfe2f17bebbdf978943d45c47b590663aa'];
const rows = fs.readdirSync(__dirname).filter(n => /^SUSHI_[MR]\d+\.json$/.test(n))
    .map(n => {
        const r = JSON.parse(fs.readFileSync(path.join(__dirname, n), 'utf8'));
        return { file: n, ...r, ...(r.room && typeof r.room === 'object' ? {
            state: r.room.state, haul: r.room.hauling, freighters: r.room.freighters,
            sources: r.room.sources.map(s => [s.id, s.stationedWork, s.miners]),
            income: r.room.income, progress: r.room.progress, haulCpu: r.room.logistics.cpu
        } : {}) };
    })
    .filter(r => builds.includes(r.build.id)).sort((a, b) => a.tick - b.tick);
const samples = rows.map((r, i) => {
    const previous = rows[i - 1];
    const local = r.freighters.filter(c => c.assignmentClass === 'local');
    const pairs = previous ? local.map(c => [previous.freighters.find(p =>
        p.name === c.name && p.ttl + previous.tick === c.ttl + r.tick), c]).filter(p => p[0]) : [];
    return { file: r.file, tick: r.tick, build: r.build.id, state: r.state, local: local.length,
        remote: r.freighters.filter(c => c.assignmentClass === 'remote').length,
        physicalLocalCarry: local.reduce((n, c) => n + c.carryParts, 0),
        healthyLocalCarry: r.haul.localCarry, requiredLocalCarry: r.haul.requiredCarry,
        backlog: r.haul.backlog, sourceWork: r.sources.map(s => s[1]), income: r.income ?? r.haul.creepHaulIncome,
        cpuEma: r.cpu.total, bucket: r.cpu.bucket, pixels: r.resource, progress: r.progress,
        claims: local.filter(c => c.predecessors.length).map(c => ({ name: c.name, predecessors: c.predecessors })),
        tech: r.tech, haulCpu: r.haulCpu || null,
        interval: previous ? { ticks: r.tick - previous.tick, survivingLocalGenerations: pairs.length,
            deliveredByThoseSurvivors: pairs.length ? pairs.reduce((n, [a, b]) => n + (b.flow?.delivered || 0) - (a.flow?.delivered || 0), 0) : null,
            allLocalGenerationsMatched: pairs.length === local.length && pairs.length === previous.freighters.filter(c => c.assignmentClass === 'local').length,
            controllerProgress: r.progress - previous.progress, bucketChange: r.cpu.bucket - previous.cpu.bucket } : null };
});
const result = { builds, note: 'Survivor delivery deltas are conservative: expired generations are omitted. CPU is a rolling EMA, not a causal estimate; cross-build comparisons are not controlled. Samples do not prove every intervening engine tick.', samples };
fs.writeFileSync(path.join(__dirname, 'observations-summary.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ samples: samples.length, first: samples[0], last: samples.at(-1) }, null, 2));
