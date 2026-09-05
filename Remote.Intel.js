/* Volatile room intel ages independently of durable source/ownership records. */
function request(roomName, reason, priority) {
    if (!roomName) return;
    var memory = Memory.rooms[roomName] || (Memory.rooms[roomName] = {});
    if (memory.intelRefreshRequestedAt === undefined) memory.intelRefreshRequestedAt = Game.time;
    if ((priority || 1) >= (memory.intelPriority || 0)) memory.intelRefreshReason = reason;
    memory.intelPriority = Math.max(memory.intelPriority || 0, priority || 1);
}

function refresh(room) {
    if (!room) return;
    var memory = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
    var controller = room.controller;
    if (!controller) memory.controller = null;
    else {
        var saved = memory.controller || {};
        saved.id = controller.id;
        saved.pos = controller.pos && { x: controller.pos.x, y: controller.pos.y, roomName: room.name };
        saved.owner = controller.owner && controller.owner.username || null;
        saved.my = controller.my === true;
        saved.level = controller.level || 0;
        saved.lastObservedAt = Game.time;
        saved.reservation = controller.reservation ? {
            username: controller.reservation.username, ticksToEnd: controller.reservation.ticksToEnd,
            observedAt: Game.time
        } : null;
        delete saved.ownershipIntelStale;
        memory.controller = saved;
    }
    memory.lastIntelRefreshAt = Game.time;
    delete memory.intelRefreshRequestedAt;
    delete memory.intelRefreshReason;
    delete memory.intelPriority;
}

function getEffectiveReservation(roomName) {
    if (Game.rooms[roomName]) refresh(Game.rooms[roomName]);
    var memory = Memory.rooms[roomName];
    var controller = memory && memory.controller;
    var saved = controller && controller.reservation;
    if (!saved) return null;
    var observedAt = typeof saved === 'object' && saved.observedAt !== undefined ? saved.observedAt :
        controller.lastObservedAt !== undefined ? controller.lastObservedAt : memory.lastIntelRefreshAt;
    // Untimed legacy snapshots cannot safely promise future reservation duration.
    if (observedAt === undefined) {
        request(roomName, 'RESERVATION_INTEL_UNTIMED', 80);
        return null;
    }
    var remaining = Math.max(0, (typeof saved === 'object' ? saved.ticksToEnd : controller.ticksToEnd) -
        Math.max(0, Game.time - observedAt)) || 0;
    if (!Game.rooms[roomName] && remaining < 1000) request(roomName, 'RESERVATION_EXPIRING', 70);
    return remaining > 0 ? { username: typeof saved === 'string' ? saved : saved.username,
        ticksToEnd: remaining, observedAt: observedAt } : null;
}

function controller(roomName) {
    var reservation = getEffectiveReservation(roomName);
    var saved = Memory.rooms[roomName] && Memory.rooms[roomName].controller;
    if (!saved) return null;
    if (!Game.rooms[roomName] && saved.owner &&
        (saved.lastObservedAt === undefined || Game.time - saved.lastObservedAt >= 500)) {
        saved.ownershipIntelStale = true;
        request(roomName, 'STALE_CONTROLLER_OWNERSHIP', 100);
    }
    return Object.assign({}, saved, { reservation: reservation });
}

module.exports = { request: request, refresh: refresh, controller: controller, getEffectiveReservation: getEffectiveReservation };
