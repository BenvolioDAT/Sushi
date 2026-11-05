const Bootstrap = require('Tick.Bootstrap');
const Planning = require('Tick.Planning');
const Rooms = require('Tick.Rooms');
const Creeps = require('Tick.Creeps');
const Finalize = require('Tick.Finalize');
const Telemetry = require('HiveMind.Telemetry');
const Diagnostics = require('Diagnostics');
const DiagnosticView = require('Diagnostics.View');
const ResourceManager = require('Resource.Manager');

/* Phase order remains fixed. An independent phase failure leaves traffic and
 * final telemetry reachable. Bootstrap failure stops dependent work this tick. */
module.exports.loop = function loop() {
    Diagnostics.install(DiagnosticView.room, Telemetry.getView);
    Telemetry.startTick();
    Telemetry.measure('diagnostics', () => Diagnostics.begin());
    function phase(name, fn) {
        try { return Telemetry.measure(name, fn); }
        catch (error) { Diagnostics.exception('SUBSYSTEM_EXCEPTION', null, error, name); return null; }
    }
    try {
        let bootstrapped = false;
        phase('bootstrapIndex', () => { Bootstrap.run(); bootstrapped = true; });
        if (!bootstrapped) return;
        phase('combat', () => Planning.refreshIntelAndThreats());
        phase('planning', () => Planning.runStrategy());
        const spawnReport = phase('spawnPlanning', () => Planning.generateSpawnRequests());
        phase('spawnPlanning', () => Planning.runSpawning(spawnReport));
        phase('roomStructures', () => Rooms.runStructures());
        phase('creepExecution', () => Creeps.run());
        phase('traffic', () => Finalize.resolveTraffic());
        phase('visuals', () => Finalize.runOptionalWork());
    } finally {
        // Both operations have independent boundaries; storage never prevents telemetry.
        if (Game.time % 25 === 0 && Diagnostics.config().mode !== 'OFF') {
            phase('diagnostics', () => Diagnostics.observeJobs(ResourceManager.jobDiagnostics()));
        }
        phase('diagnostics', () => Diagnostics.finish({ total: Game.cpu?.getUsed ? Game.cpu.getUsed() : 0 }));
        phase('telemetry', () => Telemetry.finish());
    }
};
