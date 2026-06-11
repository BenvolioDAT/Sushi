/*
 * Logic.Tower.js
 *
 * Owned-room tower logic.
 *
 * Towers always defend first. If hostile creeps are in the room, every tower
 * attacks the chosen hostile target and no repairs happen that tick.
 *
 * When the room is safe, towers may repair important structures in a clear
 * priority order. The repair code remembers one target so towers finish that
 * target before starting a new one.
 */
var TowerLogic = {};

/*
 * Towers should keep energy ready for defense.
 * A tower only repairs when it has at least this much energy.
 */
var TOWER_REPAIR_MIN_ENERGY = 500;

/*
 * Structures start being tower-repaired when they are below 60% of their
 * repair target. For normal structures the target is hitsMax. For ramparts and
 * walls the target is a safer configurable cap.
 */
var REPAIR_START_PERCENT = 0.60;

/*
 * Ramparts can have very large hitsMax values. These caps keep towers from
 * spending all their energy trying to repair ramparts to their maximum.
 */
var RAMPART_REPAIR_CAP_BY_RCL = {
    1: 0,
    2: 10000,
    3: 25000,
    4: 50000,
    5: 100000,
    6: 250000,
    7: 500000,
    8: 1000000
};

/*
 * Walls can also have very large hitsMax values. These caps keep wall repairs
 * useful without draining every tower forever.
 */
var WALL_REPAIR_CAP_BY_RCL = {
    1: 0,
    2: 5000,
    3: 10000,
    4: 25000,
    5: 50000,
    6: 100000,
    7: 250000,
    8: 500000
};

/*
 * Main function.
 *
 * Call this once per owned room every tick.
 *
 * Example:
 * TowerLogic.run(room);
 */
TowerLogic.run = function(room) {
    /*
     * Safety check:
     * If the room is missing, or the room is not mine, stop.
     */
    if (!room || !room.controller || !room.controller.my) {
        return;
    }

    /*
     * Find all my towers in this room.
     */
    var towers = findMyTowers(room);

    /*
     * If I have no towers, there is nothing to do.
     */
    if (towers.length === 0) {
        return;
    }

    /*
     * Find enemy creeps in the room.
     */
    var enemies = findEnemyCreeps(room);

    /*
     * Defense always comes first.
     *
     * If enemies exist, forget any repair target and shoot the hostile target.
     * This prevents repair work from overriding tower attacks.
     */
    if (enemies.length > 0) {
        clearRepairTarget(room);

        var target = chooseTowerTarget(towers, enemies);

        if (target) {
            attackWithAllTowers(towers, target);
        }

        return;
    }

    /*
     * No enemies are present, so towers may spend extra energy on repairs.
     */
    repairWithAvailableTowers(room, towers);
};

/*
 * Find all owned towers in the room.
 */
function findMyTowers(room) {
    return room.find(FIND_MY_STRUCTURES, {
        filter: function(structure) {
            return structure.structureType === STRUCTURE_TOWER;
        }
    });
}

/*
 * Find enemy creeps in the room.
 *
 * FIND_HOSTILE_CREEPS only finds creeps that are not yours.
 */
function findEnemyCreeps(room) {
    return room.find(FIND_HOSTILE_CREEPS);
}

/*
 * Pick which enemy to shoot.
 *
 * Simple beginner rule:
 * Use the first tower and find the enemy closest to that tower.
 */
function chooseTowerTarget(towers, enemies) {
    /*
     * Using the first tower as the perspective is simple and deterministic.
     * A later upgrade could score enemies by total tower damage, healing parts,
     * or distance to important structures.
     */
    var firstTower = towers[0];

    if (!firstTower) {
        return null;
    }

    return firstTower.pos.findClosestByRange(enemies);
}

/*
 * Make every tower shoot the same target.
 */
function attackWithAllTowers(towers, target) {
    for (var i = 0; i < towers.length; i++) {
        var tower = towers[i];

        /*
         * If the tower has no energy, skip it.
         *
         * Towers need energy to attack.
         */
        if (tower.store.getUsedCapacity(RESOURCE_ENERGY) <= 0) {
            continue;
        }

        tower.attack(target);
    }
}

/*
 * Repair one remembered or newly chosen structure with towers that have enough
 * reserve energy.
 */
function repairWithAvailableTowers(room, towers) {
    var target = getRepairTarget(room);

    /*
     * If there is no valid repair target, towers stay idle and keep energy.
     */
    if (!target) {
        return;
    }

    for (var i = 0; i < towers.length; i++) {
        var tower = towers[i];

        /*
         * Keep a defensive energy reserve. A low-energy tower should wait so it
         * can still help if enemies arrive soon.
         */
        if (tower.store.getUsedCapacity(RESOURCE_ENERGY) < TOWER_REPAIR_MIN_ENERGY) {
            continue;
        }

        /*
         * The target came from Game.getObjectById or room.find, so it is a real
         * structure object. Repairing only happens after all hostile checks.
         */
        tower.repair(target);
    }

    /*
     * If the structure is already at its target level, stop remembering it.
     * In Screeps, hits usually update next tick after repairs are processed, so
     * this also works as a clean-up check on the next safe tick.
     */
    if (target.hits >= getRepairTargetHits(room, target)) {
        clearRepairTarget(room);
    }
}

/*
 * Get the current repair target.
 *
 * First try the remembered target. If it is gone or finished, choose a new one.
 */
function getRepairTarget(room) {
    var rememberedTarget = getRememberedRepairTarget(room);

    if (rememberedTarget) {
        return rememberedTarget;
    }

    var newTarget = findBestRepairTarget(room);

    if (newTarget) {
        rememberRepairTarget(room, newTarget);
    }

    return newTarget;
}

/*
 * Read the saved target ID from Memory and return the object if it still needs
 * repair up to its target level.
 */
function getRememberedRepairTarget(room) {
    var roomMemory = getTowerRoomMemory(room);
    var targetId = roomMemory.towerRepairTargetId;

    if (!targetId) {
        return null;
    }

    var target = Game.getObjectById(targetId);

    if (!target) {
        clearRepairTarget(room);
        return null;
    }

    /*
     * Only repair the structure types this file understands. This protects the
     * tower from using an old or manually edited memory value on the wrong kind
     * of object.
     */
    if (!isWantedRepairStructure(target)) {
        clearRepairTarget(room);
        return null;
    }

    /*
     * Remembered targets continue being repaired until they reach their target
     * hits, not just until they rise above the 60% start threshold.
     */
    if (target.hits < getRepairTargetHits(room, target)) {
        return target;
    }

    clearRepairTarget(room);
    return null;
}

/*
 * Save the selected repair target ID in room memory.
 */
function rememberRepairTarget(room, target) {
    if (!target) {
        return;
    }

    getTowerRoomMemory(room).towerRepairTargetId = target.id;
}

/*
 * Clear the saved repair target ID.
 */
function clearRepairTarget(room) {
    var roomMemory = getTowerRoomMemory(room);
    delete roomMemory.towerRepairTargetId;
}

/*
 * Make sure Memory.rooms[room.name] exists before reading or writing tower
 * repair memory.
 */
function getTowerRoomMemory(room) {
    if (!Memory.rooms) {
        Memory.rooms = {};
    }

    if (!Memory.rooms[room.name]) {
        Memory.rooms[room.name] = {};
    }

    return Memory.rooms[room.name];
}

/*
 * Decide if a structure should start a new tower repair job.
 */
function structureNeedsTowerRepair(room, structure) {
    var targetHits = getRepairTargetHits(room, structure);
    var startHits = getRepairStartHits(room, structure);

    if (targetHits <= 0) {
        return false;
    }

    return structure.hits < startHits;
}

/*
 * Get the hits level that towers should repair this structure up to.
 */
function getRepairTargetHits(room, structure) {
    if (!structure) {
        return 0;
    }

    if (structure.structureType === STRUCTURE_RAMPART) {
        return getRampartRepairCap(room);
    }

    if (structure.structureType === STRUCTURE_WALL) {
        return getWallRepairCap(room);
    }

    return structure.hitsMax;
}

/*
 * Get the hits level where this structure should start being repaired.
 */
function getRepairStartHits(room, structure) {
    return getRepairTargetHits(room, structure) * REPAIR_START_PERCENT;
}

/*
 * Read the rampart cap for the room controller level.
 */
function getRampartRepairCap(room) {
    var level = getRoomControllerLevel(room);
    return RAMPART_REPAIR_CAP_BY_RCL[level] || 0;
}

/*
 * Read the wall cap for the room controller level.
 */
function getWallRepairCap(room) {
    var level = getRoomControllerLevel(room);
    return WALL_REPAIR_CAP_BY_RCL[level] || 0;
}

/*
 * Get the room controller level safely.
 */
function getRoomControllerLevel(room) {
    if (!room || !room.controller) {
        return 0;
    }

    return room.controller.level || 0;
}

/*
 * Lower number means higher priority.
 */
function getRepairPriority(structure) {
    if (structure.structureType === STRUCTURE_CONTAINER) {
        return 1;
    }

    if (structure.structureType === STRUCTURE_EXTENSION) {
        return 2;
    }

    if (structure.structureType === STRUCTURE_SPAWN) {
        return 3;
    }

    if (structure.structureType === STRUCTURE_RAMPART) {
        return 4;
    }

    if (structure.structureType === STRUCTURE_WALL) {
        return 5;
    }

    if (structure.structureType === STRUCTURE_ROAD) {
        return 6;
    }

    return 999;
}

/*
 * Find the best new repair target in the room.
 *
 * Priority order:
 * 1. Containers
 * 2. Extensions
 * 3. Spawns
 * 4. Ramparts
 * 5. Walls
 * 6. Roads
 */
function findBestRepairTarget(room) {
    var repairableStructures = room.find(FIND_STRUCTURES, {
        filter: function(structure) {
            return isWantedRepairStructure(structure) && structureNeedsTowerRepair(room, structure);
        }
    });

    if (repairableStructures.length === 0) {
        return null;
    }

    repairableStructures.sort(function(a, b) {
        var priorityA = getRepairPriority(a);
        var priorityB = getRepairPriority(b);

        if (priorityA !== priorityB) {
            return priorityA - priorityB;
        }

        return getRepairHitsPercent(room, a) - getRepairHitsPercent(room, b);
    });

    return repairableStructures[0];
}

/*
 * Only these structures are repaired by towers.
 */
function isWantedRepairStructure(structure) {
    return structure.structureType === STRUCTURE_CONTAINER ||
        structure.structureType === STRUCTURE_EXTENSION ||
        structure.structureType === STRUCTURE_SPAWN ||
        structure.structureType === STRUCTURE_RAMPART ||
        structure.structureType === STRUCTURE_WALL ||
        structure.structureType === STRUCTURE_ROAD;
}

/*
 * Compare repair candidates by how damaged they are relative to their target.
 * Smaller percent means more damaged, so it should be repaired first when two
 * structures have the same priority.
 */
function getRepairHitsPercent(room, structure) {
    var targetHits = getRepairTargetHits(room, structure);

    if (targetHits <= 0) {
        return 1;
    }

    return structure.hits / targetHits;
}

module.exports = TowerLogic;
