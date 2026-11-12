/*
 * Structure-plan road planner.
 *
 * Planner.Road.js owns roads that are saved inside
 * Memory.rooms[roomName].structurePlanner.plan. It is separate from
 * Planner.Roads.js, which still owns broader room, route, and remote roads.
 */

var Util = require('Planner.Util');

function planRoadAt(ctx, room, plan, reserved, pos, rcl) {
    if (!plan || !reserved || !isValidRoadTile(ctx, room, pos, reserved)) {
        return false;
    }

    ctx.recordPlannedStructure(plan, reserved, STRUCTURE_ROAD, pos, getRoadRclForStructure(rcl));
    return true;
}

function getRoadRclForStructure(rcl) {
    return Math.max(2, Math.min(8, rcl || 2));
}

function hasPlannedRoadAt(plan, pos) {
    return !!(
        plan &&
        plan.positions &&
        plan.positions[STRUCTURE_ROAD] &&
        Util.hasPosition(plan.positions[STRUCTURE_ROAD], pos)
    );
}

function ensureRoadAccessForStructure(ctx, room, plan, reserved, structureType, pos, rcl) {
    if (!structureNeedsRoadAccess(structureType)) {
        return true;
    }

    var roadPos = findRoadAccessTile(ctx, room, plan, reserved, structureType, pos);
    if (!roadPos) {
        return false;
    }

    return planRoadAt(ctx, room, plan, reserved, roadPos, getRoadRclForStructure(rcl));
}

function structureNeedsRoadAccess(structureType) {
    return (
        structureType === STRUCTURE_SPAWN ||
        structureType === STRUCTURE_EXTENSION ||
        structureType === STRUCTURE_STORAGE ||
        structureType === STRUCTURE_LINK ||
        structureType === STRUCTURE_TOWER ||
        structureType === STRUCTURE_TERMINAL ||
        structureType === STRUCTURE_FACTORY ||
        structureType === STRUCTURE_POWER_SPAWN ||
        structureType === STRUCTURE_NUKER ||
        structureType === STRUCTURE_LAB
    );
}

function findRoadAccessTile(ctx, room, plan, reserved, structureType, pos) {
    if (!room || !pos || pos.roomName !== room.name) {
        return null;
    }

    var anchor = ctx.getPlanAnchorPosition(plan, room.name);
    var best = null;

    for (var i = 0; i < Util.AROUND.length; i++) {
        var offset = Util.AROUND[i];
        var roadPos = Util.makeRoomPositionSafe(pos.x + offset.x, pos.y + offset.y, room.name);

        if (!isValidRoadTile(ctx, room, roadPos, reserved)) {
            continue;
        }

        var score = scoreRoadAccessTile(ctx, room, plan, reserved, roadPos, anchor);
        if (structureType === STRUCTURE_TOWER || structureType === STRUCTURE_POWER_SPAWN) {
            score -= 2;
        }

        if (!best || score < best.score) {
            best = {
                pos: roadPos,
                score: score
            };
        }
    }

    return best ? best.pos : null;
}

function scoreRoadAccessTile(ctx, room, plan, reserved, pos, anchor) {
    var score = anchor ? pos.getRangeTo(anchor) * 3 : 0;

    if (hasPlannedRoadAt(plan, pos)) {
        score -= 100;
    }

    if (ctx.hasStructureTypeAt(room, pos, STRUCTURE_ROAD)) {
        score -= 80;
    }

    if (hasConstructionSiteTypeAt(room, pos, STRUCTURE_ROAD)) {
        score -= 70;
    }

    if (isReservedExtensionServiceTile(reserved, pos)) {
        score -= 50;
    }

    score -= countAdjacentRoadLikeTiles(ctx, room, plan, reserved, pos) * 6;

    if (room.getTerrain().get(pos.x, pos.y) === TERRAIN_MASK_SWAMP) {
        score += 2;
    }

    return score;
}

function countAdjacentRoadLikeTiles(ctx, room, plan, reserved, pos) {
    var count = 0;

    for (var i = 0; i < Util.AROUND.length; i++) {
        var near = Util.makeRoomPositionSafe(pos.x + Util.AROUND[i].x, pos.y + Util.AROUND[i].y, pos.roomName);
        if (!near) {
            continue;
        }

        if (
            hasPlannedRoadAt(plan, near) ||
            ctx.hasStructureTypeAt(room, near, STRUCTURE_ROAD) ||
            isReservedExtensionServiceTile(reserved, near)
        ) {
            count++;
        }
    }

    return count;
}

function isValidRoadTile(ctx, room, pos, reserved) {
    if (!room || !pos || pos.roomName !== room.name || Util.isEdge(pos)) {
        return false;
    }

    if (room.getTerrain().get(pos.x, pos.y) === TERRAIN_MASK_WALL) {
        return false;
    }

    if (ctx.hasNaturalObject(room, pos, STRUCTURE_ROAD)) {
        return false;
    }

    if (hasBlockingRoadStructure(room, pos)) {
        return false;
    }

    if (hasBlockingRoadConstructionSite(room, pos)) {
        return false;
    }

    return !hasBlockingPlannedRoadReservation(reserved, pos);
}

function hasBlockingRoadStructure(room, pos) {
    var structures = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);

    for (var i = 0; i < structures.length; i++) {
        var structure = structures[i];

        if (
            structure.structureType === STRUCTURE_ROAD ||
            structure.structureType === STRUCTURE_CONTAINER
        ) {
            continue;
        }

        if (structure.structureType === STRUCTURE_RAMPART && (structure.my || structure.isPublic)) {
            continue;
        }

        return true;
    }

    return false;
}

function hasBlockingRoadConstructionSite(room, pos) {
    var sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y);

    for (var i = 0; i < sites.length; i++) {
        if (
            sites[i].structureType === STRUCTURE_ROAD ||
            sites[i].structureType === STRUCTURE_CONTAINER ||
            sites[i].structureType === STRUCTURE_RAMPART
        ) {
            continue;
        }

        return true;
    }

    return false;
}

function hasBlockingPlannedRoadReservation(reserved, pos) {
    var tile = reserved && reserved[Util.packCoord(pos)];
    if (!tile || !tile.types) {
        return false;
    }

    for (var structureType in tile.types) {
        if (!tile.types.hasOwnProperty(structureType)) {
            continue;
        }

        if (
            structureType === STRUCTURE_ROAD ||
            structureType === STRUCTURE_CONTAINER ||
            structureType === STRUCTURE_RAMPART
        ) {
            continue;
        }

        return true;
    }

    return false;
}

function hasConstructionSiteTypeAt(room, pos, structureType) {
    var sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y);

    for (var i = 0; i < sites.length; i++) {
        if (sites[i].structureType === structureType) {
            return true;
        }
    }

    return false;
}

function isReservedExtensionServiceTile(reserved, pos) {
    var tile = reserved && reserved[Util.packCoord(pos)];
    return !!(tile && tile.extensionService === true);
}

module.exports = {
    planRoadAt: planRoadAt,
    getRoadRclForStructure: getRoadRclForStructure,
    hasPlannedRoadAt: hasPlannedRoadAt,
    ensureRoadAccessForStructure: ensureRoadAccessForStructure,
    structureNeedsRoadAccess: structureNeedsRoadAccess,
    findRoadAccessTile: findRoadAccessTile,
    isValidRoadTile: isValidRoadTile,
    isReservedExtensionServiceTile: isReservedExtensionServiceTile
};
