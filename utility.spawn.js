function genCreepName(creepType) {
    var maxNumber = 100;
    var creepMemory = Memory.creeps || {};

    for (var number = 1; number <= maxNumber; number++) {
        var paddedNumber = '';

        if (number < 10) {
            paddedNumber = '00' + number;
        } else if (number < 100) {
            paddedNumber = '0' + number;
        } else {
            paddedNumber = '' + number;
        }

        var creepName = creepType + '_' + paddedNumber;

        /*
         * Check both:
         * - Game.creeps: alive creeps
         * - Memory.creeps: old memory that may still exist
         *
         * This function does NOT create any memory entry.
         * It only reads memory to avoid name conflicts.
         */
        if (!Game.creeps[creepName] && !creepMemory[creepName]) {
            return creepName;
        }
    }

    /*
     * If all names from 001 to 100 are taken,
     * return null so spawn code knows no name is free.
     */
    return null;
}

/**
 * Get a spawn name without hard-coding "Spawn1".
 *
 * If roomName is given:
 * - only look for spawns in that room
 *
 * If roomName is not given:
 * - return the first spawn we find
 *
 * This prefers an idle spawn, but if all matching spawns are busy,
 * it returns the first matching spawn name anyway.
 *
 * @param {string|undefined} roomName - Optional room name, like "W1N1".
 * @returns {string|null} Spawn name, or null if no spawn was found.
 */
function getSpawnName(roomName) {
    var firstMatchingSpawnName = null;

    for (var spawnName in Game.spawns) {
        if (!Game.spawns.hasOwnProperty(spawnName)) {
            continue;
        }

        var spawn = Game.spawns[spawnName];

        if (!spawn || !spawn.room) {
            continue;
        }

        /*
         * If a room name was given, skip spawns that are not in that room.
         */
        if (roomName && spawn.room.name !== roomName) {
            continue;
        }

        /*
         * Save the first matching spawn as a fallback.
         * This lets us still return a spawn name even if every spawn is busy.
         */
        if (!firstMatchingSpawnName) {
            firstMatchingSpawnName = spawnName;
        }

        /*
         * Best choice: return a spawn that is not currently spawning.
         */
        if (!spawn.spawning) {
            return spawnName;
        }
    }

    return firstMatchingSpawnName;
}
// ============================================================================
// Exports
// ============================================================================
module.exports = {
    genCreepName: genCreepName,
    getSpawnName: getSpawnName
};