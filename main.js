const Bootstrap = require('Tick.Bootstrap');
const Planning = require('Tick.Planning');
const Rooms = require('Tick.Rooms');
const Creeps = require('Tick.Creeps');
const Finalize = require('Tick.Finalize');

/*
 * This conductor owns phase order, not subsystem policy. Roles and managers
 * choose destinations, utility.Travel.Creep registers movement intents, and
 * the final traffic pass performs creep.move after every actor has run.
 */
module.exports.loop = function loop() {
    Bootstrap.run();
    Planning.refreshIntelAndThreats();
    Planning.runStrategy();
    const spawnReport = Planning.generateSpawnRequests();
    Planning.runSpawning(spawnReport);
    Rooms.runStructures();
    Creeps.run();
    Finalize.resolveTraffic();
    Finalize.runOptionalWork();
};
