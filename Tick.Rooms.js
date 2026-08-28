const TowerLogic = require('Logic.Tower');
const utilityVisual = require('utility.Visual');
const TickIndex = require('HiveMind.Index');
const SafeModePolicy = require('SafeMode.Policy');
const ResourceManager = require('Resource.Manager');

function updateRepairStructureMemory(room) {
    if (!room) return;
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
    const ids = room.find(FIND_STRUCTURES, {
        filter: structure => structure.hits < structure.hitsMax
    }).map(structure => structure.id);
    const previous = Memory.rooms[room.name].RepairStructure;
    if (!previous || previous.length !== ids.length || previous.some((id, index) => id !== ids[index])) {
        Memory.rooms[room.name].RepairStructure = ids;
    }
}

function runStructures() {
    for (const room of TickIndex.get().ownedRooms) {
        TowerLogic.run(room);
        SafeModePolicy.run(room);
        ResourceManager.runRoom(room);
        if (Game.time % 10 === 0) updateRepairStructureMemory(room);
    }
    ResourceManager.runEmpireStructures();
}

function drawSourceFlags() {
    for (const room of TickIndex.get().visibleRooms) utilityVisual.drawSourceFlags(room.name);
}

module.exports = { runStructures, drawSourceFlags, updateRepairStructureMemory };
