const HiveMemory = require('HiveMind.Memory');
const TickIndex = require('HiveMind.Index');
const DemandBoard = require('Spawn.DemandBoard');
const Season11Adapter = require('Season11.Adapter');

function isDedicatedThorium(resourceType) {
    const thorium = Season11Adapter.resourceType();
    return Season11Adapter.isAvailable() && thorium !== null && resourceType === thorium;
}

function cancelGenericDemands(roomName) {
    DemandBoard.cancel(`mineral:${roomName}:MineralMiner`);
    DemandBoard.cancel(`mineral:${roomName}:ResourceCourier`);
}

function stateFor(roomName) {
    const rooms = HiveMemory.ensure().resources.rooms;
    if (!rooms[roomName]) rooms[roomName] = { roomName, mineral: null, jobs: [] };
    return rooms[roomName];
}

function amount(store, resourceType) {
    if (!store) return 0;
    return typeof store.getUsedCapacity === 'function' ? store.getUsedCapacity(resourceType) || 0 : store[resourceType] || 0;
}

function free(store, resourceType) {
    if (!store) return 0;
    return typeof store.getFreeCapacity === 'function' ? store.getFreeCapacity(resourceType) || 0 : 0;
}

function mineralInRoom(room) {
    if (!room || typeof room.find !== 'function') return null;
    return (room.find(FIND_MINERALS) || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] || null;
}

function extractorFor(roomName, mineral) {
    const byType = TickIndex.get().structuresByRoom.get(roomName);
    return (byType && byType.get(STRUCTURE_EXTRACTOR) || []).find(extractor =>
        extractor.pos && mineral.pos && extractor.pos.x === mineral.pos.x && extractor.pos.y === mineral.pos.y) || null;
}

function mineralContainer(roomName, mineral) {
    const byType = TickIndex.get().structuresByRoom.get(roomName);
    return (byType && byType.get(STRUCTURE_CONTAINER) || []).filter(container =>
        container.pos && mineral.pos && container.pos.getRangeTo(mineral) <= 2)
        .sort((a, b) => a.pos.getRangeTo(mineral) - b.pos.getRangeTo(mineral) || String(a.id).localeCompare(String(b.id)))[0] || null;
}

function hasDepositCapacity(room, resourceType) {
    return [room.terminal, room.storage].some(structure => structure && free(structure.store, resourceType) >= 1000);
}

function observe(room) {
    const state = stateFor(room.name);
    const mineral = mineralInRoom(room);
    if (!mineral) {
        state.mineral = null;
        state.updatedTick = Game.time;
        return state;
    }
    const extractor = extractorFor(room.name, mineral);
    const container = mineralContainer(room.name, mineral);
    const depleted = mineral.mineralAmount <= 0;
    const constrained = !hasDepositCapacity(room, mineral.mineralType);
    const seasonal = isDedicatedThorium(mineral.mineralType);
    state.mineral = {
        id: mineral.id,
        mineralType: mineral.mineralType,
        roomName: room.name,
        pos: { x: mineral.pos.x, y: mineral.pos.y, roomName: room.name },
        amount: mineral.mineralAmount,
        density: mineral.density || null,
        ticksToRegeneration: mineral.ticksToRegeneration || null,
        extractorId: extractor && extractor.id || null,
        containerId: container && container.id || null,
        depleted,
        storageConstrained: constrained,
        active: !seasonal && !!extractor && !depleted && !constrained,
        seasonalDedicated: seasonal,
        lastSeen: Game.time,
        debugReason: seasonal ? 'Thorium reserved for the dedicated Season 11 pipeline' :
            !extractor ? 'Waiting for planned extractor' :
            depleted ? 'Mineral depleted until regeneration' :
                constrained ? 'Storage and terminal constrained' : 'Mineral extraction active'
    };
    if (seasonal) cancelGenericDemands(room.name);
    state.updatedTick = Game.time;
    return state;
}

function emitDemands(room, state) {
    const mineral = state && state.mineral;
    if (!mineral || isDedicatedThorium(mineral.mineralType)) {
        if (room && room.name) cancelGenericDemands(room.name);
        return [];
    }
    const operationId = `mineral:${room.name}`;
    const demands = [];
    if (mineral.active) {
        demands.push(DemandBoard.emit({
            id: `${operationId}:MineralMiner`, operationId, role: 'MineralMiner', count: 1,
            priority: 32, originRoom: room.name, preferredSpawnRoom: room.name, targetRoom: room.name,
            replacementBuffer: 75, validUntil: Game.time + 30,
            memory: { mineralId: mineral.id, mineralType: mineral.mineralType, extractorId: mineral.extractorId, containerId: mineral.containerId },
            reason: mineral.debugReason
        }));
    }
    const container = mineral.containerId && Game.getObjectById(mineral.containerId);
    if (mineral.active || container && amount(container.store, mineral.mineralType) > 0) {
        demands.push(DemandBoard.emit({
            id: `${operationId}:ResourceCourier`, operationId, role: 'ResourceCourier', count: 1,
            priority: 34, originRoom: room.name, preferredSpawnRoom: room.name, targetRoom: room.name,
            replacementBuffer: 60, validUntil: Game.time + 30,
            memory: { mineralId: mineral.id, mineralType: mineral.mineralType },
            reason: 'Mineral and room resource hauling'
        }));
    }
    return demands;
}

function jobs(room, state) {
    const mineral = state && state.mineral;
    if (!mineral || isDedicatedThorium(mineral.mineralType) || !mineral.containerId) return [];
    const container = Game.getObjectById(mineral.containerId);
    const stored = container && amount(container.store, mineral.mineralType);
    if (!stored) return [];
    const target = [room.terminal, room.storage].find(structure => structure && free(structure.store, mineral.mineralType) > 0);
    if (!target) return [];
    return [{
        id: `mineral-haul:${room.name}:${mineral.mineralType}`,
        type: 'TRANSFER', roomName: room.name, resourceType: mineral.mineralType,
        amount: stored, sourceId: container.id, targetId: target.id,
        priority: 60, reason: 'Move harvested mineral to owned terminal/storage'
    }];
}

function plan() {
    const report = [];
    for (const room of TickIndex.get().ownedRooms) {
        if (!room.controller || room.controller.level < 6) continue;
        const state = observe(room);
        emitDemands(room, state);
        report.push(state);
    }
    return report;
}

module.exports = {
    stateFor, mineralInRoom, extractorFor, mineralContainer, observe, emitDemands, jobs, plan,
    isDedicatedThorium, cancelGenericDemands
};
