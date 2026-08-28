const TowerLogic = require('Logic.Tower');
const utilityVisual = require('utility.Visual');

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
    for (const roomName of Object.keys(Game.rooms)) {
        const room = Game.rooms[roomName];
        if (room.controller && room.controller.my) {
            TowerLogic.run(room);
            if (Game.time % 10 === 0) updateRepairStructureMemory(room);
        }
    }
}

function drawSourceFlags() {
    for (const roomName of Object.keys(Game.rooms)) utilityVisual.drawSourceFlags(roomName);
}

module.exports = { runStructures, drawSourceFlags, updateRepairStructureMemory };
