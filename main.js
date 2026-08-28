const Bootstrap = require('Tick.Bootstrap');
const Planning = require('Tick.Planning');
const Rooms = require('Tick.Rooms');
const Creeps = require('Tick.Creeps');
const Finalize = require('Tick.Finalize');
const Telemetry = require('HiveMind.Telemetry');

/*
 * This conductor owns phase order, not subsystem policy. Roles and managers
 * choose destinations, utility.Travel.Creep registers movement intents, and
 * the final traffic pass performs creep.move after every actor has run.
 */
module.exports.loop = function loop() {
    Telemetry.startTick();
    Telemetry.measure('bootstrapIndex', () => Bootstrap.run());
    Telemetry.measure('combat', () => Planning.refreshIntelAndThreats());
    Telemetry.measure('planning', () => Planning.runStrategy());
    const spawnReport = Telemetry.measure('spawnPlanning', () => Planning.generateSpawnRequests());
    Telemetry.measure('spawnPlanning', () => Planning.runSpawning(spawnReport));
    Telemetry.measure('roomStructures', () => Rooms.runStructures());
    Telemetry.measure('creepExecution', () => Creeps.run());
    Telemetry.measure('traffic', () => Finalize.resolveTraffic());
    Telemetry.measure('visuals', () => Finalize.runOptionalWork());
    Telemetry.finish();
};
