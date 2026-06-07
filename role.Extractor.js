var utility = require('utility');
var utilityCreep = require('utility.Creep');
var utilityTravelCreep = require('utility.Travel.Creep');

var roleExtractor = {

    /** @param {Creep} creep **/
    run: function(creep) {
        /*
         * Extractors are source harvesters. If the creep is missing or still
         * spawning, it cannot harvest, transfer, or drop energy this tick.
         */
        if(!creep || creep.spawning) {
            return;
        }
        /*
         * Keep source container planning fresh for this room. This may read
         * Memory.rooms[roomName].sources and write container planning fields.
         */
        utility.planSourceContainers(creep.room.name);

        // A Veinseeker is a basic source miner. It remembers one source if it can.
        /*
         * getAssignedSource uses room memory to spread miners between sources.
         * It may write creep.memory.sourceId and source assignment lists.
         */
        var source = utilityCreep.getAssignedSource(creep);
        //var source = getAssignedSource(creep);
        if(!source) {
            /*
             * No source means there is nothing useful for this creep to do.
             * Returning avoids calling harvest with a null target.
             */
            return;
        }

        /*
         * If the creep has free energy capacity, keep harvesting. The RESOURCE_ENERGY
         * argument asks Screeps specifically about energy space, not other resources.
         */
        var miningSeat = utilityCreep.getAssignedMiningSeat(creep, source);

        if (miningSeat && !isCreepOnPosition(creep, miningSeat)) {
            /*
            * If the creep is already beside the source, let it harvest while it moves
            * onto the better seat. This keeps it productive instead of waddling with
            * empty hands like a confused Roomba.
            */
            if (creep.pos.getRangeTo(source.pos) <= 1 && creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                creep.harvest(source);
            }

            utilityTravelCreep.move(creep, miningSeat, {
                range: 0,
                visualizePathStyle: {
                    stroke: '#ffaa00'
                }
            });

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

function isCreepOnPosition(creep, position) {
    if (!creep || !position) {
        return false;
    }

    return (
        creep.pos.x === position.x &&
        creep.pos.y === position.y &&
        creep.pos.roomName === position.roomName
    );
}

function getSourceFromRoomMemory(creep) {
    /*
     * Room scan data lives under Memory.rooms[roomName]. If the room has never
     * been scanned, there is no source memory to read.
     */
    if(!Memory.rooms || !Memory.rooms[creep.room.name]) {
        return null;
    }

    var sourcesMemory = Memory.rooms[creep.room.name].sources;
    if(!sourcesMemory) {
        return null;
    }

    // Sushi's room scan stores sources as Memory.rooms[roomName].sources[sourceId].
    /*
     * Loop through each remembered source record. hasOwnProperty avoids reading
     * inherited JavaScript properties that are not real source ids.
     */
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
    /*
     * creep.harvest uses WORK parts to take energy from a Source. OK means the
     * harvest happened; ERR_NOT_IN_RANGE means the source is valid but too far.
     */
    var result = creep.harvest(source);
    if(result === ERR_NOT_IN_RANGE) {
        utilityTravelCreep.move(creep, source, {visualizePathStyle: {stroke: '#ffaa00'}});
    }
}

function offloadEnergy(creep, source) {
    /*
     * Source miners try to put energy into nearby logistics structures. The
     * search is centered on source.pos because source containers are normally
     * built right beside the source.
     */
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
        /*
         * transfer moves energy from the creep into the structure store.
         * Returning true tells run() that offloading was handled this tick.
         */
        if(creep.transfer(nearbyStores[0], RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            utilityTravelCreep.move(creep, nearbyStores[0], {visualizePathStyle: {stroke: '#ffffff'}});
        }
        return true;
    }

    return false;
}

module.exports = roleExtractor;
