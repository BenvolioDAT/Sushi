const TickIndex = require('HiveMind.Index');

function plannedPosition(room, key, sourceId) {
    const plan = Memory.rooms && Memory.rooms[room.name] &&
        Memory.rooms[room.name].structurePlanner && Memory.rooms[room.name].structurePlanner.plan;
    if (!plan || !plan.links) return null;
    return sourceId ? plan.links.sources && plan.links.sources[sourceId] : plan.links[key];
}

function closestLink(links, plain) {
    if (!plain) return null;
    return links.slice().sort((a, b) => {
        const ar = Math.max(Math.abs(a.pos.x - plain.x), Math.abs(a.pos.y - plain.y));
        const br = Math.max(Math.abs(b.pos.x - plain.x), Math.abs(b.pos.y - plain.y));
        return ar - br || String(a.id).localeCompare(String(b.id));
    })[0] || null;
}

function energy(link) {
    if (!link || !link.store) return 0;
    return typeof link.store.getUsedCapacity === 'function' ?
        link.store.getUsedCapacity(RESOURCE_ENERGY) || 0 : link.store[RESOURCE_ENERGY] || 0;
}

function free(link) {
    if (!link || !link.store) return 0;
    return typeof link.store.getFreeCapacity === 'function' ?
        link.store.getFreeCapacity(RESOURCE_ENERGY) || 0 : Math.max(0, (link.storeCapacity || 800) - energy(link));
}

function classify(room, links) {
    const storage = closestLink(links, plannedPosition(room, 'storage')) ||
        (room.storage ? links.slice().sort((a, b) => a.pos.getRangeTo(room.storage) - b.pos.getRangeTo(room.storage))[0] : null);
    const controller = closestLink(links.filter(link => link !== storage), plannedPosition(room, 'controller')) ||
        (room.controller ? links.filter(link => link !== storage)
            .sort((a, b) => a.pos.getRangeTo(room.controller) - b.pos.getRangeTo(room.controller))[0] : null);
    const sourceIds = Object.keys(Memory.rooms && Memory.rooms[room.name] &&
        Memory.rooms[room.name].structurePlanner && Memory.rooms[room.name].structurePlanner.plan &&
        Memory.rooms[room.name].structurePlanner.plan.links &&
        Memory.rooms[room.name].structurePlanner.plan.links.sources || {});
    const used = new Set([storage, controller].filter(Boolean).map(link => link.id));
    const sources = [];
    for (const sourceId of sourceIds) {
        const link = closestLink(links.filter(candidate => !used.has(candidate.id)), plannedPosition(room, null, sourceId));
        if (link) {
            used.add(link.id);
            sources.push(link);
        }
    }
    for (const link of links) if (!used.has(link.id)) sources.push(link);
    return { storage, controller, sources };
}

function send(sender, receiver) {
    if (!sender || !receiver || sender.cooldown > 0 || energy(sender) <= 0 || free(receiver) <= 0) return null;
    const amount = Math.min(energy(sender), free(receiver));
    const result = sender.transferEnergy(receiver, amount);
    return { sender: sender.id, receiver: receiver.id, amount, result };
}

function run(room) {
    const byType = TickIndex.get().structuresByRoom.get(room.name);
    const links = byType && byType.get(STRUCTURE_LINK) || [];
    if (links.length < 2) return { roomName: room.name, transfers: [] };
    const roles = classify(room, links);
    const transfers = [];
    for (const source of roles.sources.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
        const target = roles.storage && free(roles.storage) > 0 ? roles.storage : roles.controller;
        const transfer = send(source, target);
        if (transfer) transfers.push(transfer);
    }
    const energyRatio = (room.energyAvailable || 0) / Math.max(1, room.energyCapacityAvailable || 1);
    if (transfers.length === 0 && energyRatio >= 0.5 && roles.controller && energy(roles.controller) < 400) {
        const transfer = send(roles.storage, roles.controller);
        if (transfer) transfers.push(transfer);
    }
    return {
        roomName: room.name,
        roles: {
            storage: roles.storage && roles.storage.id || null,
            controller: roles.controller && roles.controller.id || null,
            sources: roles.sources.map(link => link.id)
        },
        transfers
    };
}

module.exports = { run, classify, energy, free };
