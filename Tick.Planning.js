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

function isWarRoomEnabled() {
    if (!Memory.settings) Memory.settings = {};
    if (Memory.settings.useWarRoom === undefined) Memory.settings.useWarRoom = false;
    return Memory.settings.useWarRoom === true;
}

function refreshIntelAndThreats() {
    ThreatLedger.run();
    if (isWarRoomEnabled()) Scheduler.run('emergencyDefense', () => WarRoom.run(), { emergency: true });
}

function runStrategy() {
    Telemetry.measure('remotePlanning', () => {
        Scheduler.run('remotePlanning', () => RemotePlanner.run(), { interval: 5 });
    });
    Scheduler.run('roomPlanning', () => PlannerBrain.run(), { interval: 3 });
    Scheduler.run('roadPlanning', () => RoadPlanner.run(), { interval: 5 });
    Telemetry.measure('hiveMindStrategy', () => {
        HiveStrategy.run();
    });
}

function generateSpawnRequests() {
    SquadController.plan();
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
    for (const roomName of Object.keys(requestReport.rooms)) spawnManager.runRoom(roomName);
}

module.exports = {
    refreshIntelAndThreats,
    runStrategy,
    generateSpawnRequests,
    runSpawning,
    isWarRoomEnabled
};
