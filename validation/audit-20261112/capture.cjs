// Read-only snapshots of the local server's periodically persisted database.
// No credentials, server writes, console commands or enemy injection.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.resolve(__dirname, '../..');
const server = 'D:/SteamLibrary/steamapps/common/Screeps/server';
const hash = text => crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const db = JSON.parse(fs.readFileSync(path.join(server, 'db.json'), 'utf8'));
const col = name => db.collections.find(c => c.name === name)?.data || [];
const user = col('users').find(u => u.username === 'BenvolioDAT');
if (!user) throw Error('Expected local test player not found');
const env = col('env')[0].data;
const raw = env['memory:' + user._id];
const memory = JSON.parse(raw);
const code = col('users.code').find(c => c.user === user._id && c.activeWorld);
if (!code || code.branch !== 'Sushi') throw Error('Unexpected active branch');
const modules = Object.fromEntries(Object.entries(code.modules).map(([name, value]) => [name.replace(/\$DOT\$/g, '.') + '.js', value]));
const matches = [], differences = [];
for (const [file, source] of Object.entries(modules)) {
    const local = path.join(root, file);
    (fs.existsSync(local) && hash(source) === hash(fs.readFileSync(local, 'utf8')) ? matches : differences).push(file);
}
const objects = col('rooms.objects');
const mine = objects.filter(o => o.user === user._id);
const ownedRooms = mine.filter(o => o.type === 'controller').map(o => o.room);
const creeps = mine.filter(o => o.type === 'creep').map(o => ({ ...o, memory: memory.creeps?.[o.name] }));
const counts = {};
for (const c of creeps) counts[c.memory?.role || '?'] = (counts[c.memory?.role || '?'] || 0) + 1;
const structures = objects.filter(o => ownedRooms.includes(o.room) && o.type !== 'creep');
const snapshot = {
    capturedAt: new Date().toISOString(), databaseSavedAt: fs.statSync(path.join(server, 'db.json')).mtime.toISOString(),
    tick: Number(env.gameTime), memoryChars: raw.length, cpuAvailable: user.cpuAvailable, cpuLimit: user.cpu,
    activeBranch: code.branch, codeTimestamp: code.timestamp, build: modules['Runtime.Build.js'],
    codeMatches: matches.length, codeDifferences: differences, counts, creeps, structures,
    rooms: memory.rooms, hive: memory.hive, cpu: memory.cpu, config: memory.config,
    visibleHostiles: objects.filter(o => o.type === 'creep' && ownedRooms.includes(o.room) && o.user !== user._id),
};
const label = process.argv[2] || 'snapshot';
if (!/^[a-z0-9-]+$/i.test(label)) throw Error('Invalid snapshot label');
fs.writeFileSync(path.join(__dirname, label + '.json'), JSON.stringify(snapshot, null, 2));
console.log(JSON.stringify({ tick: snapshot.tick, memoryChars: snapshot.memoryChars, counts,
    codeMatches: matches.length, codeDifferences: differences, branch: code.branch,
    cpu: {tick:memory.hive?.telemetry?.cpu?.tick,total:memory.hive?.telemetry?.cpu?.total},
    progress:memory.hive?.telemetry?.growth, state:memory.rooms?.W7N4?.economy?.state,
    remote:memory.rooms?.W7N4?.economy?.growth?.remote,
    renewals:creeps.filter(c=>c.memory?.freighterPredecessors).map(c=>({name:c.name,carry:c.body.filter(p=>p.type==='carry').length,predecessors:c.memory.freighterPredecessors})),
}, null, 2));
