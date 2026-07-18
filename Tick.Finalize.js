const trafficManager = require('traffic_manager');
const Dashboard = require('Visual.Dashboard');
const StructurePlannerVisual = require('Visual.Planner.Structures');

const TRAFFIC_MANAGER_THRESHOLD = 20;

trafficManager.init();

function isTrafficManagerEnabled() {
    if (!Memory.settings) {
        Memory.settings = {};
    }
    if (Memory.settings.useTrafficManager === undefined) {
        Memory.settings.useTrafficManager = true;
    }
    return Memory.settings.useTrafficManager !== false;
}

function isTrafficBlockedStructure(structure) {
    if (
        structure.structureType === STRUCTURE_ROAD ||
        structure.structureType === STRUCTURE_CONTAINER
    ) {
        return false;
    }
    if (structure.structureType === STRUCTURE_RAMPART) {
        return !structure.my && !structure.isPublic;
    }
    return typeof OBSTACLE_OBJECT_TYPES !== 'undefined' &&
        OBSTACLE_OBJECT_TYPES.indexOf(structure.structureType) !== -1;
}

function buildTrafficCostMatrix(room) {
    const costs = new PathFinder.CostMatrix();
    const structures = room.find(FIND_STRUCTURES);

    for (let i = 0; i < structures.length; i++) {
        const structure = structures[i];
        if (structure.structureType === STRUCTURE_ROAD) {
            costs.set(structure.pos.x, structure.pos.y, 1);
        }
        else if (structure.structureType === STRUCTURE_CONTAINER) {
            costs.set(structure.pos.x, structure.pos.y, 5);
        }
        else if (isTrafficBlockedStructure(structure)) {
            costs.set(structure.pos.x, structure.pos.y, 255);
        }
    }

    const sites = room.find(FIND_CONSTRUCTION_SITES);
    for (let i = 0; i < sites.length; i++) {
        const site = sites[i];
        if (
            site.structureType !== STRUCTURE_ROAD &&
            site.structureType !== STRUCTURE_CONTAINER &&
            site.structureType !== STRUCTURE_RAMPART
        ) {
            costs.set(site.pos.x, site.pos.y, 255);
        }
    }
    return costs;
}

function resolveTraffic() {
    if (!isTrafficManagerEnabled()) {
        return;
    }
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        trafficManager.run(
            room,
            buildTrafficCostMatrix(room),
            TRAFFIC_MANAGER_THRESHOLD
        );
    }
}

function drawVisuals() {
    if (!Memory.settings) {
        Memory.settings = {};
    }
    if (Memory.settings.showStructurePlanner === undefined) {
        Memory.settings.showStructurePlanner = false;
    }
    StructurePlannerVisual.run();
    Dashboard.run();
}

function cleanDeadCreepMemory() {
    if (!Memory.creeps) {
        return;
    }
    for (const name in Memory.creeps) {
        if (!Game.creeps[name]) {
            delete Memory.creeps[name];
            console.log('Clearing non-existing creep memory:', name);
        }
    }
}

module.exports = {
    resolveTraffic: resolveTraffic,
    drawVisuals: drawVisuals,
    cleanDeadCreepMemory: cleanDeadCreepMemory,
    buildTrafficCostMatrix: buildTrafficCostMatrix
};
