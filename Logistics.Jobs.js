/* Compact explicit transport-job plumbing. Automatic HOME balancing is intentionally out of scope. */
function assign(creep, job) {
    if (!creep || !creep.memory || !job || !job.originRoom || !job.destinationRoom) return false;
    if (!Number.isInteger(job.amount) || job.amount <= 0) return false;
    var memory = creep.memory;
    if (memory.role !== 'Freighter' || memory.FreighterWorking || memory.freighterJob ||
        memory.pickupTargetId || memory.pickupSourceId || memory.remoteDeliverySourceId) return false;
    if (creep.store && Object.keys(creep.store).some(function(key) {
        return typeof creep.store[key] === 'number' && creep.store[key] > 0;
    })) return false;
    creep.memory.freighterJob = 'transport';
    creep.memory.originRoom = job.originRoom;
    creep.memory.pickupRoom = job.originRoom;
    creep.memory.destinationRoom = job.destinationRoom;
    creep.memory.resourceType = job.resourceType || RESOURCE_ENERGY;
    creep.memory.logisticsAmount = job.amount;
    creep.memory.logisticsRemaining = job.amount;
    creep.memory.logisticsDelivered = 0;
    creep.memory.logisticsPurpose = job.purpose || 'HOME_TRANSFER';
    creep.memory.logisticsPriority = job.priority || 0;
    if (job.pickupTargetId) creep.memory.pickupTargetId = job.pickupTargetId;
    return true;
}

function clear(creep) {
    if (!creep || !creep.memory) return;
    var fields = ['freighterJob', 'originRoom', 'pickupRoom', 'pickupSourceId', 'pickupTargetId',
        'pickupTargetType', 'destinationRoom', 'resourceType', 'logisticsAmount', 'logisticsRemaining', 'logisticsDelivered', 'logisticsPendingDelivery',
        'logisticsPurpose', 'logisticsPriority', 'freighterReservedCarry',
        'freighterReservedUntil', 'remoteTrip'];
    for (var i = 0; i < fields.length; i++) delete creep.memory[fields[i]];
}

function reconcileDelivery(creep) {
    var pending = creep.memory.logisticsPendingDelivery;
    if (!pending) return;
    var resource = creep.memory.resourceType || RESOURCE_ENERGY;
    var delivered = Math.min(pending.amount, Math.max(0, pending.before - (creep.store[resource] || 0)));
    if (!delivered && pending.tick === Game.time) return;
    creep.memory.logisticsDelivered = (creep.memory.logisticsDelivered || 0) + delivered;
    creep.memory.logisticsRemaining = Math.max(0, creep.memory.logisticsRemaining - delivered);
    delete creep.memory.logisticsPendingDelivery;
}

function destination(creep) {
    return creep && creep.memory && (creep.memory.destinationRoom || creep.memory.homeRoom) || null;
}

module.exports = { assign: assign, clear: clear, destination: destination, reconcileDelivery: reconcileDelivery };
