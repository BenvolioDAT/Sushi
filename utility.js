/*
 * Module code goes here. Use 'module.exports' to export things:
 * module.exports.thing = 'a thing';
 *
 * You can import it from another modules like this:
 * var mod = require('utils');
 * mod.thing == 'a thing'; // true
 */
/**
 * First-scan the creep's current room and save important room data into memory.
 *
 * This function scans:
 * - energy sources
 * - source mining seats
 * - room controller
 * - minerals
 *
 * Memory shape:
 *
 * Memory.rooms[roomName].sources[sourceId]
 * Memory.rooms[roomName].controller
 * Memory.rooms[roomName].Mineral[mineralId]
 *
 * This function exits early if source memory already exists.
 *
 * @param {Creep} creep - A creep inside the room you want to scan.
 * @returns {object|null} The saved room memory, or null if something is wrong.
 */
function scanRoom(creep) {
    if (!creep || !creep.room) {
        return null;
    }

    var room = creep.room;
    var roomName = room.name;

    if (!Memory.rooms) {
        Memory.rooms = {};
    }

    if (!Memory.rooms[roomName]) {
        Memory.rooms[roomName] = {};
    }

    /*
     * Early exit.
     *
     * If this room already has source memory, we treat the room as already scanned.
     * This protects your source Flag data and saves CPU.
     *
     * Later, if you want to force a rescan, you can delete:
     * delete Memory.rooms['W1N1'].sources;
     */
    if (Memory.rooms[roomName].sources) {
        return Memory.rooms[roomName];
    }

    Memory.rooms[roomName].sources = {};
    Memory.rooms[roomName].Mineral = {};

    /*
     * Save basic room scan info.
     * This can be useful later for debugging or room planning.
     */
    Memory.rooms[roomName].roomName = roomName;
    Memory.rooms[roomName].lastScanned = Game.time;

    /*
     * Scan controller.
     *
     * Some special rooms may not have a controller, so we check first.
     */
    if (room.controller) {
        Memory.rooms[roomName].controller = {
            id: room.controller.id,

            pos: {
                x: room.controller.pos.x,
                y: room.controller.pos.y,
                roomName: room.controller.pos.roomName
            },

            /*
             * owner is null if nobody owns the controller.
             * If someone owns it, save the username only.
             */
            owner: room.controller.owner ? room.controller.owner.username : null,

            /*
             * reservation is for remote rooms reserved by a player.
             * This can matter later for remote mining logic.
             */
            reservation: room.controller.reservation ? {
                username: room.controller.reservation.username,
                ticksToEnd: room.controller.reservation.ticksToEnd
            } : null,

            /*
             * true if this is your controller.
             */
            my: room.controller.my === true,

            /*
             * Controller level.
             * Neutral controllers usually show level 0.
             */
            level: room.controller.level || 0,

            /*
             * Placeholder for a controller flag.
             * Later code can flip this to true after it creates a controller flag.
             */
            flag: false,
            flagName: null,

            /*
             * Future-use placeholders.
             * These are handy later for upgrader positions, controller container,
             * controller link, or road planning.
             */
            seats: [],
            seatCount: 0,
            containerId: null,
            linkId: null,
            roadPlanned: false
        };
    } else {
        Memory.rooms[roomName].controller = null;
    }

    /*
     * Scan energy sources.
     */
    var terrain = room.getTerrain();
    var sources = room.find(FIND_SOURCES);

    for (var sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
        var source = sources[sourceIndex];

        var sourceMemory = {
            id: source.id,

            pos: {
                x: source.pos.x,
                y: source.pos.y,
                roomName: source.pos.roomName
            },

            seats: [],
            seatCount: 0,
            lastScanned: Game.time,

            /*
             * Source flag starts false.
             * Your source flag function can update this to true later.
             */
            Flag: false,
            flagName: null,

            /*
             * Future-use placeholders.
             */
            assignedMiner: null,
            containerId: null,
            linkId: null,
            roadPlanned: false
        };

        /*
         * Check all 8 tiles around the source for valid mining seats.
         */
        for (var dx = -1; dx <= 1; dx++) {
            for (var dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) {
                    continue;
                }

                var seatX = source.pos.x + dx;
                var seatY = source.pos.y + dy;

                if (seatX < 0 || seatX > 49 || seatY < 0 || seatY > 49) {
                    continue;
                }

                if (terrain.get(seatX, seatY) === TERRAIN_MASK_WALL) {
                    continue;
                }

                sourceMemory.seats.push({
                    x: seatX,
                    y: seatY,
                    roomName: roomName
                });
            }
        }

        sourceMemory.seatCount = sourceMemory.seats.length;

        Memory.rooms[roomName].sources[source.id] = sourceMemory;
    }

    /*
     * Scan minerals.
     *
     * Most normal rooms have one mineral deposit.
     * We still loop because FIND_MINERALS returns an array.
     */
    var minerals = room.find(FIND_MINERALS);

    for (var mineralIndex = 0; mineralIndex < minerals.length; mineralIndex++) {
        var mineral = minerals[mineralIndex];

        Memory.rooms[roomName].Mineral[mineral.id] = {
            id: mineral.id,

            pos: {
                x: mineral.pos.x,
                y: mineral.pos.y,
                roomName: mineral.pos.roomName
            },

            density: mineral.density,
            mineralType: mineral.mineralType,

            /*
             * Placeholder amount.
             * Another function can update this later when you want live mineral tracking.
             */
            Amount: 0,

            /*
             * Optional useful live value from the first scan.
             * You can remove this if you only want the placeholder.
             */
            lastKnownAmount: mineral.mineralAmount,

            /*
             * Placeholder for mineral flag logic later.
             */
            flag: false,
            flagName: null,

            /*
             * Future-use placeholders.
             */
            extractorId: null,
            containerId: null,
            roadPlanned: false,
            lastScanned: Game.time
        };
    }

    return Memory.rooms[roomName];
}

/**
 * Create cyan/white flags directly on top of each source in the creep's room.
 *
 * This uses source memory created by scanRoom(creep).
 *
 * Memory path:
 *
 * Memory.rooms[roomName].sources[sourceId].Flag = true or false
 *
 * This function is safe to call every tick.
 * If every source in the room already has Flag === true, it exits early.
 *
 * @param {Creep} creep - A creep inside the room being checked.
 * @returns {object|null} A small report showing what happened.
 */
function createSourceFlagsFromMemory(creep) {
    if (!creep || !creep.room) {
        return null;
    }

    var room = creep.room;
    var roomName = room.name;

    if (!Memory.rooms) {
        Memory.rooms = {};
    }

    if (!Memory.rooms[roomName]) {
        Memory.rooms[roomName] = {};
    }

    // Make sure source memory exists.
    // If you renamed scanRoom(creep) to scanRoom(creep),
    // change this line to scanRoom(creep).
    if (!Memory.rooms[roomName].sources) {
        scanRoom(creep);
    }

    var sourcesMemory = Memory.rooms[roomName].sources;

    if (!sourcesMemory) {
        return null;
    }

    var report = {
        roomName: roomName,
        created: 0,
        verified: 0,
        repairedMemory: 0,
        skipped: 0,
        errors: []
    };

    for (var sourceId in sourcesMemory) {
        if (!sourcesMemory.hasOwnProperty(sourceId)) {
            continue;
        }

        var sourceMemory = sourcesMemory[sourceId];

        // If the source memory or position is missing, just skip it quietly.
        // No error log/report entry.
        if (!sourceMemory || !sourceMemory.pos) {
            report.skipped++;
            continue;
        }

        /*
         * Use the saved flag name if we already have one.
         * If not, create the name from the last 5 characters of the source ID.
         */
        var flagName = sourceMemory.flagName || sourceId.slice(-5);

        /*
         * Always save the flag name into memory.
         * This makes later checks easier.
         */
        sourceMemory.flagName = flagName;

        /*
         * Direct lookup.
         * This checks only Game.flags[flagName], not all flags.
         */
        var flag = Game.flags[flagName];

        if (flag) {
            /*
             * Make sure the flag is actually on the source position.
             */
            if (
                flag.pos.x === sourceMemory.pos.x &&
                flag.pos.y === sourceMemory.pos.y &&
                flag.pos.roomName === sourceMemory.pos.roomName
            ) {
                if (sourceMemory.Flag !== true) {
                    report.repairedMemory++;
                }

                sourceMemory.Flag = true;
                report.verified++;
                continue;
            }

            /*
             * Flag exists, but it is not on the source.
             * Do not create another one because flag names must be unique.
             */
            sourceMemory.Flag = false;

            report.errors.push({
                sourceId: sourceId,
                flagName: flagName,
                error: 'Flag exists, but it is not on this source position'
            });

            continue;
        }

        /*
         * If we reach this point, the flag does not exist.
         * This also handles the case where you manually deleted it.
         */
        sourceMemory.Flag = false;

        var result = room.createFlag(
            sourceMemory.pos.x,
            sourceMemory.pos.y,
            flagName,
            COLOR_CYAN,
            COLOR_WHITE
        );

        if (result === flagName) {
            sourceMemory.Flag = true;
            sourceMemory.flagName = flagName;
            report.created++;
        } else {
            sourceMemory.Flag = false;

            report.errors.push({
                sourceId: sourceId,
                flagName: flagName,
                result: result
            });
        }
    }

    return report;
}





/////////////////////////////////////////////////////////////////////////////////////////////////
/**
 * Make sure each scanned source has one container planned.
 *
 * What this does:
 * - Reads Memory.rooms[roomName].sources.
 * - Checks if sourceMemory.containerId is still alive.
 * - If the container is dead/missing, clears containerId.
 * - Looks for an existing container near the source and saves its id.
 * - Looks for an existing container construction site near the source and skips it.
 * - If no container/site exists, chooses the best source seat and places a container site.
 * - Stops after placing one construction site to save CPU.
 *
 * Smarter placement:
 * - Picks the tile that can touch the most source seats.
 * - This helps place the container in the "middle" of the source seats when possible.
 * - Distance to spawn/storage/controller is only used as a small tie breaker.
 *
 * Important:
 * - The room must be visible.
 * - Your scan memory should have source pos and seats saved.
 *
 * @param {string} roomName
 * @returns {object}
 */
function planSourceContainers(roomName) {
    if (!roomName) {
        return {
            ok: false,
            reason: "missing roomName"
        };
    }

    var room = Game.rooms[roomName];

    if (!room) {
        return {
            ok: false,
            reason: "room is not visible"
        };
    }

    if (!Memory.rooms) {
        return {
            ok: false,
            reason: "Memory.rooms does not exist"
        };
    }

    if (!Memory.rooms[roomName]) {
        return {
            ok: false,
            reason: "Memory.rooms[roomName] does not exist"
        };
    }

    if (!Memory.rooms[roomName].sources) {
        return {
            ok: false,
            reason: "room source memory does not exist"
        };
    }

    var sourceMemoryById = Memory.rooms[roomName].sources;

    for (var sourceId in sourceMemoryById) {
        var sourceMemory = sourceMemoryById[sourceId];

        if (!sourceMemory) {
            continue;
        }

        var source = Game.getObjectById(sourceMemory.id || sourceId);

        if (!source) {
            // The room is visible, but this source could not be found.
            // Skip it instead of guessing.
            continue;
        }

        /*
         * Step 1:
         * If memory says this source already has a container,
         * verify that the container is still alive and still beside this source.
         *
         * This is the "do not end early with a dead containerId" safety check.
         */
        if (sourceMemory.containerId) {
            var rememberedContainer = Game.getObjectById(sourceMemory.containerId);

            if (
                rememberedContainer &&
                rememberedContainer.structureType === STRUCTURE_CONTAINER &&
                rememberedContainer.pos.getRangeTo(source.pos) <= 1
            ) {
                // Container is alive and beside this source.
                // This source is good. Check the next source.
                continue;
            }

            // Memory had a container id, but it is dead, invalid, or not beside the source.
            // Clear it so the code can repair the plan.
            sourceMemory.containerId = null;
        }

        /*
         * Step 2:
         * Look for an already-built container near the source.
         *
         * Containers beside sources are usually placed within range 1,
         * because the miner can stand on the container tile and harvest.
         */
        var nearbyContainers = source.pos.findInRange(FIND_STRUCTURES, 1, {
            filter: function (structure) {
                return structure.structureType === STRUCTURE_CONTAINER;
            }
        });

        if (nearbyContainers.length > 0) {
            sourceMemory.containerId = nearbyContainers[0].id;

            saveContainerPlannedPosition(sourceMemory, nearbyContainers[0].pos);

            // Existing container found. This source is good. Check next source.
            continue;
        }

        /*
         * Step 3:
         * Look for an existing container construction site.
         *
         * Important:
         * We do NOT judge if the site is in the best spot.
         * We do NOT remove it.
         * If a container site exists beside the source, this source is already planned.
         */
        var nearbyContainerSites = source.pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
            filter: function (site) {
                return site.structureType === STRUCTURE_CONTAINER;
            }
        });

        if (nearbyContainerSites.length > 0) {
            sourceMemory.containerPlanned = true;
            sourceMemory.containerPlannedAt = sourceMemory.containerPlannedAt || Game.time;
            sourceMemory.containerPlannedPos = {
                x: nearbyContainerSites[0].pos.x,
                y: nearbyContainerSites[0].pos.y,
                roomName: nearbyContainerSites[0].pos.roomName
            };

            // Site already exists. Do not create another one.
            continue;
        }

        /*
         * Step 4:
         * No live container and no construction site.
         * Pick the best source seat and place one container site.
         */
        var bestPosition = findBestContainerPositionForSource(room, source, sourceMemory);

        if (!bestPosition) {
            continue;
        }

        var result = bestPosition.createConstructionSite(STRUCTURE_CONTAINER);

        if (result === OK) {
            saveContainerPlannedPosition(sourceMemory, bestPosition);

            // Stop after placing one site.
            // This saves CPU and avoids trying to place too many sites in one tick.
            return {
                ok: true,
                placed: true,
                sourceId: source.id,
                x: bestPosition.x,
                y: bestPosition.y,
                result: result
            };
        }

        return {
            ok: false,
            placed: false,
            sourceId: source.id,
            x: bestPosition.x,
            y: bestPosition.y,
            result: result,
            reason: "createConstructionSite failed"
        };
    }

    return {
        ok: true,
        placed: false,
        reason: "all sources already have a container or container site"
    };
}

/**
 * Pick the best container position beside a source.
 *
 * The old version mostly cared about distance to spawn/storage/controller.
 * This version cares first about the source seats.
 *
 * Smart rules:
 * - Candidate positions come from your saved source seats.
 * - If your memory has no seats, it falls back to the 8 tiles around the source.
 * - The best tile is the tile that can touch the most source seats.
 * - Then it prefers the most central tile between those seats.
 * - Then it uses swamp and base distance as small tie breakers.
 *
 * @param {Room} room
 * @param {Source} source
 * @param {object} sourceMemory
 * @returns {RoomPosition|null}
 */
function findBestContainerPositionForSource(room, source, sourceMemory) {
    var sourceSeats = getSourceSeatPositions(room, source, sourceMemory);

    if (sourceSeats.length === 0) {
        return null;
    }

    var anchor = getContainerPlanningAnchor(room);
    var bestPosition = null;
    var bestScore = Infinity;

    for (var i = 0; i < sourceSeats.length; i++) {
        var position = sourceSeats[i];

        if (!isGoodContainerPosition(room, position)) {
            continue;
        }

        var score = scoreContainerPositionForSource(
            room,
            position,
            sourceSeats,
            anchor
        );

        if (score < bestScore) {
            bestScore = score;
            bestPosition = position;
        }
    }

    return bestPosition;
}

/**
 * Score one possible container tile.
 *
 * Lower score is better.
 *
 * The big idea:
 * - A tile that touches more source seats wins.
 * - A tile near the middle of all source seats wins tie breakers.
 * - Swamp and base distance only matter after seat coverage.
 *
 * @param {Room} room
 * @param {RoomPosition} position
 * @param {RoomPosition[]} sourceSeats
 * @param {RoomPosition|null} anchor
 * @returns {number}
 */
function scoreContainerPositionForSource(room, position, sourceSeats, anchor) {
    var coveredSeatCount = 0;
    var totalSeatRange = 0;

    for (var i = 0; i < sourceSeats.length; i++) {
        var seat = sourceSeats[i];
        var rangeToSeat = position.getRangeTo(seat);

        totalSeatRange += rangeToSeat;

        /*
         * Range 1 means a creep standing on that seat can reach the container.
         * Range 0 means the container is on that exact seat, which is also fine.
         */
        if (rangeToSeat <= 1) {
            coveredSeatCount++;
        }
    }

    var score = 0;

    /*
     * Main priority:
     * Cover as many seats as possible.
     *
     * This number is huge on purpose.
     * It makes "touches 3 seats" beat "touches 2 seats",
     * even if the 2-seat tile is closer to spawn.
     */
    score -= coveredSeatCount * 10000;

    /*
     * Second priority:
     * Prefer the center of the source seats.
     *
     * This helps avoid placing the container off to one side when
     * a middle tile can reach more creeps.
     */
    score += totalSeatRange * 100;

    /*
     * Small tie breaker:
     * Prefer plain terrain over swamp.
     */
    var terrain = room.getTerrain().get(position.x, position.y);

    if (terrain === TERRAIN_MASK_SWAMP) {
        score += 25;
    }

    /*
     * Tiny tie breaker:
     * Prefer being closer to your base anchor.
     * This should never overpower seat coverage.
     */
    if (anchor) {
        score += position.getRangeTo(anchor);
    }

    /*
     * Stable tie breaker:
     * Keeps the result from flipping around between equal choices.
     */
    score += position.x * 0.01;
    score += position.y * 0.001;

    return score;
}

/**
 * Get usable source seat positions from memory.
 * Falls back to scanning the 8 tiles around the source.
 *
 * @param {Room} room
 * @param {Source} source
 * @param {object} sourceMemory
 * @returns {RoomPosition[]}
 */
function getSourceSeatPositions(room, source, sourceMemory) {
    var positions = [];

    /*
     * Preferred:
     * Use your scanner's saved source seats.
     *
     * This supports memory shaped like:
     * sourceMemory.seats = [
     *     { x: 10, y: 20 },
     *     { x: 11, y: 20 },
     *     { pos: { x: 12, y: 20 } }
     * ];
     */
    if (sourceMemory && sourceMemory.seats) {
        for (var seatIndex in sourceMemory.seats) {
            var memoryPosition = getRoomPositionFromSeatMemory(
                sourceMemory.seats[seatIndex],
                room.name
            );

            if (!memoryPosition) {
                continue;
            }

            if (isPositionBesideSource(memoryPosition, source)) {
                positions.push(memoryPosition);
            }
        }

        if (positions.length > 0) {
            return positions;
        }
    }

    /*
     * Fallback:
     * If your scan did not save seat positions, scan the 8 tiles around source.
     */
    for (var x = source.pos.x - 1; x <= source.pos.x + 1; x++) {
        for (var y = source.pos.y - 1; y <= source.pos.y + 1; y++) {
            if (x === source.pos.x && y === source.pos.y) {
                continue;
            }

            if (x < 1 || x > 48 || y < 1 || y > 48) {
                continue;
            }

            var position = new RoomPosition(x, y, room.name);
            var terrain = room.getTerrain().get(x, y);

            if (terrain !== TERRAIN_MASK_WALL) {
                positions.push(position);
            }
        }
    }

    return positions;
}

/**
 * Convert one saved seat memory entry into a RoomPosition.
 *
 * Supports:
 * - { x: 10, y: 20 }
 * - { x: 10, y: 20, roomName: "W7N9" }
 * - { pos: { x: 10, y: 20 } }
 * - { pos: { x: 10, y: 20, roomName: "W7N9" } }
 *
 * @param {object} seatMemory
 * @param {string} roomName
 * @returns {RoomPosition|null}
 */
function getRoomPositionFromSeatMemory(seatMemory, roomName) {
    if (!seatMemory) {
        return null;
    }

    if (
        seatMemory.x !== undefined &&
        seatMemory.y !== undefined
    ) {
        return new RoomPosition(
            seatMemory.x,
            seatMemory.y,
            seatMemory.roomName || roomName
        );
    }

    if (
        seatMemory.pos &&
        seatMemory.pos.x !== undefined &&
        seatMemory.pos.y !== undefined
    ) {
        return new RoomPosition(
            seatMemory.pos.x,
            seatMemory.pos.y,
            seatMemory.pos.roomName || roomName
        );
    }

    return null;
}

/**
 * Make sure the remembered seat is actually beside this source.
 *
 * @param {RoomPosition} position
 * @param {Source} source
 * @returns {boolean}
 */
function isPositionBesideSource(position, source) {
    if (!position || !source) {
        return false;
    }

    if (position.roomName !== source.pos.roomName) {
        return false;
    }

    return position.getRangeTo(source.pos) <= 1;
}

/**
 * Check if a tile is okay for a new container construction site.
 *
 * Creeps do NOT block this check.
 * A creep standing there right now should not change the long-term plan.
 *
 * @param {Room} room
 * @param {RoomPosition} position
 * @returns {boolean}
 */
function isGoodContainerPosition(room, position) {
    var terrain = room.getTerrain().get(position.x, position.y);

    if (terrain === TERRAIN_MASK_WALL) {
        return false;
    }

    var structures = position.lookFor(LOOK_STRUCTURES);

    for (var i = 0; i < structures.length; i++) {
        var structure = structures[i];

        /*
         * Roads can share a tile with containers.
         */
        if (structure.structureType === STRUCTURE_ROAD) {
            continue;
        }

        /*
         * If a container already exists here, this position is not bad,
         * but the main function should have found that container already.
         */
        if (structure.structureType === STRUCTURE_CONTAINER) {
            continue;
        }

        /*
         * Anything else blocks the tile.
         */
        return false;
    }

    var sites = position.lookFor(LOOK_CONSTRUCTION_SITES);

    for (var j = 0; j < sites.length; j++) {
        var site = sites[j];

        /*
         * If any construction site is already on this tile,
         * do not try to place another one here.
         *
         * This keeps the planner simple and avoids createConstructionSite failing
         * because the tile is already busy.
         */
        if (site) {
            return false;
        }
    }

    return true;
}

/**
 * Save planned container position into source memory.
 *
 * This does NOT save containerId.
 * containerId should only be saved when the real container exists.
 *
 * @param {object} sourceMemory
 * @param {RoomPosition} position
 */
function saveContainerPlannedPosition(sourceMemory, position) {
    sourceMemory.containerPlanned = true;
    sourceMemory.containerPlannedAt = Game.time;
    sourceMemory.containerPlannedPos = {
        x: position.x,
        y: position.y,
        roomName: position.roomName
    };
}

/**
 * Pick something useful to measure distance from.
 *
 * This is only a small tie breaker.
 * Seat coverage is more important.
 *
 * @param {Room} room
 * @returns {RoomPosition|null}
 */
function getContainerPlanningAnchor(room) {
    if (room.storage) {
        return room.storage.pos;
    }

    var spawns = room.find(FIND_MY_SPAWNS);

    if (spawns.length > 0) {
        return spawns[0].pos;
    }

    if (room.controller) {
        return room.controller.pos;
    }

    return null;
}
////////////////////////////////////////////////////////////////////////////
// ============================================================================
// Exports
// ============================================================================
module.exports = {
    scanRoom,
    createSourceFlagsFromMemory,

    planSourceContainers,
};