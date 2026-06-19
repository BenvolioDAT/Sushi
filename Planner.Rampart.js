function continueKeyRamparts(ctx, room, job, targets) {
    var targetIndex = job.rampartTargetIndex || 0;
    var positionIndex = job.rampartPositionIndex || 0;

    while (targetIndex < targets.length) {
        var structureType = targets[targetIndex];
        var positions = job.draftPlan.positions[structureType] || [];

        while (positionIndex < positions.length) {
            if (!ctx.canContinueStructurePlanning()) {
                job.rampartTargetIndex = targetIndex;
                job.rampartPositionIndex = positionIndex;
                return false;
            }

            var plain = positions[positionIndex];
            positionIndex++;

            var pos = ctx.makeRoomPositionSafe(plain.x, plain.y, plain.roomName || room.name);
            ctx.addPlannedStructure(room, job.draftPlan, job.reserved, STRUCTURE_RAMPART, pos, 5);
        }

        targetIndex++;
        positionIndex = 0;
    }

    delete job.rampartTargetIndex;
    delete job.rampartPositionIndex;
    return true;
}

module.exports = {
    continueKeyRamparts: continueKeyRamparts
};
