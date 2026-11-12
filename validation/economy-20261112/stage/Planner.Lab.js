function continueFromCandidates(ctx, room, job) {
    var maxLabs = Math.min(3, ctx.getAllowedAtRcl(STRUCTURE_LAB, 8));
    var candidates = job.candidates || [];
    var i = job.labCandidateIndex || 0;

    while (i < candidates.length && ctx.getPlannedCount(job.draftPlan, STRUCTURE_LAB) < maxLabs) {
        if (!ctx.canContinueStructurePlanning()) {
            job.labCandidateIndex = i;
            return false;
        }

        var pos = ctx.getCandidatePosition(candidates[i], room.name);
        i++;

        if (!pos) {
            continue;
        }

        var ordinal = ctx.getPlannedCount(job.draftPlan, STRUCTURE_LAB) + 1;
        var rcl = ctx.getFirstRclForOrdinal(STRUCTURE_LAB, ordinal);

        ctx.addPlannedStructure(room, job.draftPlan, job.reserved, STRUCTURE_LAB, pos, rcl);
    }

    delete job.labCandidateIndex;
    return true;
}

module.exports = {
    continueFromCandidates: continueFromCandidates
};
