/*
 * utility.Travel.Creep.js
 *
 * Sushi movement wrapper.
 *
 * Goal:
 * - Role files should call this wrapper instead of calling creep.moveTo()
 *   or creep.travelTo() directly.
 *
 * Why?
 * - Today this can use Traveler.js.
 * - Later we can change this file to use your own traffic manager.
 * - Your role files will not need to be rewritten.
 */

/*
 * Load Traveler.js.
 *
 * Most Traveler versions add creep.travelTo() onto Creep.prototype
 * when the module is required.
 *
 * This means after this line runs, creeps should be able to use:
 *
 * creep.travelTo(target, options)
 */
require('Traveler');

/**
 * Safely get a RoomPosition from a target.
 *
 * The target can be:
 * - a RoomPosition
 * - a creep
 * - a source
 * - a structure
 * - anything with .pos
 *
 * @param {*} target
 * @returns {RoomPosition|null}
 */
function getTargetPosition(target) {
    /*
     * Many Screeps APIs accept either a RoomPosition or an object with .pos.
     * This helper normalizes both shapes so movement code can be called simply.
     */
    if (!target) {
        return null;
    }

    /*
     * RoomPosition has x, y, and roomName directly.
     */
    if (
        target.x !== undefined &&
        target.y !== undefined &&
        target.roomName !== undefined
    ) {
        return target;
    }

    /*
     * Game objects usually have .pos.
     */
    if (target.pos) {
        return target.pos;
    }

    return null;
}

/**
 * Move a creep toward a target.
 *
 * This is the main function your roles should use.
 *
 * Example:
 *
 * travel.move(creep, source, { range: 1 });
 * travel.move(creep, controller, { range: 3 });
 *
 * @param {Creep} creep - The creep that should move.
 * @param {*} target - RoomPosition or object with .pos.
 * @param {object} options - Optional movement settings.
 * @returns {number} Screeps result code.
 */
function move(creep, target, options) {
    /*
     * Return Screeps error constants instead of throwing. That lets callers
     * inspect the result code if they need to debug movement behavior.
     */
    if (!creep || !target) {
        return ERR_INVALID_ARGS;
    }

    var targetPosition = getTargetPosition(target);

    if (!targetPosition) {
        return ERR_INVALID_TARGET;
    }

    /*
     * Do not let the same creep try to move more than once in one tick.
     *
     * This helps stop role code from accidentally doing:
     * - move to energy
     * - then also move to controller
     *
     * Same-tick double-move bugs are difficult to diagnose because the later
     * move request can silently override the earlier movement plan.
     */
    if (creep.memory._sushiMoveTick === Game.time) {
        return ERR_BUSY;
    }

    /*
     * Default options.
     *
     * range:
     * - 1 means stand beside the target
     *
     * reusePath:
     * - Traveler can reuse paths to save CPU.
     *
     * visualizePathStyle:
     * - simple white line so you can see movement while testing.
     */
    var moveOptions = {
        range: 1,
        reusePath: 10,
        visualizePathStyle: {
            stroke: '#ffffff'
        }
    };

    /*
     * Copy custom options over the defaults.
     *
     * Example:
     * travel.move(creep, controller, { range: 3 });
     */
    if (options) {
        for (var key in options) {
            if (options.hasOwnProperty(key)) {
                moveOptions[key] = options[key];
            }
        }
    }

    /*
     * If the creep is already close enough, do not move.
     * Returning OK here means "movement goal is satisfied", even though no
     * actual move command was sent this tick.
     */
    if (
        creep.pos.roomName === targetPosition.roomName &&
        creep.pos.inRangeTo(targetPosition, moveOptions.range)
    ) {
        return OK;
    }

    var result;

    /*
     * Prefer Traveler if it exists.
     *
     * This lets Sushi use Traveler now, while keeping the role code clean.
     */
    if (typeof creep.travelTo === 'function') {
        result = creep.travelTo(targetPosition, moveOptions);
    } else {
        /*
         * Fallback:
         * If Traveler failed to load for some reason, use normal moveTo.
         */
        result = creep.moveTo(targetPosition, moveOptions);
    }

    /*
     * Mark that this creep already tried to move this tick.
     * This writes to creep.memory._sushiMoveTick so later role logic can avoid
     * issuing a second movement command in the same tick.
     */
    if (
        result === OK ||
        result === ERR_TIRED ||
        result === ERR_NO_PATH ||
        result === ERR_NOT_FOUND
    ) {
        creep.memory._sushiMoveTick = Game.time;
    }

    return result;
}

/**
 * Move a creep to a room.
 *
 * This is useful for scouts, claimers, reservers, and remote workers.
 *
 * It moves toward the center of the room by default.
 *
 * Example:
 *
 * travel.moveToRoom(creep, 'W1N1');
 *
 * @param {Creep} creep
 * @param {string} roomName
 * @param {object} options
 * @returns {number}
 */
function moveToRoom(creep, roomName, options) {
    /*
     * roomName should be a string such as "W1N1". Without a valid creep and
     * target room, there is no safe movement request to make.
     */
    if (!creep || !roomName) {
        return ERR_INVALID_ARGS;
    }

    /*
     * If already in the target room, we are done.
     */
    if (creep.room.name === roomName) {
        return OK;
    }

    /*
     * Move toward the middle of the target room.
     * Traveler can handle moving across rooms to this RoomPosition.
     */
    var targetPosition = new RoomPosition(25, 25, roomName);

    return move(creep, targetPosition, options);
}

/**
 * Clear this creep's movement cache.
 *
 * Useful if a creep gets stuck, changes jobs, or changes target.
 *
 * @param {Creep} creep
 */
function clearTravelMemory(creep) {
    /*
     * Movement caches live inside creep.memory. Clearing them forces future
     * movement calls to calculate a fresh path.
     */
    if (!creep || !creep.memory) {
        return;
    }

    /*
     * Traveler commonly uses creep.memory._trav or creep.memory._move
     * depending on version/settings.
     *
     * Normal moveTo uses creep.memory._move.
     */
    delete creep.memory._trav;
    delete creep.memory._move;
    delete creep.memory._sushiMoveTick;
}
// ============================================================================
// Exports
// ============================================================================
module.exports = {
    move: move,
    moveToRoom: moveToRoom,
    clearTravelMemory: clearTravelMemory
};
