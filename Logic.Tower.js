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
var tickCache = require('Tick.Cache');
var combatThreat = require('Combat.Threat');
var TOWER_TARGET_LOCK_TICKS = 3;
var lastDefenseStateByRoom = {};

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
    2: 5000,
    3: 10000,
    4: 10000,
    5: 10000,
    6: 10000,
    7: 10000,
    8: 10000
};

/*
 * Walls can also have very large hitsMax values. These caps keep wall repairs
 * useful without draining every tower forever.
 */
var WALL_REPAIR_CAP_BY_RCL = {
    1: 0,
    2: 5000,
    3: 10000,
    4: 10000,
    5: 10000,
    6: 10000,
    7: 10000,
    8: 10000
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

        var targetEvaluation = chooseTowerTarget(room, towers, enemies);
        var endangeredDefender = chooseEndangeredDefender(room, enemies);

        if (
            endangeredDefender &&
            (!targetEvaluation || targetEvaluation.netDamage <= 0)
        ) {
            healWithAllTowers(towers, endangeredDefender);
            saveDefenseState(room, enemies, targetEvaluation, 'heal', endangeredDefender);
        }
        else if (targetEvaluation && targetEvaluation.target) {
            attackWithAllTowers(towers, targetEvaluation.target);
            saveDefenseState(room, enemies, targetEvaluation, 'attack', null);
        }

        return;
    }

    clearTowerTarget(room);

    var peacefulHealTarget = choosePeacefulHealTarget(room);
    if (peacefulHealTarget) {
        healWithAllTowers(towers, peacefulHealTarget);
        saveDefenseState(room, enemies, null, 'heal', peacefulHealTarget);
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
    var structures = tickCache.getMyStructures(room);
    var towers = [];
    for (var i = 0; i < structures.length; i++) {
        if (structures[i].structureType === STRUCTURE_TOWER) {
            towers.push(structures[i]);
        }
    }
    return towers;
}

/*
 * Find enemy creeps in the room.
 *
 * FIND_HOSTILE_CREEPS only finds creeps that are not yours.
 */
function findEnemyCreeps(room) {
    return tickCache.getHostileCreeps(room);
}

/*
 * Pick which enemy to shoot.
 *
 * Simple beginner rule:
 * Use the first tower and find the enemy closest to that tower.
 */
function chooseTowerTarget(room, towers, enemies) {
    var evaluations = [];
    for (var i = 0; i < enemies.length; i++) {
        evaluations.push(evaluateTowerTarget(room, towers, enemies[i], enemies));
    }
    evaluations.sort(function(a, b) {
        if (a.score !== b.score) {
            return b.score - a.score;
        }
        return String(a.target.id) < String(b.target.id) ? -1 : 1;
    });

    var best = evaluations.length > 0 ? evaluations[0] : null;
    var roomMemory = getTowerRoomMemory(room);
    var locked = null;
    for (var evaluationIndex = 0; evaluationIndex < evaluations.length; evaluationIndex++) {
        if (evaluations[evaluationIndex].target.id === roomMemory.towerTargetId) {
            locked = evaluations[evaluationIndex];
            break;
        }
    }

    var criticalThreatBreak = !!(
        best && locked && best.target.id !== locked.target.id &&
        (
            best.analysis.strategicThreat >=
                locked.analysis.strategicThreat + 250 ||
            best.analysis.totalThreat >= locked.analysis.totalThreat * 1.5
        )
    );

    if (
        locked &&
        locked.analysis.dangerous &&
        roomMemory.towerTargetUntil > Game.time &&
        !criticalThreatBreak &&
        (!best || best.score <= locked.score * 1.35)
    ) {
        return locked;
    }

    if (best) {
        roomMemory.towerTargetId = best.target.id;
        roomMemory.towerTargetUntil = Game.time + TOWER_TARGET_LOCK_TICKS;
        roomMemory.towerTargetScore = Math.round(best.score);
    }
    return best;
}

function getTowerEffectMultiplier(tower) {
    if (!tower || !tower.effects || typeof PWR_OPERATE_TOWER === 'undefined') {
        return 1;
    }
    for (var i = 0; i < tower.effects.length; i++) {
        var effect = tower.effects[i];
        if (effect && effect.effect === PWR_OPERATE_TOWER) {
            return 1 + Math.max(0, effect.level || 0) * 0.1;
        }
    }
    return 1;
}

function getTowerPowerAtRange(basePower, range) {
    if (range <= 5) {
        return basePower;
    }
    if (range >= 20) {
        return basePower * 0.25;
    }
    return basePower * (1 - 0.75 * (range - 5) / 15);
}

function getTowerAttackDamage(towers, target) {
    var damage = 0;
    for (var i = 0; i < towers.length; i++) {
        var tower = towers[i];
        if (getTowerEnergy(tower) < 10) {
            continue;
        }
        var range = combatThreat.getRange(tower.pos, target.pos);
        damage += getTowerPowerAtRange(600, range) *
            getTowerEffectMultiplier(tower);
    }
    return Math.round(damage);
}

function evaluateTowerTarget(room, towers, target, enemies) {
    var analysis = combatThreat.analyze(target, room);
    var rawDamage = getTowerAttackDamage(towers, target);
    var actualDamage = combatThreat.estimateDamageAfterTough(target, rawDamage);
    var healing = combatThreat.getHealingSupport(target, enemies);
    var netDamage = actualDamage - healing;
    var killable = actualDamage >= (target.hits || 0) + healing;
    var score = analysis.totalThreat;

    score += killable ? 5000 : 0;
    score += netDamage > 0 ? 1000 + Math.min(1000, netDamage) : -2000;
    score += analysis.category === 'healer' ? 350 : 0;
    score += analysis.strategicThreat;

    return {
        target: target,
        analysis: analysis,
        rawDamage: rawDamage,
        actualDamage: actualDamage,
        hostileHealing: healing,
        netDamage: netDamage,
        killable: killable,
        score: score
    };
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
        if (getTowerEnergy(tower) < 10) {
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

    var targets = [target];
    if (towers.length > 1) {
        var candidates = findRepairCandidates(room);
        for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
            if (candidates[candidateIndex].id === target.id) {
                continue;
            }
            targets.push(candidates[candidateIndex]);
            if (targets.length >= towers.length) {
                break;
            }
        }
    }

    for (var i = 0; i < towers.length; i++) {
        var tower = towers[i];

        /*
         * Keep a defensive energy reserve. A low-energy tower should wait so it
         * can still help if enemies arrive soon.
         */
        if (getTowerEnergy(tower) < TOWER_REPAIR_MIN_ENERGY) {
            continue;
        }

        /*
         * The target came from Game.getObjectById or room.find, so it is a real
         * structure object. Repairing only happens after all hostile checks.
         */
        var repairTarget = targets.length > 1 ?
            targets[Math.min(i, targets.length - 1)] : target;
        tower.repair(repairTarget);
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

    /*
     * Scanning every structure in the room costs CPU. If the last scan found
     * nothing to repair, wait a few ticks before scanning again. Remembered
     * targets are still checked every tick above.
     */
    if (!shouldScanForRepairTarget(room)) {
        return null;
    }

    var newTarget = findBestRepairTarget(room);

    if (newTarget) {
        rememberRepairTarget(room, newTarget);
        return newTarget;
    }

    setNextRepairScan(room);
    return null;
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
     * of object. Roads are not wanted, so old remembered road targets are
     * cleared here before any tower can repair them.
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

    var roomMemory = getTowerRoomMemory(room);

    roomMemory.towerRepairTargetId = target.id;

    /*
     * A real target was found, so no scan cooldown is needed right now.
     */
    delete roomMemory.towerRepairNextScan;
}

/*
 * Clear the saved repair target ID.
 */
function clearRepairTarget(room) {
    var roomMemory = getTowerRoomMemory(room);
    delete roomMemory.towerRepairTargetId;
}

/*
 * Decide if it is time to scan all structures for a new repair target.
 */
function shouldScanForRepairTarget(room) {
    var roomMemory = getTowerRoomMemory(room);

    if (typeof roomMemory.towerRepairNextScan !== 'number') {
        return true;
    }

    return Game.time >= roomMemory.towerRepairNextScan;
}

/*
 * After a scan finds no work, wait 10 ticks before scanning every structure
 * again. This saves CPU in rooms where nothing needs tower repair.
 */
function setNextRepairScan(room) {
    getTowerRoomMemory(room).towerRepairNextScan = Game.time + 10;
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
    if (structure.structureType === STRUCTURE_SPAWN) {
        return 1;
    }

    if (structure.structureType === STRUCTURE_TOWER) {
        return 2;
    }

    if (structure.structureType === STRUCTURE_STORAGE) {
        return 3;
    }

    if (structure.structureType === STRUCTURE_CONTAINER) {
        return 4;
    }

    if (structure.structureType === STRUCTURE_EXTENSION) {
        return 5;
    }

    if (structure.structureType === STRUCTURE_RAMPART) {
        return 6;
    }

    if (structure.structureType === STRUCTURE_WALL) {
        return 7;
    }

    return 999;
}

function getTowerEnergy(tower) {
    if (!tower) {
        return 0;
    }
    if (tower.store && typeof tower.store.getUsedCapacity === 'function') {
        return tower.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    }
    if (tower.store) {
        return tower.store[RESOURCE_ENERGY] || 0;
    }
    return typeof tower.energy === 'number' ? tower.energy : 0;
}

function healWithAllTowers(towers, target) {
    for (var i = 0; i < towers.length; i++) {
        if (getTowerEnergy(towers[i]) >= 10) {
            towers[i].heal(target);
        }
    }
}

function getIncomingDamage(target, enemies) {
    var incoming = 0;
    for (var i = 0; i < enemies.length; i++) {
        var analysis = combatThreat.analyze(enemies[i], target.room);
        var range = combatThreat.getRange(enemies[i].pos, target.pos);
        if (range <= 1) {
            incoming += analysis.attackPower;
        }
        if (range <= 3) {
            incoming += analysis.rangedPower;
        }
    }
    return incoming;
}

function chooseEndangeredDefender(room, enemies) {
    var creeps = tickCache.getMyCreepsInRoom(room);
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < creeps.length; i++) {
        var creep = creeps[i];
        if (!creep || creep.hits >= creep.hitsMax) {
            continue;
        }
        var role = creep.memory && creep.memory.role;
        if (role !== 'Ronin' && role !== 'Volley' && role !== 'Cleric') {
            continue;
        }
        var ratio = creep.hits / Math.max(1, creep.hitsMax);
        var incoming = getIncomingDamage(creep, enemies);
        if (ratio > 0.35 && incoming < creep.hits) {
            continue;
        }
        var score = (1 - ratio) * 1000 + incoming;
        if (!best || score > bestScore) {
            best = creep;
            bestScore = score;
        }
    }
    return best;
}

function choosePeacefulHealTarget(room) {
    var creeps = tickCache.getMyCreepsInRoom(room);
    var best = null;
    var bestRatio = 1;
    for (var i = 0; i < creeps.length; i++) {
        if (!creeps[i] || creeps[i].hits >= creeps[i].hitsMax) {
            continue;
        }
        var ratio = creeps[i].hits / Math.max(1, creeps[i].hitsMax);
        if (!best || ratio < bestRatio) {
            best = creeps[i];
            bestRatio = ratio;
        }
    }
    return best;
}

function clearTowerTarget(room) {
    var roomMemory = getTowerRoomMemory(room);
    delete roomMemory.towerTargetId;
    delete roomMemory.towerTargetUntil;
    delete roomMemory.towerTargetScore;
}

function saveDefenseState(room, enemies, evaluation, action, healTarget) {
    var summary = combatThreat.getRoomSummary(room, enemies);
    lastDefenseStateByRoom[room.name] = {
        tick: Game.time,
        action: action,
        hostileCount: summary.hostileCount,
        harmfulHostileCount: summary.harmfulHostileCount,
        totalThreat: summary.totalThreat,
        targetId: evaluation && evaluation.target ? evaluation.target.id : null,
        targetCategory: evaluation ? evaluation.analysis.category : null,
        rawDamage: evaluation ? evaluation.rawDamage : 0,
        actualDamage: evaluation ? evaluation.actualDamage : 0,
        hostileHealing: evaluation ? evaluation.hostileHealing : 0,
        netDamage: evaluation ? evaluation.netDamage : 0,
        killable: evaluation ? evaluation.killable : false,
        healTargetId: healTarget ? healTarget.id : null
    };
}

/*
 * Find the best new repair target in the room.
 *
 * Priority order:
 * 1. Spawns
 * 2. Towers
 * 3. Storage
 * 4. Containers
 * 5. Extensions
 * 6. Ramparts
 * 7. Walls
 *
 * Roads are not listed because towers should never repair roads.
 */
function findBestRepairTarget(room) {
    var repairableStructures = findRepairCandidates(room);

    return repairableStructures.length > 0 ? repairableStructures[0] : null;
}

function findRepairCandidates(room) {
    var structures = tickCache.getRoomStructures(room);
    var repairableStructures = [];
    for (var i = 0; i < structures.length; i++) {
        if (
            isWantedRepairStructure(structures[i]) &&
            structureNeedsTowerRepair(room, structures[i])
        ) {
            repairableStructures.push(structures[i]);
        }
    }

    repairableStructures.sort(function(a, b) {
        var priorityA = getRepairPriority(a);
        var priorityB = getRepairPriority(b);

        if (priorityA !== priorityB) {
            return priorityA - priorityB;
        }

        return getRepairHitsPercent(room, a) - getRepairHitsPercent(room, b);
    });

    return repairableStructures;
}

/*
 * Only these structures are repaired by towers.
 */
function isWantedRepairStructure(structure) {
    return structure.structureType === STRUCTURE_SPAWN ||
        structure.structureType === STRUCTURE_TOWER ||
        structure.structureType === STRUCTURE_STORAGE ||
        structure.structureType === STRUCTURE_CONTAINER ||
        structure.structureType === STRUCTURE_EXTENSION ||
        structure.structureType === STRUCTURE_RAMPART ||
        structure.structureType === STRUCTURE_WALL;
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

TowerLogic.chooseTowerTarget = chooseTowerTarget;
TowerLogic.evaluateTowerTarget = evaluateTowerTarget;
TowerLogic.getTowerAttackDamage = getTowerAttackDamage;
TowerLogic.getTowerPowerAtRange = getTowerPowerAtRange;
TowerLogic.getLastDefenseState = function(roomName) {
    return lastDefenseStateByRoom[roomName] || null;
};

module.exports = TowerLogic;
