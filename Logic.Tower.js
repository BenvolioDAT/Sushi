/*
 * Logic.Tower.js
 *
 * Sushi Tower Logic
 *
 * Job:
 * 1. Attack enemy creeps.
 * 2. Heal friendly creeps when safe.
 * 3. Repair only important emergency targets when safe.
 *
 * Main lesson:
 * Towers should focus fire enemies.
 * Focus fire means all towers attack the same best target.
 * One dead enemy is better than five annoyed enemies.
 */

const TowerLogic = {};

const TOWER_CONFIG = {
    /*
     * This is the player we really care about right now.
     * If giaco enters the room, the towers will score him higher.
     */
    primaryEnemyUsername: 'giaco',

    /*
     * Add friendly player names here later if needed.
     * Example:
     * allies: ['SomeFriendName']
     */
    allies: [],

    /*
     * Towers use 10 energy per action.
     * If a tower has less than this, it cannot attack/heal/repair.
     */
    minimumEnergyToAct: 10,

    /*
     * Do not spend tower energy on repairs unless the tower has this much energy.
     * This saves tower energy as ammo.
     */
    minimumEnergyToRepair: 500,

    /*
     * Ramparts and walls have huge max hit points.
     * We only let towers do emergency repairs on them.
     * Worker creeps can handle bigger wall/rampart work later.
     */
    emergencyRampartHits: 10000,
    emergencyWallHits: 10000,

    /*
     * Important structures are repaired if they fall below this percent.
     * Example: 0.70 means 70%.
     */
    importantStructureRepairPercent: 0.70,

    /*
     * Turn this off later if visuals get annoying.
     */
    debugVisuals: true
};

/*
 * Main function.
 *
 * Call this once per owned room every tick.
 */
TowerLogic.run = function (room) {
    if (!room || !room.controller || !room.controller.my) {
        return;
    }

    const towers = getReadyTowers(room);

    if (towers.length === 0) {
        return;
    }

    const hostiles = getHostileCreeps(room);

    /*
     * Priority 1:
     * Enemy creeps are in the room.
     * Stop everything else and shoot.
     */
    if (hostiles.length > 0) {
        const target = getBestHostileTarget(room, towers, hostiles);

        if (target) {
            attackTargetWithAllTowers(room, towers, target);
            saveCombatIntel(room, hostiles, target);
            return;
        }
    }

    /*
     * If we reach this point, there are no enemies.
     * Now towers are allowed to help friendly creeps.
     */
    savePeaceIntel(room);

    /*
     * Priority 2:
     * Heal damaged friendly creeps.
     */
    const healTarget = getBestHealTarget(room);

    if (healTarget) {
        healTargetWithTowers(towers, healTarget);
        return;
    }

    /*
     * Priority 3:
     * Repair critical structures only.
     */
    repairEmergencyTargets(room, towers);
};

/*
 * Find my towers that have enough energy to do at least one action.
 */
function getReadyTowers(room) {
    return room.find(FIND_MY_STRUCTURES, {
        filter: structure =>
            structure.structureType === STRUCTURE_TOWER &&
            structure.store.getUsedCapacity(RESOURCE_ENERGY) >= TOWER_CONFIG.minimumEnergyToAct
    });
}

/*
 * Find hostile creeps that are not allies.
 */
function getHostileCreeps(room) {
    return room.find(FIND_HOSTILE_CREEPS, {
        filter: creep => !isAlly(creep)
    });
}

/*
 * Simple ally check.
 *
 * Later, if you want, we can move allies into Memory.allies.
 */
function isAlly(creep) {
    if (!creep || !creep.owner || !creep.owner.username) {
        return false;
    }

    const username = creep.owner.username;

    return TOWER_CONFIG.allies.indexOf(username) !== -1;
}

/*
 * Pick the best hostile target.
 *
 * We do not just shoot the closest creep.
 * We score every enemy and shoot the highest score.
 */
function getBestHostileTarget(room, towers, hostiles) {
    let bestTarget = null;
    let bestScore = -Infinity;

    const importantPositions = getImportantRoomPositions(room);

    for (const hostile of hostiles) {
        const score = getHostileScore(room, towers, hostile, importantPositions);

        if (score > bestScore) {
            bestScore = score;
            bestTarget = hostile;
        }
    }

    return bestTarget;
}

/*
 * Give each enemy a danger score.
 *
 * Bigger score = better tower target.
 */
function getHostileScore(room, towers, hostile, importantPositions) {
    let score = 0;

    const username = hostile.owner && hostile.owner.username;

    /*
     * giaco gets bonus points.
     * Congratulations, giaco, you won the angry raffle.
     */
    if (username === TOWER_CONFIG.primaryEnemyUsername) {
        score += 1000;
    }

    /*
     * Healers are top danger because they undo tower damage.
     */
    const healParts = hostile.getActiveBodyparts(HEAL);
    score += healParts * 250;

    /*
     * Ranged attackers can shoot from distance.
     */
    const rangedParts = hostile.getActiveBodyparts(RANGED_ATTACK);
    score += rangedParts * 175;

    /*
     * Melee attackers are dangerous if they reach your creeps or buildings.
     */
    const attackParts = hostile.getActiveBodyparts(ATTACK);
    score += attackParts * 150;

    /*
     * WORK parts can dismantle your structures.
     */
    const workParts = hostile.getActiveBodyparts(WORK);
    score += workParts * 80;

    /*
     * CLAIM parts can mess with controllers.
     */
    const claimParts = hostile.getActiveBodyparts(CLAIM);
    score += claimParts * 100;

    /*
     * Prefer finishing wounded enemies.
     */
    const missingHits = hostile.hitsMax - hostile.hits;
    score += Math.floor(missingHits / 10);

    /*
     * If towers can likely kill this creep right now,
     * make it a very attractive target.
     */
    const expectedDamage = estimateTotalTowerDamage(towers, hostile);

    if (expectedDamage >= hostile.hits) {
        score += 500;
    }

    /*
     * More tower damage means better target.
     * This helps towers avoid wasting shots on far-away targets if
     * a closer dangerous target is available.
     */
    score += Math.floor(expectedDamage / 5);

    /*
     * Enemies close to important structures are more urgent.
     */
    score += getDangerToBaseScore(hostile, importantPositions);

    return score;
}

/*
 * Estimate how much damage all towers can do to this target.
 *
 * Tower damage is strongest near the tower and weaker farther away.
 */
function estimateTotalTowerDamage(towers, target) {
    let totalDamage = 0;

    for (const tower of towers) {
        const range = tower.pos.getRangeTo(target);
        totalDamage += estimateTowerDamageAtRange(range);
    }

    return totalDamage;
}

/*
 * Screeps has constants for tower damage falloff.
 *
 * TOWER_POWER_ATTACK is normally 600.
 * Towers do full damage at close range, then fall off with distance.
 */
function estimateTowerDamageAtRange(range) {
    if (range <= TOWER_OPTIMAL_RANGE) {
        return TOWER_POWER_ATTACK;
    }

    if (range >= TOWER_FALLOFF_RANGE) {
        return Math.floor(TOWER_POWER_ATTACK * (1 - TOWER_FALLOFF));
    }

    const falloffRange = TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE;
    const rangePastOptimal = range - TOWER_OPTIMAL_RANGE;
    const falloffPercent = TOWER_FALLOFF * rangePastOptimal / falloffRange;

    return Math.floor(TOWER_POWER_ATTACK * (1 - falloffPercent));
}

/*
 * Get important positions in the room.
 *
 * We use these to ask:
 * "Is the enemy close to something important?"
 */
function getImportantRoomPositions(room) {
    const positions = [];

    const importantStructures = room.find(FIND_MY_STRUCTURES, {
        filter: structure =>
            structure.structureType === STRUCTURE_SPAWN ||
            structure.structureType === STRUCTURE_TOWER ||
            structure.structureType === STRUCTURE_STORAGE ||
            structure.structureType === STRUCTURE_TERMINAL
    });

    for (const structure of importantStructures) {
        positions.push(structure.pos);
    }

    if (room.controller) {
        positions.push(room.controller.pos);
    }

    return positions;
}

/*
 * Add danger score when hostile is close to important stuff.
 */
function getDangerToBaseScore(hostile, importantPositions) {
    let score = 0;

    for (const pos of importantPositions) {
        const range = hostile.pos.getRangeTo(pos);

        if (range <= 3) {
            score += 250;
        } else if (range <= 6) {
            score += 125;
        } else if (range <= 10) {
            score += 50;
        }
    }

    return score;
}

/*
 * All towers attack the same target.
 *
 * This is the pew-pew heart of the module.
 */
function attackTargetWithAllTowers(room, towers, target) {
    for (const tower of towers) {
        tower.attack(target);
    }

    if (TOWER_CONFIG.debugVisuals) {
        drawAttackVisuals(room, towers, target);
    }
}

/*
 * Draw simple visuals so we can see what the towers are doing.
 */
function drawAttackVisuals(room, towers, target) {
    room.visual.circle(target.pos, {
        radius: 0.55,
        stroke: '#ff0000',
        fill: 'transparent',
        opacity: 0.85
    });

    room.visual.text('PEW', target.pos.x, target.pos.y - 0.7, {
        color: '#ff4444',
        font: 0.5,
        stroke: '#000000',
        strokeWidth: 0.12
    });

    for (const tower of towers) {
        room.visual.line(tower.pos, target.pos, {
            color: '#ff4444',
            opacity: 0.35,
            lineStyle: 'dashed'
        });
    }
}

/*
 * Find the most damaged friendly creep.
 */
function getBestHealTarget(room) {
    const injuredCreeps = room.find(FIND_MY_CREEPS, {
        filter: creep => creep.hits < creep.hitsMax
    });

    if (injuredCreeps.length === 0) {
        return null;
    }

    let bestTarget = null;
    let mostMissingHits = 0;

    for (const creep of injuredCreeps) {
        const missingHits = creep.hitsMax - creep.hits;

        if (missingHits > mostMissingHits) {
            mostMissingHits = missingHits;
            bestTarget = creep;
        }
    }

    return bestTarget;
}

/*
 * Heal friendly creeps with towers.
 */
function healTargetWithTowers(towers, target) {
    for (const tower of towers) {
        tower.heal(target);
    }
}

/*
 * Repair important structures only when no enemies are present.
 *
 * Attack = focus fire.
 * Repair = split work.
 *
 * Why split repair?
 * If 3 towers all repair the same tiny-damaged structure,
 * that can waste tower actions. So each tower gets a target from the list.
 */
function repairEmergencyTargets(room, towers) {
    const repairTargets = getEmergencyRepairTargets(room);

    if (repairTargets.length === 0) {
        return;
    }

    const repairReadyTowers = towers.filter(tower =>
        tower.store.getUsedCapacity(RESOURCE_ENERGY) >= TOWER_CONFIG.minimumEnergyToRepair
    );

    if (repairReadyTowers.length === 0) {
        return;
    }

    for (let i = 0; i < repairReadyTowers.length; i++) {
        const tower = repairReadyTowers[i];
        const target = repairTargets[i % repairTargets.length];

        tower.repair(target);
    }
}

/*
 * Find structures that are worth emergency tower repair.
 */
function getEmergencyRepairTargets(room) {
    const targets = room.find(FIND_STRUCTURES, {
        filter: structure => {
            if (structure.hits >= structure.hitsMax) {
                return false;
            }

            /*
             * Important owned structures.
             */
            if (
                structure.structureType === STRUCTURE_SPAWN ||
                structure.structureType === STRUCTURE_TOWER ||
                structure.structureType === STRUCTURE_STORAGE ||
                structure.structureType === STRUCTURE_TERMINAL
            ) {
                return structure.hits < structure.hitsMax * TOWER_CONFIG.importantStructureRepairPercent;
            }

            /*
             * Emergency rampart repair.
             */
            if (structure.structureType === STRUCTURE_RAMPART) {
                return structure.hits < TOWER_CONFIG.emergencyRampartHits;
            }

            /*
             * Emergency wall repair.
             */
            if (structure.structureType === STRUCTURE_WALL) {
                return structure.hits < TOWER_CONFIG.emergencyWallHits;
            }

            return false;
        }
    });

    /*
     * Weakest structures first.
     */
    targets.sort((a, b) => a.hits - b.hits);

    return targets;
}

/*
 * Save simple combat memory.
 *
 * Later, spawn logic can read this and say:
 * "Enemy in room. Make angry bees."
 */
function saveCombatIntel(room, hostiles, target) {
    if (!Memory.rooms) {
        Memory.rooms = {};
    }

    if (!Memory.rooms[room.name]) {
        Memory.rooms[room.name] = {};
    }

    let primaryEnemyCount = 0;
    let hostileAttackParts = 0;
    let hostileRangedParts = 0;
    let hostileHealParts = 0;
    let hostileWorkParts = 0;

    for (const hostile of hostiles) {
        if (
            hostile.owner &&
            hostile.owner.username === TOWER_CONFIG.primaryEnemyUsername
        ) {
            primaryEnemyCount++;
        }

        hostileAttackParts += hostile.getActiveBodyparts(ATTACK);
        hostileRangedParts += hostile.getActiveBodyparts(RANGED_ATTACK);
        hostileHealParts += hostile.getActiveBodyparts(HEAL);
        hostileWorkParts += hostile.getActiveBodyparts(WORK);
    }

    Memory.rooms[room.name].combatIntel = {
        primaryEnemyUsername: TOWER_CONFIG.primaryEnemyUsername,
        primaryEnemyPresent: primaryEnemyCount > 0,
        primaryEnemyCount: primaryEnemyCount,

        hostileCreepCount: hostiles.length,
        hostileAttackParts: hostileAttackParts,
        hostileRangedParts: hostileRangedParts,
        hostileHealParts: hostileHealParts,
        hostileWorkParts: hostileWorkParts,

        towerTargetId: target ? target.id : null,
        towerTargetOwner: target && target.owner ? target.owner.username : null,

        lastScanned: Game.time
    };
}

/*
 * Save quiet state.
 *
 * This prevents old combat intel from looking fresh forever.
 */
function savePeaceIntel(room) {
    if (!Memory.rooms) {
        Memory.rooms = {};
    }

    if (!Memory.rooms[room.name]) {
        Memory.rooms[room.name] = {};
    }

    if (!Memory.rooms[room.name].combatIntel) {
        Memory.rooms[room.name].combatIntel = {};
    }

    Memory.rooms[room.name].combatIntel.primaryEnemyUsername = TOWER_CONFIG.primaryEnemyUsername;
    Memory.rooms[room.name].combatIntel.primaryEnemyPresent = false;
    Memory.rooms[room.name].combatIntel.primaryEnemyCount = 0;
    Memory.rooms[room.name].combatIntel.hostileCreepCount = 0;
    Memory.rooms[room.name].combatIntel.towerTargetId = null;
    Memory.rooms[room.name].combatIntel.lastScanned = Game.time;
}

module.exports = TowerLogic;