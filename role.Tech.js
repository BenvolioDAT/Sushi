/*
 * role.Tech.js
 *
 * Upgrader role.
 *
 * Tech keeps the controller upgraded. The teaching point in this file is
 * priority ordering: a controller-adjacent container is best for upgrader CPU
 * and travel time, then storage, then opportunistic free energy, then mining as
 * the slow emergency fallback.
 */
var creepUtility = require('utility.Creep');
var travel = require('utility.Travel.Creep');
var Economy = require('HiveMind.Economy');
var ColonyState = require('HiveMind.ColonyState');
var TickIndex = require('HiveMind.Index');

function isBaselineRepresentative(creep, homeRoomName) {
    if (!global.__sushiBaselineTechRepresentatives ||
        global.__sushiBaselineTechRepresentatives.tick !== Game.time) {
        global.__sushiBaselineTechRepresentatives = { tick: Game.time, rooms: {} };
    }
    var cache = global.__sushiBaselineTechRepresentatives.rooms;
    if (cache.hasOwnProperty(homeRoomName)) return cache[homeRoomName] === (creep.name || creep.id);
    var techs = (TickIndex.get().creepsByHomeRoom.get(homeRoomName) || []).filter(function(unit) {
        return unit && unit.memory && unit.memory.role === 'Tech' &&
            (unit.ticksToLive === undefined || unit.ticksToLive > 50);
    }).sort(function(left, right) {
        return String(left.name || left.id).localeCompare(String(right.name || right.id));
    });
    cache[homeRoomName] = techs.length > 0 ? (techs[0].name || techs[0].id) : null;
    return cache[homeRoomName] === (creep.name || creep.id);
}

var roleTech = {
    run: function(creep) {
        creep._capacityProductive = false;
        if (typeof creep.setTrafficLock === 'function') creep.setTrafficLock(false);
        var homeRoomName = creep.memory.homeRoom || creep.room.name;
        var controllerEmergency = creep.memory.controllerEmergency === true ||
            creep.room.controller && creep.room.controller.ticksToDowngrade < 5000;
        var controllerGrowthFloor = creep.memory.controllerGrowthFloor === true;
        var colony = ColonyState.get(homeRoomName);
        var baselineRepresentative = !controllerGrowthFloor && colony && colony.growthAllowed &&
            colony.rcl < 8 &&
            isBaselineRepresentative(creep, homeRoomName);
        var floorPolicyActive = (controllerGrowthFloor || baselineRepresentative) && colony &&
            colony.rcl < 8;
        var growthStillAllowed = controllerEmergency || !floorPolicyActive || colony.growthAllowed;
        var spendCategory = controllerEmergency ? 'controllerSafety' :
            floorPolicyActive ? 'controllerGrowth' : 'upgradeSurplus';
        if (!growthStillAllowed || !Economy.canSpend(homeRoomName, spendCategory)) {
            creep.memory.upgrading = false;
            if (creep.store[RESOURCE_ENERGY] > 0) creepUtility.fillRoomEnergy(creep);
            else creepUtility.collectEnergy(creep);
            return;
        }
        /*
         * Tech is the upgrader role.
         *
         * creep.memory.upgrading:
         * false = collect energy
         * true  = upgrade controller
         */
        if (creep.memory.upgrading && creepUtility.isEmpty(creep)) {
            creep.memory.upgrading = false;
        }

        if (!creep.memory.upgrading && (creepUtility.isFull(creep) ||
            creep.store[RESOURCE_ENERGY] > 0 && creep.room.controller && creep.pos.getRangeTo(creep.room.controller) <= 3)) {
            creep.memory.upgrading = true;
        }

        if (creep.memory.upgrading) {
            creep._capacityProductive = !!creep.room.controller;
            upgradeRoomController(creep);
            return;
        }

        /*
         * Tech uses its own energy order now:
         *
         * 1. Controller container
         * 2. Storage
         * 3. Local dropped energy stockpiles, but not source drops
         * 4. Tombstones
         * 5. Ruins
         * 6. Source containers
         * 7. Mine its own energy
         */
        creep._capacityProductive = !!getEnergyForTech(creep);
    }
};

function upgradeRoomController(creep) {
    if (!creep.room.controller) {
        return;
    }

    /*
     * Upgrading works from range 3.
     * So we move to range 3 instead of standing directly on top of the controller.
     */
    var result = creep.upgradeController(creep.room.controller);
    if (result === OK) {
        preserveControllerStation(creep);
    } else if (result === ERR_NOT_IN_RANGE) {
        travel.move(creep, creep.room.controller, {
            range: 3
        });
    }
}

function getEnergyForTech(creep) {
    if (!creep || !creep.room) {
        return false;
    }

    if (creepUtility.isFull(creep)) {
        return false;
    }

    /*
     * Priority 1:
     * Use the controller container first.
     *
     * This keeps the Tech working near the controller instead of running across
     * the room like a confused shopping cart.
     */
    if (withdrawFromControllerContainer(creep)) {
        return true;
    }

    /*
     * Priority 2:
     * If the controller container is empty, use storage next.
     */
    if (creepUtility.withdrawFromStorage(creep)) {
        return true;
    }

    /*
     * Priority 3:
     * Pick up local dropped energy stockpiles, but not source drops.
     *
     * Freighters may drop energy near spawn as a shared stockpile for worker
     * creeps. Tech should use that pile, but should not steal dropped energy
     * beside sources because source logistics and Freighters own that flow.
     */
    if (pickupDroppedEnergyForTech(creep)) {
        return true;
    }

    /*
     * Priority 4:
     * Pull energy from tombstones.
     * Tombstones are fallen creeps. If they have energy, grab it before
     * checking ruins because tombstones decay away faster.
     */

    if (creepUtility.withdrawFromClosestTombstone(creep)) {
        return true;
    }

    /*
     * Priority 5:
     * Pull energy from ruins.
     */
    if (creepUtility.withdrawFromClosestRuin(creep)) {
        return true;
    }

    /*
     * Priority 6:
     * Withdraw from source containers.
     *
     * This comes after storage because Tech should not steal source-container
     * energy unless the better upgrader fuel spots are empty.
     */
    if (withdrawFromSourceContainer(creep)) {
        return true;
    }

    /*
     * Priority 7:
     * Last resort. Mine its own energy.
     *
     * This is slow, but it keeps the Tech alive in a weak room.
     */
    if (creepUtility.harvestClosestSource(creep)) {
        return true;
    }

    return false;
}

function withdrawFromControllerContainer(creep) {
    var container = findControllerContainerWithEnergy(creep);

    if (!container) {
        return false;
    }

    var handled = creepUtility.withdrawEnergy(creep, container);
    if (handled && creep.pos.getRangeTo(container) <= 1 && creep.pos.getRangeTo(creep.room.controller) <= 3) {
        preserveControllerStation(creep, container);
    }
    return handled;
}

function preserveControllerStation(creep, container) {
    if (typeof creep.setWorkingArea === 'function') creep.setWorkingArea(creep.room.controller.pos, 3);
    container = container || findControllerContainerWithEnergy(creep);
    // A sustainable work/refill tile is a station, just like a miner's tile.
    // Traffic routes around it instead of pushing the Tech out of upgrade range.
    if (container && creep.pos.getRangeTo(container) <= 1 && typeof creep.setTrafficLock === 'function') {
        var station = offRoadControllerStation(creep, container);
        if (station) {
            travel.move(creep, station, { range: 0 });
            return;
        }
        creep.setTrafficLock(true);
    }
}

function offRoadControllerStation(creep, container) {
    if (typeof creep.getActiveBodyparts === 'function' && creep.getActiveBodyparts(MOVE) <= 0) return null;
    var index = TickIndex.get(), byType = index.structuresByRoom.get(creep.room.name) || new Map();
    var roads = byType.get(STRUCTURE_ROAD) || [];
    if (!roads.some(s => s.pos.isEqualTo(creep.pos))) return null;
    // A locked road tile can trap the haulers refilling this very container.
    // Only leave it for a free adjacent work/refill tile; once off-road the fast
    // return above preserves the station without repeated movement or searches.
    var occupied = new Set((index.creepsByCurrentRoom.get(creep.room.name) || [])
        .filter(c => c.name !== creep.name).map(c => c.pos.x + ':' + c.pos.y));
    for (var c of index.powerCreepsByRoom.get(creep.room.name) || []) occupied.add(c.pos.x + ':' + c.pos.y);
    var reserved = index.techStationReservations || (index.techStationReservations = new Set());
    var structures = Array.from(byType.values()).flat();
    var sites = index.constructionSitesByRoom.get(creep.room.name) || [];
    var resources = (index.sourcesByRoom.get(creep.room.name) || []).concat(index.mineralsByRoom.get(creep.room.name) || []);
    var terrain = Game.map.getRoomTerrain(creep.room.name);
    for (var y = creep.pos.y - 1; y <= creep.pos.y + 1; y++) {
        for (var x = creep.pos.x - 1; x <= creep.pos.x + 1; x++) {
            var key = x + ':' + y, reservation = creep.room.name + ':' + key;
            if (x < 1 || x > 48 || y < 1 || y > 48 || occupied.has(key) || reserved.has(reservation) ||
                terrain.get(x,y) === TERRAIN_MASK_WALL) continue;
            var pos = new RoomPosition(x,y,creep.room.name);
            if (pos.getRangeTo(container) > 1 || pos.getRangeTo(creep.room.controller) > 3 ||
                structures.some(s => s.pos.isEqualTo(pos) &&
                    s.structureType !== STRUCTURE_CONTAINER &&
                    !(s.structureType === STRUCTURE_RAMPART && (s.my || s.isPublic))) ||
                sites.some(s => s.pos.isEqualTo(pos)) || resources.some(s => s.pos.isEqualTo(pos))) continue;
            reserved.add(reservation);
            return pos;
        }
    }
    return null;
}

function findControllerContainerWithEnergy(creep) {
    if (!creep || !creep.room || !creep.room.controller) {
        return null;
    }

    /*
     * Range 3 is intentional.
     *
     * A Tech can stand near this container, withdraw energy, and still be close
     * enough to upgrade the controller. This catches both truly adjacent
     * containers and good upgrader containers placed a couple tiles away.
     */
    var structures = TickIndex.get().structuresByRoom.get(creep.room.name);
    var containers = structures && structures.get(STRUCTURE_CONTAINER) || [];
    var best = null, distance = Infinity;
    for (var container of containers) {
        if (!container.store || container.store.getUsedCapacity(RESOURCE_ENERGY) <= 0 ||
            container.pos.getRangeTo(creep.room.controller) > 3) continue;
        var range = creep.pos.getRangeTo(container);
        if (range < distance) { best = container; distance = range; }
    }
    return best;
}

function pickupDroppedEnergyForTech(creep) {
    var droppedEnergy = findDroppedEnergyForTech(creep);

    if (!droppedEnergy) {
        return false;
    }

    return creepUtility.pickupEnergy(creep, droppedEnergy);
}

function findDroppedEnergyForTech(creep) {
    if (!creep || !creep.room) {
        return null;
    }

    /*
     * Freighters can create useful dropped-energy stockpiles near spawn.
     * Choose the closest usable pile by path, like Artificers do.
     *
     * Drops close to sources are intentionally ignored. Those piles belong to
     * source logistics, where Freighters or source workers should handle them.
     */
    return creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: function(resource) {
            return (
                resource.resourceType === RESOURCE_ENERGY &&
                resource.amount > 0 &&
                resource.pos.findInRange(FIND_SOURCES, 3).length === 0
            );
        }
    });
}

function withdrawFromSourceContainer(creep) {
    var container = findSourceContainerWithEnergy(creep);

    if (!container) {
        return false;
    }

    return creepUtility.withdrawEnergy(creep, container);
}

function findSourceContainerWithEnergy(creep) {
    if (!creep || !creep.room) {
        return null;
    }

    /*
     * Source containers are containers within range 2 of a source.
     *
     * This keeps the Tech from treating the controller container as a source
     * container too. We already checked the controller container first.
     */
    return creep.pos.findClosestByPath(FIND_STRUCTURES, {
        filter: function(structure) {
            return (
                structure.structureType === STRUCTURE_CONTAINER &&
                structure.store &&
                structure.store.getUsedCapacity(RESOURCE_ENERGY) > 0 &&
                structure.pos.findInRange(FIND_SOURCES, 2).length > 0
            );
        }
    });
}

roleTech.findDroppedEnergyForTech = findDroppedEnergyForTech;
roleTech.getEnergyForTech = getEnergyForTech;
roleTech.upgradeRoomController = upgradeRoomController;

module.exports = roleTech;
