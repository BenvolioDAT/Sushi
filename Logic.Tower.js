var TowerLogic = {};

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
     * If the room is missing, stop.
     */
    if (!room) {
        return;
    }

    /*
     * Safety check:
     * Only run tower logic in rooms that I own.
     */
    if (!room.controller || !room.controller.my) {
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
     * If there are no enemies, the towers do nothing.
     */
    if (enemies.length === 0) {
        return;
    }

    /*
     * Pick one enemy for all towers to shoot.
     *
     * This is called focus fire.
     * Focus fire is good because one dead enemy is better than
     * five enemies with hurt feelings.
     */
    var target = chooseTowerTarget(towers, enemies);

    /*
     * If something went wrong and no target was found, stop.
     */
    if (!target) {
        return;
    }

    /*
     * Shoot the target with every tower that has energy.
     */
    attackWithAllTowers(towers, target);
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

module.exports = TowerLogic;