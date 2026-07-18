const TickBootstrap = require('Tick.Bootstrap');
const TickPlanning = require('Tick.Planning');
const TickCreeps = require('Tick.Creeps');
const TickRooms = require('Tick.Rooms');
const TickFinalize = require('Tick.Finalize');

/* Screeps calls this once per tick; details live in cohesive phase modules. */
module.exports.loop = function () {
    TickBootstrap.run();
    TickPlanning.runMaintenanceAndPlanning();
    const requestReport = TickPlanning.generateSpawnRequests();
    TickPlanning.runSpawning(requestReport);
    TickCreeps.run();
    TickRooms.run();
    TickFinalize.resolveTraffic();
    TickFinalize.drawVisuals();
    TickFinalize.cleanDeadCreepMemory();
};
