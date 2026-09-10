const Policy = require('Resource.Policy');
const Economy = require('HiveMind.Economy');
const TickIndex = require('HiveMind.Index');

const DEFAULTS = Object.freeze({ desiredReactorThorium: 900, thoriumStagingDesired: 200,
    thoriumStagingUrgent: 450 });
function config() {
    const raw = require('HiveMind.Memory').getConfig('season11') || {};
    return { desiredReactorThorium: Math.min(1000, Math.max(1, Number(raw.desiredReactorThorium) || DEFAULTS.desiredReactorThorium)),
        thoriumStagingDesired: Math.max(1, Number(raw.thoriumStagingDesired) || DEFAULTS.thoriumStagingDesired),
        thoriumStagingUrgent: Math.max(1, Number(raw.thoriumStagingUrgent) || DEFAULTS.thoriumStagingUrgent) };
}

function safeStorage(roomName) {
    const index = TickIndex.get();
    const rooms = index.ownedRooms.filter(room => Policy.active(room.storage) && Policy.free(room.storage.store) > Policy.config().minimumStorageFreeCapacity &&
        !(index.combatHostilesByRoom.get(room.name) || []).length);
    rooms.sort((a, b) => (a.name === roomName ? 0 : 1) - (b.name === roomName ? 0 : 1) || a.name.localeCompare(b.name));
    return rooms[0] && rooms[0].storage || null;
}
function prediction(stored, rate, eta) {
    const expectedAtArrival = Math.max(0, stored) + Math.max(0, rate) * Math.max(0, eta);
    return { currentStaging: stored, miningRate: rate, haulerETA: eta, expectedAtArrival,
        urgent: expectedAtArrival >= config().thoriumStagingUrgent };
}
function assess(assignment, memory) {
    const Adapter = require('Season11.Adapter'), index = TickIndex.get();
    const room = assignment && Game.rooms[assignment.roomName];
    const staging = assignment && Game.getObjectById(assignment.stagingId);
    const storage = assignment && safeStorage(assignment.roomName);
    const economy = room && Economy.get(room);
    const homeEconomy = assignment && Economy.get(assignment.homeRoom);
    let reason = (!Adapter.isAvailable() || !['auto', 'active'].includes(memory.mode)) ? 'INACTIVE' : !assignment || (!assignment.ready && !assignment.depleted) || !room || !room.controller || !room.controller.my || room.controller.level < 6 ? 'WAITING_INFRASTRUCTURE' :
        assignment.remaining <= 0 ? 'DEPLETED' : (economy && economy.state === 'SURVIVAL' || homeEconomy && homeEconomy.state === 'SURVIVAL') ? 'PAUSED_SURVIVAL' :
            memory.config.pauseMining === true ? 'PAUSED_MANUAL' :
                (index.combatHostilesByRoom.get(room.name) || []).length ? 'PAUSED_HOSTILES' : null;
    const type = Adapter.resourceType();
    const stored = (staging && staging.store && staging.store[type] || 0);
    const routes = Object.values(memory.reactorPortfolio.reactors).filter(e => e.active && (e.assignedMiningRooms || []).includes(assignment && assignment.roomName));
    if (!reason && (!staging || Policy.free(staging.store) <= 0 || !storage && !routes.length)) reason = 'PAUSED_NO_SAFE_DELIVERY';
    if (!reason && staging.structureType === (typeof STRUCTURE_CONTAINER !== 'undefined' ? STRUCTURE_CONTAINER : 'container') && stored >= config().thoriumStagingUrgent) reason = 'PAUSED_STAGING_PRESSURE';
    let work = 0;
    for (const creep of index.creepsByRole.get('ThoriumMiner') || []) if (creep.memory.season11SourceRoom === (assignment && assignment.roomName)) {
        work += typeof creep.getActiveBodyparts === 'function' ? creep.getActiveBodyparts('work') :
            (creep.body || []).filter(part => part.type === 'work' && part.hits !== 0).length;
    }
    // Normal extractor cooldown applies; observed throughput can override this estimate.
    const rate = Number.isFinite(assignment && assignment.observedHarvestRate) ? assignment.observedHarvestRate :
        work * (typeof HARVEST_MINERAL_POWER === 'number' ? HARVEST_MINERAL_POWER : 1) /
        (typeof EXTRACTOR_COOLDOWN === 'number' ? EXTRACTOR_COOLDOWN : 5);
    const eta = staging && storage && staging.pos.roomName === storage.pos.roomName ? staging.pos.getRangeTo(storage) : 50;
    const result = { ...prediction(stored, rate, eta), allowed: !reason, reason: reason || 'FINITE_RESOURCE', storageId: storage && storage.id || null };
    if (assignment) assignment.resourcePolicy = result;
    return result;
}
function reservePlans(room, memory, makeHaulerPlan, count) {
    const plans = [];
    for (const a of Object.values(memory.assignments.mining)) {
        if (!a || a.homeRoom !== room.name || !a.stagingId) continue;
        const report = assess(a, memory), storage = report.storageId && Game.getObjectById(report.storageId);
        if (!storage || storage.id === a.stagingId || !['FINITE_RESOURCE', 'PAUSED_STAGING_PRESSURE', 'DEPLETED'].includes(report.reason)) continue;
        if (report.expectedAtArrival < config().thoriumStagingDesired) continue;
        const plan = makeHaulerPlan(room.name, a, { id: 'reserve:' + storage.id, roomName: storage.pos.roomName }, false);
        if (!plan) continue;
        plan.memory.season11ReserveStorageId = storage.id;
        const capacity = plan.requestedCarryParts * 50;
        plan.desired = Math.min(memory.config.maxHaulersPerRoute, Math.max(1,
            Math.ceil(Math.max(report.expectedAtArrival, report.miningRate * report.haulerETA * 2) / capacity)));
        if (count(plan.assignmentKey, true) < plan.desired) plans.push(plan);
    }
    return plans;
}
function runway(record, deliveryEta, replacementDelay, inTransit = 0) {
    const runwayTicks = Math.max(0, (record.thorium || 0) - Math.max(0, Game.time - (record.lastSeen || Game.time)));
    const required = Math.max(0, deliveryEta || 0) + Math.max(0, replacementDelay || 0) + 150;
    return { supplyRunwayTicks: runwayTicks, requiredRunwayTicks: required, inTransit,
        desiredReactorThorium: Math.min(1000, Math.max(config().desiredReactorThorium, required)),
        emergencyPriority: runwayTicks < required ? 72 + Math.min(18, Math.log10(1 + (record.continuousWork || 0)) * 3) : 42 };
}
module.exports = { DEFAULTS, config, safeStorage, prediction, assess, reservePlans, runway };
