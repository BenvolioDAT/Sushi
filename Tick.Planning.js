const WarRoom = require('Logic.WarRoom');
const ExpansionLogic = require('Logic.Expansion');
const Season11 = require('Logic.Season11');
const spawnManager = require('spawn.manager');
const spawnRequestManager = require('spawn.request.manager');
const RemotePlanner = require('Planner.Remote');
const PlannerBrain = require('Planner.Brain');
const RoadPlanner = require('Planner.Roads');
const Scheduler = require('HiveMind.Scheduler');
const Telemetry = require('HiveMind.Telemetry');
const ThreatLedger = require('Combat.ThreatLedger');

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
        Scheduler.run('expansionStrategy', () => ExpansionLogic.run(), { interval: 17 });
        Scheduler.run('season11Operations', () => Season11.run(), { interval: 1 });
    });
}

function generateSpawnRequests() {
    return spawnRequestManager.run();
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
