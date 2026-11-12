function beginFill(job) {
    job.fill = {
        structureType: STRUCTURE_TOWER,
        candidateIndex: 0,
        nextPhase: 'extensions'
    };
}

function continueFromCandidates(ctx, room, job) {
    if (!job.fill) {
        beginFill(job);
    }

    return ctx.continueFillFromCandidates(room, job);
}

module.exports = {
    beginFill: beginFill,
    continueFromCandidates: continueFromCandidates
};
