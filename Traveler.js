/**
 * To start using Traveler, require it in main.js:
 * Example: var Traveler = require('Traveler.js');
 */
/*
 * Traveler is a movement/pathfinding helper. Sushi's utility.Travel.Creep
 * wrapper loads this file so creeps gain creep.travelTo(destination, options).
 *
 * The important beginner idea:
 * - PathFinder.search calculates a path.
 * - Traveler stores a short path string in creep.memory._trav.
 * - Later ticks reuse that path to save CPU.
 */
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class Traveler {
    /**
     * move creep to destination
     * @param creep
     * @param destination
     * @param options
     * @returns {number}
     */
    static travelTo(creep, destination, options = {}) {
        // uncomment if you would like to register hostile rooms entered
        // this.updateRoomStatus(creep.room);
        /*
         * travelTo is called by a creep. destination can be a RoomPosition or a
         * game object with .pos. Returning ERR_INVALID_ARGS matches Screeps API
         * style instead of throwing a JavaScript error.
         */
        if (!destination) {
            return ERR_INVALID_ARGS;
        }
        /*
         * Fatigue means the creep is too tired to move this tick. Returning
         * ERR_TIRED tells the caller no movement was possible.
         */
        if (creep.fatigue > 0) {
            Traveler.circle(creep.pos, "aqua", .3);
            return ERR_TIRED;
        }
        destination = this.normalizePos(destination);
        // manage case where creep is nearby destination
        let rangeToDestination = creep.pos.getRangeTo(destination);
        /*
         * If the creep is already close enough, there is no need to pathfind.
         * This early exit saves CPU.
         */
        if (options.range && rangeToDestination <= options.range) {
            return OK;
        }
        else if (rangeToDestination <= 1) {
            if (rangeToDestination === 1 && !options.range) {
                let direction = creep.pos.getDirectionTo(destination);
                if (options.returnData) {
                    options.returnData.nextPos = destination;
                    options.returnData.path = direction.toString();
                }
                return Traveler.requestMove(creep, direction, options);
            }
            return OK;
        }
        // initialize data object
        if (!creep.memory._trav) {
            delete creep.memory._travel;
            creep.memory._trav = {};
        }
        /*
         * creep.memory._trav is Traveler's persistent per-creep movement cache.
         * It survives across ticks just like any other creep memory.
         */
        let travelData = creep.memory._trav;
        let state = this.deserializeState(travelData, destination);
        // uncomment to visualize destination
        // this.circle(destination.pos, "orange");
        // check if creep is stuck
        if (this.isStuck(creep, state)) {
            state.stuckCount++;
            Traveler.circle(creep.pos, "magenta", state.stuckCount * .2);
        }
        else {
            state.stuckCount = 0;
        }
        // handle case where creep is stuck
        if (!options.stuckValue) {
            options.stuckValue = DEFAULT_STUCK_VALUE;
        }
        if (state.stuckCount >= options.stuckValue && Math.random() > .5) {
            options.ignoreCreeps = false;
            options.freshMatrix = true;
            delete travelData.path;
        }
        // TODO:handle case where creep moved by some other function, but destination is still the same
        // delete path cache if destination is different
        if (!this.samePos(state.destination, destination)) {
            /*
             * If the destination changed, the old cached path may point to the
             * wrong place. Delete it so a new path can be calculated.
             */
            if (options.movingTarget && state.destination.isNearTo(destination)) {
                travelData.path += state.destination.getDirectionTo(destination);
                state.destination = destination;
            }
            else {
                delete travelData.path;
            }
        }
        if (options.repath && Math.random() < options.repath) {
            // add some chance that you will find a new path randomly
            delete travelData.path;
        }
        // pathfinding
        let newPath = false;
        if (!travelData.path) {
            newPath = true;
            if (creep.spawning) {
                return ERR_BUSY;
            }
            state.destination = destination;
            /*
             * PathFinder can be CPU-heavy, so Traveler measures CPU and reports
             * unusually expensive path searches.
             */
            let cpu = Game.cpu.getUsed();
            let ret = this.findTravelPath(creep.pos, destination, options);
            let cpuUsed = Game.cpu.getUsed() - cpu;
            state.cpu = _.round(cpuUsed + state.cpu);
            if (state.cpu > REPORT_CPU_THRESHOLD) {
                // see note at end of file for more info on this
                console.log(`TRAVELER: heavy cpu use: ${creep.name}, cpu: ${state.cpu} origin: ${creep.pos}, dest: ${destination}`);
            }
            let color = "orange";
            if (ret.incomplete) {
                // uncommenting this is a great way to diagnose creep behavior issues
                // console.log(`TRAVELER: incomplete path for ${creep.name}`);
                color = "red";
            }
            if (options.returnData) {
                options.returnData.pathfinderReturn = ret;
            }
            travelData.path = Traveler.serializePath(creep.pos, ret.path, color);
            state.stuckCount = 0;
        }
        this.serializeState(creep, destination, state, travelData);
        if (!travelData.path || travelData.path.length === 0) {
            return ERR_NO_PATH;
        }
        // consume path
        /*
         * The cached path is a string of direction numbers. After a successful
         * unstuck tick, Traveler removes the first direction so next tick uses
         * the next step.
         */
        if (state.stuckCount === 0 && !newPath) {
            travelData.path = travelData.path.substr(1);
        }
        let nextDirection = parseInt(travelData.path[0], 10);
        if (options.returnData) {
            if (nextDirection) {
                let nextPos = Traveler.positionAtDirection(creep.pos, nextDirection);
                if (nextPos) {
                    options.returnData.nextPos = nextPos;
                }
            }
            options.returnData.state = state;
            options.returnData.path = travelData.path;
        }
        return Traveler.requestMove(creep, nextDirection, options);
    }
    /**
     * Submit the final movement direction.
     *
     * Sushi's travel wrapper provides options.sushiMoveHandler so Traveler can
     * keep pathfinding while traffic manager owns the actual move resolution.
     * Direct Traveler callers still get the old immediate creep.move behavior.
     *
     * @param {Creep} creep
     * @param {number} direction
     * @param {object} options
     * @returns {number}
     */
    static requestMove(creep, direction, options = {}) {
        if (options && typeof options.sushiMoveHandler === "function") {
            return options.sushiMoveHandler(creep, direction);
        }

        return creep.move(direction);
    }
    /**
     * make position objects consistent so that either can be used as an argument
     * @param destination
     * @returns {any}
     */
    static normalizePos(destination) {
        if (!(destination instanceof RoomPosition)) {
            return destination.pos;
        }
        return destination;
    }
    /**
     * check if room should be avoided by findRoute algorithm
     * @param roomName
     * @returns {RoomMemory|number}
     */
    static checkAvoid(roomName) {
        return Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].avoid;
    }
    /**
     * check if a position is an exit
     * @param pos
     * @returns {boolean}
     */
    static isExit(pos) {
        return pos.x === 0 || pos.y === 0 || pos.x === 49 || pos.y === 49;
    }
    /**
     * check two coordinates match
     * @param pos1
     * @param pos2
     * @returns {boolean}
     */
    static sameCoord(pos1, pos2) {
        return pos1.x === pos2.x && pos1.y === pos2.y;
    }
    /**
     * check if two positions match
     * @param pos1
     * @param pos2
     * @returns {boolean}
     */
    static samePos(pos1, pos2) {
        return this.sameCoord(pos1, pos2) && pos1.roomName === pos2.roomName;
    }
    /**
     * draw a circle at position
     * @param pos
     * @param color
     * @param opacity
     */
    static circle(pos, color, opacity) {
        new RoomVisual(pos.roomName).circle(pos, {
            radius: .45, fill: "transparent", stroke: color, strokeWidth: .15, opacity: opacity
        });
    }
    /**
     * update memory on whether a room should be avoided based on controller owner
     * @param room
     */
    static updateRoomStatus(room) {
        if (!room) {
            return;
        }
        if (room.controller) {
            if (room.controller.owner && !room.controller.my) {
                room.memory.avoid = 1;
            }
            else {
                delete room.memory.avoid;
            }
        }
    }
    /**
     * find a path from origin to destination
     * @param origin
     * @param destination
     * @param options
     * @returns {PathfinderReturn}
     */
    static findTravelPath(origin, destination, options = {}) {
        /*
         * This is the main PathFinder wrapper. It builds a room callback so
         * PathFinder knows which terrain, structures, and creeps to avoid.
         */
        _.defaults(options, {
            ignoreCreeps: true,
            maxOps: DEFAULT_MAXOPS,
            range: 1,
        });
        if (options.movingTarget) {
            options.range = 0;
        }
        origin = this.normalizePos(origin);
        destination = this.normalizePos(destination);
        let originRoomName = origin.roomName;
        let destRoomName = destination.roomName;
        // check to see whether findRoute should be used
        let roomDistance = Game.map.getRoomLinearDistance(origin.roomName, destination.roomName);
        let allowedRooms = options.route;
        if (!allowedRooms && (options.useFindRoute || (options.useFindRoute === undefined && roomDistance > 2))) {
            let route = this.findRoute(origin.roomName, destination.roomName, options);
            if (route) {
                allowedRooms = route;
            }
        }
        let roomsSearched = 0;
        let callback = (roomName) => {
            /*
             * PathFinder calls this function for each room it wants to search.
             * Returning false tells PathFinder that room is blocked.
             */
            if (allowedRooms) {
                if (!allowedRooms[roomName]) {
                    return false;
                }
            }
            else if (!options.allowHostile && Traveler.checkAvoid(roomName)
                && roomName !== destRoomName && roomName !== originRoomName) {
                return false;
            }
            roomsSearched++;
            let matrix;
            let room = Game.rooms[roomName];
            if (room) {
                /*
                 * A CostMatrix assigns movement costs to positions in a room.
                 * High values block tiles; low values make tiles preferred.
                 */
                if (options.ignoreStructures) {
                    matrix = new PathFinder.CostMatrix();
                    if (!options.ignoreCreeps) {
                        Traveler.addCreepsToMatrix(room, matrix);
                    }
                }
                else if (options.ignoreCreeps || roomName !== originRoomName) {
                    matrix = this.getStructureMatrix(room, options.freshMatrix);
                }
                else {
                    matrix = this.getCreepMatrix(room);
                }
                if (options.obstacles) {
                    matrix = matrix.clone();
                    for (let obstacle of options.obstacles) {
                        if (obstacle.pos.roomName !== roomName) {
                            continue;
                        }
                        matrix.set(obstacle.pos.x, obstacle.pos.y, 0xff);
                    }
                }
            }
            if (options.roomCallback) {
                if (!matrix) {
                    matrix = new PathFinder.CostMatrix();
                }
                let outcome = options.roomCallback(roomName, matrix.clone());
                if (outcome !== undefined) {
                    return outcome;
                }
            }
            return matrix;
        };
        let ret = PathFinder.search(origin, { pos: destination, range: options.range }, {
            /*
             * plainCost and swampCost tell PathFinder how expensive terrain is.
             * Roads are handled through the room callback's CostMatrix.
             */
            maxOps: options.maxOps,
            maxRooms: options.maxRooms,
            plainCost: options.offRoad ? 1 : options.ignoreRoads ? 1 : 2,
            swampCost: options.offRoad ? 1 : options.ignoreRoads ? 5 : 10,
            roomCallback: callback,
        });
        if (ret.incomplete && options.ensurePath) {
            if (options.useFindRoute === undefined) {
                // handle case where pathfinder failed at a short distance due to not using findRoute
                // can happen for situations where the creep would have to take an uncommonly indirect path
                // options.allowedRooms and options.routeCallback can also be used to handle this situation
                if (roomDistance <= 2) {
                    console.log(`TRAVELER: path failed without findroute, trying with options.useFindRoute = true`);
                    console.log(`from: ${origin}, destination: ${destination}`);
                    options.useFindRoute = true;
                    ret = this.findTravelPath(origin, destination, options);
                    console.log(`TRAVELER: second attempt was ${ret.incomplete ? "not " : ""}successful`);
                    return ret;
                }
                // TODO: handle case where a wall or some other obstacle is blocking the exit assumed by findRoute
            }
            else {
            }
        }
        return ret;
    }
    /**
     * find a viable sequence of rooms that can be used to narrow down pathfinder's search algorithm
     * @param origin
     * @param destination
     * @param options
     * @returns {{}}
     */
    static findRoute(origin, destination, options = {}) {
        /*
         * Game.map.findRoute works at the room level, not the tile level. It
         * chooses which rooms are allowed before tile pathfinding starts.
         */
        let restrictDistance = options.restrictDistance || Game.map.getRoomLinearDistance(origin, destination) + 10;
        let allowedRooms = { [origin]: true, [destination]: true };
        let highwayBias = 1;
        if (options.preferHighway) {
            highwayBias = 2.5;
            if (options.highwayBias) {
                highwayBias = options.highwayBias;
            }
        }
        let ret = Game.map.findRoute(origin, destination, {
            routeCallback: (roomName) => {
                if (options.routeCallback) {
                    let outcome = options.routeCallback(roomName);
                    if (outcome !== undefined) {
                        return outcome;
                    }
                }
                let rangeToRoom = Game.map.getRoomLinearDistance(origin, roomName);
                if (rangeToRoom > restrictDistance) {
                    // room is too far out of the way
                    return Number.POSITIVE_INFINITY;
                }
                if (!options.allowHostile && Traveler.checkAvoid(roomName) &&
                    roomName !== destination && roomName !== origin) {
                    // room is marked as "avoid" in room memory
                    return Number.POSITIVE_INFINITY;
                }
                let parsed;
                if (options.preferHighway) {
                    parsed = /^[WE]([0-9]+)[NS]([0-9]+)$/.exec(roomName);
                    let isHighway = (parsed[1] % 10 === 0) || (parsed[2] % 10 === 0);
                    if (isHighway) {
                        return 1;
                    }
                }
                // SK rooms are avoided when there is no vision in the room, harvested-from SK rooms are allowed
                if (!options.allowSK && !Game.rooms[roomName]) {
                    if (!parsed) {
                        parsed = /^[WE]([0-9]+)[NS]([0-9]+)$/.exec(roomName);
                    }
                    let fMod = parsed[1] % 10;
                    let sMod = parsed[2] % 10;
                    let isSK = !(fMod === 5 && sMod === 5) &&
                        ((fMod >= 4) && (fMod <= 6)) &&
                        ((sMod >= 4) && (sMod <= 6));
                    if (isSK) {
                        return 10 * highwayBias;
                    }
                }
                return highwayBias;
            },
        });
        if (!_.isArray(ret)) {
            console.log(`couldn't findRoute to ${destination}`);
            return;
        }
        for (let value of ret) {
            allowedRooms[value.room] = true;
        }
        return allowedRooms;
    }
    /**
     * check how many rooms were included in a route returned by findRoute
     * @param origin
     * @param destination
     * @returns {number}
     */
    static routeDistance(origin, destination) {
        let linearDistance = Game.map.getRoomLinearDistance(origin, destination);
        if (linearDistance >= 32) {
            return linearDistance;
        }
        let allowedRooms = this.findRoute(origin, destination);
        if (allowedRooms) {
            return Object.keys(allowedRooms).length;
        }
    }
    /**
     * build a cost matrix based on structures in the room. Will be cached for more than one tick. Requires vision.
     * @param room
     * @param freshMatrix
     * @returns {any}
     */
    static getStructureMatrix(room, freshMatrix) {
        /*
         * Structure matrices are cached by room name so repeated movement calls
         * in the same tick do not rebuild the same costs over and over.
         */
        if (!this.structureMatrixCache[room.name] || (freshMatrix && Game.time !== this.structureMatrixTick)) {
            this.structureMatrixTick = Game.time;
            let matrix = new PathFinder.CostMatrix();
            this.structureMatrixCache[room.name] = Traveler.addStructuresToMatrix(room, matrix, 1);
        }
        return this.structureMatrixCache[room.name];
    }
    /**
     * build a cost matrix based on creeps and structures in the room. Will be cached for one tick. Requires vision.
     * @param room
     * @returns {any}
     */
    static getCreepMatrix(room) {
        if (!this.creepMatrixCache[room.name] || Game.time !== this.creepMatrixTick) {
            this.creepMatrixTick = Game.time;
            this.creepMatrixCache[room.name] = Traveler.addCreepsToMatrix(room, this.getStructureMatrix(room, true).clone());
        }
        return this.creepMatrixCache[room.name];
    }
    /**
     * add structures to matrix so that impassible structures can be avoided and roads given a lower cost
     * @param room
     * @param matrix
     * @param roadCost
     * @returns {CostMatrix}
     */
    static addStructuresToMatrix(room, matrix, roadCost) {
        /*
         * This loop reads every visible structure and marks how it affects
         * movement: roads are cheap, containers are passable but costly, and
         * most other structures are blocked.
         */
        let impassibleStructures = [];
        for (let structure of room.find(FIND_STRUCTURES)) {
            if (structure instanceof StructureRampart) {
                if (!structure.my && !structure.isPublic) {
                    impassibleStructures.push(structure);
                }
            }
            else if (structure instanceof StructureRoad) {
                matrix.set(structure.pos.x, structure.pos.y, roadCost);
            }
            else if (structure instanceof StructureContainer) {
                matrix.set(structure.pos.x, structure.pos.y, 5);
            }
            else {
                impassibleStructures.push(structure);
            }
        }
        for (let site of room.find(FIND_MY_CONSTRUCTION_SITES)) {
            if (site.structureType === STRUCTURE_CONTAINER || site.structureType === STRUCTURE_ROAD
                || site.structureType === STRUCTURE_RAMPART) {
                continue;
            }
            matrix.set(site.pos.x, site.pos.y, 0xff);
        }
        for (let structure of impassibleStructures) {
            matrix.set(structure.pos.x, structure.pos.y, 0xff);
        }
        return matrix;
    }
    /**
     * add creeps to matrix so that they will be avoided by other creeps
     * @param room
     * @param matrix
     * @returns {CostMatrix}
     */
    static addCreepsToMatrix(room, matrix) {
        room.find(FIND_CREEPS).forEach((creep) => matrix.set(creep.pos.x, creep.pos.y, 0xff));
        return matrix;
    }
    /**
     * serialize a path, traveler style. Returns a string of directions.
     * @param startPos
     * @param path
     * @param color
     * @returns {string}
     */
    static serializePath(startPos, path, color = "orange") {
        let serializedPath = "";
        let lastPosition = startPos;
        this.circle(startPos, color);
        for (let position of path) {
            if (position.roomName === lastPosition.roomName) {
                new RoomVisual(position.roomName)
                    .line(position, lastPosition, { color: color, lineStyle: "dashed" });
                serializedPath += lastPosition.getDirectionTo(position);
            }
            lastPosition = position;
        }
        return serializedPath;
    }
    /**
     * returns a position at a direction relative to origin
     * @param origin
     * @param direction
     * @returns {RoomPosition}
     */
    static positionAtDirection(origin, direction) {
        let offsetX = [0, 0, 1, 1, 1, 0, -1, -1, -1];
        let offsetY = [0, -1, -1, 0, 1, 1, 1, 0, -1];
        let x = origin.x + offsetX[direction];
        let y = origin.y + offsetY[direction];
        if (x > 49 || x < 0 || y > 49 || y < 0) {
            return;
        }
        return new RoomPosition(x, y, origin.roomName);
    }
    /**
     * convert room avoidance memory from the old pattern to the one currently used
     * @param cleanup
     */
    static patchMemory(cleanup = false) {
        /*
         * Older Traveler setups stored hostile/avoid room data under
         * Memory.empire.hostileRooms. This migration copies those flags into the
         * current Memory.rooms[roomName].avoid shape used by checkAvoid().
         */
        if (!Memory.empire) {
            return;
        }
        if (!Memory.empire.hostileRooms) {
            return;
        }
        let count = 0;
        for (let roomName in Memory.empire.hostileRooms) {
            if (Memory.empire.hostileRooms[roomName]) {
                if (!Memory.rooms[roomName]) {
                    Memory.rooms[roomName] = {};
                }
                Memory.rooms[roomName].avoid = 1;
                count++;
            }
            if (cleanup) {
                delete Memory.empire.hostileRooms[roomName];
            }
        }
        if (cleanup) {
            delete Memory.empire.hostileRooms;
        }
        console.log(`TRAVELER: room avoidance data patched for ${count} rooms`);
    }
    static deserializeState(travelData, destination) {
        /*
         * Memory cannot store RoomPosition objects directly in a useful way, so
         * Traveler stores small arrays and rebuilds the state object each tick.
         */
        let state = {};
        if (travelData.state) {
            state.lastCoord = { x: travelData.state[STATE_PREV_X], y: travelData.state[STATE_PREV_Y] };
            state.cpu = travelData.state[STATE_CPU];
            state.stuckCount = travelData.state[STATE_STUCK];
            state.destination = new RoomPosition(travelData.state[STATE_DEST_X], travelData.state[STATE_DEST_Y], travelData.state[STATE_DEST_ROOMNAME]);
        }
        else {
            state.cpu = 0;
            state.destination = destination;
        }
        return state;
    }
    static serializeState(creep, destination, state, travelData) {
        /*
         * The compact array saves memory compared with storing an object with
         * named keys for every creep. The STATE_* constants below document which
         * index means what.
         */
        travelData.state = [creep.pos.x, creep.pos.y, state.stuckCount, state.cpu, destination.x, destination.y,
            destination.roomName];
    }
    static isStuck(creep, state) {
        let stuck = false;
        if (state.lastCoord !== undefined) {
            if (this.sameCoord(creep.pos, state.lastCoord)) {
                // didn't move
                stuck = true;
            }
            else if (this.isExit(creep.pos) && this.isExit(state.lastCoord)) {
                // moved against exit
                stuck = true;
            }
        }
        return stuck;
    }
}
Traveler.structureMatrixCache = {};
Traveler.creepMatrixCache = {};
exports.Traveler = Traveler;
// this might be higher than you wish, setting it lower is a great way to diagnose creep behavior issues. When creeps
// need to repath to often or they aren't finding valid paths, it can sometimes point to problems elsewhere in your code
const REPORT_CPU_THRESHOLD = 1000;
const DEFAULT_MAXOPS = 20000;
const DEFAULT_STUCK_VALUE = 2;
const STATE_PREV_X = 0;
const STATE_PREV_Y = 1;
const STATE_STUCK = 2;
const STATE_CPU = 3;
const STATE_DEST_X = 4;
const STATE_DEST_Y = 5;
const STATE_DEST_ROOMNAME = 6;
// assigns a function to Creep.prototype: creep.travelTo(destination)
/*
 * This extends the Screeps Creep prototype. After Traveler is required, every
 * creep can call creep.travelTo(...) as if it were a built-in method.
 */
Creep.prototype.travelTo = function (destination, options) {
    return Traveler.travelTo(this, destination, options);
};
