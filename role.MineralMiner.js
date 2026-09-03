const travel = require('utility.Travel.Creep');
const Season11 = require('Logic.Season11');

function migrateThoriumMiner(creep, mineral) {
    const thorium = Season11.getThoriumResourceType();
    if (!Season11.isOperatingMode() || !thorium || !mineral || mineral.mineralType !== thorium) return false;
    const assignments = Season11.ensureMemory().assignments.mining || {};
    const assignment = Object.values(assignments).find(item => item &&
        (item.mineralId === mineral.id || item.roomName === creep.room.name));
    if (!assignment || !assignment.stagingId) return false;
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
            retireAsCourier(creep);
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
        if (carried > 0) {
            const deposit = findDeposit(creep, mineral);
            if (deposit) {
                const result = creep.transfer(deposit, thorium);
                if (result === ERR_NOT_IN_RANGE) travel.move(creep, deposit, { range: 1, trafficPriority: 35 });
                creep.memory.mineralState = 'retiringThoriumCargo';
                return;
            }
            creep.memory.mineralState = 'waitingToRetireThoriumCargo';
            return;
        }
        retireAsCourier(creep);
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

module.exports = { run, findDeposit, migrateThoriumMiner, retireAsCourier };
