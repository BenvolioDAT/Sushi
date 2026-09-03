const travel = require('utility.Travel.Creep');
const Season11 = require('Logic.Season11');

function migrateThoriumMiner(creep, mineral) {
    const thorium = Season11.getThoriumResourceType();
    if (!Season11.isOperatingMode() || !thorium || !mineral || mineral.mineralType !== thorium) return false;
    const assignments = Season11.ensureMemory().assignments.mining || {};
    const assignment = Object.values(assignments).find(item => item && item.mineralId === mineral.id);
    const staging = assignment && assignment.stagingId && Game.getObjectById(assignment.stagingId);
    if (!assignment || assignment.ready !== true || assignment.depleted === true ||
        !(Number(assignment.remaining) > 0) || assignment.mineralId !== mineral.id ||
        !mineral.pos || mineral.pos.roomName !== assignment.roomName ||
        !isValidOwnedStaging(staging, assignment.roomName, thorium)) return false;
    creep.memory.role = 'ThoriumMiner';
    creep.memory.season11AssignmentKey = assignment.key;
    creep.memory.season11SourceRoom = assignment.roomName;
    creep.memory.season11MineralId = assignment.mineralId;
    creep.memory.season11StagingId = assignment.stagingId;
    creep.memory.season11RouteDistance = assignment.routeDistance;
    delete creep.memory.mineralId;
    delete creep.memory.mineralType;
    creep.memory.mineralState = 'migratedToSeason11';
    return true;
}

function retireAsCourier(creep) {
    creep.memory.role = 'ResourceCourier';
    delete creep.memory.demandId;
    delete creep.memory.operationId;
    delete creep.memory.resourceJobId;
    delete creep.memory.mineralId;
    delete creep.memory.mineralType;
    creep.memory.resourceCourierState = 'retiredGenericThoriumMiner';
}

function isValidOwnedStaging(structure, roomName, resourceType) {
    if (!structure || !structure.store || !structure.pos || structure.pos.roomName !== roomName ||
        structure.my === false) return false;
    const room = Game.rooms && Game.rooms[roomName];
    if (!room || !room.controller || !room.controller.my) return false;
    const validTypes = [STRUCTURE_CONTAINER, STRUCTURE_STORAGE, STRUCTURE_TERMINAL];
    if (!validTypes.includes(structure.structureType)) return false;
    return typeof structure.store.getFreeCapacity !== 'function' ||
        structure.store.getFreeCapacity(resourceType) > 0;
}

function findThoriumRetirementDeposit(creep, resourceType) {
    const assignments = Season11.ensureMemory().assignments.mining || {};
    const staging = Object.values(assignments).map(item => ({
        assignment: item,
        structure: item && item.stagingId && Game.getObjectById(item.stagingId)
    })).find(item => item.assignment &&
        isValidOwnedStaging(item.structure, item.assignment.roomName, resourceType));
    if (staging) return staging.structure;
    const rooms = Object.values(Game.rooms || {}).filter(room => room && room.controller &&
        room.controller.my && room.storage && room.storage.my !== false && room.storage.store &&
        (typeof room.storage.store.getFreeCapacity !== 'function' ||
            room.storage.store.getFreeCapacity(resourceType) > 0));
    rooms.sort((a, b) => (a.name === creep.room.name ? -1 : 0) -
        (b.name === creep.room.name ? -1 : 0) || a.name.localeCompare(b.name));
    return rooms[0] && rooms[0].storage || null;
}

function retireThoriumMiner(creep, resourceType) {
    retireAsCourier(creep);
    if (!resourceType || !(creep.store[resourceType] > 0)) return;
    const deposit = findThoriumRetirementDeposit(creep, resourceType);
    if (!deposit) {
        creep.memory.resourceCourierState = 'waitingToRetireThoriumCargo';
        return;
    }
    const result = creep.transfer(deposit, resourceType);
    if (result === ERR_NOT_IN_RANGE) travel.move(creep, deposit, { range: 1, trafficPriority: 45 });
    creep.memory.resourceCourierState = 'returningThoriumToSeason11';
}

function findDeposit(creep, mineral) {
    const structures = mineral.pos.findInRange(FIND_STRUCTURES, 2, {
        filter: structure => [STRUCTURE_CONTAINER, STRUCTURE_STORAGE, STRUCTURE_TERMINAL].includes(structure.structureType) &&
            structure.store && structure.store.getFreeCapacity(creep.memory.mineralType) > 0
    });
    return structures.sort((a, b) => a.pos.getRangeTo(mineral) - b.pos.getRangeTo(mineral) || String(a.id).localeCompare(String(b.id)))[0] || null;
}

function run(creep) {
    if (!creep || creep.spawning) return;
    const thoriumType = Season11.getThoriumResourceType();
    const mineral = creep.memory.mineralId && Game.getObjectById(creep.memory.mineralId);
    if (!mineral) {
        if (Season11.isApiAvailable() && thoriumType && creep.memory.mineralType === thoriumType) {
            retireThoriumMiner(creep, thoriumType);
            return;
        }
        creep.memory.mineralState = 'missingMineral';
        return;
    }
    creep.memory.mineralType = mineral.mineralType;
    const carried = creep.store[mineral.mineralType] || 0;
    const thorium = Season11.getThoriumResourceType();
    if (Season11.isApiAvailable() && thorium && mineral.mineralType === thorium) {
        if (migrateThoriumMiner(creep, mineral)) return;
        retireThoriumMiner(creep, thorium);
        return;
    }
    if (carried > 0 && (creep.store.getFreeCapacity() === 0 || mineral.mineralAmount <= 0)) {
        const deposit = findDeposit(creep, mineral);
        if (!deposit) {
            creep.memory.mineralState = 'waitingForDepositCapacity';
            return;
        }
        const result = creep.transfer(deposit, mineral.mineralType);
        if (result === ERR_NOT_IN_RANGE) travel.move(creep, deposit, { range: 1, trafficPriority: 35 });
        creep.memory.mineralState = 'depositing';
        return;
    }
    if (mineral.mineralAmount <= 0) {
        creep.memory.mineralState = 'depleted';
        if (typeof creep.setTrafficLock === 'function') creep.setTrafficLock(true);
        return;
    }
    const result = creep.harvest(mineral);
    if (result === ERR_NOT_IN_RANGE) travel.move(creep, mineral, { range: 1, trafficPriority: 35 });
    else if (result === OK) {
        creep.memory.mineralState = 'harvesting';
        if (typeof creep.setWorkingArea === 'function') creep.setWorkingArea(mineral.pos, 1);
    }
    else creep.memory.mineralState = `harvest:${result}`;
}

module.exports = {
    run, findDeposit, migrateThoriumMiner, retireAsCourier,
    findThoriumRetirementDeposit, isValidOwnedStaging
};
