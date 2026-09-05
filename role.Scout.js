var utility = require('utility');
var Intel = require('Remote.Intel');
var utilityTravelCreep = require('utility.Travel.Creep');
var RemotePlanner = require('Planner.Remote');
var Season11 = require('Logic.Season11');

var SCOUT_RADIUS = 3;
var SCOUT_RESCAN_AFTER_TICKS = 3000;
var SCOUT_PLAN_MEMORY_KEY = 'scoutPlan';
var SCOUT_UNREACHABLE_TICKS = 300;

/*
 * role.Scout.js
 *
 * Room intel role.
 *
 * Scout builds and follows a reusable room plan around its home room. It scans
 * visible rooms into Memory, pauses unreachable rooms instead of deleting them,
 * and cycles back to stale rooms after SCOUT_RESCAN_AFTER_TICKS.
 */
var roleScout = {

    /** @param {Creep} creep **/
    run: function(creep) {
        /*
         * Scouts only need MOVE parts, but they still cannot do anything while
         * spawning. This guard keeps the rest of the role from using bad data.
         */
        if(!creep || creep.spawning) {
            return;
        }

        ensureScoutHomeRoom(creep);

        ensureScoutPlan(creep);

        /*
         * Keep the normal Sushi room scan. This records sources, controller
         * info, minerals, and other room planning data.
         */
        utility.scanRoom(creep);

        /*
         * Save simple scouting data every time the Scout has vision in a room.
         */
        saveScoutVisit(creep);
        Intel.refresh(creep.room);

        /*
         * Remote planning uses scanRoom plus the fresh visible Room object. The
         * Scout still moves exactly like before; this only lets the home room
         * score remote sources after Sushi has saved room/source/controller intel.
         */
        RemotePlanner.onScoutRoom(creep);

        /* Season intel piggybacks on the existing Scout's normal visibility. */
        Season11.observeRoom(creep.room, creep.memory.homeRoom, true);

        /*
         * If the Scout just arrived, clear targetRoom so the next choice comes
         * from the planned scout list instead of old memory.
         */
        if(creep.memory.targetRoom && creep.room.name === creep.memory.targetRoom) {
            delete creep.memory.targetRoom;
        }

        if(!creep.memory.targetRoom) {
            chooseNextScoutRoom(creep);
        }

        if(creep.memory.targetRoom) {
            moveToTargetRoom(creep, creep.memory.targetRoom);
            return;
        }

        idleNearHome(creep);
    }
};

function ensureScoutHomeRoom(creep) {
    /*
     * A Scout plans around its home room. Use existing memory first so a Scout
     * keeps the same center even after it travels far away.
     */
    if(!creep || !creep.memory || !creep.room) {
        return null;
    }

    var homeRoom = creep.memory.homeRoom ||
        creep.memory.spawnRoom ||
        creep.memory.birthRoom ||
        creep.room.name;

    creep.memory.homeRoom = homeRoom;

    return homeRoom;
}

function ensureRoomMemory(roomName) {
    /*
     * Memory.rooms is the long-term storage object organized by room name.
     */
    if(!roomName) {
        return null;
    }

    if(!Memory.rooms) {
        Memory.rooms = {};
    }

    if(!Memory.rooms[roomName]) {
        Memory.rooms[roomName] = {};
    }

    return Memory.rooms[roomName];
}

function ensureScoutPlan(creep) {
    /*
     * The plan lives in the home room memory so all Scouts from that room can
     * share one predictable room list.
     */
    var homeRoom = ensureScoutHomeRoom(creep);
    var homeMemory = ensureRoomMemory(homeRoom);

    if(!homeMemory) {
        return null;
    }

    var plan = homeMemory[SCOUT_PLAN_MEMORY_KEY];

    var scoutRadius = Season11.getScoutRadius(SCOUT_RADIUS);

    if(
        !plan ||
        plan.homeRoom !== homeRoom ||
        plan.radius !== scoutRadius ||
        !plan.rooms
    ) {
        homeMemory[SCOUT_PLAN_MEMORY_KEY] = buildScoutPlan(homeRoom, scoutRadius);
    }

    return homeMemory[SCOUT_PLAN_MEMORY_KEY];
}

function getScoutPlan(creep) {
    /*
     * Read the existing plan without rebuilding it. This is useful for small
     * helper functions that only want to update a known record.
     */
    var homeRoom = creep && creep.memory ? creep.memory.homeRoom : null;

    if(!homeRoom || !Memory.rooms || !Memory.rooms[homeRoom]) {
        return null;
    }

    return Memory.rooms[homeRoom][SCOUT_PLAN_MEMORY_KEY] || null;
}

function parseRoomName(roomName) {
    /*
     * Screeps room names are split into horizontal and vertical parts.
     *
     * This helper converts them into simple internal x/y numbers:
     * E0 = 0, E1 = 1, W0 = -1, W1 = -2
     * S0 = 0, S1 = 1, N0 = -1, N1 = -2
     *
     * That model avoids off-by-one bugs around the W0/E0 and N0/S0 borders.
     */
    if(typeof roomName !== 'string') {
        return null;
    }

    var match = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);

    if(!match) {
        return null;
    }

    var horizontalDirection = match[1];
    var horizontalNumber = parseInt(match[2], 10);
    var verticalDirection = match[3];
    var verticalNumber = parseInt(match[4], 10);

    return {
        x: horizontalDirection === 'E' ? horizontalNumber : -horizontalNumber - 1,
        y: verticalDirection === 'S' ? verticalNumber : -verticalNumber - 1
    };
}

function roomNameFromXY(x, y) {
    /*
     * Convert the internal x/y numbers back into Screeps room names.
     */
    if(typeof x !== 'number' || typeof y !== 'number') {
        return null;
    }

    var horizontalName = x >= 0 ? 'E' + x : 'W' + (-x - 1);
    var verticalName = y >= 0 ? 'S' + y : 'N' + (-y - 1);

    return horizontalName + verticalName;
}

function buildScoutPlan(homeRoom, radius) {
    /*
     * Build a square list of rooms around the home room. Distance is Chebyshev
     * distance, so every room in the same square ring has the same distance.
     */
    var plan = {
        homeRoom: homeRoom,
        radius: radius,
        createdAt: Game.time,
        rooms: {}
    };

    var center = parseRoomName(homeRoom);

    if(!center) {
        return plan;
    }

    for(var dx = -radius; dx <= radius; dx++) {
        for(var dy = -radius; dy <= radius; dy++) {
            var roomName = roomNameFromXY(center.x + dx, center.y + dy);

            if(!roomName) {
                continue;
            }

            var roomStatus = getRoomStatusString(roomName);

            if(!isScoutRoomStatusAllowed(roomStatus)) {
                continue;
            }

            plan.rooms[roomName] = {
                roomName: roomName,
                distance: Math.max(Math.abs(dx), Math.abs(dy)),
                status: roomStatus,
                lastScanTick: null,
                unreachableUntil: 0
            };
        }
    }

    return plan;
}

function isScoutRoomStatusAllowed(roomStatus) {
    /*
     * Plan only rooms Screeps says are available for normal play.
     */
    return roomStatus === 'normal' ||
        roomStatus === 'novice' ||
        roomStatus === 'respawn';
}

function getRoomStatusString(roomName) {
    /*
     * getRoomStatus lets us avoid closed or unavailable rooms before travel.
     */
    if(!roomName || !Game.map || typeof Game.map.getRoomStatus !== 'function') {
        return 'unknown';
    }

    var roomStatus = Game.map.getRoomStatus(roomName);

    if(!roomStatus || !roomStatus.status) {
        return 'unknown';
    }

    return roomStatus.status;
}

function saveScoutVisit(creep) {
    /*
     * This stores the latest room visit in Memory.rooms[roomName]. The plan also
     * gets updated if this room belongs to the Scout's home-room plan.
     */
    if(!creep || !creep.room) {
        return;
    }

    var roomName = creep.room.name;
    var roomMemory = ensureRoomMemory(roomName);

    if(!roomMemory) {
        return;
    }

    roomMemory.lastScanTick = Game.time;
    roomMemory.scoutIntel = {
        lastScanTick: Game.time,
        roomName: roomName,
        roomStatus: getRoomStatusString(roomName),
        sourceCount: creep.room.find(FIND_SOURCES).length,
        hostileCreepCount: creep.room.find(FIND_HOSTILE_CREEPS).length,
        hostileStructureCount: creep.room.find(FIND_HOSTILE_STRUCTURES).length,
        invaderCore: hasInvaderCore(creep.room),
        controllerOwner: getControllerOwnerName(creep.room),
        controllerReservation: getControllerReservationName(creep.room),
        controllerLevel: getControllerLevel(creep.room)
    };

    var plan = getScoutPlan(creep);

    if(plan && plan.rooms && plan.rooms[roomName]) {
        plan.rooms[roomName].lastScanTick = Game.time;
        plan.rooms[roomName].status = getRoomStatusString(roomName);
    }
}

function hasInvaderCore(room) {
    /*
     * Some private servers or older environments may not define this constant,
     * so check it before using it.
     */
    if(!room || typeof STRUCTURE_INVADER_CORE === 'undefined') {
        return false;
    }

    var invaderCores = room.find(FIND_HOSTILE_STRUCTURES, {
        filter: function(structure) {
            return structure.structureType === STRUCTURE_INVADER_CORE;
        }
    });

    return invaderCores.length > 0;
}

function getControllerOwnerName(room) {
    if(!room || !room.controller || !room.controller.owner) {
        return null;
    }

    return room.controller.owner.username || null;
}

function getControllerReservationName(room) {
    if(!room || !room.controller || !room.controller.reservation) {
        return null;
    }

    return room.controller.reservation.username || null;
}

function getControllerLevel(room) {
    if(!room || !room.controller) {
        return null;
    }

    return room.controller.level || 0;
}

function chooseNextScoutRoom(creep) {
    /*
     * First visit every room in the plan once. After that, revisit the oldest
     * stale room so intel stays fresh without random wandering.
     *
     * The selection deliberately prefers never-scanned nearby rooms before stale
     * old rooms because new visibility can unlock source, controller, and
     * hostile-room information the rest of the bot has never seen.
     */
    var plan = ensureScoutPlan(creep);

    if(!plan || !plan.rooms) {
        delete creep.memory.targetRoom;
        return false;
    }

    var priorityRoom = null;
    var bestNeverScanned = null;
    var oldestScanned = null;

    for(var roomName in plan.rooms) {
        if(!plan.rooms.hasOwnProperty(roomName)) {
            continue;
        }

        var roomRecord = plan.rooms[roomName];

        if(!roomRecord || roomName === creep.room.name) {
            continue;
        }

        if(roomRecord.unreachableUntil && roomRecord.unreachableUntil > Game.time) {
            continue;
        }

        var roomStatus = getRoomStatusString(roomName);
        roomRecord.status = roomStatus;

        if(!isScoutRoomStatusAllowed(roomStatus)) {
            continue;
        }

        var intel = Memory.rooms[roomName];
        if (intel && intel.intelRefreshRequestedAt !== undefined &&
            (!priorityRoom || (intel.intelPriority || 0) > priorityRoom.priority ||
                (intel.intelPriority || 0) === priorityRoom.priority && intel.intelRefreshRequestedAt < priorityRoom.at)) {
            priorityRoom = { roomName: roomName, priority: intel.intelPriority || 0, at: intel.intelRefreshRequestedAt };
        }
        if(roomRecord.lastScanTick === null || roomRecord.lastScanTick === undefined) {
            if(
                !bestNeverScanned ||
                roomRecord.distance < bestNeverScanned.distance ||
                (
                    roomRecord.distance === bestNeverScanned.distance &&
                    (Season11.scoutPriority(roomName) > Season11.scoutPriority(bestNeverScanned.roomName) ||
                        Season11.scoutPriority(roomName) === Season11.scoutPriority(bestNeverScanned.roomName) &&
                        roomName < bestNeverScanned.roomName)
                )
            ) {
                bestNeverScanned = roomRecord;
            }

            continue;
        }

        if(
            !oldestScanned ||
            roomRecord.lastScanTick < oldestScanned.lastScanTick ||
            (
                roomRecord.lastScanTick === oldestScanned.lastScanTick &&
                (roomRecord.distance < oldestScanned.distance ||
                    roomRecord.distance === oldestScanned.distance &&
                    Season11.scoutPriority(roomName) > Season11.scoutPriority(oldestScanned.roomName))
            )
        ) {
            oldestScanned = roomRecord;
        }
    }

    if (priorityRoom) { creep.memory.targetRoom = priorityRoom.roomName; return true; }
    if(bestNeverScanned) {
        creep.memory.targetRoom = bestNeverScanned.roomName;
        return true;
    }

    if(
        oldestScanned &&
        Game.time - oldestScanned.lastScanTick >= SCOUT_RESCAN_AFTER_TICKS
    ) {
        creep.memory.targetRoom = oldestScanned.roomName;
        return true;
    }

    delete creep.memory.targetRoom;
    return false;
}

function moveToTargetRoom(creep, roomName) {
    /*
     * Move the Scout to another room.
     *
     * Important:
     * Do NOT move to the closest exit tile with default range 1.
     * That can make the Scout stop beside the exit instead of crossing rooms.
     *
     * Instead, use utilityTravelCreep.moveToRoom(), which targets a position
     * inside the target room and lets Traveler handle the room transition.
     */
    if(!creep || !creep.room || !roomName) {
        return false;
    }

    if(creep.room.name === roomName) {
        return true;
    }

    /*
     * Quick route check.
     * If Screeps says there is no route, pause this target room for a while.
     */
    var exitDir = Game.map.findExit(creep.room, roomName);

    if(exitDir < 0) {
        markScoutRoomUnreachable(creep, roomName, SCOUT_UNREACHABLE_TICKS);
        delete creep.memory.targetRoom;
        return false;
    }

    /*
     * Move toward the center of the target room.
     * range 22 means the Scout only needs to enter the room area, not walk
     * all the way to the center like it is reporting for military inspection.
     */
    var moveResult = utilityTravelCreep.moveToRoom(creep, roomName, {
        range: 22,
        reusePath: 20,
        visualizePathStyle: {
            stroke: '#ffffff'
        }
    });

    if(moveResult === ERR_NO_PATH || moveResult === ERR_INVALID_TARGET || moveResult === ERR_INVALID_ARGS) {
        markScoutRoomUnreachable(creep, roomName, SCOUT_UNREACHABLE_TICKS);
        delete creep.memory.targetRoom;
        return false;
    }

    return true;
}

function markScoutRoomUnreachable(creep, roomName, ticks) {
    /*
     * If routing fails, pause this room instead of deleting it. The Scout can
     * try again later in case the map or route becomes available.
     */
    var plan = getScoutPlan(creep);

    if(!plan || !plan.rooms || !plan.rooms[roomName]) {
        return;
    }

    plan.rooms[roomName].unreachableUntil = Game.time + ticks;
}

function idleNearHome(creep) {
    /*
     * When no planned room needs a scan, wait near home. This keeps the Scout
     * predictable and close to the next scan cycle.
     */
    var homeRoom = ensureScoutHomeRoom(creep);

    if(!homeRoom) {
        return;
    }

    if(creep.room.name !== homeRoom) {
        moveToTargetRoom(creep, homeRoom);
        return;
    }

    var spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);

    if(spawn && creep.pos.getRangeTo(spawn) > 3) {
        utilityTravelCreep.move(creep, spawn, {
            range: 3,
            visualizePathStyle: {
                stroke: '#bbbbbb'
            }
        });
    }
}

roleScout._test = { chooseNextScoutRoom: chooseNextScoutRoom, ensureScoutPlan: ensureScoutPlan };
module.exports = roleScout;
