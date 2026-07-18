const TowerLogic = require('Logic.Tower');
const WarRoom = require('Logic.WarRoom');
const ExpansionLogic = require('Logic.Expansion');
const spawnManager = require('spawn.manager');
const spawnRequestManager = require('spawn.request.manager');
const RemotePlanner = require('Planner.Remote');
const PlannerBrain = require('Planner.Brain');
const RoadPlanner = require('Planner.Roads');

function ensureWarRoomSetting() {
    if (!Memory.settings) {
        Memory.settings = {};
    }
    if (Memory.settings.useWarRoom === undefined) {
        Memory.settings.useWarRoom = false;
    }
    return Memory.settings.useWarRoom === true;
}

function updateRepairStructureMemory(room) {
    if (!room) {
        return;
    }
    if (!Memory.rooms) {
        Memory.rooms = {};
    }
    if (!Memory.rooms[room.name]) {
        Memory.rooms[room.name] = {};
    }

    const damagedStructures = room.find(FIND_STRUCTURES, {
        filter: function (structure) {
            return structure.hits < structure.hitsMax;
        }
    });
    Memory.rooms[room.name].RepairStructure = damagedStructures.map(function (structure) {
        return structure.id;
    });
}

function runMaintenanceAndPlanning() {
    if (ensureWarRoomSetting()) {
        WarRoom.run();
    }

    RemotePlanner.run();
    PlannerBrain.run();
    RoadPlanner.run();

    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room.controller || !room.controller.my) {
            continue;
        }
        TowerLogic.run(room);
        if (Game.time % 10 === 0) {
            updateRepairStructureMemory(room);
        }
    }
}

function generateSpawnRequests() {
    ExpansionLogic.run();
    return spawnRequestManager.run();
}

function runSpawning(requestReport) {
    if (!requestReport || !requestReport.rooms) {
        return;
    }
    for (const roomName in requestReport.rooms) {
        if (requestReport.rooms.hasOwnProperty(roomName)) {
            spawnManager.runRoom(roomName);
        }
    }
}

module.exports = {
    runMaintenanceAndPlanning: runMaintenanceAndPlanning,
    generateSpawnRequests: generateSpawnRequests,
    runSpawning: runSpawning,
    updateRepairStructureMemory: updateRepairStructureMemory
};
