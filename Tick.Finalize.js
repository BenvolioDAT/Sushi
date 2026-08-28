const trafficManager = require('traffic_manager');
const Dashboard = require('Visual.Dashboard');
const StructurePlannerVisual = require('Visual.Planner.Structures');
const Rooms = require('Tick.Rooms');

const TRAFFIC_MANAGER_THRESHOLD = 20;
trafficManager.init();

function isTrafficManagerEnabled() {
    if (!Memory.settings) Memory.settings = {};
    if (Memory.settings.useTrafficManager === undefined) Memory.settings.useTrafficManager = true;
    return Memory.settings.useTrafficManager !== false;
}

function isTrafficBlockedStructure(structure) {
    if (structure.structureType === STRUCTURE_ROAD || structure.structureType === STRUCTURE_CONTAINER) return false;
    if (structure.structureType === STRUCTURE_RAMPART) return !structure.my && !structure.isPublic;
    return typeof OBSTACLE_OBJECT_TYPES !== 'undefined' && OBSTACLE_OBJECT_TYPES.includes(structure.structureType);
}

function buildTrafficCostMatrix(room) {
    const costs = new PathFinder.CostMatrix();
    for (const structure of room.find(FIND_STRUCTURES)) {
        if (structure.structureType === STRUCTURE_ROAD) costs.set(structure.pos.x, structure.pos.y, 1);
        else if (structure.structureType === STRUCTURE_CONTAINER) costs.set(structure.pos.x, structure.pos.y, 5);
        else if (isTrafficBlockedStructure(structure)) costs.set(structure.pos.x, structure.pos.y, 255);
    }
    for (const site of room.find(FIND_CONSTRUCTION_SITES)) {
        if (![STRUCTURE_ROAD, STRUCTURE_CONTAINER, STRUCTURE_RAMPART].includes(site.structureType)) {
            costs.set(site.pos.x, site.pos.y, 255);
        }
    }
    return costs;
}

function resolveTraffic() {
    if (!isTrafficManagerEnabled()) return;
    for (const room of Object.values(Game.rooms)) {
        trafficManager.run(room, buildTrafficCostMatrix(room), TRAFFIC_MANAGER_THRESHOLD);
    }
}

function cleanDeadCreepMemory() {
    if (!Memory.creeps) return;
    for (const name of Object.keys(Memory.creeps)) {
        if (!Game.creeps[name]) delete Memory.creeps[name];
    }
}

function runOptionalWork() {
    if (!Memory.settings) Memory.settings = {};
    if (Memory.settings.showStructurePlanner === undefined) Memory.settings.showStructurePlanner = false;
    Rooms.drawSourceFlags();
    StructurePlannerVisual.run();
    Dashboard.run();
    cleanDeadCreepMemory();
}

module.exports = {
    resolveTraffic,
    runOptionalWork,
    cleanDeadCreepMemory,
    buildTrafficCostMatrix,
    isTrafficManagerEnabled
};
