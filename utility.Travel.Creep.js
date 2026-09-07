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
var HiveMemory = require('HiveMind.Memory');

var ROUTE_CACHE_TTL = 10000;
var ROUTE_CACHE_CLEANUP_INTERVAL = 750;
var ROUTE_CACHE_LOW_BUCKET = 1000;
var ROUTE_CACHE_MAX_CPU_BUFFER = 5;
var ROUTE_CACHE_STUCK_THRESHOLD = 3;
var ROUTE_CACHE_MAX_ROUTES_PER_ROOM = 75;

/*
 * Shared route cache is an opportunistic accelerator for stable same-room
 * logistics lanes: storage/terminal/controller/container/spawn/source routes
 * that many creeps may reuse over time.
 *
 * It is deliberately not the source of truth for movement. If a creep cannot
 * use a cached lane this tick, the caller falls back to Traveler so the creep
 * can still path normally.
 */
var ROUTE_FOLLOW_ROUTE_BAD = 'routeBad';
var ROUTE_FOLLOW_CREEP_OFF_ROUTE = 'creepOffRoute';
var ROUTE_FOLLOW_CREEP_STUCK = 'creepStuck';
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
 * Return true when a position is on a room exit tile.
 *
 * @param {RoomPosition} pos
 * @returns {boolean}
 */
function isOnExitTile(pos) {
    if (!pos || pos.x === undefined || pos.y === undefined) {
        return false;
    }

    return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;
}

/**
 * Get the nearest position one tile inward from a room exit.
 *
 * Corner exits move both coordinates inward so the destination is not still
 * on another exit edge.
 *
 * @param {RoomPosition} pos
 * @returns {RoomPosition|null}
 */
function getInwardExitPosition(pos) {
    if (!isOnExitTile(pos) || !pos.roomName) {
        return null;
    }

    var x = pos.x;
    var y = pos.y;

    if (x === 0) {
        x = 1;
    } else if (x === 49) {
        x = 48;
    }

    if (y === 0) {
        y = 1;
    } else if (y === 49) {
        y = 48;
    }

    return new RoomPosition(x, y, pos.roomName);
}

/**
 * Move a creep inward after it crosses a room exit.
 *
 * Returns false when the creep is not on an exit. Returns true when the exit
 * position was handled, including when another move was already requested this
 * tick.
 *
 * @param {Creep} creep
 * @returns {boolean}
 */
function moveOffExit(creep) {
    if (!creep || !creep.memory || !isOnExitTile(creep.pos)) {
        return false;
    }

    /*
     * Do not clear movement memory or submit a second move when another system
     * already handled this creep during the current tick.
     */
    if (creep.memory._sushiMoveTick === Game.time) {
        return true;
    }

    var inwardPosition = getInwardExitPosition(creep.pos);

    if (!inwardPosition) {
        return false;
    }

    /*
     * The previous room path may point back through the exit. Clear it before
     * asking Traveler and the traffic manager for the one-tile inward shove.
     */
    delete creep.memory._trav;
    delete creep.memory._move;
    delete creep.memory._sushiRoute;

    move(creep, inwardPosition, {
        range: 0,
        maxRooms: 1,
        reusePath: 0,
        disableSharedRouteCache: true
    });

    return true;
}

/**
 * Read Sushi's movement feature switch.
 *
 * Default is enabled. Set Memory.config.general.useTrafficManager = false in the
 * console if traffic movement causes trouble and Sushi should use direct moves.
 *
 * @returns {boolean}
 */
function shouldUseTrafficManager() {
    return HiveMemory.getConfig('general').useTrafficManager !== false;
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
    /*
     * A stable target key is allowed only for durable logistics targets. The
     * route cache should not learn routes to arbitrary moving creeps or short
     * lived objects, because those destinations make poor shared lanes.
     */
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

function getStableAnchors(room) {
    if (!room) {
        return [];
    }

    /*
     * nearbyStableObjectKey() can run once per moving creep. Scanning room
     * structures and sources every time is wasteful, so this cache stores the
     * stable anchors once per room per tick and every movement call reuses it.
     */
    if (!global.__sushiStableAnchors) {
        global.__sushiStableAnchors = {};
    }

    var cached = global.__sushiStableAnchors[room.name];
    if (cached && cached.tick === Game.time) {
        return cached.objects;
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

    global.__sushiStableAnchors[room.name] = {
        tick: Game.time,
        objects: objects
    };

    return objects;
}

function nearbyStableObjectKey(room, pos) {
    if (!room || !pos || room.name !== pos.roomName) {
        return null;
    }

    /*
     * The anchor groups movement by durable logistics landmarks, while
     * makeRouteKey() appends the exact creep tile. That keeps CPU-saving route
     * reuse where it is safe without pretending all tiles around an anchor are
     * interchangeable.
     */
    var objects = getStableAnchors(room);
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

    /*
     * The anchor name keeps routes grouped by stable logistics lane, but the
     * exact start tile keeps the saved path honest. Two creeps near the same
     * container can stand on different tiles, and those are different route
     * variants.
     */
    return fromKey + ':' + creep.pos.x + ':' + creep.pos.y + '|' + toKey + '|' + range;
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

        if (isBlockingStructure(structure)) {
            costs.set(structure.pos.x, structure.pos.y, 255);
        }
    }

    /*
     * Non-road construction sites reserve tiles that can become blocking
     * structures after any tick. Shared routes planned through those sites go
     * stale as soon as the site appears, so avoid them while planning too.
     */
    var sites = room.find(FIND_CONSTRUCTION_SITES);
    for (var j = 0; j < sites.length; j++) {
        if (isBlockingConstructionSite(sites[j])) {
            costs.set(sites[j].pos.x, sites[j].pos.y, 255);
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

function isBlockingStructure(structure) {
    if (!structure) {
        return false;
    }

    if (structure.structureType === STRUCTURE_ROAD || structure.structureType === STRUCTURE_CONTAINER) {
        return false;
    }

    if (structure.structureType === STRUCTURE_RAMPART) {
        return !structure.my && !structure.isPublic;
    }

    return (
        typeof OBSTACLE_OBJECT_TYPES !== 'undefined' &&
        OBSTACLE_OBJECT_TYPES.indexOf(structure.structureType) !== -1
    );
}

function isBlockingConstructionSite(site) {
    if (!site) {
        return false;
    }

    return !(
        site.structureType === STRUCTURE_ROAD ||
        site.structureType === STRUCTURE_CONTAINER ||
        site.structureType === STRUCTURE_RAMPART
    );
}

function hasBlockingObstacle(pos) {
    var room = Game.rooms[pos.roomName];
    if (!room) {
        return false;
    }

    var structures = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);
    for (var i = 0; i < structures.length; i++) {
        if (isBlockingStructure(structures[i])) {
            return true;
        }
    }

    var sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y);
    for (var j = 0; j < sites.length; j++) {
        if (isBlockingConstructionSite(sites[j])) {
            return true;
        }
    }

    return false;
}

function planSharedRoute(creep, targetPosition, range, routeKey) {
    /*
     * Shared route planning uses PathFinder directly instead of Traveler because
     * this cache wants the whole serialized lane stored at room level. Traveler
     * still remains the fallback for any creep that cannot use the lane.
     */
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

function makeRouteFollowResult(code, reason, deleteRoute, clearCreepRoute, invalidatedByObstacle) {
    /*
     * Raw Screeps return codes are not specific enough here. ERR_NOT_FOUND can
     * mean "this creep is not near the lane" or "the saved route is unusable".
     *
     * deleteRoute affects the shared room cache. clearCreepRoute affects only
     * this creep's local progress pointer. Keeping those side effects separate
     * is what prevents one bad join attempt from deleting a valid shared lane.
     */
    return {
        code: code,
        reason: reason,
        deleteRoute: deleteRoute === true,
        clearCreepRoute: clearCreepRoute === true,
        invalidatedByObstacle: invalidatedByObstacle === true
    };
}

function clearCachedMovementForFreshPath(creep) {
    if (!creep || !creep.memory) {
        return;
    }

    delete creep.memory._sushiRoute;
    delete creep.memory._trav;
    delete creep.memory._move;
}

function followSharedRoute(creep, routeKey, route, targetPosition, range, moveOptions) {
    var positions = getRoutePositions(route);
    if (positions.length < 2) {
        /*
         * A cached route with fewer than two decoded positions is corrupt or
         * undecodable. That is route-level proof, so the shared cache entry can
         * be deleted instead of just clearing this creep's local state.
         */
        return makeRouteFollowResult(ERR_NO_PATH, ROUTE_FOLLOW_ROUTE_BAD, true, true);
    }

    var routeMemory = creep.memory._sushiRoute;
    var index;

    if (!routeMemory || routeMemory.routeKey !== routeKey) {
        index = findRouteIndex(creep, positions);
        if (index < 0) {
            /*
             * Shared route cache is for stable logistics lanes. One creep being
             * unable to join this route from its current tile does not prove the
             * room route is bad; fall back to Traveler for this creep only.
             */
            return makeRouteFollowResult(ERR_NOT_FOUND, ROUTE_FOLLOW_CREEP_OFF_ROUTE, false, true);
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

    /*
     * Stuck detection is creep-local. Traffic, fatigue, another creep, or
     * temporary positioning can stop one creep without making the cached lane
     * invalid for everyone else.
     */
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
        return makeRouteFollowResult(ERR_TIRED, ROUTE_FOLLOW_CREEP_STUCK, false, true);
    }

    index = findRouteIndex(creep, positions);
    if (index < 0) {
        /*
         * The creep drifted away from the lane after joining it. Clear this
         * creep's pointer and let Traveler rejoin or choose a different path.
         */
        return makeRouteFollowResult(ERR_NOT_FOUND, ROUTE_FOLLOW_CREEP_OFF_ROUTE, false, true);
    }

    if (index >= positions.length - 1 || creep.pos.inRangeTo(targetPosition, range)) {
        return makeRouteFollowResult(OK, null, false, false);
    }

    var nextPosition = positions[index + 1];
    if (hasBlockingObstacle(nextPosition)) {
        /*
         * Delete shared routes only when there is strong proof that the route
         * itself is invalid. Construction sites count here because a saved lane
         * through an extension/spawn/etc. site will keep producing stale traffic
         * intents and may become a blocking structure after any tick.
         */
        clearCachedMovementForFreshPath(creep);
        return makeRouteFollowResult(ERR_NO_PATH, ROUTE_FOLLOW_ROUTE_BAD, true, true, true);
    }

    routeMemory.pathIndex = index;
    route.lastUsed = Game.time;
    route.uses = (route.uses || 0) + 1;

    return makeRouteFollowResult(
        requestMove(creep, creep.pos.getDirectionTo(nextPosition), moveOptions),
        null,
        false,
        false
    );
}

function samePackedPosition(a, b) {
    return a && b && a.x === b.x && a.y === b.y && a.roomName === b.roomName;
}

function applyRouteFollowResult(creep, cache, routeKey, followResult, moveOptions) {
    if (!followResult) {
        return null;
    }

    /*
     * Apply cache cleanup before deciding whether to fall back. A null return
     * means "shared route did not produce a usable movement result; continue to
     * Traveler". It does not imply that the shared route was deleted.
     */
    if (followResult.deleteRoute) {
        delete cache.routes[routeKey];

        if (followResult.invalidatedByObstacle) {
            cache.invalidatedByObstacle = (cache.invalidatedByObstacle || 0) + 1;
        }
    }

    if (followResult.clearCreepRoute) {
        delete creep.memory._sushiRoute;
    }

    if (followResult.reason === ROUTE_FOLLOW_ROUTE_BAD) {
        delete creep.memory._trav;
        delete creep.memory._move;

        if (moveOptions) {
            moveOptions.freshMatrix = true;
            moveOptions.reusePath = 0;
        }
    }

    if (
        followResult.code === ERR_NOT_FOUND ||
        followResult.code === ERR_NO_PATH ||
        followResult.reason === ROUTE_FOLLOW_CREEP_OFF_ROUTE ||
        followResult.reason === ROUTE_FOLLOW_CREEP_STUCK ||
        followResult.reason === ROUTE_FOLLOW_ROUTE_BAD
    ) {
        return null;
    }

    return followResult.code;
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

    /*
     * Prefer the creep's active route memory when the destination and range
     * still match. If the target changed, the old per-creep pointer is not
     * trusted, even if the old shared route remains valid for another caller.
     */
    if (
        activeRouteMemory &&
        activeRouteMemory.routeKey &&
        activeRouteMemory.range === range &&
        samePackedPosition(activeRouteMemory.destination, packPosition(targetPosition))
    ) {
        routeKey = activeRouteMemory.routeKey;
        route = cache.routes[routeKey];

        if (isRouteFresh(route)) {
            var activeFollow = followSharedRoute(creep, routeKey, route, targetPosition, range, moveOptions);
            var activeResult = applyRouteFollowResult(creep, cache, routeKey, activeFollow, moveOptions);
            if (activeResult !== null) {
                return activeResult;
            }

            if (activeFollow && activeFollow.reason === ROUTE_FOLLOW_ROUTE_BAD) {
                return null;
            }
        } else if (route) {
            /*
             * Staleness is a route-level condition: the cache entry has aged
             * beyond its TTL, so remove it and let a future movement replan.
             */
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
            /*
             * Same stale-route rule for routes found by the current key. This
             * is different from a creep-local join failure, which only clears
             * creep.memory._sushiRoute and falls back to Traveler.
             */
            delete cache.routes[routeKey];
        }

        route = planSharedRoute(creep, targetPosition, range, routeKey);
    }

    if (!route) {
        return null;
    }

    /*
     * One creep failing to join a route, getting stuck behind traffic, or being
     * on the wrong side of a structure should not delete a room-level logistics
     * lane. Deletion is reserved for stale, corrupt, or permanently blocked
     * routes; otherwise this creep simply falls back to Traveler.
     */
    return applyRouteFollowResult(
        creep,
        cache,
        routeKey,
        followSharedRoute(creep, routeKey, route, targetPosition, range, moveOptions),
        moveOptions
    );
}

function cleanupRouteCaches() {
    if (!Memory.rooms || Game.time % ROUTE_CACHE_CLEANUP_INTERVAL !== 0) {
        return;
    }

    /*
     * Periodic cleanup handles old shared lanes that no creep has used in a
     * while. This is intentionally separate from follow failure handling so a
     * temporary traffic problem does not evict useful route infrastructure.
     */
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

    /*
     * Terrain is room-scoped and immutable during this run, so build it once
     * before walking cached route positions instead of recreating it inside the
     * inner loop for every candidate road tile.
     */
    var terrain = Game.map.getRoomTerrain(room.name);

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
function requestMove(creep, direction, options) {
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
            options = options || {};
            return creep.registerMove(direction, {
                priority: options.trafficPriority,
                fixed: options.trafficFixed === true,
                squadId: options.squadId,
                operationId: options.operationId,
                fallbackPositions: options.fallbackPositions,
                remoteRoute: options.remoteRoute
            });
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

    // Saved remote geometry already supplies the next tile. Do not pathfind around traffic.
    if (moveOptions.canonicalStep) {
        if (creep.pos.roomName === targetPosition.roomName && creep.pos.getRangeTo(targetPosition) === 1) {
            return moveDirection(creep, creep.pos.getDirectionTo(targetPosition), moveOptions);
        }
        if (creep.pos.roomName !== targetPosition.roomName && isOnExitTile(creep.pos)) {
            var exits = Game.map.describeExits(creep.pos.roomName) || {};
            var crossing = Object.keys(exits).find(function(key) { return exits[key] === targetPosition.roomName; });
            if (crossing) return moveDirection(creep, Number(crossing), moveOptions);
        }
    }

    /*
     * Keep Traveler responsible for pathfinding, path reuse, stuck detection,
     * room routing, and choosing the next direction. This callback only changes
     * how the final one-step move is submitted.
     */
    moveOptions.sushiMoveHandler = function(handlerCreep, direction) {
        return requestMove(handlerCreep, direction, moveOptions);
    };

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
function moveDirection(creep, direction, options) {
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

    var result = requestMove(creep, direction, options);

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
    moveOffExit: moveOffExit,
    requestMove: requestMove,
    shouldUseTrafficManager: shouldUseTrafficManager,
    clearTravelMemory: clearTravelMemory,
    cleanupRouteCaches: cleanupRouteCaches,
    buildRoadsFromRouteCache: buildRoadsFromRouteCache,
    getRoomRouteCache: getRoomRouteCache,
    getRoutePositions: getRoutePositions
};
