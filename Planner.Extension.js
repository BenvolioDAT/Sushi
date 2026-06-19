/*
 * Extension placement and service-road rules.
 */

var Util = require('Planner.Util');
var PlannerRoad = require('Planner.Road');

function addPlannedStructure(ctx, room, plan, reserved, pos, rcl) {
    if (!pos || !ctx.canPlanAt(room, STRUCTURE_EXTENSION, pos) || ctx.hasPlannedConflict(reserved, STRUCTURE_EXTENSION, pos)) {
        return false;
    }

    var servicePos = findExtensionServiceTile(ctx, room, plan, reserved, pos);
    if (!servicePos) {
        return false;
    }

    if (!ctx.recordPlannedStructure(plan, reserved, STRUCTURE_EXTENSION, pos, rcl)) {
        return false;
    }

    reserveExtensionServiceTile(ctx, room, plan, reserved, servicePos, rcl);
    return true;
}

function continueFromCandidates(ctx, room, job) {
    return ctx.continueFillFromCandidates(room, job);
}

function hasBuildAccess(ctx, room, pos, plan, planReserved) {
    if (!isExtensionBuildTile(ctx, room, plan, pos)) {
        return false;
    }

    return !!findExtensionServiceTile(ctx, room, plan, planReserved || ctx.makePlanReservationLookup(plan), pos);
}

function reserveExtensionServiceTile(ctx, room, plan, reserved, pos, rcl) {
    var packed = Util.packCoord(pos);

    if (!reserved[packed]) {
        reserved[packed] = {
            types: {}
        };
    }
    if (!reserved[packed].types) {
        reserved[packed].types = {};
    }

    reserved[packed].extensionService = true;

    if (!plan.extensionServiceTiles) {
        plan.extensionServiceTiles = [];
    }

    if (!Util.hasPosition(plan.extensionServiceTiles, pos)) {
        plan.extensionServiceTiles.push(Util.plainPosition(pos));
    }

    PlannerRoad.planRoadAt(ctx, room, plan, reserved, pos, PlannerRoad.getRoadRclForStructure(rcl));
}

function findExtensionServiceTile(ctx, room, plan, reserved, extensionPos) {
    if (!isExtensionBuildTile(ctx, room, plan, extensionPos)) {
        return null;
    }

    var anchor = ctx.getPlanAnchorPosition(plan, room.name);
    var best = null;

    for (var i = 0; i < Util.CARDINAL_AROUND.length; i++) {
        var offset = Util.CARDINAL_AROUND[i];
        var servicePos = Util.makeRoomPositionSafe(extensionPos.x + offset.x, extensionPos.y + offset.y, room.name);

        if (!isValidExtensionServiceTile(ctx, room, servicePos, reserved)) {
            continue;
        }

        var score = scoreExtensionServiceTile(ctx, room, servicePos, reserved, anchor);
        if (!best || score < best.score) {
            best = {
                pos: servicePos,
                score: score
            };
        }
    }

    return best ? best.pos : null;
}

function isExtensionBuildTile(ctx, room, plan, pos) {
    if (!pos) {
        return false;
    }

    if (ctx.hasStructureTypeAt(room, pos, STRUCTURE_EXTENSION)) {
        return true;
    }

    var anchor = ctx.getPlanAnchorPosition(plan, pos.roomName);
    if (!anchor) {
        return true;
    }

    return ((pos.x + pos.y) % 2) === ((anchor.x + anchor.y) % 2);
}

function isValidExtensionServiceTile(ctx, room, pos, reserved) {
    if (!pos || pos.roomName !== room.name || Util.isEdge(pos)) {
        return false;
    }

    if (room.getTerrain().get(pos.x, pos.y) === TERRAIN_MASK_WALL) {
        return false;
    }

    if (ctx.hasNaturalObject(room, pos, null)) {
        return false;
    }

    if (hasBlockingServiceStructure(room, pos)) {
        return false;
    }

    if (hasBlockingServiceConstructionSite(room, pos)) {
        return false;
    }

    return !hasBlockingPlannedServiceReservation(reserved, pos);
}

function scoreExtensionServiceTile(ctx, room, pos, reserved, anchor) {
    var score = anchor ? pos.getRangeTo(anchor) * 3 : 0;

    if (PlannerRoad.isReservedExtensionServiceTile(reserved, pos)) {
        score -= 100;
    }

    score -= countAdjacentExtensionServiceTiles(reserved, pos) * 8;

    if (room.getTerrain().get(pos.x, pos.y) === TERRAIN_MASK_SWAMP) {
        score += 2;
    }

    return score;
}

function countAdjacentExtensionServiceTiles(reserved, pos) {
    var count = 0;

    for (var i = 0; i < Util.AROUND.length; i++) {
        var near = Util.makeRoomPositionSafe(pos.x + Util.AROUND[i].x, pos.y + Util.AROUND[i].y, pos.roomName);
        if (near && PlannerRoad.isReservedExtensionServiceTile(reserved, near)) {
            count++;
        }
    }

    return count;
}

function hasBlockingServiceStructure(room, pos) {
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

function hasBlockingServiceConstructionSite(room, pos) {
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

function hasBlockingPlannedServiceReservation(reserved, pos) {
    var tile = reserved && reserved[Util.packCoord(pos)];
    if (!tile || !tile.types) {
        return false;
    }

    for (var structureType in tile.types) {
        if (!tile.types.hasOwnProperty(structureType)) {
            continue;
        }

        if (
            structureType !== STRUCTURE_ROAD &&
            structureType !== STRUCTURE_CONTAINER &&
            structureType !== STRUCTURE_RAMPART
        ) {
            return true;
        }
    }

    return false;
}

module.exports = {
    addPlannedStructure: addPlannedStructure,
    continueFromCandidates: continueFromCandidates,
    hasBuildAccess: hasBuildAccess,
    reserveExtensionServiceTile: reserveExtensionServiceTile,
    findExtensionServiceTile: findExtensionServiceTile,
    isExtensionBuildTile: isExtensionBuildTile,
    isValidExtensionServiceTile: isValidExtensionServiceTile
};
