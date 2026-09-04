/* Compact explicit transport-job plumbing. Automatic HOME balancing is intentionally out of scope. */
function assign(creep, job) {
    if (!creep || !creep.memory || !job || !job.originRoom || !job.destinationRoom) return false;
    creep.memory.freighterJob = 'transport';
    creep.memory.originRoom = job.originRoom;
    creep.memory.pickupRoom = job.originRoom;
    creep.memory.destinationRoom = job.destinationRoom;
    creep.memory.resourceType = job.resourceType || RESOURCE_ENERGY;
    creep.memory.logisticsAmount = Math.max(0, job.amount || 0);
    creep.memory.logisticsPurpose = job.purpose || 'HOME_TRANSFER';
    creep.memory.logisticsPriority = job.priority || 0;
    if (job.pickupTargetId) creep.memory.pickupTargetId = job.pickupTargetId;
    return true;
}

function clear(creep) {
    if (!creep || !creep.memory) return;
    var fields = ['freighterJob', 'originRoom', 'pickupRoom', 'pickupSourceId', 'pickupTargetId',
        'pickupTargetType', 'destinationRoom', 'resourceType', 'logisticsAmount',
        'logisticsPurpose', 'logisticsPriority', 'freighterReservedCarry',
        'freighterReservedUntil', 'remoteTrip'];
    for (var i = 0; i < fields.length; i++) delete creep.memory[fields[i]];
}

function destination(creep) {
    return creep && creep.memory && (creep.memory.destinationRoom || creep.memory.homeRoom) || null;
}

module.exports = { assign: assign, clear: clear, destination: destination };
