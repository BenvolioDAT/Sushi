const WarRoom = require('Logic.WarRoom');
const ExpansionLogic = require('Logic.Expansion');
const Season11 = require('Logic.Season11');
const spawnManager = require('spawn.manager');
const spawnRequestManager = require('spawn.request.manager');
const RemotePlanner = require('Planner.Remote');
const PlannerBrain = require('Planner.Brain');
const RoadPlanner = require('Planner.Roads');

function isWarRoomEnabled() {
    if (!Memory.settings) Memory.settings = {};
    if (Memory.settings.useWarRoom === undefined) Memory.settings.useWarRoom = false;
    return Memory.settings.useWarRoom === true;
}

function refreshIntelAndThreats() {
    if (isWarRoomEnabled()) WarRoom.run();
}

function runStrategy() {
    RemotePlanner.run();
    PlannerBrain.run();
    RoadPlanner.run();
    ExpansionLogic.run();
    Season11.run();
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
