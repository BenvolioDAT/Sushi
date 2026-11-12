function planExistingRoadAccess(ctx, room, plan, reserved) {
    var spawns = plan && plan.positions ? plan.positions[STRUCTURE_SPAWN] || [] : [];

    for (var i = 0; i < spawns.length; i++) {
        var plain = spawns[i];
        var pos = ctx.makeRoomPositionSafe(plain.x, plain.y, plain.roomName || room.name);

        if (!pos || pos.roomName !== room.name) {
            continue;
        }

        ctx.ensureRoadAccessForStructure(room, plan, reserved, STRUCTURE_SPAWN, pos, 2);
    }
}

function continueExtraFromCandidates(ctx, room, job) {
    if (job.extraSpawnsDone) {
        return true;
    }

    var finalAllowed = ctx.getAllowedAtRcl(STRUCTURE_SPAWN, 8);
    var candidates = job.candidates || [];
    var i = job.extraSpawnCandidateIndex || 0;
    var existingSpawnCount = job.existingSpawnCount || 0;

    while (ctx.getPlannedCount(job.draftPlan, STRUCTURE_SPAWN) < finalAllowed) {
        var ordinal = ctx.getPlannedCount(job.draftPlan, STRUCTURE_SPAWN) + 1;
        var rcl = ctx.getFirstRclForOrdinal(STRUCTURE_SPAWN, ordinal);

        if (rcl < 7 || ordinal <= existingSpawnCount) {
            job.extraSpawnsDone = true;
            delete job.extraSpawnCandidateIndex;
            return true;
        }

        if (i >= candidates.length) {
            job.extraSpawnsDone = true;
            delete job.extraSpawnCandidateIndex;
            return true;
        }

        if (!ctx.canContinueStructurePlanning()) {
            job.extraSpawnCandidateIndex = i;
            return false;
        }

        var pos = ctx.getCandidatePosition(candidates[i], room.name);
        i++;

        if (pos) {
            ctx.addPlannedStructure(room, job.draftPlan, job.reserved, STRUCTURE_SPAWN, pos, rcl);
        }
    }

    job.extraSpawnsDone = true;
    delete job.extraSpawnCandidateIndex;
    return true;
}

module.exports = {
    planExistingRoadAccess: planExistingRoadAccess,
    continueExtraFromCandidates: continueExtraFromCandidates
};
