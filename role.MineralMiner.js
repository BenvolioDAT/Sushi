const travel = require('utility.Travel.Creep');

function findDeposit(creep, mineral) {
    const structures = mineral.pos.findInRange(FIND_STRUCTURES, 2, {
        filter: structure => [STRUCTURE_CONTAINER, STRUCTURE_STORAGE, STRUCTURE_TERMINAL].includes(structure.structureType) &&
            structure.store && structure.store.getFreeCapacity(creep.memory.mineralType) > 0
    });
    return structures.sort((a, b) => a.pos.getRangeTo(mineral) - b.pos.getRangeTo(mineral) || String(a.id).localeCompare(String(b.id)))[0] || null;
}

function run(creep) {
    if (!creep || creep.spawning) return;
    const mineral = creep.memory.mineralId && Game.getObjectById(creep.memory.mineralId);
    if (!mineral) {
        creep.memory.mineralState = 'missingMineral';
        return;
    }
    creep.memory.mineralType = mineral.mineralType;
    const carried = creep.store[mineral.mineralType] || 0;
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

module.exports = { run, findDeposit };
