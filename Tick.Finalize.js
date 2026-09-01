const trafficManager = require('traffic_manager');
const Dashboard = require('Visual.Dashboard');
const StructurePlannerVisual = require('Visual.Planner.Structures');
const Rooms = require('Tick.Rooms');
const TickIndex = require('HiveMind.Index');
const Scheduler = require('HiveMind.Scheduler');
const HiveMemory = require('HiveMind.Memory');

const TRAFFIC_MANAGER_THRESHOLD = 20;
trafficManager.init();
const matrixCache = new Map();

function isTrafficManagerEnabled() {
    return HiveMemory.getConfig('general').useTrafficManager !== false;
}

function isTrafficBlockedStructure(structure) {
    if (structure.structureType === STRUCTURE_ROAD || structure.structureType === STRUCTURE_CONTAINER) return false;
    if (structure.structureType === STRUCTURE_RAMPART) return !structure.my && !structure.isPublic;
    return typeof OBSTACLE_OBJECT_TYPES !== 'undefined' && OBSTACLE_OBJECT_TYPES.includes(structure.structureType);
}

function getRoomStructures(index, roomName) {
    const byType = index.structuresByRoom.get(roomName);
    return byType ? Array.from(byType.values()).flat() : [];
}

function matrixSignature(structures, sites) {
    const values = [];
    for (const item of structures.concat(sites)) {
        values.push([
            item.id || '', item.structureType || '', item.pos && item.pos.x,
            item.pos && item.pos.y, item.my === false ? 0 : 1, item.isPublic ? 1 : 0
        ].join(':'));
    }
    return values.sort().join('|');
}

function buildTrafficCostMatrix(room, index = TickIndex.get()) {
    const structures = getRoomStructures(index, room.name);
    const sites = index.constructionSitesByRoom.get(room.name) || [];
    const signature = matrixSignature(structures, sites);
    const cached = matrixCache.get(room.name);
    if (cached && cached.signature === signature) return cached.matrix;

    const costs = new PathFinder.CostMatrix();
    for (const structure of structures) {
        if (structure.structureType === STRUCTURE_ROAD) costs.set(structure.pos.x, structure.pos.y, 1);
        else if (structure.structureType === STRUCTURE_CONTAINER) costs.set(structure.pos.x, structure.pos.y, 5);
        else if (isTrafficBlockedStructure(structure)) costs.set(structure.pos.x, structure.pos.y, 255);
    }
    for (const site of sites) {
        if (![STRUCTURE_ROAD, STRUCTURE_CONTAINER, STRUCTURE_RAMPART].includes(site.structureType)) {
            costs.set(site.pos.x, site.pos.y, 255);
        }
    }
    matrixCache.set(room.name, { signature, matrix: costs });
    return costs;
}

function resolveTraffic() {
    if (!isTrafficManagerEnabled()) return;
    const index = TickIndex.get();
    for (const [roomName, creeps] of index.creepsByCurrentRoom.entries()) {
        if (!creeps.length || !trafficManager.hasMovementIntents(roomName)) continue;
        const room = Game.rooms[roomName];
        if (!room) continue;
        trafficManager.run(room, buildTrafficCostMatrix(room, index), TRAFFIC_MANAGER_THRESHOLD, {
            creeps,
            blockers: (index.hostilesByRoom.get(roomName) || []).concat(index.powerCreepsByRoom.get(roomName) || [])
        });
    }
}

function cleanDeadCreepMemory() {
    if (!Memory.creeps) return;
    for (const name of Object.keys(Memory.creeps)) {
        if (!Game.creeps[name]) delete Memory.creeps[name];
    }
}

function runOptionalWork() {
    cleanDeadCreepMemory();
    const interval = Math.max(1, HiveMemory.getConfig('visuals').visualInterval || 1);
    if (!Scheduler.shouldRun('visuals', { interval })) return;
    Rooms.drawSourceFlags();
    StructurePlannerVisual.run();
    Dashboard.run();
}

module.exports = {
    resolveTraffic,
    runOptionalWork,
    cleanDeadCreepMemory,
    buildTrafficCostMatrix,
    isTrafficManagerEnabled
};
