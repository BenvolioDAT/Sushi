/*
 * Shared helpers for the structure planner family.
 *
 * This module must stay free of Planner.Brain.js imports so structure-specific
 * planners can use it without circular require chains.
 */

var AROUND = [
    { x: -1, y: -1 },
    { x: 0, y: -1 },
    { x: 1, y: -1 },
    { x: -1, y: 0 },
    { x: 1, y: 0 },
    { x: -1, y: 1 },
    { x: 0, y: 1 },
    { x: 1, y: 1 }
];

var CARDINAL_AROUND = [
    { x: 0, y: -1 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 }
];

var NEAR_STORAGE_OFFSETS = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
    { x: 1, y: -1 },
    { x: -1, y: -1 },
    { x: 2, y: 0 },
    { x: -2, y: 0 },
    { x: 0, y: 2 },
    { x: 0, y: -2 }
];

function packCoord(pos) {
    return pos.x + (pos.y * 50);
}

function unpackCoord(packed, roomName) {
    var value = parseInt(packed, 10) || 0;
    var x = value % 50;
    var y = Math.floor(value / 50);

    return new RoomPosition(x, y, roomName);
}

function makeRoomPositionSafe(x, y, roomName) {
    if (x < 0 || x > 49 || y < 0 || y > 49) {
        return null;
    }

    return new RoomPosition(x, y, roomName);
}

function isEdge(pos) {
    return pos.x <= 0 || pos.x >= 49 || pos.y <= 0 || pos.y >= 49;
}

function plainPosition(pos) {
    if (!pos) {
        return null;
    }

    return {
        x: pos.x,
        y: pos.y,
        roomName: pos.roomName
    };
}

function hasPosition(positions, pos) {
    return !!getPositionEntry(positions, pos);
}

function getPositionEntry(positions, pos) {
    if (!positions || !pos) {
        return null;
    }

    for (var i = 0; i < positions.length; i++) {
        if (positions[i].x === pos.x && positions[i].y === pos.y && positions[i].roomName === pos.roomName) {
            return positions[i];
        }
    }

    return null;
}

module.exports = {
    AROUND: AROUND,
    CARDINAL_AROUND: CARDINAL_AROUND,
    NEAR_STORAGE_OFFSETS: NEAR_STORAGE_OFFSETS,
    packCoord: packCoord,
    unpackCoord: unpackCoord,
    makeRoomPositionSafe: makeRoomPositionSafe,
    isEdge: isEdge,
    plainPosition: plainPosition,
    hasPosition: hasPosition,
    getPositionEntry: getPositionEntry
};
