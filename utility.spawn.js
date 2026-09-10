/*
 * utility.spawn.js
 *
 * Small spawn-related helpers.
 *
 * This file does not decide what to spawn. It only provides reusable utilities
 * used by the spawn queue manager, such as safe creep-name generation and spawn
 * selection.
 */
function genCreepName(creepType) {
    const occupied = new Set([...Object.keys(Game.creeps || {}), ...Object.keys(Memory.creeps || {})]);
    for (const spawn of Object.values(Game.spawns || {}).concat(require('Spawn.Intents').get().spawns)) {
        if (spawn.spawning) occupied.add(spawn.spawning.name);
    }
    // N occupied names can block at most N suffixes, so N + 1 always terminates.
    for (let number = 1; number <= occupied.size + 1; number++) {
        const name = creepType + '_' + String(number).padStart(3, '0');
        if (!occupied.has(name)) return name;
    }
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

    /*
     * Loop through all owned spawns. Game.spawns is keyed by spawn name, so
     * spawnName is the string needed later for Game.spawns[spawnName].
     */
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
