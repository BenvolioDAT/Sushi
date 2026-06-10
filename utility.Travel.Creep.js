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
 * - Traffic manager can now resolve the final movement step.
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

var ROUTE_CACHE_TTL = 10000;
var ROUTE_CACHE_CLEANUP_INTERVAL = 750;
var ROUTE_CACHE_LOW_BUCKET = 1000;
var ROUTE_CACHE_MAX_CPU_BUFFER = 5;
var ROUTE_CACHE_STUCK_THRESHOLD = 3;
var ROUTE_CACHE_MAX_ROUTES_PER_ROOM = 75;
var ROUTE_CACHE_ROAD_BUILD_INTERVAL = 1500;
var ROUTE_CACHE_MAX_ROAD_SITES_PER_RUN = 3;

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
 * Read Sushi's movement feature switch.
 *
 * Default is enabled. Set Memory.settings.useTrafficManager = false in the
 * console if traffic movement causes trouble and Sushi should use direct moves.
 *
 * @returns {boolean}
 */
function shouldUseTrafficManager() {
    if (!Memory.settings) {
        Memory.settings = {};
    }

    if (Memory.settings.useTrafficManager === undefined) {
        Memory.settings.useTrafficManager = true;
    }

    return Memory.settings.useTrafficManager !== false;
}

function ensureRoomMemory(roomName) {
    if (!Memory.rooms) {
        Memory.rooms = {};
    }

    if (!Memory.rooms[roomName]) {
        Memory.rooms[roomName] = {};
    }

    return Memory.rooms[roomName];
}

function getRoomRouteCache(roomName) {
    var roomMemory = ensureRoomMemory(roomName);

    if (!roomMemory.routeCache) {
        roomMemory.routeCache = { routes: {} };
    }

    if (!roomMemory.routeCache.routes) {
        roomMemory.routeCache.routes = {};
    }

    return roomMemory.routeCache;
}

function packPosition(pos) {
    return {
        x: pos.x,
        y: pos.y,
        roomName: pos.roomName
    };
}

function makeRoomPosition(pos) {
    return new RoomPosition(pos.x, pos.y, pos.roomName);
}

function stableTargetKey(target, targetPosition) {
    if (!target || !targetPosition) {
        return null;
    }

    if (target.id) {
        if (target.structureType) {
            if (
                target.structureType === STRUCTURE_STORAGE ||
                target.structureType === STRUCTURE_TERMINAL ||
                target.structureType === STRUCTURE_CONTAINER ||
                target.structureType === STRUCTURE_SPAWN ||
                target.structureType === STRUCTURE_CONTROLLER
            ) {
                return target.structureType + ':' + target.id;
            }

            return null;
        }

        if (target.energyCapacity !== undefined || target.mineralType !== undefined) {
            return 'source:' + target.id;
        }
    }

    if (target.structureType === STRUCTURE_CONTROLLER || target.my !== undefined && target.level !== undefined) {
        return 'controller:' + target.id;
    }

    return null;
}

function nearbyStableObjectKey(room, pos) {
    if (!room || !pos || room.name !== pos.roomName) {
        return null;
    }

    var objects = [];

    if (room.storage) {
        objects.push(room.storage);
    }

    if (room.terminal) {
        objects.push(room.terminal);
    }

    if (room.controller) {
        objects.push(room.controller);
    }

    var structures = room.find(FIND_STRUCTURES);
    for (var i = 0; i < structures.length; i++) {
        if (
            structures[i].structureType === STRUCTURE_CONTAINER ||
            structures[i].structureType === STRUCTURE_SPAWN
        ) {
            objects.push(structures[i]);
        }
    }

    var sources = room.find(FIND_SOURCES);
    for (var j = 0; j < sources.length; j++) {
        objects.push(sources[j]);
    }

    var best = null;
    var bestRange = 2;

    for (var k = 0; k < objects.length; k++) {
        if (!objects[k] || !objects[k].pos) {
            continue;
        }

        var range = pos.getRangeTo(objects[k].pos);
        if (range <= bestRange) {
            best = objects[k];
            bestRange = range;
        }
    }

    if (!best) {
        return 'pos:' + pos.roomName + ':' + pos.x + ':' + pos.y;
    }

    return stableTargetKey(best, best.pos) || ('pos:' + pos.roomName + ':' + pos.x + ':' + pos.y);
}

function makeRouteKey(creep, target, targetPosition, range) {
    if (!creep || !creep.room || !targetPosition) {
        return null;
    }

    if (creep.pos.roomName !== targetPosition.roomName) {
        return null;
    }

    var toKey = stableTargetKey(target, targetPosition);
    if (!toKey) {
        return null;
    }

    var fromKey = nearbyStableObjectKey(creep.room, creep.pos);
    if (!fromKey) {
        return null;
    }

    return fromKey + '|' + toKey + '|' + range;
}

function canPlanSharedRoute() {
    if (Game.cpu.bucket !== undefined && Game.cpu.bucket < ROUTE_CACHE_LOW_BUCKET) {
        return false;
    }

    if (Game.cpu.tickLimit !== undefined && Game.cpu.getUsed() > Game.cpu.tickLimit - ROUTE_CACHE_MAX_CPU_BUFFER) {
        return false;
    }

    return true;
}

function isRouteFresh(route) {
    return route && route.path && route.complete && Game.time - route.created <= ROUTE_CACHE_TTL;
}

function buildRouteCostMatrix(roomName) {
    var room = Game.rooms[roomName];
    if (!room) {
        return false;
    }

    var costs = new PathFinder.CostMatrix();
    var structures = room.find(FIND_STRUCTURES);

    for (var i = 0; i < structures.length; i++) {
        var structure = structures[i];

        if (structure.structureType === STRUCTURE_ROAD) {
            costs.set(structure.pos.x, structure.pos.y, 1);
            continue;
        }

        if (structure.structureType === STRUCTURE_CONTAINER) {
            costs.set(structure.pos.x, structure.pos.y, 5);
            continue;
        }

        if (structure.structureType === STRUCTURE_RAMPART && structure.my) {
            continue;
        }

        if (
            typeof OBSTACLE_OBJECT_TYPES !== 'undefined' &&
            OBSTACLE_OBJECT_TYPES.indexOf(structure.structureType) !== -1
        ) {
            costs.set(structure.pos.x, structure.pos.y, 255);
        }
    }

    return costs;
}

function serializeDirectionPath(startPos, path) {
    var serializedPath = '';
    var lastPosition = startPos;

    for (var i = 0; i < path.length; i++) {
        if (path[i].roomName !== lastPosition.roomName) {
            return null;
        }

        serializedPath += lastPosition.getDirectionTo(path[i]);
        lastPosition = path[i];
    }

    return serializedPath;
}

function getRoutePositions(route) {
    if (!route || !route.from || !route.path) {
        return [];
    }

    var positions = [makeRoomPosition(route.from)];
    var pos = positions[0];

    for (var i = 0; i < route.path.length; i++) {
        var direction = parseInt(route.path[i], 10);
        if (!direction) {
            return [];
        }

        var nextPos = positionAtDirection(pos, direction);
        if (!nextPos) {
            return [];
        }

        positions.push(nextPos);
        pos = nextPos;
    }

    return positions;
}

function findRouteIndex(creep, positions) {
    var closestIndex = -1;
    var closestRange = 99;

    for (var i = 0; i < positions.length; i++) {
        if (positions[i].roomName !== creep.pos.roomName) {
            continue;
        }

        var range = creep.pos.getRangeTo(positions[i]);
        if (range < closestRange) {
            closestRange = range;
            closestIndex = i;
        }

        if (range === 0) {
            break;
        }
    }

    if (closestRange > 1) {
        return -1;
    }

    return closestIndex;
}

function positionAtDirection(origin, direction) {
    var offsetX = [0, 0, 1, 1, 1, 0, -1, -1, -1];
    var offsetY = [0, -1, -1, 0, 1, 1, 1, 0, -1];
    var x = origin.x + offsetX[direction];
    var y = origin.y + offsetY[direction];

    if (x > 49 || x < 0 || y > 49 || y < 0) {
        return null;
    }

    return new RoomPosition(x, y, origin.roomName);
}

function hasBlockingStructure(pos) {
    var room = Game.rooms[pos.roomName];
    if (!room) {
        return false;
    }

    var structures = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);
    for (var i = 0; i < structures.length; i++) {
        var structure = structures[i];

        if (structure.structureType === STRUCTURE_ROAD || structure.structureType === STRUCTURE_CONTAINER) {
            continue;
        }

        if (structure.structureType === STRUCTURE_RAMPART && structure.my) {
            continue;
        }

        if (
            typeof OBSTACLE_OBJECT_TYPES !== 'undefined' &&
            OBSTACLE_OBJECT_TYPES.indexOf(structure.structureType) !== -1
        ) {
            return true;
        }
    }

    return false;
}

function planSharedRoute(creep, targetPosition, range, routeKey) {
    if (!canPlanSharedRoute()) {
        return null;
    }

    var ret = PathFinder.search(creep.pos, { pos: targetPosition, range: range }, {
        maxRooms: 1,
        maxOps: 4000,
        plainCost: 2,
        swampCost: 10,
        roomCallback: buildRouteCostMatrix
    });

    if (ret.incomplete || !ret.path || ret.path.length === 0) {
        return null;
    }

    var path = serializeDirectionPath(creep.pos, ret.path);
    if (!path) {
        return null;
    }

    var cache = getRoomRouteCache(creep.pos.roomName);
    var route = {
        path: path,
        created: Game.time,
        lastUsed: Game.time,
        uses: 0,
        from: packPosition(creep.pos),
        to: packPosition(targetPosition),
        range: range,
        complete: true
    };

    cache.routes[routeKey] = route;
    return route;
}

function followSharedRoute(creep, routeKey, route, targetPosition, range) {
    var positions = getRoutePositions(route);
    if (positions.length < 2) {
        return ERR_NOT_FOUND;
    }

    var routeMemory = creep.memory._sushiRoute;
    var index;

    if (!routeMemory || routeMemory.routeKey !== routeKey) {
        index = findRouteIndex(creep, positions);
        if (index < 0) {
            return ERR_NOT_FOUND;
        }

        routeMemory = {
            routeKey: routeKey,
            pathIndex: index,
            stuck: 0,
            lastX: creep.pos.x,
            lastY: creep.pos.y,
            lastRoom: creep.pos.roomName,
            destination: packPosition(targetPosition),
            range: range
        };
        creep.memory._sushiRoute = routeMemory;
    }

    if (
        routeMemory.lastX === creep.pos.x &&
        routeMemory.lastY === creep.pos.y &&
        routeMemory.lastRoom === creep.pos.roomName
    ) {
        routeMemory.stuck = (routeMemory.stuck || 0) + 1;
    } else {
        routeMemory.stuck = 0;
    }

    routeMemory.lastX = creep.pos.x;
    routeMemory.lastY = creep.pos.y;
    routeMemory.lastRoom = creep.pos.roomName;

    if (routeMemory.stuck >= ROUTE_CACHE_STUCK_THRESHOLD) {
        return ERR_NOT_FOUND;
    }

    index = findRouteIndex(creep, positions);
    if (index < 0) {
        return ERR_NOT_FOUND;
    }

    if (index >= positions.length - 1 || creep.pos.inRangeTo(targetPosition, range)) {
        return OK;
    }

    var nextPosition = positions[index + 1];
    if (hasBlockingStructure(nextPosition)) {
        return ERR_NOT_FOUND;
    }

    routeMemory.pathIndex = index;
    route.lastUsed = Game.time;
    route.uses = (route.uses || 0) + 1;

    return requestMove(creep, creep.pos.getDirectionTo(nextPosition));
}

function samePackedPosition(a, b) {
    return a && b && a.x === b.x && a.y === b.y && a.roomName === b.roomName;
}

function trySharedRoute(creep, target, targetPosition, moveOptions) {
    if (moveOptions.disableSharedRouteCache) {
        return null;
    }

    if (creep.pos.roomName !== targetPosition.roomName) {
        return null;
    }

    var range = moveOptions.range || 1;
    var activeRouteMemory = creep.memory._sushiRoute;
    var cache = getRoomRouteCache(creep.pos.roomName);
    var routeKey;
    var route;

    if (
        activeRouteMemory &&
        activeRouteMemory.routeKey &&
        activeRouteMemory.range === range &&
        samePackedPosition(activeRouteMemory.destination, packPosition(targetPosition))
    ) {
        routeKey = activeRouteMemory.routeKey;
        route = cache.routes[routeKey];

        if (isRouteFresh(route)) {
            var activeResult = followSharedRoute(creep, routeKey, route, targetPosition, range);
            if (activeResult !== ERR_NOT_FOUND && activeResult !== ERR_NO_PATH) {
                return activeResult;
            }

            delete cache.routes[routeKey];
        }

        delete creep.memory._sushiRoute;
    }

    routeKey = makeRouteKey(creep, target, targetPosition, range);
    if (!routeKey) {
        delete creep.memory._sushiRoute;
        return null;
    }

    route = cache.routes[routeKey];

    if (!isRouteFresh(route)) {
        if (route) {
            delete cache.routes[routeKey];
        }

        route = planSharedRoute(creep, targetPosition, range, routeKey);
    }

    if (!route) {
        return null;
    }

    var result = followSharedRoute(creep, routeKey, route, targetPosition, range);
    if (result === ERR_NOT_FOUND || result === ERR_NO_PATH) {
        delete cache.routes[routeKey];
        delete creep.memory._sushiRoute;
        return null;
    }

    return result;
}

function cleanupRouteCaches() {
    if (!Memory.rooms || Game.time % ROUTE_CACHE_CLEANUP_INTERVAL !== 0) {
        return;
    }

    for (var roomName in Memory.rooms) {
        if (!Memory.rooms.hasOwnProperty(roomName)) {
            continue;
        }

        var routeCache = Memory.rooms[roomName].routeCache;
        if (!routeCache || !routeCache.routes) {
            continue;
        }

        var routeKeys = Object.keys(routeCache.routes);
        for (var i = 0; i < routeKeys.length; i++) {
            var route = routeCache.routes[routeKeys[i]];
            if (!route || !route.path || Game.time - (route.lastUsed || route.created || 0) > ROUTE_CACHE_TTL) {
                delete routeCache.routes[routeKeys[i]];
            }
        }

        routeKeys = Object.keys(routeCache.routes);
        if (routeKeys.length <= ROUTE_CACHE_MAX_ROUTES_PER_ROOM) {
            continue;
        }

        routeKeys.sort(function (a, b) {
            return (routeCache.routes[a].lastUsed || 0) - (routeCache.routes[b].lastUsed || 0);
        });

        while (routeKeys.length > ROUTE_CACHE_MAX_ROUTES_PER_ROOM) {
            delete routeCache.routes[routeKeys.shift()];
        }
    }
}

function buildRoadsFromRouteCache(room) {
    if (!room || !room.controller || !room.controller.my) {
        return 0;
    }

    if (Game.time % ROUTE_CACHE_ROAD_BUILD_INTERVAL !== 0) {
        return 0;
    }

    if (Game.cpu.bucket !== undefined && Game.cpu.bucket < ROUTE_CACHE_LOW_BUCKET) {
        return 0;
    }

    var cache = getRoomRouteCache(room.name);
    var keys = Object.keys(cache.routes);
    var built = 0;

    for (var i = 0; i < keys.length && built < ROUTE_CACHE_MAX_ROAD_SITES_PER_RUN; i++) {
        var route = cache.routes[keys[i]];
        if (!isRouteFresh(route) || (route.uses || 0) < 3) {
            continue;
        }

        var positions = getRoutePositions(route);
        for (var j = 1; j < positions.length - 1 && built < ROUTE_CACHE_MAX_ROAD_SITES_PER_RUN; j++) {
            if (positions[j].roomName !== room.name) {
                continue;
            }

            var terrain = Game.map.getRoomTerrain(room.name);
            if (terrain.get(positions[j].x, positions[j].y) === TERRAIN_MASK_WALL) {
                continue;
            }

            if (room.lookForAt(LOOK_STRUCTURES, positions[j].x, positions[j].y).length > 0) {
                continue;
            }

            if (room.lookForAt(LOOK_CONSTRUCTION_SITES, positions[j].x, positions[j].y).length > 0) {
                continue;
            }

            var result = room.createConstructionSite(positions[j], STRUCTURE_ROAD);
            if (result === OK) {
                built++;
            }
        }
    }

    return built;
}

/**
 * Request one step of movement.
 *
 * Flow:
 * - role asks this travel utility to move
 * - Traveler calculates/reuses the path and finds the next direction
 * - this helper registers that direction with traffic manager
 * - main.js runs traffic manager at end of tick
 * - traffic manager performs the real creep.move(direction)
 *
 * @param {Creep} creep
 * @param {number} direction
 * @returns {number}
 */
function requestMove(creep, direction) {
    if (!creep) {
        return ERR_INVALID_ARGS;
    }

    if (
        typeof direction !== 'number' ||
        direction < 1 ||
        direction > 8 ||
        Math.floor(direction) !== direction
    ) {
        return ERR_INVALID_ARGS;
    }

    if (shouldUseTrafficManager()) {
        if (typeof creep.registerMove === 'function') {
            return creep.registerMove(direction);
        }

        /*
         * Safety fallback only:
         * trafficManager.init() should install creep.registerMove during main
         * bootstrap. If that failed, move directly so the bot does not freeze.
         */
        return creep.move(direction);
    }

    return creep.move(direction);
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
     * Keep Traveler responsible for pathfinding, path reuse, stuck detection,
     * room routing, and choosing the next direction. This callback only changes
     * how the final one-step move is submitted.
     */
    moveOptions.sushiMoveHandler = requestMove;

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

    var result = trySharedRoute(creep, target, targetPosition, moveOptions);

    if (result === null) {
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
             * This is outside the traffic-manager path because native moveTo does
             * not expose the final direction for registration.
             */
            result = creep.moveTo(targetPosition, moveOptions);
        }
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
 * Move a creep one step in a direction.
 *
 * Use this for simple movement like:
 *
 * travel.moveDirection(creep, TOP);
 * travel.moveDirection(creep, Math.floor(Math.random() * 8) + 1);
 *
 * Screeps directions are numbers from 1 to 8:
 * 1 is top, then the numbers go clockwise around the creep.
 *
 * @param {Creep} creep
 * @param {number} direction
 * @returns {number} Screeps result code.
 */
function moveDirection(creep, direction) {
    /*
     * Return an error instead of throwing if the caller gives bad input.
     * This keeps role code simple and safe.
     */
    if (!creep || !creep.memory) {
        return ERR_INVALID_ARGS;
    }

    /*
     * Screeps direction numbers are whole numbers from 1 through 8.
     */
    if (
        typeof direction !== 'number' ||
        direction < 1 ||
        direction > 8 ||
        Math.floor(direction) !== direction
    ) {
        return ERR_INVALID_ARGS;
    }

    /*
     * Do not let the same creep move more than once in the same tick.
     */
    if (creep.memory._sushiMoveTick === Game.time) {
        return ERR_BUSY;
    }

    var result = requestMove(creep, direction);

    /*
     * These results mean the wrapper safely handled this tick's movement
     * request, even if the creep could not physically move right now.
     */
    if (
        result === OK ||
        result === ERR_BUSY ||
        result === ERR_TIRED ||
        result === ERR_NO_BODYPART
    ) {
        creep.memory._sushiMoveTick = Game.time;
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
    delete creep.memory._sushiRoute;
    delete creep.memory._sushiMoveTick;
}
// ============================================================================
// Exports
// ============================================================================
module.exports = {
    move: move,
    moveToRoom: moveToRoom,
    moveDirection: moveDirection,
    requestMove: requestMove,
    shouldUseTrafficManager: shouldUseTrafficManager,
    clearTravelMemory: clearTravelMemory,
    cleanupRouteCaches: cleanupRouteCaches,
    buildRoadsFromRouteCache: buildRoadsFromRouteCache,
    getRoomRouteCache: getRoomRouteCache,
    getRoutePositions: getRoutePositions
};
