const roles = {
    Foreman: require('role.Foreman'),
    Extractor: require('role.Extractor'),
    Tech: require('role.Tech'),
    Freighter: require('role.Freighter'),
    Annex: require('role.Annex'),
    Artificer: require('role.Artificer'),
    Pioneer: require('role.Pioneer'),
    SupplyRunner: require('role.SupplyRunner'),
    Scout: require('role.Scout'),
    Ronin: require('role.Ronin'),
    Volley: require('role.Volley'),
    Cleric: require('role.Cleric'),
    MineralMiner: require('role.MineralMiner'),
    ResourceCourier: require('role.ResourceCourier'),
    CoreBreaker: require('role.CoreBreaker'),
    Breacher: require('role.CoreBreaker')
};
const TickIndex = require('HiveMind.Index');
const SquadController = require('Squad.Controller');
const HiveMemory = require('HiveMind.Memory');

function recordRoleError(creep, error) {
    const telemetry = HiveMemory.ensure().telemetry;
    const errors = telemetry.creepErrors || (telemetry.creepErrors = {});
    const role = creep.memory.role;
    const previous = errors[role];
    const interval = Math.max(1, Number(HiveMemory.getConfig('cpu').telemetry.errorLogInterval) || 100);
    const log = !previous || previous.lastLogTick > Game.time ||
        Game.time - previous.lastLogTick >= interval;
    errors[role] = { creepName: creep.name, roomName: creep.room && creep.room.name,
        message: String(error && error.message || error).slice(0, 200), tick: Game.time,
        count: Math.min(1000000000, (previous && previous.count || 0) + 1),
        lastLogTick: log ? Game.time : previous.lastLogTick };
    require('Diagnostics').exception('ROLE_EXCEPTION', creep.room && creep.room.name, error, role);
    try { if (log) console.log(`[Sushi role error] ${role} ${creep.name}: ${String(error && error.stack || error).slice(0, 1800)}`); } catch (loggingError) { /* Logging cannot stop other roles. */ }
}

function run() {
    const sample = (Game.time % 25 === 0 || require('Diagnostics').config().mode === 'PROFILE') && Game.cpu && typeof Game.cpu.getUsed === 'function';
    const samples = {};
    const squadBefore = sample ? Game.cpu.getUsed() : 0;
    const squadControlled = SquadController.execute();
    const squadCost = sample ? Math.max(0, Game.cpu.getUsed() - squadBefore) / Math.max(1, squadControlled.size) : 0;
    function record(creep, cpu) {
        if (creep.spawning) return;
        const roomName = creep.memory.homeRoom || creep.room && creep.room.name || 'unknown';
        const room = samples[roomName] || (samples[roomName] = {});
        const value = room[creep.memory.role] || (room[creep.memory.role] = { cpu: 0, active: 0, count: 0 });
        value.cpu += cpu; value.count++; value.active += productive(creep) ? 1 : 0;
    }
    for (const creep of TickIndex.get().allCreeps) {
        if (!creep || creep.spawning) continue;
        if (sample && squadControlled.has(creep.name)) record(creep, squadCost);
        if (squadControlled.has(creep.name)) continue;
        const role = creep && creep.memory ? roles[creep.memory.role] : null;
        if (role && typeof role.run === 'function') {
            const before = sample ? Game.cpu.getUsed() : 0;
            try { role.run(creep); }
            catch (error) {
                creep._sushiRoleFailedTick = Game.time;
                recordRoleError(creep, error);
            }
            if (sample) record(creep, Math.max(0, Game.cpu.getUsed() - before));
        }
    }
    if (sample) require('HiveMind.Telemetry').samplePopulation(samples);
}

function productive(creep) {
    if (creep._sushiRoleFailedTick === Game.time) return false;
    const m = creep.memory || {}, role = m.role;
    if (role === 'Artificer') return !!m.artificerTask && !['IDLE', 'UPGRADE_FALLBACK'].includes(m.artificerTask) &&
        !(m.artificerTask === 'COLLECT' && m.artificerNextTask === 'UPGRADE_FALLBACK');
    if (role === 'Freighter') return !!(m.freighterFlow && m.freighterFlow.tick === Game.time && m.freighterFlow.active);
    if (role === 'Tech') return creep._capacityProductive === true;
    if (role === 'Extractor') return m.extractorState !== 'idleNoSource' && !!(m.sourceId || m.sourceTargetId || m.targetSourceId);
    if (role === 'Scout') return !!(m.targetRoom || m.scoutTarget || m.scoutTargetRoom);
    return true;
}

module.exports = { run, roles, productive };
