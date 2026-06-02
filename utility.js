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

module.exports = {
    scanRoom: scanRoom,
    createSourceFlagsFromMemory: createSourceFlagsFromMemory
};