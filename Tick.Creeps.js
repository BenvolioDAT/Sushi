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
    ThoriumMiner: require('role.ThoriumMiner'),
    ThoriumHauler: require('role.ThoriumHauler'),
    ReactorClaimer: require('role.ReactorClaimer'),
    MineralMiner: require('role.MineralMiner'),
    ResourceCourier: require('role.ResourceCourier')
};
const TickIndex = require('HiveMind.Index');
const SquadController = require('Squad.Controller');

function run() {
    const sample = Game.time % 25 === 0 && Game.cpu && typeof Game.cpu.getUsed === 'function';
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
        if (sample && squadControlled.has(creep.name)) record(creep, squadCost);
        if (squadControlled.has(creep.name)) continue;
        const role = creep && creep.memory ? roles[creep.memory.role] : null;
        if (role && typeof role.run === 'function') {
            const before = sample ? Game.cpu.getUsed() : 0;
            role.run(creep);
            if (sample) record(creep, Math.max(0, Game.cpu.getUsed() - before));
        }
    }
    if (sample) require('HiveMind.Telemetry').samplePopulation(samples);
}

function productive(creep) {
    const m = creep.memory || {}, role = m.role;
    if (role === 'Artificer') return !!m.artificerTask && !['IDLE', 'UPGRADE_FALLBACK'].includes(m.artificerTask) &&
        !(m.artificerTask === 'COLLECT' && m.artificerNextTask === 'UPGRADE_FALLBACK');
    if (role === 'Freighter') return !!(m.freighterJob || m.pickupTargetId || creep.store && creep.store.energy > 0);
    if (role === 'Tech') return creep._capacityProductive === true;
    if (role === 'Extractor') return m.extractorState !== 'idleNoSource' && !!(m.sourceId || m.sourceTargetId || m.targetSourceId);
    if (role === 'Scout') return !!(m.targetRoom || m.scoutTarget || m.scoutTargetRoom);
    return true;
}

module.exports = { run, roles, productive };
