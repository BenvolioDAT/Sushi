/*
 * Visual.Planner.Structures.js
 *
 * Room visual preview for Planner.Brain.js saved structure plans.
 *
 * This module only reads Memory.rooms[roomName].structurePlanner.plan and draws
 * temporary RoomVisual labels. It never creates construction sites and never
 * changes planner or room layout decisions.
 *
 * It is off by default. Enable it manually from the console with:
 * Memory.settings = Memory.settings || {}; Memory.settings.showStructurePlanner = true;
 *
 * Disable it with:
 * Memory.settings.showStructurePlanner = false;
 */

var MAX_MARKERS_PER_ROOM = 250;
var MARKER_FONT = 0.4;
var SERVICE_MARKER_FONT = 0.28;
var SERVICE_MARKER_COLOR = '#b6f7b0';

var LABELS = {};
LABELS[STRUCTURE_SPAWN] = 'SP';
LABELS[STRUCTURE_EXTENSION] = 'EX';
LABELS[STRUCTURE_ROAD] = 'RD';
LABELS[STRUCTURE_TOWER] = 'TW';
LABELS[STRUCTURE_STORAGE] = 'ST';
LABELS[STRUCTURE_CONTAINER] = 'CN';
LABELS[STRUCTURE_LINK] = 'LK';
LABELS[STRUCTURE_TERMINAL] = 'TE';
LABELS[STRUCTURE_EXTRACTOR] = 'XT';
LABELS[STRUCTURE_FACTORY] = 'FA';
LABELS[STRUCTURE_OBSERVER] = 'OB';
LABELS[STRUCTURE_POWER_SPAWN] = 'PS';
LABELS[STRUCTURE_NUKER] = 'NK';
LABELS[STRUCTURE_LAB] = 'LB';
LABELS[STRUCTURE_RAMPART] = 'RP';

var COLORS = {};
COLORS[STRUCTURE_SPAWN] = '#ffffff';
COLORS[STRUCTURE_EXTENSION] = '#7fd1ff';
COLORS[STRUCTURE_ROAD] = '#b8b8b8';
COLORS[STRUCTURE_TOWER] = '#ffcc66';
COLORS[STRUCTURE_STORAGE] = '#f7f06d';
COLORS[STRUCTURE_CONTAINER] = '#c49a6c';
COLORS[STRUCTURE_LINK] = '#78f0c4';
COLORS[STRUCTURE_TERMINAL] = '#ff9ad5';
COLORS[STRUCTURE_EXTRACTOR] = '#ffaa44';
COLORS[STRUCTURE_FACTORY] = '#b8b8b8';
COLORS[STRUCTURE_OBSERVER] = '#8fc7ff';
COLORS[STRUCTURE_POWER_SPAWN] = '#ff7070';
COLORS[STRUCTURE_NUKER] = '#d9ff5c';
COLORS[STRUCTURE_LAB] = '#b58cff';
COLORS[STRUCTURE_RAMPART] = '#62e36f';

function isEnabled() {
    return Memory.settings && Memory.settings.showStructurePlanner === true;
}

function run() {
    if (!isEnabled()) {
        return;
    }

    for (var roomName in Game.rooms) {
        if (!Game.rooms.hasOwnProperty(roomName)) {
            continue;
        }

        drawRoom(Game.rooms[roomName]);
    }
}

function drawRoom(room) {
    if (!isEnabled()) {
        return 0;
    }

    if (!room || !room.controller || !room.controller.my) {
        return 0;
    }

    var plan = getSavedPlan(room.name);
    if (!isValidPlan(plan)) {
        return 0;
    }

    var seen = {};
    var occupied = {};
    var drawn = 0;

    for (var rcl = 1; rcl <= 8 && drawn < MAX_MARKERS_PER_ROOM; rcl++) {
        var entries = plan.byRcl[rcl];
        if (!entries || !entries.length) {
            continue;
        }

        for (var i = 0; i < entries.length && drawn < MAX_MARKERS_PER_ROOM; i++) {
            var entry = entries[i];
            var structureType = entry && (entry.type || entry.structureType);

            if (!structureType || !isValidCoord(entry.x) || !isValidCoord(entry.y)) {
                continue;
            }

            if (entry.roomName && entry.roomName !== room.name) {
                continue;
            }

            var key = structureType + ':' + entry.x + ':' + entry.y;
            if (seen[key]) {
                continue;
            }
            seen[key] = true;
            occupied[entry.x + ':' + entry.y] = true;

            drawMarker(room.visual, structureType, entry.x, entry.y);
            drawn++;
        }
    }

    drawn = drawExtensionServiceTiles(room, plan, occupied, drawn);
    drawHeader(room, drawn);
    return drawn;
}

function getSavedPlan(roomName) {
    if (!Memory.rooms || !Memory.rooms[roomName]) {
        return null;
    }

    var planner = Memory.rooms[roomName].structurePlanner;
    if (!planner) {
        return null;
    }

    return planner.plan || null;
}

function isValidPlan(plan) {
    return !!(
        plan &&
        plan.byRcl &&
        plan.positions &&
        plan.links &&
        plan.containers
    );
}

function isValidCoord(value) {
    return typeof value === 'number' && value >= 0 && value <= 49;
}

function drawMarker(visual, structureType, x, y) {
    visual.text(LABELS[structureType] || '??', x, y + 0.13, {
        color: COLORS[structureType] || '#ffffff',
        font: MARKER_FONT,
        opacity: 0.78,
        stroke: '#000000',
        strokeWidth: 0.16
    });
}

function drawExtensionServiceTiles(room, plan, occupied, drawn) {
    var tiles = plan.extensionServiceTiles || [];

    for (var i = 0; i < tiles.length && drawn < MAX_MARKERS_PER_ROOM; i++) {
        var tile = tiles[i];

        if (!tile || !isValidCoord(tile.x) || !isValidCoord(tile.y)) {
            continue;
        }

        if (tile.roomName && tile.roomName !== room.name) {
            continue;
        }

        var key = tile.x + ':' + tile.y;
        if (occupied[key]) {
            continue;
        }
        occupied[key] = true;

        room.visual.text('..', tile.x, tile.y + 0.1, {
            color: SERVICE_MARKER_COLOR,
            font: SERVICE_MARKER_FONT,
            opacity: 0.62,
            stroke: '#000000',
            strokeWidth: 0.12
        });

        drawn++;
    }

    return drawn;
}

function drawHeader(room, drawn) {
    var currentRcl = room.controller ? room.controller.level || 0 : 0;

    room.visual.text(
        'Structure Plan RCL ' + currentRcl + ' / showing RCL 1-8 / drawn ' + drawn,
        1,
        1,
        {
            align: 'left',
            color: '#ffffff',
            font: 0.55,
            opacity: 0.85,
            stroke: '#000000',
            strokeWidth: 0.12
        }
    );
}

module.exports = {
    run: run,
    drawRoom: drawRoom
};
