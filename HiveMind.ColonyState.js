const HiveMemory = require('HiveMind.Memory');
const TickIndex = require('HiveMind.Index');
const Economy = require('HiveMind.Economy');

const PHASES = Object.freeze({
    OWNED_NO_SPAWN: 'OWNED_NO_SPAWN', BOOTSTRAP: 'BOOTSTRAP', GROWTH: 'GROWTH',
    DEVELOPMENT: 'DEVELOPMENT', MATURE: 'MATURE'
});
const ALERTS = Object.freeze({ PEACE: 'PEACE', THREATENED: 'THREATENED', SIEGE: 'SIEGE' });

function countRole(roomName, role) {
    return (TickIndex.get().creepsByHomeRoom.get(roomName) || [])
        .filter(creep => creep && creep.memory && creep.memory.role === role &&
            (creep.ticksToLive === undefined || creep.ticksToLive > 50)).length;
}

function structures(roomName, type) {
    const byType = TickIndex.get().structuresByRoom.get(roomName);
    return byType && (byType.get(type) || []).length || 0;
}

function milestoneFor(room, phase) {
    const rcl = room.controller && room.controller.level || 0;
    const extension = typeof STRUCTURE_EXTENSION !== 'undefined' ? STRUCTURE_EXTENSION : 'extension';
    const tower = typeof STRUCTURE_TOWER !== 'undefined' ? STRUCTURE_TOWER : 'tower';
    const storage = typeof STRUCTURE_STORAGE !== 'undefined' ? STRUCTURE_STORAGE : 'storage';
    const requirements = [];
    if (phase === PHASES.OWNED_NO_SPAWN) requirements.push('owned spawn');
    else if (phase === PHASES.BOOTSTRAP) requirements.push('harvest WORK', 'CARRY capacity', 'spawn fill', 'Foreman coverage');
    else if (rcl <= 1) requirements.push('controller upgrading');
    else if (rcl === 2) requirements.push('5 extensions', 'essential source logistics');
    else if (rcl === 3) requirements.push('first tower', '10 extensions');
    else if (rcl === 4) requirements.push('storage', '20 extensions');
    else if (rcl <= 7) requirements.push('advanced infrastructure', 'healthy reserves');
    else requirements.push('controller safety', 'core infrastructure');
    const unmet = [];
    if (requirements.includes('owned spawn')) unmet.push('waiting for owned spawn');
    if (requirements.includes('harvest WORK') && countRole(room.name, 'Extractor') < 1) unmet.push('waiting for harvest WORK');
    if (requirements.includes('CARRY capacity') && countRole(room.name, 'Freighter') < 1) unmet.push('waiting for CARRY capacity');
    if (requirements.includes('spawn fill') && countRole(room.name, 'Foreman') < 1) unmet.push('waiting for spawn fill');
    if (requirements.includes('Foreman coverage') && countRole(room.name, 'Foreman') < 1) unmet.push('waiting for Foreman coverage');
    if (rcl === 2 && structures(room.name, extension) < 5) unmet.push('waiting for extensions');
    if (rcl === 3 && structures(room.name, tower) < 1) unmet.push('waiting for first tower');
    if (rcl === 3 && structures(room.name, extension) < 10) unmet.push('waiting for extensions');
    if (rcl === 4 && structures(room.name, storage) < 1) unmet.push('waiting for storage');
    if (room.controller && room.controller.ticksToDowngrade < 5000) unmet.unshift('controller downgrade danger');
    return { current: requirements[0] || 'maintain colony', requirements, unmet };
}

function rawPhase(room, economy) {
    const spawns = TickIndex.get().ownedSpawnsByRoom.get(room.name) || [];
    if (!spawns.length) return PHASES.OWNED_NO_SPAWN;
    const sustainable = economy && !['SURVIVAL', 'RECOVERY'].includes(economy.state) &&
        countRole(room.name, 'Extractor') > 0 && countRole(room.name, 'Freighter') > 0 && countRole(room.name, 'Foreman') > 0;
    if (!sustainable) return PHASES.BOOTSTRAP;
    const rcl = room.controller && room.controller.level || 0;
    if (rcl <= 4) return PHASES.GROWTH;
    if (rcl <= 7) return PHASES.DEVELOPMENT;
    return PHASES.MATURE;
}

function alertFor(room) {
    const threat = HiveMemory.ensure().threats[room.name];
    if (!threat || !(threat.harmfulHostileCount > 0)) return ALERTS.PEACE;
    return threat.emergency || threat.totalThreat >= 1000 ? ALERTS.SIEGE : ALERTS.THREATENED;
}

function update(room) {
    if (!room || !room.controller || !room.controller.my) return null;
    const memory = HiveMemory.getRoomMemory(room.name);
    if (!memory.colony || typeof memory.colony !== 'object') memory.colony = {};
    const record = memory.colony;
    const economy = Economy.get(room.name) || { state: 'RECOVERY' };
    const proposed = rawPhase(room, economy);
    const holdTicks = Math.max(1, HiveMemory.getConfig('lifecycle').hysteresisTicks || 5);
    if (!record.phase) {
        record.phase = proposed;
        record.stateStartTick = Game.time;
        record.stateChangedAt = Game.time;
    }
    else if (proposed !== record.phase) {
        if (record.pendingPhase !== proposed) {
            record.pendingPhase = proposed;
            record.pendingSince = Game.time;
        }
        const urgent = proposed === PHASES.OWNED_NO_SPAWN || proposed === PHASES.BOOTSTRAP;
        if (urgent || Game.time - record.pendingSince >= holdTicks) {
            record.phase = proposed;
            record.stateStartTick = Game.time;
            record.stateChangedAt = Game.time;
            delete record.pendingPhase;
            delete record.pendingSince;
        }
    }
    else {
        delete record.pendingPhase;
        delete record.pendingSince;
    }
    const milestone = milestoneFor(room, record.phase);
    record.alert = alertFor(room);
    record.rcl = room.controller.level || 0;
    if (record.milestone !== milestone.current) {
        record.milestone = milestone.current;
        record.milestoneSince = Game.time;
    }
    record.requirements = milestone.requirements;
    record.unmet = milestone.unmet;
    if (record.unmet.length && countRole(room.name, 'Artificer') < 1 &&
        record.unmet.some(reason => /extensions|tower|storage/.test(reason))) {
        record.unmet.push('waiting for builder WORK');
    }
    if (Game.cpu && Game.cpu.bucket < 2000) record.unmet.unshift('CPU bucket too low');
    if (Game.constructionSites && Object.keys(Game.constructionSites).length >= 90) {
        record.unmet.unshift('construction-site cap');
    }
    if (record.alert !== ALERTS.PEACE) record.unmet.unshift('threat preemption');
    const timeout = Math.max(1, HiveMemory.getConfig('lifecycle').milestoneTimeout || 1500);
    record.milestoneTimedOut = !!(record.unmet.length && Game.time - (record.milestoneSince || Game.time) >= timeout);
    record.reason = record.milestoneTimedOut ? `milestone timeout: ${record.unmet[0]}` :
        record.unmet[0] || `${record.phase} requirements satisfied`;
    record.updatedTick = Game.time;
    return { ...record, economy: economy.state };
}

function run() {
    const result = {};
    for (const room of TickIndex.get().ownedRooms) result[room.name] = update(room);
    return result;
}

function get(roomName) {
    return Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].colony || null;
}

module.exports = { PHASES, ALERTS, run, update, get, milestoneFor };
