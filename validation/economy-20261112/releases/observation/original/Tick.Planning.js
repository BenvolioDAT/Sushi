const WarRoom = require('Logic.WarRoom');
const spawnManager = require('spawn.manager');
const spawnRequestManager = require('spawn.request.manager');
const RemotePlanner = require('Planner.Remote');
const PlannerBrain = require('Planner.Brain');
const RoadPlanner = require('Planner.Roads');
const Scheduler = require('HiveMind.Scheduler');
const Telemetry = require('HiveMind.Telemetry');
const ThreatLedger = require('Combat.ThreatLedger');
const HiveStrategy = require('HiveMind.Strategy');
const DemandBoard = require('Spawn.DemandBoard');
const SquadController = require('Squad.Controller');
const ResourceManager = require('Resource.Manager');
const Economy = require('HiveMind.Economy');
const HiveMemory = require('HiveMind.Memory');
const ColonyState = require('HiveMind.ColonyState');
const PowerManager = require('Power.Manager');
const KeeperOperations = require('Keeper.Operations');
const NpcOperations = require('NPC.Operations');

function isWarRoomEnabled() {
    return HiveMemory.getConfig('combat').useWarRoom === true;
}

function refreshIntelAndThreats() {
    ThreatLedger.run();
    if (isWarRoomEnabled()) Scheduler.run('emergencyDefense', () => WarRoom.run(), { emergency: true });
}

function runStrategy() {
    /* Economy is sampled first so every planner and demand emitter shares one policy. */
    Telemetry.measure('economy', () => Economy.run());
    Telemetry.measure('colonyState', () => ColonyState.run());
    Telemetry.measure('capacity', () => require('HiveMind.Capacity').get());
    Telemetry.measure('npcOperations', () => { KeeperOperations.run(); NpcOperations.run(); });
    Telemetry.measure('remotePlanning', () => {
        Scheduler.run('remotePlanning', () => RemotePlanner.run(), { interval: 5 });
    });
    Telemetry.measure('roomPlanning', () => Scheduler.run('roomPlanning', () => PlannerBrain.run(), { interval: 3 }));
    Telemetry.measure('roadPlanning', () => Scheduler.run('roadPlanning', () => RoadPlanner.run(), { interval: 5 }));
    Telemetry.measure('hiveMindStrategy', () => {
        HiveStrategy.run();
    });
}

function generateSpawnRequests() {
    SquadController.plan();
    PowerManager.plan();
    ResourceManager.plan();
    const report = spawnRequestManager.run();
    const board = DemandBoard.flush();
    if (!report.rooms) report.rooms = {};
    for (const roomName of Object.keys(board.rooms)) {
        if (!report.rooms[roomName]) report.rooms[roomName] = { roomName, demandBoardOnly: true };
    }
    report.demandBoard = board;
    return report;
}

function runSpawning(requestReport) {
    if (!requestReport || !requestReport.rooms) return;
    for (const roomName of Object.keys(requestReport.rooms)) {
        try { requestReport.rooms[roomName].spawnResult = spawnManager.runRoom(roomName); }
        catch (error) { require('Diagnostics').exception('SPAWN_SUBSYSTEM_FAILED', roomName, error, 'spawnManager'); }
    }
}

module.exports = {
    refreshIntelAndThreats,
    runStrategy,
    generateSpawnRequests,
    runSpawning,
    isWarRoomEnabled
};
