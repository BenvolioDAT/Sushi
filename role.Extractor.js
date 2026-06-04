var utility = require('utility');
var utilityCreep = require('utility.Creep');
var utilityTravelCreep = require('utility.Travel.Creep');

var roleExtractor = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if(!creep || creep.spawning) {
            return;
        }

        // A Veinseeker is a basic source miner. It remembers one source if it can.
        var source = utilityCreep.getAssignedSource(creep);
        //var source = getAssignedSource(creep);
        if(!source) {
            return;
        }

        if(creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            harvestSource(creep, source);
            return;
        }

        // When full, prefer a nearby container/link. If none exists, drop energy
        // so a Trucker can collect it instead of letting the miner stand idle.
        if(!offloadEnergy(creep, source)) {
            creep.drop(RESOURCE_ENERGY);
        }
    }
};

function getAssignedSource(creep) {
    var source = null;

    if(creep.memory.sourceId) {
        source = Game.getObjectById(creep.memory.sourceId);
        if(source) {
            return source;
        }
        delete creep.memory.sourceId;
    }

    source = getSourceFromRoomMemory(creep);
    if(source) {
        creep.memory.sourceId = source.id;
        return source;
    }

    var sources = creep.room.find(FIND_SOURCES);
    if(!sources || sources.length === 0) {
        return null;
    }

    source = creep.pos.findClosestByPath(sources) || sources[0];
    creep.memory.sourceId = source.id;
    return source;
}

function getSourceFromRoomMemory(creep) {
    if(!Memory.rooms || !Memory.rooms[creep.room.name]) {
        return null;
    }

    var sourcesMemory = Memory.rooms[creep.room.name].sources;
    if(!sourcesMemory) {
        return null;
    }

    // Sushi's room scan stores sources as Memory.rooms[roomName].sources[sourceId].
    for(var sourceId in sourcesMemory) {
        if(!sourcesMemory.hasOwnProperty(sourceId)) {
            continue;
        }

        var sourceMemory = sourcesMemory[sourceId];
        var id = sourceMemory && sourceMemory.id ? sourceMemory.id : sourceId;
        var source = Game.getObjectById(id);
        if(source) {
            return source;
        }
    }

    return null;
}

function harvestSource(creep, source) {
    var result = creep.harvest(source);
    if(result === ERR_NOT_IN_RANGE) {
        creep.moveTo(source, {visualizePathStyle: {stroke: '#ffaa00'}});
    }
}

function offloadEnergy(creep, source) {
    var nearbyStores = source.pos.findInRange(FIND_STRUCTURES, 2, {
        filter: function(structure) {
            return (
                (structure.structureType === STRUCTURE_CONTAINER ||
                 structure.structureType === STRUCTURE_LINK ||
                 structure.structureType === STRUCTURE_STORAGE) &&
                structure.store &&
                structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0
            );
        }
    });

    if(nearbyStores && nearbyStores.length > 0) {
        if(creep.transfer(nearbyStores[0], RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            creep.moveTo(nearbyStores[0], {visualizePathStyle: {stroke: '#ffffff'}});
        }
        return true;
    }

    return false;
}

module.exports = roleExtractor;
