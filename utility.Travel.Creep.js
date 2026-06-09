/*
 * utility.Travel.Creep.js
 *
 * Sushi movement wrapper.
 *
 * Role files call this module instead of calling native movement helpers
 * directly.
 *
 * Movement now happens in two phases:
 * 1. Role logic asks this wrapper to move. The wrapper pathfinds one next tile
 *    and calls creep.registerMove(nextPosition).
 * 2. main.js runs traffic_manager after all roles. The traffic manager resolves
 *    collisions, swaps, and pushes, then sends the final native move commands.
 */

var PATH_MEMORY_KEY = '_hm';

var DEFAULT_RANGE = 1;
var DEFAULT_REUSE_PATH = 10;
var DEFAULT_PLAIN_COST = 2;
var DEFAULT_SWAMP_COST = 10;
var DEFAULT_MAX_OPS = 2000;
var DEFAULT_MAX_ROOMS = 16;
var STUCK_REPATH_TICKS = 3;
var BLOCKED_COST = 255;
var costMatrixCacheTick = -1;
var costMatrixCache = {};

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
    if(!target) {
        return null;
    }

    if(
        target.x !== undefined &&
        target.y !== undefined &&
        target.roomName !== undefined
    ) {
        return target;
    }

    if(target.pos) {
        return target.pos;
    }

    return null;
}

function buildMoveOptions(options) {
    var moveOptions = {
        range: DEFAULT_RANGE,
        reusePath: DEFAULT_REUSE_PATH,
        plainCost: DEFAULT_PLAIN_COST,
        swampCost: DEFAULT_SWAMP_COST,
        maxOps: DEFAULT_MAX_OPS,
        maxRooms: DEFAULT_MAX_ROOMS
    };

    if(options) {
        for(var key in options) {
            if(options.hasOwnProperty(key)) {
                moveOptions[key] = options[key];
            }
        }
    }

    if(moveOptions.range === undefined || moveOptions.range === null) {
        moveOptions.range = DEFAULT_RANGE;
    }

    return moveOptions;
}

function hasActiveMovePart(creep) {
    if(!creep || !creep.body) {
        return false;
    }

    for(var i = 0; i < creep.body.length; i++) {
        if(creep.body[i].type === MOVE && creep.body[i].hits > 0) {
            return true;
        }
    }

    return false;
}

function getMovementSafetyResult(creep) {
    if(!creep || !creep.memory) {
        return ERR_INVALID_ARGS;
    }

    if(creep.spawning) {
        return ERR_BUSY;
    }

    if(creep.fatigue > 0) {
        return ERR_TIRED;
    }

    if(!hasActiveMovePart(creep)) {
        return ERR_NO_BODYPART;
    }

    return OK;
}

function getPositionKey(position) {
    return position.roomName + ':' + position.x + ':' + position.y;
}

function getTargetKey(targetPosition, range) {
    return getPositionKey(targetPosition) + ':' + range;
}

function getMoveMemory(creep) {
    if(!creep.memory[PATH_MEMORY_KEY]) {
        creep.memory[PATH_MEMORY_KEY] = {};
    }

    return creep.memory[PATH_MEMORY_KEY];
}

function updateStuckMemory(creep) {
    var moveMemory = getMoveMemory(creep);
    var currentPositionKey = getPositionKey(creep.pos);

    if(moveMemory.lastPosition === currentPositionKey) {
        moveMemory.stuck = (moveMemory.stuck || 0) + 1;
    } else {
        moveMemory.stuck = 0;
    }

    moveMemory.lastPosition = currentPositionKey;
    moveMemory.lastTick = Game.time;

    return moveMemory.stuck;
}

function getReuseTicks(moveOptions) {
    if(moveOptions.reusePath === false || moveOptions.reusePath === 0) {
        return 0;
    }

    if(typeof moveOptions.reusePath === 'number') {
        return moveOptions.reusePath;
    }

    return DEFAULT_REUSE_PATH;
}

function positionFromPathStep(step) {
    if(!step) {
        return null;
    }

    return new RoomPosition(step.x, step.y, step.roomName);
}

function isSamePosition(a, b) {
    return (
        a &&
        b &&
        a.x === b.x &&
        a.y === b.y &&
        a.roomName === b.roomName
    );
}

function isExitStep(creep, nextPosition) {
    return (
        creep &&
        nextPosition &&
        nextPosition.roomName !== creep.pos.roomName &&
        (
            creep.pos.x === 0 ||
            creep.pos.x === 49 ||
            creep.pos.y === 0 ||
            creep.pos.y === 49
        )
    );
}

function isUsableNextStep(creep, nextPosition) {
    if(!creep || !nextPosition) {
        return false;
    }

    if(nextPosition.roomName === creep.pos.roomName) {
        return !creep.pos.isEqualTo(nextPosition) && creep.pos.getRangeTo(nextPosition) <= 1;
    }

    return isExitStep(creep, nextPosition);
}

function pruneCachedPath(creep, path) {
    while(path.length > 0) {
        var nextPosition = positionFromPathStep(path[0]);

        if(isSamePosition(creep.pos, nextPosition)) {
            path.shift();
            continue;
        }

        break;
    }
}

function getCachedNextPosition(creep, targetKey, moveOptions, stuckTicks) {
    var moveMemory = creep.memory[PATH_MEMORY_KEY];

    if(!moveMemory || !moveMemory.path || !moveMemory.path.length) {
        return null;
    }

    if(moveMemory.targetKey !== targetKey) {
        return null;
    }

    if(moveMemory.expires < Game.time) {
        return null;
    }

    if(stuckTicks >= STUCK_REPATH_TICKS) {
        return null;
    }

    pruneCachedPath(creep, moveMemory.path);

    if(!moveMemory.path.length) {
        return null;
    }

    var nextPosition = positionFromPathStep(moveMemory.path[0]);

    if(!isUsableNextStep(creep, nextPosition)) {
        return null;
    }

    return nextPosition;
}

function rememberPath(creep, targetKey, path, reuseTicks) {
    var moveMemory = getMoveMemory(creep);

    moveMemory.targetKey = targetKey;
    moveMemory.path = [];
    moveMemory.expires = Game.time + reuseTicks;
    moveMemory.stuck = 0;

    for(var i = 0; i < path.length; i++) {
        moveMemory.path.push({
            x: path[i].x,
            y: path[i].y,
            roomName: path[i].roomName
        });
    }
}

function buildAllowedRooms(creep, targetPosition, moveOptions) {
    if(
        creep.pos.roomName === targetPosition.roomName ||
        typeof moveOptions.routeCallback !== 'function'
    ) {
        return null;
    }

    var allowedRooms = {};
    allowedRooms[creep.pos.roomName] = true;
    allowedRooms[targetPosition.roomName] = true;

    var route;

    try {
        route = Game.map.findRoute(creep.pos.roomName, targetPosition.roomName, {
            routeCallback: moveOptions.routeCallback
        });
    } catch(error) {
        return false;
    }

    if(route === ERR_NO_PATH || !route) {
        return false;
    }

    for(var i = 0; i < route.length; i++) {
        if(route[i] && route[i].room) {
            allowedRooms[route[i].room] = true;
        }
    }

    return allowedRooms;
}

function getPathRoomCallback(moveOptions, allowedRooms) {
    return function(roomName) {
        if(allowedRooms && allowedRooms[roomName] !== true) {
            return false;
        }

        if(typeof moveOptions.roomCallback === 'function') {
            var customMatrix = moveOptions.roomCallback(roomName);

            if(customMatrix === false) {
                return false;
            }

            if(customMatrix) {
                return customMatrix;
            }
        }

        return getRoomCostMatrix(roomName);
    };
}

function findPath(creep, targetPosition, moveOptions) {
    var allowedRooms = buildAllowedRooms(creep, targetPosition, moveOptions);

    if(allowedRooms === false) {
        return null;
    }

    return PathFinder.search(
        creep.pos,
        {
            pos: targetPosition,
            range: moveOptions.range
        },
        {
            plainCost: moveOptions.plainCost,
            swampCost: moveOptions.swampCost,
            maxOps: moveOptions.maxOps,
            maxRooms: moveOptions.maxRooms,
            roomCallback: getPathRoomCallback(moveOptions, allowedRooms)
        }
    );
}

function drawPath(creep, path, style) {
    if(!style || !path || !path.length) {
        return;
    }

    var visiblePath = [creep.pos];

    for(var i = 0; i < path.length; i++) {
        if(path[i].roomName !== creep.room.name) {
            break;
        }

        visiblePath.push(path[i]);
    }

    if(visiblePath.length > 1) {
        new RoomVisual(creep.room.name).poly(visiblePath, style);
    }
}

function getNextPosition(creep, targetPosition, moveOptions) {
    var targetKey = getTargetKey(targetPosition, moveOptions.range);
    var reuseTicks = getReuseTicks(moveOptions);
    var stuckTicks = updateStuckMemory(creep);
    var nextPosition = null;

    if(reuseTicks > 0) {
        nextPosition = getCachedNextPosition(creep, targetKey, moveOptions, stuckTicks);
    }

    if(nextPosition) {
        return nextPosition;
    }

    var pathResult = findPath(creep, targetPosition, moveOptions);

    if(!pathResult || pathResult.incomplete || !pathResult.path || pathResult.path.length === 0) {
        clearTravelMemory(creep);
        return null;
    }

    drawPath(creep, pathResult.path, moveOptions.visualizePathStyle);

    if(reuseTicks > 0) {
        rememberPath(creep, targetKey, pathResult.path, reuseTicks);
    }

    return pathResult.path[0];
}

function rememberMoveAttempt(creep) {
    getMoveMemory(creep).moveTick = Game.time;
}

function getExitDirection(creep, nextPosition) {
    var wantsLeft = creep.pos.x === 0 && nextPosition.x === 49;
    var wantsRight = creep.pos.x === 49 && nextPosition.x === 0;
    var wantsTop = creep.pos.y === 0 && nextPosition.y === 49;
    var wantsBottom = creep.pos.y === 49 && nextPosition.y === 0;

    if(wantsTop && wantsRight) {
        return TOP_RIGHT;
    }

    if(wantsRight && wantsBottom) {
        return BOTTOM_RIGHT;
    }

    if(wantsBottom && wantsLeft) {
        return BOTTOM_LEFT;
    }

    if(wantsLeft && wantsTop) {
        return TOP_LEFT;
    }

    if(wantsTop) {
        return TOP;
    }

    if(wantsRight) {
        return RIGHT;
    }

    if(wantsBottom) {
        return BOTTOM;
    }

    if(wantsLeft) {
        return LEFT;
    }

    return null;
}

function directionLeavesRoom(creep, direction) {
    return (
        (creep.pos.x === 0 && (direction === LEFT || direction === TOP_LEFT || direction === BOTTOM_LEFT)) ||
        (creep.pos.x === 49 && (direction === RIGHT || direction === TOP_RIGHT || direction === BOTTOM_RIGHT)) ||
        (creep.pos.y === 0 && (direction === TOP || direction === TOP_LEFT || direction === TOP_RIGHT)) ||
        (creep.pos.y === 49 && (direction === BOTTOM || direction === BOTTOM_LEFT || direction === BOTTOM_RIGHT))
    );
}

function registerNextStep(creep, nextPosition) {
    if(isExitStep(creep, nextPosition)) {
        /*
         * traffic_manager is room-local and packs only 0..49 room coordinates.
         * A step into another room has no in-room destination tile, so this one
         * border-crossing case uses direct movement.
         */
        var exitDirection = getExitDirection(creep, nextPosition);

        if(!exitDirection) {
            return ERR_NO_PATH;
        }

        creep._skipTrafficMove = true;
        return creep.move(exitDirection);
    }

    if(typeof creep.registerMove !== 'function') {
        return ERR_BUSY;
    }

    creep.registerMove(nextPosition);
    return OK;
}

/**
 * Move a creep toward a target.
 *
 * This is the main function roles should use.
 *
 * Example:
 *
 * travel.move(creep, source, { range: 1 });
 * travel.move(creep, controller, { range: 3 });
 *
 * @param {Creep} creep
 * @param {*} target
 * @param {object} options
 * @returns {number} Screeps result code.
 */
function move(creep, target, options) {
    if(!creep || !target) {
        return ERR_INVALID_ARGS;
    }

    var targetPosition = getTargetPosition(target);

    if(!targetPosition) {
        return ERR_INVALID_TARGET;
    }

    var moveOptions = buildMoveOptions(options);

    if(
        creep.pos.roomName === targetPosition.roomName &&
        creep.pos.inRangeTo(targetPosition, moveOptions.range)
    ) {
        return OK;
    }

    var safetyResult = getMovementSafetyResult(creep);

    if(safetyResult !== OK) {
        return safetyResult;
    }

    if(getMoveMemory(creep).moveTick === Game.time) {
        return ERR_BUSY;
    }

    var nextPosition = getNextPosition(creep, targetPosition, moveOptions);

    if(!nextPosition) {
        rememberMoveAttempt(creep);

        if(typeof creep.say === 'function') {
            creep.say('no path', true);
        }

        return ERR_NO_PATH;
    }

    var result = registerNextStep(creep, nextPosition);

    if(
        result === OK ||
        result === ERR_BUSY ||
        result === ERR_TIRED ||
        result === ERR_NO_BODYPART ||
        result === ERR_NO_PATH
    ) {
        rememberMoveAttempt(creep);
    }

    return result;
}

/**
 * Move a creep to a room.
 *
 * This targets the middle of the room. Once the creep has entered that room,
 * the room movement goal is satisfied and this returns OK.
 *
 * @param {Creep} creep
 * @param {string} roomName
 * @param {object} options
 * @returns {number}
 */
function moveToRoom(creep, roomName, options) {
    if(!creep || !roomName) {
        return ERR_INVALID_ARGS;
    }

    if(creep.room.name === roomName) {
        return OK;
    }

    return move(creep, new RoomPosition(25, 25, roomName), options);
}

/**
 * Move a creep one step in a direction.
 *
 * Use this for simple movement like:
 *
 * travel.moveDirection(creep, TOP);
 *
 * @param {Creep} creep
 * @param {number} direction
 * @returns {number} Screeps result code.
 */
function moveDirection(creep, direction) {
    if(!creep || !creep.memory) {
        return ERR_INVALID_ARGS;
    }

    if(
        typeof direction !== 'number' ||
        direction < 1 ||
        direction > 8 ||
        Math.floor(direction) !== direction
    ) {
        return ERR_INVALID_ARGS;
    }

    var safetyResult = getMovementSafetyResult(creep);

    if(safetyResult !== OK) {
        return safetyResult;
    }

    if(getMoveMemory(creep).moveTick === Game.time) {
        return ERR_BUSY;
    }

    var result;

    if(directionLeavesRoom(creep, direction)) {
        /*
         * Room exits are the only direct movement path. traffic_manager cannot
         * represent a destination tile outside the current room.
         */
        creep._skipTrafficMove = true;
        result = creep.move(direction);
    } else if(typeof creep.registerMove === 'function') {
        creep.registerMove(direction);
        result = OK;
    } else {
        result = ERR_BUSY;
    }

    if(
        result === OK ||
        result === ERR_BUSY ||
        result === ERR_TIRED ||
        result === ERR_NO_BODYPART
    ) {
        rememberMoveAttempt(creep);
    }

    return result;
}

/**
 * Clear this creep's movement cache.
 *
 * Useful if a creep gets stuck, changes jobs, or changes target.
 *
 * @param {Creep} creep
 */
function clearTravelMemory(creep) {
    if(!creep || !creep.memory) {
        return;
    }

    delete creep.memory[PATH_MEMORY_KEY];
    delete creep.memory._sushiTrafficMove;
    delete creep.memory._sushiMoveTick;
    delete creep.memory._trav;
    delete creep.memory._move;
}

function getRoomCostMatrix(roomOrName) {
    var roomName = typeof roomOrName === 'string' ? roomOrName : roomOrName && roomOrName.name;

    if(!roomName) {
        return new PathFinder.CostMatrix();
    }

    if(costMatrixCacheTick !== Game.time) {
        costMatrixCacheTick = Game.time;
        costMatrixCache = {};
    }

    if(costMatrixCache[roomName]) {
        return costMatrixCache[roomName];
    }

    var matrix = new PathFinder.CostMatrix();
    var room = Game.rooms[roomName];

    if(room) {
        addStructuresToMatrix(room, matrix);
        addConstructionSitesToMatrix(room, matrix);
        addFixedObjectsToMatrix(room, matrix);
        addHostileCreepsToMatrix(room, matrix);
    }

    costMatrixCache[roomName] = matrix;
    return matrix;
}

function addStructuresToMatrix(room, matrix) {
    var structures = room.find(FIND_STRUCTURES);

    for(var i = 0; i < structures.length; i++) {
        var structure = structures[i];

        if(structure.structureType === STRUCTURE_ROAD) {
            matrix.set(structure.pos.x, structure.pos.y, 1);
            continue;
        }

        if(isBlockingStructure(structure)) {
            matrix.set(structure.pos.x, structure.pos.y, BLOCKED_COST);
        }
    }
}

function addConstructionSitesToMatrix(room, matrix) {
    var sites = room.find(FIND_CONSTRUCTION_SITES);

    for(var i = 0; i < sites.length; i++) {
        var site = sites[i];

        if(site.structureType === STRUCTURE_ROAD) {
            continue;
        }

        if(isBlockingConstructionSite(site)) {
            matrix.set(site.pos.x, site.pos.y, BLOCKED_COST);
        }
    }
}

function addFixedObjectsToMatrix(room, matrix) {
    blockPositions(room.find(FIND_SOURCES), matrix);

    if(typeof FIND_MINERALS !== 'undefined') {
        blockPositions(room.find(FIND_MINERALS), matrix);
    }

    if(typeof FIND_DEPOSITS !== 'undefined') {
        blockPositions(room.find(FIND_DEPOSITS), matrix);
    }

    if(room.controller) {
        matrix.set(room.controller.pos.x, room.controller.pos.y, BLOCKED_COST);
    }
}

function addHostileCreepsToMatrix(room, matrix) {
    blockPositions(room.find(FIND_HOSTILE_CREEPS), matrix);
}

function blockPositions(objects, matrix) {
    if(!objects) {
        return;
    }

    for(var i = 0; i < objects.length; i++) {
        matrix.set(objects[i].pos.x, objects[i].pos.y, BLOCKED_COST);
    }
}

function isBlockingStructure(structure) {
    if(structure.structureType === STRUCTURE_RAMPART) {
        return !structure.my && !structure.isPublic;
    }

    return OBSTACLE_OBJECT_TYPES.indexOf(structure.structureType) !== -1;
}

function isBlockingConstructionSite(site) {
    return OBSTACLE_OBJECT_TYPES.indexOf(site.structureType) !== -1;
}

module.exports = {
    move: move,
    moveToRoom: moveToRoom,
    moveDirection: moveDirection,
    clearTravelMemory: clearTravelMemory
};
